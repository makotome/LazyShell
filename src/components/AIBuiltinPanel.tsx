import type { BuiltinCommand } from '../types';

const CATEGORY_LABELS: Record<string, string> = {
  file: '文件',
  text: '文本',
  system: '系统',
  network: '网络',
  process: '进程',
  archive: '压缩',
  disk: '磁盘',
  package: '包管理',
  other: '其他',
};

interface AIBuiltinPanelProps {
  title: string;
  groupedBuiltinCommands: Map<string, BuiltinCommand[]>;
  builtinCommandsCount: number;
  collapsedCategories: Set<string>;
  executionEditor: { title: string; command: string } | null;
  onToggleCategory: (category: string) => void;
  onExecute: (cmd: BuiltinCommand) => void;
  onCopy: (cmd: BuiltinCommand) => void;
  onEdit: (cmd: BuiltinCommand) => void;
  onSave: (cmd: BuiltinCommand) => void;
  onExecutionEditorCommandChange: (command: string) => void;
  onExecutionEditorRun: () => void;
  onExecutionEditorClose: () => void;
}

function getBuiltinSectionDescription(cmd: BuiltinCommand): string {
  const match = cmd.description.match(/^[^｜|]+[｜|]\s*(.+)$/);
  return match ? match[1].trim() : cmd.description;
}

function getBuiltinCardTitle(cmd: BuiltinCommand, isOpenclawPanel: boolean): string {
  if (!isOpenclawPanel) {
    return cmd.name;
  }

  return cmd.examples[0]?.description || getBuiltinSectionDescription(cmd);
}

export function AIBuiltinPanel({
  title,
  groupedBuiltinCommands,
  builtinCommandsCount,
  collapsedCategories,
  executionEditor,
  onToggleCategory,
  onExecute,
  onCopy,
  onEdit,
  onSave,
  onExecutionEditorCommandChange,
  onExecutionEditorRun,
  onExecutionEditorClose,
}: AIBuiltinPanelProps) {
  const isOpenclawPanel = title === 'OPENCLAW';

  return (
    <div className="commands-panel">
      <div className="panel-header">{title} ({builtinCommandsCount})</div>
      {executionEditor && (
        <div className="command-editor-bar">
          <div className="command-editor-header">
            <span className="command-editor-title">调整命令后执行</span>
            <span className="command-editor-subtitle">{executionEditor.title}</span>
          </div>
          <textarea className="command-editor-textarea" value={executionEditor.command} onChange={(e) => onExecutionEditorCommandChange(e.target.value)} rows={3} />
          <div className="card-actions">
            <button className="btn btn-primary btn-small" onClick={onExecutionEditorRun} disabled={!executionEditor.command.trim()}>
              执行调整后的命令
            </button>
            <button className="btn btn-secondary btn-small" onClick={onExecutionEditorClose}>取消</button>
          </div>
        </div>
      )}
      {builtinCommandsCount === 0 ? (
        <div className="empty-state"><div>正在加载...</div></div>
      ) : (
        <div className="commands-list">
          {Array.from(groupedBuiltinCommands.entries()).map(([category, cmds]) => (
            <div key={category} className="category-group">
              <div className="category-header" onClick={() => onToggleCategory(`builtin-${category}`)}>
                <span className="category-toggle">{collapsedCategories.has(`builtin-${category}`) ? '▶' : '▼'}</span>
                <span className="category-name">{CATEGORY_LABELS[category] || category}</span>
                <span className="category-count">{cmds.length}</span>
              </div>
              {!collapsedCategories.has(`builtin-${category}`) && (
                <div className="category-cards">
                  {cmds.map((cmd) => (
                    <div key={cmd.name} className={`builtin-command-item${isOpenclawPanel ? ' builtin-command-item-openclaw' : ''}`}>
                      <div className="builtin-cmd-header">
                        <span className="builtin-cmd-name">{getBuiltinCardTitle(cmd, isOpenclawPanel)}</span>
                        <span className="builtin-cmd-category">{cmd.surface === 'chat' ? '聊天斜杠命令' : 'CLI 命令'}</span>
                      </div>
                      <div className="builtin-cmd-desc">{isOpenclawPanel ? getBuiltinSectionDescription(cmd) : cmd.description}</div>
                      {cmd.examples[0] && (
                        <div className="builtin-cmd-example">
                          <code>{cmd.examples[0].command}</code>
                          <span className="example-desc">{cmd.examples[0].description}</span>
                        </div>
                      )}
                      <div className="card-actions">
                        {cmd.surface === 'chat' ? (
                          <button className="btn btn-primary" onClick={() => onCopy(cmd)}>复制</button>
                        ) : (
                          <>
                            <button className="btn btn-primary" onClick={() => onExecute(cmd)}>执行</button>
                            <button className="btn btn-secondary btn-small btn-chip" onClick={() => onEdit(cmd)}>调整</button>
                            <button className="btn btn-secondary btn-small btn-chip" onClick={() => onSave(cmd)}>收藏</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
