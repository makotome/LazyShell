import { useEffect, useRef, useCallback } from 'react';
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
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalSizeRef = useRef({ rows: 24, cols: 80 });
  const recoveringSessionRef = useRef(false);
  const commandBufferRef = useRef('');
  const isActiveRef = useRef(isActive);
  const debugLog = useCallback((event: string, details?: Record<string, unknown>) => {
    if (import.meta.env.DEV) {
      console.debug(`[Terminal ${tabId}] ${event}`, details ?? {});
    }
  }, [tabId]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const ensureSession = useCallback(async () => {
    if (recoveringSessionRef.current) {
      debugLog('ensureSession:skip_already_recovering');
      return false;
    }

    recoveringSessionRef.current = true;
    const { rows, cols } = terminalSizeRef.current;
    debugLog('ensureSession:start', { serverId, rows, cols });

    try {
      await invoke('create_shell_session', {
        serverId,
        tabId,
        rows,
        cols,
      });
      debugLog('ensureSession:success');
      return true;
    } catch (err) {
      debugLog('ensureSession:error', { error: String(err) });
      console.error('Failed to recreate shell session:', err);
      return false;
    } finally {
      recoveringSessionRef.current = false;
    }
  }, [debugLog, serverId, tabId]);

  const sendInput = useCallback((data: string) => {
    debugLog('sendInput:start', { data });
    invoke('shell_input', { tabId, data }).catch(async (err) => {
      const message = String(err);
      debugLog('sendInput:error', { error: message, data });
      if (message.includes('Not connected')) {
        const recovered = await ensureSession();
        if (recovered) {
          debugLog('sendInput:retry_after_recover', { data });
          invoke('shell_input', { tabId, data }).catch(console.error);
        }
        return;
      }
      console.error(err);
    });
  }, [debugLog, ensureSession, tabId]);

  const focusTerminal = useCallback(() => {
    xtermRef.current?.focus();
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

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    containerRef.current = terminalRef.current;
    if (isActive) {
      xterm.focus();
    }
    debugLog('mount', { serverId });

    // Initial resize - use xterm's actual dimensions after fit()
    {
      const rows = xterm.rows;
      const cols = xterm.cols;
      terminalSizeRef.current = { rows, cols };
      invoke('shell_resize', { tabId, rows, cols }).catch(async (err) => {
        debugLog('initialResize:error', { error: String(err), rows, cols });
        console.error(err);
      });
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
        invoke('shell_resize', { tabId, rows, cols }).catch(async (err) => {
          debugLog('resize:error', { error: String(err), rows, cols });
          console.error(err);
        });
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      debugLog('unmount');
      resizeObserver.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [debugLog, ensureSession, serverId, tabId]);

  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !isActive) {
      return;
    }

    fitAddonRef.current.fit();
    xtermRef.current.focus();

    const rows = xtermRef.current.rows;
    const cols = xtermRef.current.cols;
    terminalSizeRef.current = { rows, cols };
    invoke('shell_resize', { tabId, rows, cols }).catch(() => {});
  }, [isActive, tabId]);

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
  const POLL_INTERVAL_MS = 33; // ~30fps, balances responsiveness and CPU

  useEffect(() => {
    if (!xtermRef.current || !isActive) return;

    const xterm = xtermRef.current;
    let cancelled = false;
    let timeoutId: number | null = null;
    recoveringSessionRef.current = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const output = await invoke<string>('shell_output', { tabId });
        if (output) {
          debugLog('poll:output', { length: output.length });
          xterm.write(output);
        }
      } catch (err) {
        debugLog('poll:error', { error: String(err) });
        if (!String(err).includes('Not connected')) {
          console.error('Failed to read shell output:', err);
        }
      }
      // Schedule next poll only after current one completes
      if (!cancelled) {
        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Start sequential polling
    timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [debugLog, isActive, tabId]);

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
    <div
      ref={terminalRef}
      className={`terminal-xterm ${isActive ? 'active' : 'inactive'}`}
      onClick={focusTerminal}
      onContextMenu={handleContextMenu}
    />
  );
}
