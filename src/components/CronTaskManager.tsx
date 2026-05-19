import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, FileCode2, Plus, RefreshCw, Server, Trash2, X, PauseCircle, PlayCircle, Pencil } from 'lucide-react';
import type { AIResponse, CronTaskChangePreview, CronTaskChangeRequest, CronTaskListResult, CronTaskRecord, CronTaskSource, CronTaskStatus } from '../types';

interface CronTaskManagerProps {
  serverId: string;
  serverName: string;
}

interface EditDialogState {
  mode: 'create' | 'update';
  task?: CronTaskRecord;
  source: CronTaskSource;
  sourcePath: string;
  schedule: string;
  user: string;
  command: string;
  error: string | null;
}

interface PreviewDialogState {
  request: CronTaskChangeRequest;
  preview: CronTaskChangePreview;
}

interface StoredProviderConfig {
  id: string;
  type: 'minimax' | 'openai' | 'anthropic';
  name: string;
  apiKey?: string;
  api_key?: string;
  baseUrl?: string | null;
  base_url?: string | null;
  model?: string | null;
}

interface AiTaskExplanation {
  status: 'loading' | 'success' | 'error';
  text: string;
  error: string | null;
}

const PROVIDER_DEFAULTS: Record<StoredProviderConfig['type'], { baseUrl: string; model: string }> = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.7',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
  },
};

const STATUS_LABELS: Record<CronTaskStatus, string> = {
  active: '启用',
  disabled: '停用',
  invalid: '无效',
  unreadable: '不可读',
};

const SOURCE_LABELS: Record<CronTaskSource, string> = {
  userCrontab: '用户 crontab',
  systemCrontab: '/etc/crontab',
  cronD: '/etc/cron.d',
  periodicDirectory: '周期目录',
};

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeCommand(command: string): string {
  if (!command.trim()) return '无命令内容';
  return command.length > 88 ? `${command.slice(0, 88)}...` : command;
}

function describeSchedule(schedule: string, fallback: string, timezone: string | null): string {
  const trimmed = schedule.trim();
  const zone = timezone ? `（远端时区 ${timezone}）` : '';
  const special: Record<string, string> = {
    '@reboot': '系统启动时运行一次。',
    '@hourly': `每小时运行一次${zone}。`,
    '@daily': `每天运行一次${zone}。`,
    '@weekly': `每周运行一次${zone}。`,
    '@monthly': `每月运行一次${zone}。`,
    '@yearly': `每年运行一次${zone}。`,
    '@annually': `每年运行一次${zone}。`,
  };
  if (special[trimmed]) return special[trimmed];

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return fallback || '无法解析运行周期。';
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const pad = (value: string) => value.padStart(2, '0');
  const weekNames: Record<string, string> = {
    '0': '周日',
    '1': '周一',
    '2': '周二',
    '3': '周三',
    '4': '周四',
    '5': '周五',
    '6': '周六',
    '7': '周日',
  };

  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每 ${minute.slice(2)} 分钟运行一次${zone}。`;
  }
  if (minute !== '*' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每 ${hour.slice(2)} 小时，在第 ${minute} 分钟运行一次${zone}。`;
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${pad(hour)}:${pad(minute)} 运行${zone}。`;
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && weekNames[dayOfWeek]) {
    return `每${weekNames[dayOfWeek]} ${pad(hour)}:${pad(minute)} 运行${zone}。`;
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `每月 ${dayOfMonth} 日 ${pad(hour)}:${pad(minute)} 运行${zone}。`;
  }
  return `${fallback || `Cron 表达式：${trimmed}`}。请按分钟、小时、日期、月份、星期字段理解${zone}。`;
}

function defaultTaskExplanation(record: CronTaskRecord, readableSchedule: string): string {
  const target = record.scriptPath ? `脚本 ${record.scriptPath}` : '这条命令';
  return `${target} 会按计划自动执行。${readableSchedule} 请重点确认命令路径、运行用户、环境变量和输出日志位置。`;
}

function buildAiPrompt(record: CronTaskRecord, readableSchedule: string): string {
  const script = record.scriptPreview
    ? record.scriptPreview.slice(0, 6000)
    : '未读取到脚本内容，请仅根据命令和 cron 配置判断。';
  return [
    '请用中文解释这个 Linux cron 定时任务的功能和作用，面向运维人员，保持简洁。',
    '请包含：1. 它大概做什么；2. 什么时候运行；3. 可能影响的服务/文件；4. 需要注意的风险或排查点。',
    '',
    `运行时间说明：${readableSchedule}`,
    `cron 表达式：${record.schedule || '未知'}`,
    `运行用户：${record.user || '当前用户 crontab 所属用户'}`,
    `命令：${record.command || '无'}`,
    `来源：${sourceName(record)}`,
    `原始行：${record.rawLine || '无'}`,
    `环境变量：${record.env.join('; ') || '未声明'}`,
    `脚本路径：${record.scriptPath || '未识别'}`,
    '',
    '脚本/命令内容：',
    script,
  ].join('\n');
}

function sourceName(record: CronTaskRecord): string {
  if (record.source === 'cronD' || record.source === 'periodicDirectory') {
    return record.sourcePath || SOURCE_LABELS[record.source];
  }
  return SOURCE_LABELS[record.source];
}

function statusIcon(status: CronTaskStatus) {
  if (status === 'active') return <PlayCircle className="ui-icon" aria-hidden="true" />;
  if (status === 'disabled') return <PauseCircle className="ui-icon" aria-hidden="true" />;
  if (status === 'invalid') return <AlertTriangle className="ui-icon" aria-hidden="true" />;
  return <FileCode2 className="ui-icon" aria-hidden="true" />;
}

export function CronTaskManager({ serverId, serverName }: CronTaskManagerProps) {
  const [records, setRecords] = useState<CronTaskRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const [editDialog, setEditDialog] = useState<EditDialogState | null>(null);
  const [previewDialog, setPreviewDialog] = useState<PreviewDialogState | null>(null);
  const [aiExplanations, setAiExplanations] = useState<Record<string, AiTaskExplanation>>({});

  const selectedRecord = useMemo(() => {
    return records.find((record) => record.id === selectedId) || records[0] || null;
  }, [records, selectedId]);

  const selectedReadableSchedule = useMemo(() => {
    if (!selectedRecord) return '';
    return describeSchedule(selectedRecord.schedule, selectedRecord.scheduleDescription, timezone);
  }, [selectedRecord, timezone]);

  const selectedAiExplanation = selectedRecord ? aiExplanations[selectedRecord.id] : null;

  const applyList = useCallback((result: CronTaskListResult, preferredId?: string) => {
    setRecords(result.records);
    setScannedAt(result.scannedAt);
    setTimezone(result.timezone);
    setLastError(result.lastError);
    setSelectedId((currentId) => {
      if (preferredId && result.records.some((record) => record.id === preferredId)) return preferredId;
      if (currentId && result.records.some((record) => record.id === currentId)) return currentId;
      return result.records[0]?.id || null;
    });
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setLoadingLabel('正在扫描定时任务...');
    try {
      const result = await invoke<CronTaskListResult>('list_cron_tasks', { serverId });
      applyList(result);
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [applyList, serverId]);

  const inspectTask = useCallback(async (record: CronTaskRecord) => {
    setSelectedId(record.id);
    setLoadingLabel('正在读取脚本内容...');
    try {
      const updated = await invoke<CronTaskRecord>('inspect_cron_task', { serverId, taskId: record.id });
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoadingLabel(null);
    }
  }, [serverId]);

  const openCreateDialog = useCallback(() => {
    setEditDialog({
      mode: 'create',
      source: 'userCrontab',
      sourcePath: '',
      schedule: '0 2 * * *',
      user: '',
      command: '',
      error: null,
    });
  }, []);

  const openUpdateDialog = useCallback((record: CronTaskRecord) => {
    if (record.status === 'unreadable' || record.source === 'periodicDirectory') return;
    setEditDialog({
      mode: 'update',
      task: record,
      source: record.source,
      sourcePath: record.sourcePath || '',
      schedule: record.schedule,
      user: record.user || '',
      command: record.command,
      error: null,
    });
  }, []);

  const previewRequest = useCallback(async (request: CronTaskChangeRequest) => {
    setLoading(true);
    setLoadingLabel('正在生成变更预览...');
    try {
      const preview = await invoke<CronTaskChangePreview>('preview_cron_task_change', { serverId, request });
      setPreviewDialog({ request, preview });
      setEditDialog(null);
    } catch (error) {
      if (editDialog) {
        setEditDialog({ ...editDialog, error: getErrorMessage(error) });
      } else {
        setLastError(getErrorMessage(error));
      }
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [editDialog, serverId]);

  const submitEditDialog = useCallback(() => {
    if (!editDialog) return;
    const request: CronTaskChangeRequest = {
      action: editDialog.mode === 'create' ? 'create' : 'update',
      taskId: editDialog.task?.id,
      source: editDialog.source,
      sourcePath: editDialog.source === 'cronD' ? editDialog.sourcePath : null,
      schedule: editDialog.schedule,
      user: editDialog.user,
      command: editDialog.command,
    };
    void previewRequest(request);
  }, [editDialog, previewRequest]);

  const previewRecordAction = useCallback((record: CronTaskRecord, action: 'disable' | 'enable' | 'delete') => {
    void previewRequest({ action, taskId: record.id });
  }, [previewRequest]);

  const applyPreview = useCallback(async () => {
    if (!previewDialog) return;
    setLoading(true);
    setLoadingLabel('正在应用定时任务变更...');
    try {
      const result = await invoke<CronTaskListResult>('apply_cron_task_change', {
        serverId,
        request: previewDialog.request,
        expectedHash: previewDialog.preview.expectedHash,
      });
      applyList(result);
      setPreviewDialog(null);
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [applyList, previewDialog, serverId]);

  const explainTaskWithAi = useCallback(async (record: CronTaskRecord, force = false) => {
    const readableSchedule = describeSchedule(record.schedule, record.scheduleDescription, timezone);
    const defaultText = defaultTaskExplanation(record, readableSchedule);
    if (!force && aiExplanations[record.id]) {
      return;
    }

    setAiExplanations((current) => ({
      ...current,
      [record.id]: { status: 'loading', text: defaultText, error: null },
    }));

    try {
      const providers = await invoke<StoredProviderConfig[]>('load_provider_config');
      const provider = providers[0];
      if (!provider) {
        throw new Error('未配置 AI Provider，请先在设置里添加 AI Provider。');
      }
      const defaults = PROVIDER_DEFAULTS[provider.type] || PROVIDER_DEFAULTS.openai;
      const apiKey = provider.apiKey || provider.api_key || '';
      const baseUrl = provider.baseUrl || provider.base_url || defaults.baseUrl;
      const model = provider.model || defaults.model;
      if (!apiKey.trim()) {
        throw new Error('AI Provider 配置缺少 API Key，请在设置里重新保存提供商配置。');
      }
      const response = await invoke<AIResponse>('call_ai', {
        params: {
          apiKey,
          baseUrl,
          model,
          prompt: buildAiPrompt(record, readableSchedule),
          context: {
            currentDir: '/',
            recentCommands: [],
            sessionState: {
              connectedServer: serverName,
              isConnected: true,
            },
            memoryContext: null,
          },
        },
      });
      const text = response.explanation || response.command || defaultText;
      setAiExplanations((current) => ({
        ...current,
        [record.id]: { status: 'success', text, error: null },
      }));
    } catch (error) {
      setAiExplanations((current) => ({
        ...current,
        [record.id]: {
          status: 'error',
          text: defaultText,
          error: getErrorMessage(error),
        },
      }));
    }
  }, [aiExplanations, serverName, timezone]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (selectedRecord && selectedRecord.status !== 'unreadable') {
      void explainTaskWithAi(selectedRecord);
    }
  }, [explainTaskWithAi, selectedRecord]);

  return (
    <div className="window-shell cron-task-window-shell">
      <div className="cron-task-manager">
        <header className="cron-task-toolbar">
          <div className="cron-task-title">
            <span className="cron-task-title-icon">
              <Clock3 className="ui-icon" aria-hidden="true" />
            </span>
            <div>
              <div className="cron-task-title-main">定时任务管理</div>
              <div className="cron-task-title-sub">
                <Server className="ui-icon" aria-hidden="true" />
                {serverName}
              </div>
            </div>
          </div>
          <div className="cron-task-toolbar-meta">
            <CalendarClock className="ui-icon" aria-hidden="true" />
            扫描：{formatTimestamp(scannedAt)} {timezone ? `· ${timezone}` : ''}
          </div>
          <div className="cron-task-toolbar-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={openCreateDialog} disabled={loading}>
              <Plus className="ui-icon" aria-hidden="true" />
              添加任务
            </button>
            <button type="button" className="btn btn-primary btn-small" onClick={() => { void loadTasks(); }} disabled={loading}>
              <RefreshCw className="ui-icon" aria-hidden="true" />
              {loading ? '处理中...' : '刷新'}
            </button>
          </div>
        </header>

        {(lastError || loadingLabel) && (
          <div className={lastError ? 'error-message cron-task-banner' : 'success-message cron-task-banner'}>
            <span>{lastError || loadingLabel}</span>
          </div>
        )}

        <main className="cron-task-shell">
          <aside className="cron-task-list-panel">
            <div className="cron-task-panel-header">
              <span>
                <Clock3 className="ui-icon" aria-hidden="true" />
                Cron 任务
              </span>
              <span>{records.length} 项</span>
            </div>
            <div className={`cron-task-list ${loading ? 'is-pending' : ''}`}>
              {records.length === 0 && !loading && (
                <div className="cron-task-empty">
                  <Clock3 className="ui-icon" aria-hidden="true" />
                  <div>没有发现 cron 定时任务。</div>
                  <button type="button" className="btn btn-primary btn-small" onClick={openCreateDialog}>
                    <Plus className="ui-icon" aria-hidden="true" />
                    添加任务
                  </button>
                </div>
              )}
              {records.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className={`cron-task-row ${selectedRecord?.id === record.id ? 'selected' : ''}`}
                  onClick={() => { void inspectTask(record); }}
                >
                  <span className={`cron-task-status-dot ${record.status}`}>{statusIcon(record.status)}</span>
                  <span className="cron-task-row-main">
                    <span className="cron-task-row-command">{summarizeCommand(record.command || record.lastError || record.rawLine)}</span>
                    <span className="cron-task-row-source">{sourceName(record)}</span>
                    <span className="cron-task-row-schedule">{describeSchedule(record.schedule, record.scheduleDescription, timezone)}</span>
                  </span>
                  <span className={`cron-task-status-pill ${record.status}`}>{STATUS_LABELS[record.status]}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="cron-task-detail-panel">
            {selectedRecord ? (
              <>
                <div className="cron-task-detail-header">
                  <div>
                    <div className="cron-task-detail-title">{summarizeCommand(selectedRecord.command || selectedRecord.rawLine)}</div>
                    <div className="cron-task-detail-path">{sourceName(selectedRecord)}</div>
                  </div>
                  <span className={`cron-task-status-pill ${selectedRecord.status}`}>{STATUS_LABELS[selectedRecord.status]}</span>
                </div>

                <div className="cron-task-actions">
                  {selectedRecord.status === 'active' && selectedRecord.source !== 'periodicDirectory' && (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => previewRecordAction(selectedRecord, 'disable')}>
                      <PauseCircle className="ui-icon" aria-hidden="true" />
                      停用
                    </button>
                  )}
                  {selectedRecord.status === 'disabled' && (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => previewRecordAction(selectedRecord, 'enable')}>
                      <PlayCircle className="ui-icon" aria-hidden="true" />
                      启用
                    </button>
                  )}
                  {selectedRecord.status !== 'unreadable' && selectedRecord.source !== 'periodicDirectory' && (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => openUpdateDialog(selectedRecord)}>
                      <Pencil className="ui-icon" aria-hidden="true" />
                      编辑
                    </button>
                  )}
                  {selectedRecord.status !== 'unreadable' && (
                    <button type="button" className="btn btn-secondary btn-small danger-icon" onClick={() => previewRecordAction(selectedRecord, 'delete')}>
                      <Trash2 className="ui-icon" aria-hidden="true" />
                      删除
                    </button>
                  )}
                </div>

                <div className="cron-task-detail-grid">
                  <div className="cron-task-field"><span>计划</span><strong>{selectedRecord.schedule || '未知'}</strong></div>
                  <div className="cron-task-field"><span>周期</span><strong>{selectedReadableSchedule}</strong></div>
                  <div className="cron-task-field"><span>运行用户</span><strong>{selectedRecord.user || '当前用户'}</strong></div>
                  <div className="cron-task-field"><span>行号</span><strong>{selectedRecord.lineNumber || '-'}</strong></div>
                </div>

                <div className="cron-task-section">
                  <div className="cron-task-section-title">运行时间说明</div>
                  <div className="cron-task-readable-card">
                    <strong>{selectedReadableSchedule}</strong>
                    <span>这个说明由本地 cron 解析生成；如果表达式较复杂，请同时核对原始 cron 行。</span>
                  </div>
                </div>

                <div className="cron-task-section">
                  <div className="cron-task-section-title">AI 功能解读</div>
                  <div className={`cron-task-ai-card ${selectedAiExplanation?.status || 'idle'}`}>
                    <div className="cron-task-ai-copy">
                      {selectedAiExplanation?.status === 'loading' ? (
                        <span>正在调用 AI 分析脚本和命令...</span>
                      ) : (
                        <span>{selectedAiExplanation?.text || defaultTaskExplanation(selectedRecord, selectedReadableSchedule)}</span>
                      )}
                      {selectedAiExplanation?.error && (
                        <span className="cron-task-ai-error">AI 调用失败：{selectedAiExplanation.error}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => { void explainTaskWithAi(selectedRecord, true); }}
                      disabled={selectedAiExplanation?.status === 'loading'}
                    >
                      <RefreshCw className="ui-icon" aria-hidden="true" />
                      {selectedAiExplanation?.status === 'loading' ? '分析中...' : '重试 AI 解读'}
                    </button>
                  </div>
                </div>

                <div className="cron-task-section">
                  <div className="cron-task-section-title">命令</div>
                  <div className="cron-task-code-row">{selectedRecord.command || '无命令内容'}</div>
                </div>

                <div className="cron-task-section">
                  <div className="cron-task-section-title">原始内容</div>
                  <pre className="cron-task-code-block">{selectedRecord.rawLine || selectedRecord.lastError || '无'}</pre>
                </div>

                <div className="cron-task-section">
                  <div className="cron-task-section-title">运行环境提醒</div>
                  <div className="cron-task-warning-list">
                    <span>Cron 的 PATH、工作目录和 shell 初始化通常不同于交互终端。</span>
                    <span>请确认命令使用绝对路径，必要时在脚本里声明 PATH、SHELL 和工作目录。</span>
                    {timezone && <span>远端当前时区：{timezone}</span>}
                  </div>
                </div>

                {selectedRecord.env.length > 0 && (
                  <div className="cron-task-section">
                    <div className="cron-task-section-title">环境变量</div>
                    <pre className="cron-task-code-block">{selectedRecord.env.join('\n')}</pre>
                  </div>
                )}

                {selectedRecord.scriptPath && (
                  <div className="cron-task-section">
                    <div className="cron-task-section-title">脚本预览：{selectedRecord.scriptPath}</div>
                    <pre className="cron-task-code-block cron-task-script-preview">{selectedRecord.scriptPreview || selectedRecord.lastError || '点击左侧任务后会尝试读取脚本内容。'}</pre>
                  </div>
                )}

                {selectedRecord.lastError && (
                  <div className="cron-task-detail-error">{selectedRecord.lastError}</div>
                )}
              </>
            ) : (
              <div className="cron-task-detail-empty">
                <Clock3 className="ui-icon" aria-hidden="true" />
                选择左侧任务查看详细信息。
              </div>
            )}
          </section>
        </main>
      </div>

      {editDialog && (
        <div className="modal-overlay" onClick={() => setEditDialog(null)}>
          <div className="modal-content cron-task-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{editDialog.mode === 'create' ? '添加定时任务' : '编辑定时任务'}</h2>
              <button type="button" className="btn btn-icon" onClick={() => setEditDialog(null)} aria-label="关闭">
                <X className="ui-icon" aria-hidden="true" />
              </button>
            </div>
            <div className="cron-task-form">
              <label>来源</label>
              <select
                className="card-edit-input"
                value={editDialog.source}
                disabled={editDialog.mode === 'update'}
                onChange={(event) => setEditDialog({ ...editDialog, source: event.target.value as CronTaskSource, error: null })}
              >
                <option value="userCrontab">当前用户 crontab</option>
                <option value="cronD">/etc/cron.d 文件</option>
              </select>
              {editDialog.source === 'cronD' && (
                <>
                  <label>cron.d 文件路径</label>
                  <input className="card-edit-input" value={editDialog.sourcePath} placeholder="/etc/cron.d/lazyshell-task" onChange={(event) => setEditDialog({ ...editDialog, sourcePath: event.target.value, error: null })} />
                </>
              )}
              <label>计划表达式</label>
              <input className="card-edit-input" value={editDialog.schedule} placeholder="0 2 * * *" onChange={(event) => setEditDialog({ ...editDialog, schedule: event.target.value, error: null })} />
              {editDialog.source === 'cronD' && (
                <>
                  <label>运行用户</label>
                  <input className="card-edit-input" value={editDialog.user} placeholder="root" onChange={(event) => setEditDialog({ ...editDialog, user: event.target.value, error: null })} />
                </>
              )}
              <label>命令</label>
              <textarea className="card-edit-input cron-task-command-input" value={editDialog.command} placeholder="/usr/bin/env bash /opt/scripts/job.sh" onChange={(event) => setEditDialog({ ...editDialog, command: event.target.value, error: null })} />
              {editDialog.error && <div className="error-message">{editDialog.error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setEditDialog(null)}>取消</button>
                <button type="button" className="btn btn-primary" onClick={submitEditDialog} disabled={loading}>
                  <CheckCircle2 className="ui-icon" aria-hidden="true" />
                  生成预览
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {previewDialog && (
        <div className="modal-overlay" onClick={() => setPreviewDialog(null)}>
          <div className="modal-content cron-task-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{previewDialog.preview.summary}</h2>
              <button type="button" className="btn btn-icon" onClick={() => setPreviewDialog(null)} aria-label="关闭">
                <X className="ui-icon" aria-hidden="true" />
              </button>
            </div>
            <div className="cron-task-preview-body">
              <div className="cron-task-preview-meta">
                <span>来源：{previewDialog.preview.affectedSource}</span>
                <span>{previewDialog.preview.requiresSudo ? '需要 sudo -n' : '当前用户权限'}</span>
              </div>
              {previewDialog.preview.warnings.length > 0 && (
                <div className="cron-task-warning-list">
                  {previewDialog.preview.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              )}
              <div className="cron-task-preview-grid">
                <div>
                  <div className="cron-task-section-title">变更前</div>
                  <pre className="cron-task-code-block">{previewDialog.preview.beforeText || '空'}</pre>
                </div>
                <div>
                  <div className="cron-task-section-title">变更后</div>
                  <pre className="cron-task-code-block">{previewDialog.preview.afterText || '空'}</pre>
                </div>
              </div>
              <div className="cron-task-section-title">将执行</div>
              <pre className="cron-task-code-block">{previewDialog.preview.commands.join('\n')}</pre>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setPreviewDialog(null)}>取消</button>
                <button type="button" className="btn btn-primary" onClick={() => { void applyPreview(); }} disabled={loading}>
                  <CheckCircle2 className="ui-icon" aria-hidden="true" />
                  确认执行
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
