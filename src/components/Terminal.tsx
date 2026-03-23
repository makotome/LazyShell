import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
}

export function Terminal({ tabId }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollCancelledRef = useRef(false);

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

    // Initial resize - use xterm's actual dimensions after fit()
    {
      const rows = xterm.rows;
      const cols = xterm.cols;
      console.log(`[DEBUG Terminal] initial resize: xterm rows=${rows}, cols=${cols}`);
      invoke('shell_resize', { tabId, rows, cols }).catch(console.error);
    }

    // Handle resize with ResizeObserver - use xterm's actual dimensions
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const rows = xtermRef.current.rows;
        const cols = xtermRef.current.cols;
        console.log(`[DEBUG Terminal] resize: xterm rows=${rows}, cols=${cols}`);
        invoke('shell_resize', { tabId, rows, cols }).catch(console.error);
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      pollCancelledRef.current = true;
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tabId]);

  // Handle terminal input
  useEffect(() => {
    if (!xtermRef.current) return;

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
        console.log('[DEBUG Terminal] onData received empty data, skipping');
        return;
      }
      const converted = convertEscapes(data);
      if (converted !== data) {
        console.log(`[DEBUG Terminal] converted: ${JSON.stringify(data)} -> ${JSON.stringify(converted)}`);
      }
      console.log(`[DEBUG Terminal] onData sending: ${JSON.stringify(converted)}, bytes: ${Array.from(converted).map(c => c.charCodeAt(0))}`);
      invoke('shell_input', { tabId, data: converted }).catch(console.error);
    };

    const disposable = xterm.onData(handleData);

    return () => {
      disposable.dispose();
    };
  }, [tabId]);

  // Poll for output using sequential setTimeout to prevent race conditions
  const POLL_INTERVAL_MS = 33; // ~30fps, balances responsiveness and CPU

  useEffect(() => {
    if (!xtermRef.current) return;

    const xterm = xtermRef.current;
    pollCancelledRef.current = false;

    const poll = async () => {
      if (pollCancelledRef.current) return;
      try {
        const output = await invoke<string>('shell_output', { tabId });
        if (output) {
          xterm.write(output);
        }
      } catch (err) {
        console.error('Failed to read shell output:', err);
      }
      // Schedule next poll only after current one completes
      if (!pollCancelledRef.current) {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Start sequential polling
    setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      pollCancelledRef.current = true;
    };
  }, [tabId]);

  return (
    <div
      ref={terminalRef}
      className="terminal-xterm"
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    />
  );
}
