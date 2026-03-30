import type { AICommandOption, DangerLevel } from '../types';

export interface PendingActionOption {
  command: string;
  description: string;
  reason?: string;
  dangerLevel: DangerLevel;
  surface?: 'shell' | 'chat' | 'sql';
  isExecuted?: boolean;
  isSaved?: boolean;
}

interface AIPendingActionCardProps {
  title: string;
  summary?: string;
  command?: string;
  commandSurface?: 'shell' | 'chat' | 'sql';
  dangerLevel?: DangerLevel;
  options?: PendingActionOption[];
  onClose: () => void;
  onExecute: () => void;
  onSave: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onOptionExecute?: (option: PendingActionOption, index: number) => void;
  onOptionSave?: (option: PendingActionOption, index: number) => void;
  onOptionEdit?: (option: PendingActionOption) => void;
  saveLabel?: string;
}

const DANGER_LABELS: Record<DangerLevel, string> = {
  green: '安全',
  yellow: '注意',
  red: '危险',
};

export function mapOptionDangerLevel(option: AICommandOption): DangerLevel {
  return option.isDangerous ? 'red' : 'green';
}

export function AIPendingActionCard({
  title,
  summary,
  command,
  commandSurface = 'shell',
  dangerLevel = 'green',
  options,
  onClose,
  onExecute,
  onSave,
  onCopy,
  onEdit,
  onOptionExecute,
  onOptionSave,
  onOptionEdit,
  saveLabel = '保存到常用',
}: AIPendingActionCardProps) {
  const isMulti = !!options?.length;
  const singlePrimaryLabel = commandSurface === 'sql' ? '复制 SQL' : '执行';

  return (
    <div className={`ai-pending-card danger-${dangerLevel}`}>
      <div className="ai-pending-header">
        <div className="ai-pending-heading">
          <span className="ai-pending-kicker">待执行动作</span>
          <span className="ai-pending-title">{title}</span>
        </div>
        <div className="ai-pending-header-actions">
          {!isMulti && commandSurface === 'sql' ? (
            <span className="surface-badge surface-sql">SQL 片段</span>
          ) : null}
          <span className={`danger-badge danger-${dangerLevel}`}>
            {isMulti ? `${options?.length || 0} 个候选` : DANGER_LABELS[dangerLevel]}
          </span>
          <button type="button" className="ai-pending-close" onClick={onClose} aria-label="关闭待执行动作">
            ×
          </button>
        </div>
      </div>
      {summary ? <div className="ai-pending-summary">{summary}</div> : null}

      {!isMulti && command ? (
        <>
          <div className="ai-pending-command">
            <code>{command}</code>
          </div>
          <div className="ai-pending-actions">
            <button type="button" className={`btn ${dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`} onClick={onExecute}>
              {singlePrimaryLabel}
            </button>
            <button type="button" className="btn btn-secondary btn-small btn-chip" onClick={onEdit}>
              调整
            </button>
            <button type="button" className="btn btn-secondary btn-small btn-chip" onClick={onSave}>
              {saveLabel}
            </button>
            <button type="button" className="btn btn-secondary btn-small btn-chip" onClick={onCopy}>
              复制
            </button>
          </div>
        </>
      ) : null}

      {isMulti ? (
        <div className="ai-pending-options">
          {options?.map((option, index) => (
            <div key={`${option.command}-${index}`} className={`ai-pending-option danger-${option.dangerLevel}`}>
              <div className="ai-pending-option-header">
                {option.surface === 'sql' ? (
                  <span className="surface-badge surface-sql">SQL 片段</span>
                ) : null}
                <span className={`danger-badge danger-${option.dangerLevel}`}>
                  {option.isExecuted ? '已执行' : DANGER_LABELS[option.dangerLevel]}
                </span>
                <span className="ai-pending-option-title">{option.description}</span>
              </div>
              <div className="ai-pending-command">
                <code>{option.command}</code>
              </div>
              {option.reason ? <div className="ai-pending-option-reason">{option.reason}</div> : null}
              <div className="ai-pending-actions">
                <button
                  type="button"
                  className={`btn ${option.dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => onOptionExecute?.(option, index)}
                  disabled={option.isExecuted && option.surface !== 'sql'}
                >
                  {option.surface === 'sql' ? '复制 SQL' : option.isExecuted ? '已执行' : '执行'}
                </button>
                <button type="button" className="btn btn-secondary btn-small btn-chip" onClick={() => onOptionEdit?.(option)}>
                  调整
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small btn-chip"
                  onClick={() => onOptionSave?.(option, index)}
                  disabled={option.isSaved}
                >
                  {option.isSaved ? '已收藏' : '收藏'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
