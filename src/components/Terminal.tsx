import { useEffect, useRef, useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
  serverId: string;
  isActive: boolean;
  onCommandObserved?: (command: string) => void;
}

export function Terminal({ tabId, serverId, isActive, onCommandObserved }: TerminalProps) {
  const BACKGROUND_RECONNECT_THRESHOLD_MS = 60_000;
  const ACTIVE_IDLE_RECONNECT_THRESHOLD_MS = 5 * 60_000;
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalSizeRef = useRef({ rows: 24, cols: 80 });
  const recoveringSessionRef = useRef(false);
  const commandBufferRef = useRef('');
  const isActiveRef = useRef(isActive);
  const inactiveSinceRef = useRef<number | null>(null);
  const lastInactiveDurationRef = useRef(0);
  const previousIsActiveRef = useRef(isActive);
  const pendingOutputRef = useRef('');
  const flushScheduledRef = useRef(false);
  const lastActivityAtRef = useRef(Date.now());
  const reconnectPromptRef = useRef<null | {
    reason: 'background_timeout' | 'idle_timeout' | 'connection_error';
    message: string;
  }>(null);
  const [reconnectPrompt, setReconnectPrompt] = useState<null | {
    reason: 'background_timeout' | 'idle_timeout' | 'connection_error';
    message: string;
  }>(null);

  useEffect(() => {
    isActiveRef.current = isActive;
    const wasActive = previousIsActiveRef.current;

    if (!isActive && wasActive) {
      inactiveSinceRef.current = Date.now();
    }

    if (isActive && !wasActive) {
      lastInactiveDurationRef.current = inactiveSinceRef.current
        ? Date.now() - inactiveSinceRef.current
        : 0;
      inactiveSinceRef.current = null;
    }

    previousIsActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    reconnectPromptRef.current = reconnectPrompt;
  }, [reconnectPrompt]);

  const isRecoverableShellError = useCallback((err: unknown) => {
    const message = String(err);
    return (
      message.includes('Not connected') ||
      message.includes('Failure while draining incoming flow') ||
      message.includes('Broken pipe') ||
      message.includes('Socket disconnected') ||
      message.includes('transport') ||
      message.includes('channel closed')
    );
  }, []);

  const ensureSession = useCallback(async () => {
    if (recoveringSessionRef.current) {
      return false;
    }

    recoveringSessionRef.current = true;
    const { rows, cols } = terminalSizeRef.current;

    try {
      await invoke('close_shell_session', { tabId }).catch(() => {});
      await invoke('create_shell_session', {
        serverId,
        tabId,
        rows,
        cols,
      });
      lastActivityAtRef.current = Date.now();
      return true;
    } catch (err) {
      console.error('Failed to recreate shell session:', err);
      return false;
    } finally {
      recoveringSessionRef.current = false;
    }
  }, [serverId, tabId]);

  const sendInput = useCallback((data: string) => {
    if (reconnectPrompt) {
      return;
    }

    const idleDuration = Date.now() - lastActivityAtRef.current;
    if (idleDuration > ACTIVE_IDLE_RECONNECT_THRESHOLD_MS) {
      setReconnectPrompt({
        reason: 'idle_timeout',
        message: '终端长时间空闲后可能已失效，请先手动重连。',
      });
      return;
    }

    invoke('shell_input', { tabId, data }).catch(async (err) => {
      if (isRecoverableShellError(err)) {
        setReconnectPrompt({
          reason: 'connection_error',
          message: '终端连接已失效，请手动重连后继续操作。',
        });
        return;
      }
      console.error(err);
    });
  }, [ACTIVE_IDLE_RECONNECT_THRESHOLD_MS, isRecoverableShellError, reconnectPrompt, tabId]);

  const focusTerminal = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const handleReconnect = useCallback(async () => {
    xtermRef.current?.clear();
    xtermRef.current?.reset();
    const recovered = await ensureSession();
    if (!recovered) {
      setReconnectPrompt({
        reason: 'connection_error',
        message: '重连失败，请稍后重试。',
      });
      return;
    }

    pendingOutputRef.current = '';
    flushScheduledRef.current = false;
    lastActivityAtRef.current = Date.now();
    setReconnectPrompt(null);
    focusTerminal();
  }, [ensureSession, focusTerminal]);

  const flushPendingOutput = useCallback(() => {
    if (flushScheduledRef.current || !isActiveRef.current || !xtermRef.current) {
      return;
    }
    flushScheduledRef.current = true;

    const flushChunk = () => {
      if (!isActiveRef.current || !xtermRef.current) {
        flushScheduledRef.current = false;
        return;
      }

      if (!pendingOutputRef.current) {
        flushScheduledRef.current = false;
        return;
      }

      const chunk = pendingOutputRef.current.slice(0, 8192);
      pendingOutputRef.current = pendingOutputRef.current.slice(chunk.length);
      xtermRef.current.write(chunk);
      lastActivityAtRef.current = Date.now();

      if (pendingOutputRef.current) {
        window.setTimeout(flushChunk, 16);
      } else {
        flushScheduledRef.current = false;
      }
    };

    window.setTimeout(flushChunk, 0);
  }, []);

  const trackObservedCommand = useCallback((data: string) => {
    const stripped = data
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1bO./g, '')
      .replace(/\x1b./g, '');

    if (!stripped) return;

    let buffer = commandBufferRef.current;

    for (const char of stripped) {
      if (char === '\r' || char === '\n') {
        const command = buffer.trim();
        if (command) {
          onCommandObserved?.(command);
        }
        buffer = '';
        continue;
      }

      if (char === '\u007f' || char === '\b') {
        buffer = buffer.slice(0, -1);
        continue;
      }

      if (char === '\u0015' || char === '\u0003') {
        buffer = '';
        continue;
      }

      if (char >= ' ' && char !== '\u007f') {
        buffer += char;
      }
    }

    commandBufferRef.current = buffer;
  }, [onCommandObserved]);

  // Initialize xterm
  useEffect(() => {
    if (!terminalRef.current) return;
    // Create xterm instance
    const xterm = new XTerm({
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      theme: {
        background: '#1e1e1e',
        foreground: '#e4e4e4',
        cursor: '#e4e4e4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e4e4e4',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    xterm.open(terminalRef.current);
    fitAddon.fit();

    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !isActiveRef.current) {
        return true;
      }

      if (reconnectPromptRef.current) {
        return false;
      }

      const idleDuration = Date.now() - lastActivityAtRef.current;
      if (idleDuration <= ACTIVE_IDLE_RECONNECT_THRESHOLD_MS) {
        return true;
      }

      setReconnectPrompt({
        reason: 'idle_timeout',
        message: '终端长时间空闲后可能已失效，请先手动重连。',
      });
      return false;
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    containerRef.current = terminalRef.current;
    if (isActive) {
      xterm.focus();
    }

    // Initial resize - use xterm's actual dimensions after fit()
    {
      const rows = xterm.rows;
      const cols = xterm.cols;
      terminalSizeRef.current = { rows, cols };
      invoke('shell_resize', { tabId, rows, cols }).catch(() => {});
    }

    // Handle resize with ResizeObserver - use xterm's actual dimensions
    const resizeObserver = new ResizeObserver(() => {
      if (!isActiveRef.current) {
        return;
      }
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const rows = xtermRef.current.rows;
        const cols = xtermRef.current.cols;
        terminalSizeRef.current = { rows, cols };
        invoke('shell_resize', { tabId, rows, cols }).catch(() => {});
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ensureSession, serverId, tabId]);

  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !isActive) {
      return;
    }

    const activateTerminal = async () => {
      if (!xtermRef.current || !fitAddonRef.current) {
        return;
      }

      const inactiveDuration = lastInactiveDurationRef.current;

      try {
        if (inactiveDuration > BACKGROUND_RECONNECT_THRESHOLD_MS) {
          setReconnectPrompt({
            reason: 'background_timeout',
            message: '终端在后台停留较久，建议先重连再继续使用。',
          });
          return;
        } else {
          const isAlive = await invoke<boolean>('shell_is_alive', { tabId });
          if (!isAlive) {
            setReconnectPrompt({
              reason: 'connection_error',
              message: '终端连接已失效，请手动重连后继续使用。',
            });
            return;
          }
        }
      } catch (err) {
        if (isRecoverableShellError(err)) {
          setReconnectPrompt({
            reason: 'connection_error',
            message: '终端连接检查失败，请手动重连后继续使用。',
          });
          return;
        }
      }

      if (!xtermRef.current || !fitAddonRef.current || !isActiveRef.current) {
        return;
      }

      fitAddonRef.current.fit();
      xtermRef.current.focus();

      const rows = xtermRef.current.rows;
      const cols = xtermRef.current.cols;
      terminalSizeRef.current = { rows, cols };
      invoke('shell_resize', { tabId, rows, cols }).catch(() => {});
      flushPendingOutput();
    };

    activateTerminal().catch(console.error);
  }, [BACKGROUND_RECONNECT_THRESHOLD_MS, flushPendingOutput, isActive, isRecoverableShellError, tabId]);

  // Handle terminal input
  useEffect(() => {
    if (!xtermRef.current || !isActive) return;

    const xterm = xtermRef.current;

    // Convert SS3 escape sequences to CSI format
    // SS3: ESC O A/B/C/D (xterm.js default)
    // CSI: ESC [ A/B/C/D (vim expects this)
    const convertEscapes = (data: string): string => {
      return data
        .replace(/\x1bOC/g, '\x1b[C')  // SS3 Right -> CSI Right
        .replace(/\x1bOD/g, '\x1b[D')  // SS3 Left -> CSI Left
        .replace(/\x1bOA/g, '\x1b[A')  // SS3 Up -> CSI Up
        .replace(/\x1bOB/g, '\x1b[B'); // SS3 Down -> CSI Down
    };

      const handleData = (data: string) => {
      if (!data || data.length === 0) {
        return;
      }
      const converted = convertEscapes(data);
      trackObservedCommand(converted);
      sendInput(converted);
    };

    const disposable = xterm.onData(handleData);

    return () => {
      disposable.dispose();
    };
  }, [sendInput, trackObservedCommand]);

  // Copy current selection into clipboard when the user selects text in xterm.
  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;
    const disposable = xterm.onSelectionChange(() => {
      const selection = xterm.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {});
      }
    });

    return () => {
      disposable.dispose();
    };
  }, []);

  // Poll for output using sequential setTimeout to prevent race conditions
  const ACTIVE_POLL_INTERVAL_MS = 33;
  const INACTIVE_POLL_INTERVAL_MS = 200;

  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;
    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const output = await invoke<string>('shell_output', { tabId });
        if (output) {
          lastActivityAtRef.current = Date.now();
          if (isActiveRef.current) {
            if (pendingOutputRef.current) {
              pendingOutputRef.current += output;
              flushPendingOutput();
            } else {
              xterm.write(output);
            }
          } else {
            pendingOutputRef.current += output;
            if (pendingOutputRef.current.length > 1024 * 1024) {
              pendingOutputRef.current = pendingOutputRef.current.slice(-512 * 1024);
            }
          }
        }
      } catch (err) {
        if (isRecoverableShellError(err)) {
          if (isActiveRef.current) {
            setReconnectPrompt((current) => current ?? {
              reason: 'connection_error',
              message: '终端连接已失效，请手动重连后继续使用。',
            });
          }
        } else {
          console.error('Failed to read shell output:', err);
        }
      }
      // Schedule next poll only after current one completes
      if (!cancelled) {
        timeoutId = window.setTimeout(
          poll,
          isActiveRef.current ? ACTIVE_POLL_INTERVAL_MS : INACTIVE_POLL_INTERVAL_MS
        );
      }
    };

    // Start sequential polling
    timeoutId = window.setTimeout(
      poll,
      isActiveRef.current ? ACTIVE_POLL_INTERVAL_MS : INACTIVE_POLL_INTERVAL_MS
    );

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [flushPendingOutput, isRecoverableShellError, tabId]);

  const handleContextMenu = useCallback(async (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    focusTerminal();
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendInput(text);
      }
    } catch {
      // Ignore clipboard permission failures.
    }
  }, [focusTerminal, sendInput]);

  return (
    <div className={`terminal-stage ${isActive ? 'active' : 'inactive'}`}>
      <div className="terminal-stage-header">
        <div className="terminal-stage-meta">
          <span className="terminal-stage-kicker">Live Shell</span>
          <span className="terminal-stage-label">{serverId}</span>
        </div>
        <div className="terminal-stage-indicators" aria-hidden="true">
          <span className="terminal-stage-dot terminal-stage-dot-live" />
          <span className="terminal-stage-dot" />
          <span className="terminal-stage-dot" />
        </div>
      </div>
      <div
        ref={terminalRef}
        className={`terminal-xterm ${isActive ? 'active' : 'inactive'}`}
        onClick={focusTerminal}
        onContextMenu={handleContextMenu}
      />
      {isActive && reconnectPrompt && (
        <div className="terminal-reconnect-overlay">
          <div className="terminal-reconnect-card">
            <div className="terminal-reconnect-title">终端需要重连</div>
            <div className="terminal-reconnect-text">{reconnectPrompt.message}</div>
            <div className="terminal-reconnect-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => { void handleReconnect(); }}
              >
                立即重连
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
