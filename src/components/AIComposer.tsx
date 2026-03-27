import type { KeyboardEvent } from 'react';
import { AIIntentTabs, type AIInputMode } from './AIIntentTabs';

interface AIComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled: boolean;
  clarificationMode: boolean;
  inputMode: AIInputMode;
  onInputModeChange: (mode: AIInputMode) => void;
}

export function AIComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  clarificationMode,
  inputMode,
  onInputModeChange,
}: AIComposerProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="ai-composer">
      <div className="ai-composer-shell">
        <div className="ai-composer-header">
          <div className="ai-composer-header-main">
            <AIIntentTabs value={inputMode} onChange={onInputModeChange} />
            {clarificationMode ? (
              <span className="ai-composer-clarification">补充上下文</span>
            ) : null}
          </div>
        </div>
        <textarea
          className="ai-composer-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={4}
          disabled={disabled}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary ai-composer-submit"
        onClick={onSubmit}
        disabled={disabled || !value.trim()}
      >
        发送
      </button>
    </div>
  );
}
