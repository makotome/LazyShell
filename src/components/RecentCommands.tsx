import { useMemo, useState } from 'react';
import type { CommandHistory, ServerTab } from '../types';

interface RecentCommandsProps {
  serverTab?: ServerTab;
  history: CommandHistory[];
  onRunCommand: (command: string) => void;
}

export function RecentCommands({ serverTab, history, onRunCommand }: RecentCommandsProps) {
  const [query, setQuery] = useState('');
  const [dedupe, setDedupe] = useState(true);

  const getSourceLabel = (source?: CommandHistory['source']) => {
    switch (source) {
      case 'ai': return 'AI';
      case 'history': return '历史';
      case 'favorite': return '常用';
      case 'builtin': return '内置';
      case 'direct': return '直连';
      case 'terminal': return '终端';
      default: return '未知';
    }
  };

  const recentHistory = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const base = history.slice().reverse();
    const filtered = normalizedQuery
      ? base.filter(entry =>
          entry.command.toLowerCase().includes(normalizedQuery) ||
          entry.output.toLowerCase().includes(normalizedQuery) ||
          getSourceLabel(entry.source).toLowerCase().includes(normalizedQuery)
        )
      : base;

    const deduped = dedupe
      ? filtered.filter((entry, index, arr) =>
          arr.findIndex(candidate => candidate.command.trim() === entry.command.trim()) === index
        )
      : filtered;

    return deduped.slice(0, 8);
  }, [history, query, dedupe]);

  if (!serverTab) {
    return (
      <div className="recent-commands">
        <div className="recent-commands-header">
          <span className="recent-commands-title">最近命令</span>
        </div>
        <div className="recent-commands-empty">选择服务器后显示最近命令</div>
      </div>
    );
  }

  return (
    <div className="recent-commands">
      <div className="recent-commands-header">
        <span className="recent-commands-title">最近命令</span>
        <span className="recent-commands-meta">{serverTab.serverName}</span>
      </div>
      <div className="recent-commands-toolbar">
        <input
          className="recent-commands-search"
          type="text"
          placeholder="搜索命令或输出"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="recent-commands-toggle">
          <input
            type="checkbox"
            checked={dedupe}
            onChange={(e) => setDedupe(e.target.checked)}
          />
          去重
        </label>
      </div>

      {recentHistory.length === 0 ? (
        <div className="recent-commands-empty">
          {query ? '没有匹配的历史命令' : '暂无命令历史'}
        </div>
      ) : (
        <div className="recent-commands-list">
          {recentHistory.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="recent-command-item">
              <div className="recent-command-main">
                <code className="recent-command-text">{entry.command}</code>
                <button
                  className="btn btn-small recent-command-run"
                  onClick={() => onRunCommand(entry.command)}
                  title="重新执行"
                >
                  重跑
                </button>
              </div>
              <div className="recent-command-meta-row">
                <span className="recent-command-source">
                  {getSourceLabel(entry.source)}
                </span>
                <span className={`recent-command-exit ${entry.exitCode === 0 ? 'success' : 'error'}`}>
                  exit {entry.exitCode}
                </span>
                <span className="recent-command-time">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
              </div>
              {entry.output && (
                <pre className="recent-command-output">
                  {entry.output.length > 120 ? `${entry.output.slice(0, 120)}...` : entry.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
