import type { CommandHistory } from '../types';

interface AIHistoryPanelProps {
  entries: CommandHistory[];
  historyQuery: string;
  historySourceFilter: 'all' | NonNullable<CommandHistory['source']>;
  historyDedupe: boolean;
  historyTrimCount: '50' | '100' | '300';
  isConfirmingClearHistory: boolean;
  executionEditor: { title: string; command: string } | null;
  getSourceLabel: (source?: CommandHistory['source']) => string;
  onHistoryQueryChange: (value: string) => void;
  onHistorySourceFilterChange: (value: 'all' | NonNullable<CommandHistory['source']>) => void;
  onHistoryDedupeChange: (value: boolean) => void;
  onHistoryTrimCountChange: (value: '50' | '100' | '300') => void;
  onTrimHistory: () => void;
  onClearHistoryRequest: () => void;
  onClearHistoryConfirm: () => void;
  onClearHistoryCancel: () => void;
  onExecute: (entry: CommandHistory) => void;
  onEdit: (entry: CommandHistory) => void;
  onSave: (entry: CommandHistory) => void;
  onExecutionEditorCommandChange: (command: string) => void;
  onExecutionEditorRun: () => void;
  onExecutionEditorClose: () => void;
}

export function AIHistoryPanel({
  entries,
  historyQuery,
  historySourceFilter,
  historyDedupe,
  historyTrimCount,
  isConfirmingClearHistory,
  executionEditor,
  getSourceLabel,
  onHistoryQueryChange,
  onHistorySourceFilterChange,
  onHistoryDedupeChange,
  onHistoryTrimCountChange,
  onTrimHistory,
  onClearHistoryRequest,
  onClearHistoryConfirm,
  onClearHistoryCancel,
  onExecute,
  onEdit,
  onSave,
  onExecutionEditorCommandChange,
  onExecutionEditorRun,
  onExecutionEditorClose,
}: AIHistoryPanelProps) {
  return (
    <div className="commands-panel">
      <div className="panel-header panel-header-actions">
        <span>历史命令 ({entries.length})</span>
        <div className="panel-actions">
          <select
            className="history-trim-select"
            value={historyTrimCount}
            onChange={(e) => onHistoryTrimCountChange(e.target.value as '50' | '100' | '300')}
          >
            <option value="50">最近 50 条</option>
            <option value="100">最近 100 条</option>
            <option value="300">最近 300 条</option>
          </select>
          <button className="btn btn-secondary btn-small" onClick={onTrimHistory}>裁剪历史</button>
          <button className="btn btn-danger btn-small" onClick={onClearHistoryRequest}>清空历史</button>
        </div>
      </div>
      {isConfirmingClearHistory && (
        <div className="history-confirm-bar">
          <span className="history-confirm-text">确定要清空当前服务器的所有命令历史吗？此操作不可撤销。</span>
          <div className="history-confirm-actions">
            <button className="btn btn-danger btn-small" onClick={onClearHistoryConfirm}>确认清空</button>
            <button className="btn btn-secondary btn-small" onClick={onClearHistoryCancel}>取消</button>
          </div>
        </div>
      )}
      {executionEditor && (
        <div className="command-editor-bar">
          <div className="command-editor-header">
            <span className="command-editor-title">调整命令后执行</span>
            <span className="command-editor-subtitle">{executionEditor.title}</span>
          </div>
          <textarea
            className="command-editor-textarea"
            value={executionEditor.command}
            onChange={(e) => onExecutionEditorCommandChange(e.target.value)}
            rows={3}
          />
          <div className="card-actions">
            <button className="btn btn-primary btn-small" onClick={onExecutionEditorRun} disabled={!executionEditor.command.trim()}>
              执行调整后的命令
            </button>
            <button className="btn btn-secondary btn-small" onClick={onExecutionEditorClose}>取消</button>
          </div>
        </div>
      )}
      <div className="history-toolbar">
        <input
          className="history-search"
          type="text"
          placeholder="搜索命令、输出或来源"
          value={historyQuery}
          onChange={(e) => onHistoryQueryChange(e.target.value)}
        />
        <select
          className="history-filter"
          value={historySourceFilter}
          onChange={(e) => onHistorySourceFilterChange(e.target.value as 'all' | NonNullable<CommandHistory['source']>)}
        >
          <option value="all">全部来源</option>
          <option value="ai">AI</option>
          <option value="terminal">终端</option>
          <option value="history">历史</option>
          <option value="favorite">常用</option>
          <option value="builtin">内置</option>
          <option value="direct">直连</option>
        </select>
        <label className="history-toggle">
          <input type="checkbox" checked={historyDedupe} onChange={(e) => onHistoryDedupeChange(e.target.checked)} />
          去重
        </label>
      </div>
      {entries.length === 0 ? (
        <div className="empty-state">
          <div>{historyQuery || historySourceFilter !== 'all' ? '没有匹配的历史命令' : '暂无命令历史'}</div>
          <div className="hint">执行过的命令会显示在这里，并跨会话保留</div>
        </div>
      ) : (
        <div className="commands-list">
          {entries.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="builtin-command-item">
              <div className="builtin-cmd-header">
                <span className="builtin-cmd-name">{entry.command}</span>
                <span className={`builtin-cmd-category ${entry.exitCode === 0 ? 'history-success' : 'history-error'}`}>exit {entry.exitCode}</span>
              </div>
              <div className="builtin-cmd-desc">
                {getSourceLabel(entry.source)} · {new Date(entry.timestamp).toLocaleString()}
              </div>
              {entry.output && (
                <div className="builtin-cmd-example">
                  <code>{entry.output.length > 140 ? `${entry.output.slice(0, 140)}...` : entry.output}</code>
                </div>
              )}
              <div className="card-actions">
                <button className="btn btn-primary" onClick={() => onExecute(entry)}>执行</button>
                <button className="btn btn-secondary btn-small btn-chip" onClick={() => onEdit(entry)}>调整</button>
                <button className="btn btn-secondary btn-small btn-chip" onClick={() => onSave(entry)}>收藏</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
