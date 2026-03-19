import { useEffect, useRef } from 'react';
import type { CommandHistory } from '../types';

interface TerminalProps {
  history: CommandHistory[];
  currentOutput?: string;
}

export function Terminal({ history, currentOutput }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const prevHistoryLengthRef = useRef(history.length);
  const prevOutputRef = useRef(currentOutput);

  useEffect(() => {
    // Only scroll if content actually changed
    const contentChanged = history.length !== prevHistoryLengthRef.current ||
                           currentOutput !== prevOutputRef.current;
    if (contentChanged && terminalRef.current) {
      terminalRef.current.scrollTo(0, terminalRef.current.scrollHeight);
      prevHistoryLengthRef.current = history.length;
      prevOutputRef.current = currentOutput;
    }
  }, [history.length, currentOutput]);

  return (
    <div className="terminal" ref={terminalRef}>
      <div className="terminal-header">
        <span className="terminal-title">终端输出</span>
      </div>
      <div className="terminal-content">
        {history.length === 0 && !currentOutput && (
          <div className="terminal-empty">
            <p>暂无命令输出</p>
            <p className="hint">在左侧AI对话框中输入命令，将在此处显示结果</p>
          </div>
        )}

        {history.map((cmd, index) => (
          <div key={index} className="terminal-command-block">
            <div className="terminal-command-line">
              <span className="prompt">$</span>
              <span className="command">{cmd.command}</span>
            </div>
            <div className={`terminal-output ${cmd.exitCode !== 0 ? 'error' : ''}`}>
              {cmd.output || '(无输出)'}
            </div>
            {cmd.exitCode !== 0 && (
              <div className="terminal-exit-code">Exit code: {cmd.exitCode}</div>
            )}
          </div>
        ))}

        {currentOutput && (
          <div className="terminal-command-block current">
            <div className="terminal-output">{currentOutput}</div>
          </div>
        )}
      </div>
    </div>
  );
}
