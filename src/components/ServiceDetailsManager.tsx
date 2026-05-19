import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Cpu, FolderOpen, MemoryStick, Network, RefreshCw, Server, SquareTerminal } from 'lucide-react';
import type { PortServiceRecord, ServiceDetailsSnapshot, ServiceProcessRecord } from '../types';

interface ServiceDetailsManagerProps {
  serverId: string;
  serverName: string;
}

type ServiceTab = 'memory' | 'cpu' | 'ports';

type SelectedItem =
  | { kind: 'process'; item: ServiceProcessRecord }
  | { kind: 'port'; item: PortServiceRecord };

const TAB_LABELS: Record<ServiceTab, string> = {
  memory: '内存占用前十',
  cpu: 'CPU 占用前十',
  ports: '对外端口',
};

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleString();
}

function formatMemory(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '-';
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string | null | undefined, max = 96): string {
  if (!value) return '-';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function processTitle(record: ServiceProcessRecord): string {
  return record.commandName || record.command || `PID ${record.pid}`;
}

function portTitle(record: PortServiceRecord): string {
  return `${record.protocol.toUpperCase()} ${record.address}:${record.port}`;
}

function dockerLabel(item: { docker: ServiceProcessRecord['docker'] }): string | null {
  if (!item.docker) return null;
  return [item.docker.name, item.docker.image].filter(Boolean).join(' · ') || item.docker.id.slice(0, 12);
}

export function ServiceDetailsManager({ serverId, serverName }: ServiceDetailsManagerProps) {
  const [snapshot, setSnapshot] = useState<ServiceDetailsSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<ServiceTab>('memory');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    if (activeTab === 'memory') {
      return snapshot.memoryTop.map((item) => ({ key: `process-${item.pid}-mem`, kind: 'process' as const, item }));
    }
    if (activeTab === 'cpu') {
      return snapshot.cpuTop.map((item) => ({ key: `process-${item.pid}-cpu`, kind: 'process' as const, item }));
    }
    return snapshot.ports.map((item) => ({ key: `port-${item.id}`, kind: 'port' as const, item }));
  }, [activeTab, snapshot]);

  const selectedItem: SelectedItem | null = useMemo(() => {
    const matched = rows.find((row) => row.key === selectedKey) || rows[0];
    if (!matched) return null;
    return matched.kind === 'process'
      ? { kind: 'process', item: matched.item }
      : { kind: 'port', item: matched.item };
  }, [rows, selectedKey]);
  const effectiveSelectedKey = selectedKey || rows[0]?.key || null;

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    try {
      const result = await invoke<ServiceDetailsSnapshot>('get_service_details', { serverId });
      setSnapshot(result);
      setLastError(result.lastError);
      setSelectedKey(null);
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  return (
    <div className="window-shell service-details-window-shell">
      <div className="service-details-manager">
        <header className="service-details-toolbar">
          <div className="service-details-title">
            <span className="service-details-title-icon">
              <Activity className="ui-icon" aria-hidden="true" />
            </span>
            <div>
              <div className="service-details-title-main">服务详情</div>
              <div className="service-details-title-sub">
                <Server className="ui-icon" aria-hidden="true" />
                {serverName}
              </div>
            </div>
          </div>
          <div className="service-details-toolbar-meta">扫描：{formatTimestamp(snapshot?.scannedAt || null)}</div>
          <button type="button" className="btn btn-primary btn-small" onClick={() => { void loadDetails(); }} disabled={loading}>
            <RefreshCw className="ui-icon" aria-hidden="true" />
            {loading ? '扫描中...' : '刷新'}
          </button>
        </header>

        {(lastError || loading) && (
          <div className={lastError ? 'error-message service-details-banner' : 'success-message service-details-banner'}>
            <span>{lastError || '正在读取远端进程和端口信息...'}</span>
          </div>
        )}

        <main className="service-details-shell">
          <aside className="service-details-list-panel">
            <div className="service-details-tabs">
              <button type="button" className={activeTab === 'memory' ? 'active' : ''} onClick={() => setActiveTab('memory')}>
                <MemoryStick className="ui-icon" aria-hidden="true" />
                内存
              </button>
              <button type="button" className={activeTab === 'cpu' ? 'active' : ''} onClick={() => setActiveTab('cpu')}>
                <Cpu className="ui-icon" aria-hidden="true" />
                CPU
              </button>
              <button type="button" className={activeTab === 'ports' ? 'active' : ''} onClick={() => setActiveTab('ports')}>
                <Network className="ui-icon" aria-hidden="true" />
                端口
              </button>
            </div>
            <div className="service-details-panel-header">
              <span>{TAB_LABELS[activeTab]}</span>
              <span>{rows.length} 项</span>
            </div>
            <div className={`service-details-list ${loading ? 'is-pending' : ''}`}>
              {rows.length === 0 && !loading && (
                <div className="service-details-empty">
                  <Activity className="ui-icon" aria-hidden="true" />
                  <div>没有读取到相关服务信息。</div>
                </div>
              )}
              {rows.map((row) => {
                const isSelected = row.key === effectiveSelectedKey;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`service-details-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedKey(row.key)}
                  >
                    {row.kind === 'process' ? (
                      <>
                        <span className="service-details-row-icon"><SquareTerminal className="ui-icon" aria-hidden="true" /></span>
                        <span className="service-details-row-main">
                          <span className="service-details-row-title">{processTitle(row.item)}</span>
                          <span className="service-details-row-sub">PID {row.item.pid} · {row.item.user} · {formatMemory(row.item.rssKb)}</span>
                          <span className="service-details-row-command">{truncate(row.item.command)}</span>
                        </span>
                        <span className="service-details-row-metric">
                          {activeTab === 'memory' ? `${row.item.memoryPercent.toFixed(1)}%` : `${row.item.cpuPercent.toFixed(1)}%`}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="service-details-row-icon"><Network className="ui-icon" aria-hidden="true" /></span>
                        <span className="service-details-row-main">
                          <span className="service-details-row-title">{portTitle(row.item)}</span>
                          <span className="service-details-row-sub">PID {row.item.pid || '-'} · {row.item.program || '未知程序'}</span>
                          <span className="service-details-row-command">{truncate(row.item.command || row.item.rawLine)}</span>
                        </span>
                        <span className="service-details-row-metric">{row.item.port}</span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="service-details-detail-panel">
            {selectedItem ? (
              selectedItem.kind === 'process' ? (
                <ProcessDetail record={selectedItem.item} metricMode={activeTab === 'cpu' ? 'cpu' : 'memory'} />
              ) : (
                <PortDetail record={selectedItem.item} />
              )
            ) : (
              <div className="service-details-detail-empty">
                <Activity className="ui-icon" aria-hidden="true" />
                <div>选择左侧条目查看运行程序、目录和容器详情。</div>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function ProcessDetail({ record, metricMode }: { record: ServiceProcessRecord; metricMode: 'memory' | 'cpu' }) {
  return (
    <>
      <div className="service-details-detail-header">
        <div>
          <div className="service-details-detail-title">{processTitle(record)}</div>
          <div className="service-details-detail-path">PID {record.pid} · PPID {record.ppid} · {record.user}</div>
        </div>
        <span className="service-details-status-pill">{metricMode === 'cpu' ? `CPU ${record.cpuPercent.toFixed(1)}%` : `内存 ${record.memoryPercent.toFixed(1)}%`}</span>
      </div>
      <DetailGrid
        items={[
          ['CPU', `${record.cpuPercent.toFixed(1)}%`],
          ['内存', `${record.memoryPercent.toFixed(1)}% · ${formatMemory(record.rssKb)}`],
          ['运行用户', record.user],
          ['进程名', record.commandName || '-'],
          ['工作目录', record.workingDirectory || '-'],
          ['可执行文件', record.executable || '-'],
        ]}
      />
      <CodeSection title="运行命令" value={record.command} />
      <DockerSection docker={record.docker} />
      {record.lastError && <div className="service-details-detail-error">{record.lastError}</div>}
    </>
  );
}

function PortDetail({ record }: { record: PortServiceRecord }) {
  return (
    <>
      <div className="service-details-detail-header">
        <div>
          <div className="service-details-detail-title">{portTitle(record)}</div>
          <div className="service-details-detail-path">{record.program || '未知程序'} · PID {record.pid || '-'}</div>
        </div>
        <span className="service-details-status-pill">{record.protocol.toUpperCase()}</span>
      </div>
      <DetailGrid
        items={[
          ['监听地址', record.address],
          ['端口', String(record.port)],
          ['PID', record.pid ? String(record.pid) : '-'],
          ['运行用户', record.user || '-'],
          ['程序', record.program || '-'],
          ['工作目录', record.workingDirectory || '-'],
          ['可执行文件', record.executable || '-'],
        ]}
      />
      <CodeSection title="运行命令 / 脚本" value={record.command || '未读取到命令内容'} />
      <CodeSection title="原始监听行" value={record.rawLine} />
      <DockerSection docker={record.docker} />
    </>
  );
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="service-details-detail-grid">
      {items.map(([label, value]) => (
        <div className="service-details-field" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CodeSection({ title, value }: { title: string; value: string }) {
  return (
    <div className="service-details-section">
      <div className="service-details-section-title">
        <FolderOpen className="ui-icon" aria-hidden="true" />
        {title}
      </div>
      <pre className="service-details-code-block">{value}</pre>
    </div>
  );
}

function DockerSection({ docker }: { docker: ServiceProcessRecord['docker'] }) {
  if (!docker) return null;
  return (
    <div className="service-details-section">
      <div className="service-details-section-title">Docker 容器</div>
      <div className="service-details-docker-card">
        <strong>{dockerLabel({ docker })}</strong>
        <span>ID：{docker.id}</span>
        <span>状态：{docker.status || '未知'}</span>
      </div>
    </div>
  );
}
