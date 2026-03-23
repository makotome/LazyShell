import type { CommandCard as CommandCardType, DangerLevel } from '../types';

interface CommandCardProps {
  card: CommandCardType;
  onExecute?: (command: string) => void;
  onAddTo常用?: (card: CommandCardType) => void;
  onDelete?: (cardId: string) => void;
}

const dangerColors: Record<DangerLevel, string> = {
  green: '#0dbc79',
  yellow: '#e5e510',
  red: '#cd3131',
};

const dangerLabels: Record<DangerLevel, string> = {
  green: '安全',
  yellow: '谨慎',
  red: '危险',
};

const categoryIcons: Record<string, string> = {
  file: '📁',
  text: '📝',
  system: '⚙️',
  network: '🌐',
  process: '📊',
  archive: '📦',
  disk: '💾',
  package: '📦',
  other: '📋',
};

export function CommandCard({ card, onExecute, onAddTo常用, onDelete }: CommandCardProps) {
  const dangerLevel = card.dangerLevel as DangerLevel;
  const color = dangerColors[dangerLevel] || dangerColors.yellow;
  const label = dangerLabels[dangerLevel] || '谨慎';
  const icon = categoryIcons[card.category] || categoryIcons.other;

  return (
    <div className="command-card" style={{ borderLeftColor: color }}>
      <div className="command-card-header">
        <span className="command-card-icon">{icon}</span>
        <span className="command-card-category">{label}</span>
        <span className="command-card-description">{card.naturalLanguage}</span>
      </div>

      <div className="command-card-body">
        <code className="command-card-command">{card.command}</code>
        {card.description && (
          <p className="command-card-explanation">{card.description}</p>
        )}
      </div>

      <div className="command-card-actions">
        {onAddTo常用 && (
          <button
            className="btn btn-secondary"
            onClick={() => onAddTo常用(card)}
            title="添加到常用"
          >
            ⭐ 添加
          </button>
        )}
        {onExecute && (
          <button
            className={`btn ${dangerLevel === 'red' ? 'btn-danger' : dangerLevel === 'yellow' ? 'btn-warning' : 'btn-primary'}`}
            onClick={() => onExecute(card.command)}
          >
            ▶ 执行
          </button>
        )}
        {onDelete && (
          <button
            className="btn btn-danger"
            onClick={() => onDelete(card.id)}
            title="删除"
          >
            🗑️
          </button>
        )}
      </div>

      <div className="command-card-footer">
        <span className="command-card-stats">
          使用 {card.usageCount} 次
        </span>
      </div>
    </div>
  );
}
