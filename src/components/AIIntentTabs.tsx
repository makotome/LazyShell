export type AIInputMode = 'execute' | 'diagnose' | 'explain' | 'script' | 'answer';

interface AIIntentTabsProps {
  value: AIInputMode;
  onChange: (mode: AIInputMode) => void;
}

const MODE_OPTIONS: Array<{ value: AIInputMode; label: string }> = [
  { value: 'execute', label: '执行' },
  { value: 'diagnose', label: '排查' },
  { value: 'explain', label: '解释' },
  { value: 'script', label: '脚本' },
  { value: 'answer', label: '只回答' },
];

export function AIIntentTabs({ value, onChange }: AIIntentTabsProps) {
  return (
    <label className="ai-intent-select-wrap">
      <span className="ai-intent-select-label">模式</span>
      <select
        className="ai-intent-select"
        value={value}
        onChange={(event) => onChange(event.target.value as AIInputMode)}
        aria-label="AI 输入模式"
      >
        {MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
