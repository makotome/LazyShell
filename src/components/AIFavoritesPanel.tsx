import type { CommandCard, CommandCategory } from '../types';

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  file: '文件', text: '文本', system: '系统', network: '网络',
  process: '进程', archive: '压缩', disk: '磁盘', package: '包管理', other: '其他',
};

interface AIFavoritesPanelProps {
  groupedCards: Map<CommandCategory, CommandCard[]>;
  collapsedCategories: Set<string>;
  editingCardId: string | null;
  editingCardDraft: Pick<CommandCard, 'naturalLanguage' | 'command' | 'description'> | null;
  executionEditor: { title: string; command: string } | null;
  onToggleCategory: (category: string) => void;
  onExecute: (card: CommandCard) => void;
  onEditStart: (card: CommandCard) => void;
  onEditCancel: () => void;
  onEditDraftChange: (field: 'naturalLanguage' | 'command' | 'description', value: string) => void;
  onSave: (card: CommandCard, executeAfterSave: boolean) => void;
  onRemove: (id: string) => void;
  onExecutionEditorCommandChange: (command: string) => void;
  onExecutionEditorRun: () => void;
  onExecutionEditorClose: () => void;
}

export function AIFavoritesPanel({
  groupedCards,
  collapsedCategories,
  editingCardId,
  editingCardDraft,
  executionEditor,
  onToggleCategory,
  onExecute,
  onEditStart,
  onEditCancel,
  onEditDraftChange,
  onSave,
  onRemove,
  onExecutionEditorCommandChange,
  onExecutionEditorRun,
  onExecutionEditorClose,
}: AIFavoritesPanelProps) {
  return (
    <div className="commands-panel">
      <div className="panel-header">常用命令</div>
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
      {groupedCards.size === 0 ? (
        <div className="empty-state">
          <div>暂无常用命令</div>
          <div className="hint">把执行单、历史或内置命令收藏到这里</div>
        </div>
      ) : (
        <div className="commands-list">
          {Array.from(groupedCards.entries()).map(([category, cards]) => (
            <div key={category} className="category-group">
              <div className="category-header" onClick={() => onToggleCategory(category)}>
                <span className="category-toggle">{collapsedCategories.has(category) ? '▶' : '▼'}</span>
                <span className="category-name">{CATEGORY_LABELS[category] || category}</span>
                <span className="category-count">{cards.length}</span>
              </div>
              {!collapsedCategories.has(category) && (
                <div className="category-cards">
                  {cards.map((card) => (
                    <div key={card.id} className={`command-card-item danger-${card.dangerLevel}`}>
                      <div className="card-header">
                        <span className={`danger-badge danger-${card.dangerLevel}`}>
                          {card.dangerLevel === 'red' ? '危险' : card.dangerLevel === 'yellow' ? '注意' : '安全'}
                        </span>
                        <span className="card-usage">使用 {card.usageCount} 次</span>
                      </div>
                      {editingCardId === card.id && editingCardDraft ? (
                        <>
                          <div className="card-edit-form">
                            <input className="card-edit-input" type="text" value={editingCardDraft.naturalLanguage} onChange={(e) => onEditDraftChange('naturalLanguage', e.target.value)} placeholder="卡片标题" />
                            <textarea className="card-edit-textarea card-edit-command" value={editingCardDraft.command} onChange={(e) => onEditDraftChange('command', e.target.value)} placeholder="命令" rows={3} />
                            <textarea className="card-edit-textarea" value={editingCardDraft.description} onChange={(e) => onEditDraftChange('description', e.target.value)} placeholder="说明" rows={2} />
                          </div>
                          <div className="card-actions">
                            <button className={`btn ${card.dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`} onClick={() => onSave(card, true)} disabled={!editingCardDraft.command.trim()}>
                              保存并执行
                            </button>
                            <button className="btn btn-secondary" onClick={() => onSave(card, false)} disabled={!editingCardDraft.command.trim()}>
                              保存
                            </button>
                            <button className="btn btn-secondary" onClick={onEditCancel}>取消</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="card-description" onDoubleClick={() => onEditStart(card)}>{card.description}</div>
                          <div className="card-command" onDoubleClick={() => onEditStart(card)}>
                            <code>{card.command}</code>
                          </div>
                          <div className="card-actions">
                            <button className={`btn ${card.dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`} onClick={() => onExecute(card)}>执行</button>
                            <button className="btn btn-secondary btn-small btn-chip" onClick={() => onEditStart(card)}>编辑</button>
                            <button className="btn btn-secondary btn-small btn-chip" onClick={() => onRemove(card.id)}>删除</button>
                          </div>
                        </>
                      )}
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
