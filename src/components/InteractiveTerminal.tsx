import { useState, useEffect, useRef, useCallback } from 'react';
import type { CommandHistory, ServerTab, ServerBanner } from '../types';

interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
}

interface InteractiveTerminalProps {
  history: CommandHistory[];
  currentOutput?: string;
  serverTab?: ServerTab;
  serverUsername?: string;
  serverHostname?: string;
  commandToFill?: string;
  welcomeBanner?: ServerBanner;
  onCommandSubmit: (command: string) => void;
  onCommandFill?: (command: string) => void;
  onCommandComplete?: (partial: string) => Promise<string[]>;
}

export function InteractiveTerminal({
  history,
  currentOutput,
  serverTab,
  serverUsername,
  serverHostname,
  commandToFill,
  welcomeBanner,
  onCommandSubmit,
  onCommandFill,
  onCommandComplete,
}: InteractiveTerminalProps) {
  const [inputBuffer, setInputBuffer] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isAwaitingInput, setIsAwaitingInput] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false });

  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevHistoryLengthRef = useRef(history.length);
  const prevOutputRef = useRef(currentOutput);

  // Build prompt string in standard format: username@hostname:path$
  // Use serverUsername/serverHostname if provided, otherwise extract from serverName
  const getPromptDisplay = () => {
    if (!serverTab) return '$';

    // Extract username from serverTab.serverName or use provided serverUsername
    // serverTab.serverName could be like "ubuntu@VM-0-17-ubuntu" or just "VM-0-17-ubuntu"
    let username = serverUsername || 'ubuntu';
    let hostname = serverHostname || serverTab.serverName;

    // If serverName contains @, split it
    if (serverTab.serverName.includes('@')) {
      const parts = serverTab.serverName.split('@');
      username = parts[0] || username;
      hostname = parts[1] || hostname;
    }

    // Check if running as root (username is root)
    const isRoot = username.toLowerCase() === 'root';
    const promptChar = isRoot ? '#' : '$';

    // Format path - replace /home/user with ~
    let path = serverTab.currentDir;
    if (path.startsWith(`/home/${username}`)) {
      path = path.replace(`/home/${username}`, '~');
    } else if (path === `/home/${username}`) {
      path = '~';
    }

    return `${username}@${hostname}:${path}${promptChar}`;
  };

  const promptDisplay = getPromptDisplay();

  // Auto-scroll on new content
  useEffect(() => {
    const contentChanged = history.length !== prevHistoryLengthRef.current ||
                           currentOutput !== prevOutputRef.current;
    if (contentChanged && terminalRef.current) {
      terminalRef.current.scrollTo(0, terminalRef.current.scrollHeight);
      prevHistoryLengthRef.current = history.length;
      prevOutputRef.current = currentOutput;
    }
  }, [history.length, currentOutput]);

  // Focus input on click
  useEffect(() => {
    const handleClick = () => {
      inputRef.current?.focus();
    };
    terminalRef.current?.addEventListener('click', handleClick);
    return () => terminalRef.current?.removeEventListener('click', handleClick);
  }, []);

  // Handle command to fill from AI
  useEffect(() => {
    if (commandToFill) {
      setInputBuffer(commandToFill);
      setCursorPosition(commandToFill.length);
      inputRef.current?.focus();
      // Clear commandToFill by calling the callback if provided
      onCommandFill?.('');
    }
  }, [commandToFill, onCommandFill]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const { key } = e;

    // Enter: submit command
    if (key === 'Enter') {
      e.preventDefault();
      const command = inputBuffer.trim();
      if (command) {
        setCommandHistory(prev => [...prev, command]);
        setHistoryIndex(-1);
        onCommandSubmit(command);
      }
      setInputBuffer('');
      setCursorPosition(0);
      return;
    }

    // Arrow Left: move cursor left
    if (key === 'ArrowLeft') {
      e.preventDefault();
      setCursorPosition(prev => Math.max(0, prev - 1));
      return;
    }

    // Arrow Right: move cursor right
    if (key === 'ArrowRight') {
      e.preventDefault();
      setCursorPosition(prev => Math.min(inputBuffer.length, prev + 1));
      return;
    }

    // Arrow Up: navigate history up
    if (key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      const newIndex = historyIndex === -1
        ? commandHistory.length - 1
        : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      const historicalCommand = commandHistory[newIndex];
      setInputBuffer(historicalCommand);
      setCursorPosition(historicalCommand.length);
      return;
    }

    // Arrow Down: navigate history down
    if (key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= commandHistory.length) {
        setHistoryIndex(-1);
        setInputBuffer('');
        setCursorPosition(0);
      } else {
        setHistoryIndex(newIndex);
        const historicalCommand = commandHistory[newIndex];
        setInputBuffer(historicalCommand);
        setCursorPosition(historicalCommand.length);
      }
      return;
    }

    // Tab: command completion
    if (key === 'Tab') {
      e.preventDefault();
      if (onCommandComplete && inputBuffer.length > 0) {
        onCommandComplete(inputBuffer).then(suggestions => {
          if (suggestions.length === 1) {
            setInputBuffer(suggestions[0]);
            setCursorPosition(suggestions[0].length);
          } else if (suggestions.length > 1) {
            // Could show suggestion list - for now just keep partial
            const partial = inputBuffer + ' ';
            const commonPrefix = suggestions.reduce((prefix, s) => {
              while (!s.startsWith(prefix)) {
                prefix = prefix.slice(0, -1);
              }
              return prefix;
            }, suggestions[0]);
            if (commonPrefix.length > inputBuffer.length) {
              setInputBuffer(commonPrefix);
              setCursorPosition(commonPrefix.length);
            }
          }
        });
      }
      return;
    }

    // Ctrl+C: cancel current input
    if (key === 'c' && e.ctrlKey) {
      e.preventDefault();
      setInputBuffer('');
      setCursorPosition(0);
      setHistoryIndex(-1);
      return;
    }

    // Ctrl+V: paste
    if (key === 'v' && e.ctrlKey) {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        const newBuffer = inputBuffer.slice(0, cursorPosition) + text + inputBuffer.slice(cursorPosition);
        setInputBuffer(newBuffer);
        setCursorPosition(cursorPosition + text.length);
      });
      return;
    }

    // Ctrl+Shift+C: copy selected text
    if (key === 'C' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      const selection = window.getSelection()?.toString() || '';
      if (selection) {
        navigator.clipboard.writeText(selection);
      }
      return;
    }

    // Ctrl+Shift+V: paste at cursor position
    if (key === 'V' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        const newBuffer = inputBuffer.slice(0, cursorPosition) + text + inputBuffer.slice(cursorPosition);
        setInputBuffer(newBuffer);
        setCursorPosition(cursorPosition + text.length);
      });
      return;
    }

    // Backspace: delete character before cursor
    if (key === 'Backspace') {
      e.preventDefault();
      if (cursorPosition > 0) {
        const newBuffer = inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
        setInputBuffer(newBuffer);
        setCursorPosition(prev => prev - 1);
      }
      return;
    }

    // Delete: delete character after cursor
    if (key === 'Delete') {
      e.preventDefault();
      if (cursorPosition < inputBuffer.length) {
        const newBuffer = inputBuffer.slice(0, cursorPosition) + inputBuffer.slice(cursorPosition + 1);
        setInputBuffer(newBuffer);
      }
      return;
    }

    // Home: move to beginning
    if (key === 'Home') {
      e.preventDefault();
      setCursorPosition(0);
      return;
    }

    // End: move to end
    if (key === 'End') {
      e.preventDefault();
      setCursorPosition(inputBuffer.length);
      return;
    }
  }, [inputBuffer, cursorPosition, historyIndex, commandHistory, onCommandSubmit, onCommandComplete]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputBuffer(newValue);
    // If change came from direct typing (not programmatic), reset cursor to end
    setCursorPosition(newValue.length);
  }, []);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  }, []);

  const handleCopySelection = useCallback(async () => {
    const selection = window.getSelection()?.toString() || '';
    if (selection) {
      await navigator.clipboard.writeText(selection);
    }
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const handlePasteSelection = useCallback(async () => {
    const text = await navigator.clipboard.readText();
    const newBuffer = inputBuffer.slice(0, cursorPosition) + text + inputBuffer.slice(cursorPosition);
    setInputBuffer(newBuffer);
    setCursorPosition(cursorPosition + text.length);
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, [inputBuffer, cursorPosition]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.visible) {
        closeContextMenu();
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu.visible, closeContextMenu]);

  // Expose method to fill command from AI
  useEffect(() => {
    if (onCommandFill) {
      (window as unknown as { __fillCommand?: (cmd: string) => void }).__fillCommand = (cmd: string) => {
        setInputBuffer(cmd);
        setCursorPosition(cmd.length);
      };
    }
  }, [onCommandFill]);

  // Parse prompt for styled rendering
  // Format: username@hostname:path# or username@hostname:path$
  const parsePrompt = () => {
    const match = promptDisplay.match(/^(.+?)@(.+?):(.+?)([#\$])$/);
    if (match) {
      return {
        username: match[1],
        hostname: match[2],
        path: match[3],
        suffix: match[4],
      };
    }
    return null;
  };

  const renderPrompt = () => {
    const parsed = parsePrompt();
    if (parsed) {
      return (
        <>
          <span className="prompt-username">{parsed.username}</span>
          <span className="prompt-at">@</span>
          <span className="prompt-host">{parsed.hostname}</span>
          <span className="prompt-colon">:</span>
          <span className="prompt-path">{parsed.path}</span>
          <span className={`prompt-suffix ${parsed.suffix === '#' ? 'root' : ''}`}>{parsed.suffix} </span>
        </>
      );
    }
    return <span className="prompt-default">{promptDisplay} </span>;
  };

  return (
    <div className="terminal interactive-terminal" ref={terminalRef}>
      <div className="terminal-header">
        <span className="terminal-title">终端</span>
      </div>
      <div className="terminal-content" onClick={() => inputRef.current?.focus()} onContextMenu={handleContextMenu}>
        {welcomeBanner && (
          <div className="terminal-welcome-banner">
            <pre className="banner-os-info">{welcomeBanner.os_info}</pre>
            <pre className="banner-distro">{welcomeBanner.distro_info}</pre>
            <div className="banner-system-info">
              <div className="banner-timestamp">System information as of {welcomeBanner.timestamp}</div>
              <pre className="banner-uptime">{welcomeBanner.uptime_info}</pre>
              <pre className="banner-memory">{welcomeBanner.memory_usage}</pre>
              <pre className="banner-disk">{welcomeBanner.disk_usage}</pre>
            </div>
            {welcomeBanner.last_login && (
              <div className="banner-last-login">Last login: {welcomeBanner.last_login}</div>
            )}
          </div>
        )}

        {history.length === 0 && !currentOutput && !welcomeBanner && (
          <div className="terminal-welcome">
            <p>Welcome to LazyShell</p>
            <p className="hint">输入命令开始操作服务器</p>
          </div>
        )}

        {history.map((cmd, index) => (
          <div key={index} className="terminal-command-block">
            <div className="terminal-command-line">
              {renderPrompt()}
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

        {/* Interactive input line */}
        <div className="terminal-input-line">
          <span className="prompt-display">
            {renderPrompt()}
          </span>
          <span className="input-wrapper">
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={inputBuffer}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <span className="cursor-marker" style={{ left: `${cursorPosition * 0.6}em` }} />
            <span className="input-display" aria-hidden="true">
              <span className="input-before">{inputBuffer.slice(0, cursorPosition)}</span>
              <span className="cursor" />
              <span className="input-after">{inputBuffer.slice(cursorPosition)}</span>
            </span>
          </span>
        </div>

        {/* Context Menu */}
        {contextMenu.visible && (
          <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
            <button onClick={handleCopySelection}>复制 (Copy)</button>
            <button onClick={handlePasteSelection}>粘贴 (Paste)</button>
          </div>
        )}
      </div>
    </div>
  );
}