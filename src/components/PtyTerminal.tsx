import { useEffect, useRef, useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

interface PtyTerminalProps {
  serverId: string;
  onClose: () => void;
}

// Legacy / experimental terminal path.
// The current application mainline uses Terminal.tsx -> shell_* -> PersistentShell.

// Character dimensions matching backend PTY settings (8x15)
const CHAR_WIDTH = 8;
const CHAR_HEIGHT = 15;

function calculateSize(container: HTMLElement): { rows: number; cols: number } {
  const width = container.clientWidth;
  const height = container.clientHeight;

  const cols = Math.max(1, Math.floor(width / CHAR_WIDTH));
  const rows = Math.max(1, Math.floor(height / CHAR_HEIGHT));

  return { rows, cols };
}

export function PtyTerminal({ serverId, onClose }: PtyTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<number | undefined>(undefined);
  const isConnectedRef = useRef(false);

  // Initialize xterm
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm instance with macOS Terminal-like theme
    const xterm = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13.5,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.42,
      scrollback: 10000, // 10k lines for vim scrolling
      theme: {
        background: '#030912',
        foreground: '#cddbeb',
        cursor: '#62b7ff',
        cursorAccent: '#03101c',
        selectionBackground: 'rgba(98, 183, 255, 0.18)',
        black: '#030912',
        brightBlack: '#61778c',
        red: '#e97771',
        brightRed: '#ff9a92',
        green: '#45c5a7',
        brightGreen: '#72dcc3',
        yellow: '#d9ad50',
        brightYellow: '#efc76f',
        blue: '#6faef7',
        brightBlue: '#9acbff',
        magenta: '#9d8cff',
        brightMagenta: '#beb2ff',
        cyan: '#6ed7e8',
        brightCyan: '#9eeaf5',
        white: '#d7e3f0',
        brightWhite: '#f4f8ff',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    xterm.open(terminalRef.current);
    fitAddon.fit();

    // Ensure the terminal receives focus
    terminalRef.current.focus();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    containerRef.current = terminalRef.current;

    // Start PTY session
    const initPty = async () => {
      try {
        const { rows, cols } = calculateSize(terminalRef.current!);
        await invoke('start_pty_session', { serverId, rows, cols });
        isConnectedRef.current = true;
      } catch (err) {
        console.error('Failed to start PTY:', err);
        onClose();
      }
    };

    initPty();

    return () => {
      isConnectedRef.current = false;
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      invoke('close_pty_session', { serverId }).catch(console.error);
    };
  }, [serverId, onClose]);

  // Handle terminal input via xterm's onData event
  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;

    const handleData = (data: string) => {
      if (isConnectedRef.current) {
        console.log(`[DEBUG] onData received: ${JSON.stringify(data)}, bytes: ${Array.from(data).map(c => c.charCodeAt(0))}`);
        invoke('pty_input', { serverId, data }).catch(console.error);
      }
    };

    const disposable = xterm.onData(handleData);

    return () => {
      disposable.dispose();
    };
  }, [serverId]);

  // Poll for PTY output
  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;

    const poll = async () => {
      if (!isConnectedRef.current) return;
      try {
        const data = await invoke<string>('pty_output', { serverId });
        if (data && data.length > 0) {
          console.log(`[DEBUG] poll received ${data.length} bytes of output`);
          xterm.write(data);
        }
      } catch {
        // Session may have ended
        isConnectedRef.current = false;
      }
    };

    // Poll at ~30fps
    pollIntervalRef.current = window.setInterval(poll, 33);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [serverId]);

  // Handle window resize with ResizeObserver
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && containerRef.current) {
        fitAddonRef.current.fit();
        const { rows, cols } = calculateSize(containerRef.current);
        invoke('pty_resize', { serverId, rows, cols }).catch(console.error);
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [serverId]);

  // Handle selection change - copy to clipboard on selection
  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;

    const handleSelectionChange = () => {
      const selection = xterm.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Clipboard write failed, ignore
        });
      }
    };

    xterm.onSelectionChange(handleSelectionChange);

    return () => {
      xterm.onSelectionChange(() => {});
    };
  }, []);

  // Handle right-click context menu for paste
  const handleContextMenu = useCallback(async (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isConnectedRef.current) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        invoke('pty_input', { serverId, data: text }).catch(console.error);
      }
    } catch {
      // Clipboard read failed, ignore
    }
  }, [serverId]);

  // Handle all keyboard events directly
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isConnectedRef.current) return;

    const xterm = xtermRef.current;

    // Ctrl+C - copy selection if any, otherwise send SIGINT
    if (e.ctrlKey && e.key === 'c') {
      if (xterm) {
        const selection = xterm.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          e.preventDefault();
          return;
        }
      }
      // Fall through to send SIGINT
    }

    // Ctrl+V - paste from clipboard
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text && isConnectedRef.current) {
          invoke('pty_input', { serverId, data: text }).catch(console.error);
        }
      }).catch(() => {});
      return;
    }

    // Ctrl+D - EOF
    if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      console.log('[DEBUG] Ctrl+D pressed');
      invoke('pty_input', { serverId, data: '\x04' }).catch(console.error);
      return;
    }

    // Ctrl+Z - suspend
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      invoke('pty_input', { serverId, data: '\x1a' }).catch(console.error);
      return;
    }

    // Ctrl+L - clear screen
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      invoke('pty_input', { serverId, data: '\x0c' }).catch(console.error);
      return;
    }

    // Handle all special keys with escape sequences
    let data = '';
    const keyName = e.key;

    switch (e.key) {
      case 'ArrowUp': data = '\x1b[A'; break;
      case 'ArrowDown': data = '\x1b[B'; break;
      case 'ArrowRight': data = '\x1b[C'; break;
      case 'ArrowLeft': data = '\x1b[D'; break;
      case 'Home': data = '\x1b[H'; break;
      case 'End': data = '\x1b[F'; break;
      case 'PageUp': data = '\x1b[5~'; break;
      case 'PageDown': data = '\x1b[6~'; break;
      case 'Insert': data = '\x1b[2~'; break;
      case 'Delete': data = '\x1b[3~'; break;
      case 'Tab': data = '\t'; e.preventDefault(); break;
      case 'Enter': data = '\r'; break;
      case 'Backspace': data = '\x7f'; break;
      case 'Escape': data = '\x1b'; break;
      case 'F1': data = '\x1b[OP'; break;
      case 'F2': data = '\x1b[OQ'; break;
      case 'F3': data = '\x1b[OR'; break;
      case 'F4': data = '\x1b[OS'; break;
      case 'F5': data = '\x1b[15~'; break;
      case 'F6': data = '\x1b[17~'; break;
      case 'F7': data = '\x1b[18~'; break;
      case 'F8': data = '\x1b[19~'; break;
      case 'F9': data = '\x1b[20~'; break;
      case 'F10': data = '\x1b[21~'; break;
      case 'F11': data = '\x1b[23~'; break;
      case 'F12': data = '\x1b[24~'; break;
    }

    if (data) {
      e.preventDefault();
      console.log(`[DEBUG] Key pressed: ${keyName}, sending: ${JSON.stringify(data)}, bytes: ${Array.from(data).map(c => c.charCodeAt(0))}`);
      invoke('pty_input', { serverId, data }).catch(console.error);
      return;
    }

    // For printable characters, let xterm handle them via onData
    // (the onData handler will send them to the PTY)
  }, [serverId]);

  return (
    <div
      ref={terminalRef}
      className="pty-terminal"
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        outline: 'none',
      }}
    />
  );
}
