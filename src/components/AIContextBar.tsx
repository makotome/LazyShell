interface AIContextBarProps {
  serverName: string;
  currentDir: string;
  providerName: string;
  modelName: string;
  modeLabel: string;
}

export function AIContextBar({
  serverName,
  currentDir,
  providerName,
  modelName,
  modeLabel,
}: AIContextBarProps) {
  return (
    <div className="ai-context-bar">
      <div className="ai-context-primary">
        <span className="ai-context-server">{serverName}</span>
      </div>
      <div className="ai-context-meta">
        <span className="ai-context-chip">{modeLabel}</span>
        <span className="ai-context-chip ai-context-chip-mono">{currentDir || '/'}</span>
        <span className="ai-context-chip">{providerName}</span>
        <span className="ai-context-chip ai-context-chip-muted">{modelName}</span>
      </div>
    </div>
  );
}
