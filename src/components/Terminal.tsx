import { useEffect, useRef, useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { openFileBrowserWindow } from '../utils/remoteWindows';
import type { PendingAiTerminalExecution, ShellSendResult, TerminalConnectionState } from '../types';
import 'xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
  serverId: string;
  serverName: string;
  serverUsername?: string;
  currentDir: string;
  isActive: boolean;
  pendingAiExecution?: PendingAiTerminalExecution | null;
  onPendingAiExecutionConsumed?: (tabId: string, executionId: string) => void;
  onCommandEntered?: (tabId: string, command: string) => void;
  onDirectoryResolved?: (tabId: string, path: string) => void;
}

const FEEDBACK_BEGIN = '__LS_AI_BEGIN__';
const FEEDBACK_END = '__LS_AI_END__';
const MARKER_TAIL_LENGTH = 160;
const SILENT_RECONNECT_WINDOW_MS = 30 * 60_000;
const FAST_RECONNECT_ACTION_DELAY_MS = 1_500;
const WINDOW_RESUME_PROBE_THRESHOLD_MS = 2 * 60_000;
const IDLE_INPUT_PROBE_THRESHOLD_MS = 3 * 60_000;
const INPUT_RESPONSE_CHECK_DELAY_MS = 250;
const INPUT_RESPONSE_RECOVERY_DELAY_MS = 1200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function resolvePromptPath(path: string, username?: string): string {
  if (path === '~') {
    return username === 'root' ? '/root' : username ? `/home/${username}` : '/';
  }

  if (path.startsWith('~/')) {
    const homeDir = username === 'root' ? '/root' : username ? `/home/${username}` : '';
    return homeDir ? `${homeDir}/${path.slice(2)}` : path;
  }

  return path;
}

export function Terminal({
  tabId,
  serverId,
  serverName,
  serverUsername,
  currentDir,
  isActive,
  pendingAiExecution,
  onPendingAiExecutionConsumed,
  onCommandEntered,
  onDirectoryResolved,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalSizeRef = useRef({ rows: 24, cols: 80 });
  const recoveringSessionRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const inactiveSinceRef = useRef<number | null>(null);
  const lastInactiveDurationRef = useRef(0);
  const previousIsActiveRef = useRef(isActive);
  const pendingOutputRef = useRef('');
  const flushScheduledRef = useRef(false);
  const lastActivityAtRef = useRef(Date.now());
  const lastUserInteractionAtRef = useRef(Date.now());
  const lastWindowInactiveAtRef = useRef<number | null>(null);
  const connectionStateRef = useRef<TerminalConnectionState>('ready');
  const queuedInputRef = useRef('');
  const commandLineBufferRef = useRef('');
  const reconnectPromptRef = useRef<null | {
    reason: 'background_timeout' | 'idle_timeout' | 'connection_error';
    message: string;
  }>(null);
  const pendingAiExecutionRef = useRef<PendingAiTerminalExecution | null>(pendingAiExecution || null);
  const feedbackStreamStateRef = useRef<{
    buffer: string;
    activeId: string | null;
    capturedOutput: string;
  }>({
    buffer: '',
    activeId: null,
    capturedOutput: '',
  });
  const [reconnectPrompt, setReconnectPrompt] = useState<null | {
    reason: 'background_timeout' | 'idle_timeout' | 'connection_error';
    message: string;
  }>(null);
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('ready');
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [showFastReconnectAction, setShowFastReconnectAction] = useState(false);

  const writeRecoveryBoundary = useCallback(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    terminal.write('\r\n');
  }, []);

  const debugTerminal = useCallback((event: string, details?: Record<string, unknown>) => {
    console.debug(`[Terminal:${tabId}] ${event}`, {
      at: new Date().toISOString(),
      connectionState: connectionStateRef.current,
      recovering: recoveringSessionRef.current,
      queuedInputLength: queuedInputRef.current.length,
      ...details,
    });
  }, [tabId]);

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
    const markWindowInactive = () => {
      lastWindowInactiveAtRef.current = Date.now();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markWindowInactive();
      }
    };

    window.addEventListener('blur', markWindowInactive);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', markWindowInactive);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    reconnectPromptRef.current = reconnectPrompt;
  }, [reconnectPrompt]);

  useEffect(() => {
    pendingAiExecutionRef.current = pendingAiExecution || null;
  }, [pendingAiExecution]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
    debugTerminal('connection-state-changed', {
      nextState: connectionState,
      message: connectionMessage,
    });
  }, [connectionMessage, connectionState, debugTerminal]);

  useEffect(() => {
    if (connectionState !== 'checking' && connectionState !== 'reconnecting') {
      setShowFastReconnectAction(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowFastReconnectAction(true);
    }, FAST_RECONNECT_ACTION_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [connectionState]);

  const markInteraction = useCallback(() => {
    const now = Date.now();
    lastUserInteractionAtRef.current = now;
    lastActivityAtRef.current = now;
  }, []);

  const clearConnectionUi = useCallback(() => {
    setConnectionState('ready');
    setConnectionMessage(null);
    setReconnectPrompt(null);
  }, []);

  const requireManualReconnect = useCallback((reason: 'background_timeout' | 'idle_timeout' | 'connection_error', message: string) => {
    setConnectionState('manual_required');
    setConnectionMessage(message);
    setReconnectPrompt({ reason, message });
  }, []);

  const canSilentReconnect = useCallback((inactiveDuration?: number) => {
    if (typeof inactiveDuration === 'number' && inactiveDuration > SILENT_RECONNECT_WINDOW_MS) {
      return false;
    }
    return Date.now() - lastUserInteractionAtRef.current <= SILENT_RECONNECT_WINDOW_MS;
  }, []);

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

  const flushQueuedInput = useCallback(async () => {
    if (!queuedInputRef.current) {
      return;
    }

    const queued = queuedInputRef.current;
    queuedInputRef.current = '';
    setConnectionState('restoring');
    setConnectionMessage('终端已恢复，正在补发你刚才的输入...');
    try {
      const { rows, cols } = terminalSizeRef.current;
      const result = await invoke<ShellSendResult>('shell_send_input_resilient', {
        serverId,
        tabId,
        rows,
        cols,
        currentDir,
        idleDurationMs: 0,
        data: queued,
      });
      if (result.reconnected) {
        writeRecoveryBoundary();
      }
    } catch (err) {
      if (isRecoverableShellError(err)) {
        queuedInputRef.current = queued + queuedInputRef.current;
        requireManualReconnect('connection_error', '终端恢复后补发输入失败，请手动重连。');
        return;
      }
      console.error(err);
    }
  }, [currentDir, isRecoverableShellError, requireManualReconnect, serverId, tabId, writeRecoveryBoundary]);

  const ensureSession = useCallback(async (statusMessage = '终端连接已断开，正在重新建立 SSH 会话...') => {
    if (recoveringSessionRef.current) {
      return false;
    }

    recoveringSessionRef.current = true;
    const { rows, cols } = terminalSizeRef.current;
    setConnectionState('reconnecting');
    setConnectionMessage(statusMessage);

    try {
      const result = await invoke<ShellSendResult>('shell_prepare_session_resilient', {
        serverId,
        tabId,
        rows,
        cols,
        currentDir,
        idleDurationMs: 0,
      });
      if (result.reconnected) {
        writeRecoveryBoundary();
      }
      pendingOutputRef.current = '';
      flushScheduledRef.current = false;
      markInteraction();
      await flushQueuedInput();
      clearConnectionUi();
      return true;
    } catch (err) {
      console.error('Failed to recreate shell session:', err);
      setConnectionState('error');
      setConnectionMessage('终端恢复失败，请手动重连。');
      return false;
    } finally {
      recoveringSessionRef.current = false;
    }
  }, [clearConnectionUi, currentDir, flushQueuedInput, markInteraction, serverId, tabId, writeRecoveryBoundary]);

  const recoverTerminalConnection = useCallback(async (options?: {
    inactiveDuration?: number;
    checkingMessage?: string;
    reconnectingMessage?: string;
    manualReason?: 'background_timeout' | 'idle_timeout' | 'connection_error';
    manualMessage?: string;
  }) => {
    if (recoveringSessionRef.current) {
      return false;
    }

    const manualReason = options?.manualReason ?? 'connection_error';
    const manualMessage = options?.manualMessage ?? '终端连接已失效，请手动重连后继续使用。';

    if (!canSilentReconnect(options?.inactiveDuration)) {
      requireManualReconnect(manualReason, manualMessage);
      return false;
    }

    setConnectionState('checking');
    setConnectionMessage(options?.checkingMessage ?? '正在检查终端连接...');

    try {
      const { rows, cols } = terminalSizeRef.current;
      await invoke<ShellSendResult>('shell_prepare_session_resilient', {
        serverId,
        tabId,
        rows,
        cols,
        currentDir,
        idleDurationMs: typeof options?.inactiveDuration === 'number'
          ? Math.max(0, Math.round(options.inactiveDuration))
          : 0,
      });
      clearConnectionUi();
      return true;
    } catch (err) {
      if (!isRecoverableShellError(err)) {
        console.error('Failed to probe shell connection:', err);
      }
    }
    const recovered = await ensureSession(options?.reconnectingMessage);
    if (!recovered) {
      requireManualReconnect('connection_error', '终端恢复失败，请手动重连后继续使用。');
      return false;
    }
    return true;
  }, [canSilentReconnect, clearConnectionUi, currentDir, ensureSession, isRecoverableShellError, requireManualReconnect, serverId, tabId]);

  const sendInput = useCallback(async (data: string) => {
    debugTerminal('send-input:start', {
      dataPreview: JSON.stringify(data.slice(0, 40)),
      dataLength: data.length,
    });

    if (reconnectPrompt) {
      debugTerminal('send-input:blocked-by-manual-reconnect');
      return;
    }

    if (
      connectionStateRef.current === 'checking'
      || connectionStateRef.current === 'reconnecting'
      || connectionStateRef.current === 'restoring'
    ) {
      queuedInputRef.current += data;
      setConnectionMessage((current) => current ?? '终端正在恢复连接，输入会在恢复后自动补发...');
      debugTerminal('send-input:queued-during-recovery', {
        addedLength: data.length,
        nextQueueLength: queuedInputRef.current.length,
      });
      return;
    }

    const idleDuration = Date.now() - lastUserInteractionAtRef.current;
    if (idleDuration > SILENT_RECONNECT_WINDOW_MS) {
      debugTerminal('send-input:blocked-by-idle-timeout', { idleDuration });
      requireManualReconnect('idle_timeout', '终端空闲超过 30 分钟，需要确认恢复连接。');
      return;
    }

    if (idleDuration >= IDLE_INPUT_PROBE_THRESHOLD_MS) {
      debugTerminal('send-input:idle-preflight-probe', { idleDuration });
      queuedInputRef.current += data;
      setConnectionState('checking');
      setConnectionMessage('终端空闲较久，正在确认连接状态...');
      try {
        const { rows, cols } = terminalSizeRef.current;
        const result = await invoke<ShellSendResult>('shell_send_input_resilient', {
          serverId,
          tabId,
          rows,
          cols,
          currentDir,
          idleDurationMs: Math.max(0, Math.round(idleDuration)),
          data: queuedInputRef.current,
        });
        if (result.reconnected) {
          writeRecoveryBoundary();
        }
        queuedInputRef.current = '';
      } catch (err) {
        if (isRecoverableShellError(err)) {
          requireManualReconnect('connection_error', '终端连接恢复失败，请手动重连后继续操作。');
          return;
        }
        console.error(err);
        return;
      }
      markInteraction();
      clearConnectionUi();
      debugTerminal('send-input:idle-preflight-complete', {
        queueLength: queuedInputRef.current.length,
      });
      return;
    }

    markInteraction();

    let settled = false;

    const slowInputTimer = window.setTimeout(() => {
      if (settled || reconnectPromptRef.current || recoveringSessionRef.current) {
        debugTerminal('send-input:slow-timer-suppressed', {
          settled,
          hasManualPrompt: Boolean(reconnectPromptRef.current),
          recovering: recoveringSessionRef.current,
        });
        return;
      }

      debugTerminal('send-input:slow-timer-fired');
      setConnectionState('checking');
      setConnectionMessage('终端输入没有及时响应，正在确认连接状态...');

      debugTerminal('send-input:slow-timer-ui-only');
    }, INPUT_RESPONSE_CHECK_DELAY_MS);

    const recoveryHintTimer = window.setTimeout(() => {
      if (settled || reconnectPromptRef.current || recoveringSessionRef.current) {
        debugTerminal('send-input:recovery-hint-suppressed', {
          settled,
          hasManualPrompt: Boolean(reconnectPromptRef.current),
          recovering: recoveringSessionRef.current,
        });
        return;
      }

      debugTerminal('send-input:recovery-hint-fired');
      setConnectionState('reconnecting');
      setConnectionMessage('终端输入仍未响应，正在尝试恢复连接...');
    }, INPUT_RESPONSE_RECOVERY_DELAY_MS);

    const { rows, cols } = terminalSizeRef.current;
    await invoke<ShellSendResult>('shell_send_input_resilient', {
      serverId,
      tabId,
      rows,
      cols,
      currentDir,
      idleDurationMs: 0,
      data,
    }).catch(async (err) => {
      debugTerminal('send-input:invoke-error', { error: String(err) });
      settled = true;
      window.clearTimeout(slowInputTimer);
      window.clearTimeout(recoveryHintTimer);

      if (isRecoverableShellError(err)) {
        const recovered = await recoverTerminalConnection({
          reconnectingMessage: '终端连接已断开，正在重新建立 SSH 会话...',
        });
        if (recovered) {
          await invoke('shell_input', { tabId, data }).catch((retryErr) => {
            if (isRecoverableShellError(retryErr)) {
              requireManualReconnect('connection_error', '终端恢复失败，请手动重连后继续操作。');
              return;
            }
            console.error(retryErr);
          });
        }
        return;
      }
      console.error(err);
    });
    debugTerminal('send-input:invoke-completed');
    settled = true;
    window.clearTimeout(slowInputTimer);
    window.clearTimeout(recoveryHintTimer);
    if (queuedInputRef.current && !recoveringSessionRef.current) {
      await flushQueuedInput();
    }
    if (!reconnectPromptRef.current && !recoveringSessionRef.current) {
      setConnectionState('ready');
      setConnectionMessage(null);
    }
  }, [clearConnectionUi, currentDir, debugTerminal, flushQueuedInput, isRecoverableShellError, markInteraction, reconnectPrompt, recoverTerminalConnection, requireManualReconnect, serverId, tabId, writeRecoveryBoundary]);

  const focusTerminal = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const handleReconnect = useCallback(async () => {
    const recovered = await ensureSession('正在手动重连终端...');
    if (!recovered) {
      requireManualReconnect('connection_error', '重连失败，请稍后重试。');
      return;
    }
    xtermRef.current?.clear();
    xtermRef.current?.reset();

    const { rows, cols } = terminalSizeRef.current;
    try {
      await invoke<ShellSendResult>('reconnect_shell_with_context', {
        serverId,
        tabId,
        rows,
        cols,
        currentDir,
      });
      clearConnectionUi();
      markInteraction();
    } catch (err) {
      console.error('Failed to reconnect shell manually:', err);
      requireManualReconnect('connection_error', '重连失败，请稍后重试。');
      return;
    }

    focusTerminal();
  }, [clearConnectionUi, currentDir, ensureSession, focusTerminal, markInteraction, requireManualReconnect, serverId, tabId]);

  const finalizeFeedbackCapture = useCallback(async (exitCode: number) => {
    const execution = pendingAiExecutionRef.current;
    const capture = feedbackStreamStateRef.current;
    if (!execution || capture.activeId !== execution.id) {
      capture.activeId = null;
      capture.capturedOutput = '';
      return;
    }

    const combined = capture.capturedOutput;
    capture.activeId = null;
    capture.capturedOutput = '';
    pendingAiExecutionRef.current = null;
    onPendingAiExecutionConsumed?.(tabId, execution.id);

    await invoke('record_execution_feedback', {
      request: {
        serverId: serverId,
        userIntent: execution.userIntent,
        suggestedCommand: execution.suggestedCommand,
        finalCommand: execution.finalCommand,
        currentDir: execution.currentDir || currentDir,
        stdout: combined,
        stderr: '',
        exitCode,
        source: 'terminal',
      },
    }).catch(err => {
      console.error('Failed to record PTY execution feedback:', err);
    });
  }, [currentDir, onPendingAiExecutionConsumed, serverId, tabId]);

  const processFeedbackChunk = useCallback((chunk: string): string => {
    const state = feedbackStreamStateRef.current;
    state.buffer += chunk;
    let visible = '';

    while (state.buffer.length > 0) {
      if (!state.activeId) {
        const beginIndex = state.buffer.indexOf(FEEDBACK_BEGIN);
        if (beginIndex === -1) {
          if (!pendingAiExecutionRef.current) {
            visible += state.buffer;
            state.buffer = '';
            break;
          }
          if (state.buffer.length > MARKER_TAIL_LENGTH) {
            const flushText = state.buffer.slice(0, state.buffer.length - MARKER_TAIL_LENGTH);
            visible += flushText;
            state.buffer = state.buffer.slice(state.buffer.length - MARKER_TAIL_LENGTH);
          }
          break;
        }

        visible += state.buffer.slice(0, beginIndex);
        state.buffer = state.buffer.slice(beginIndex);
        const beginMatch = state.buffer.match(/^__LS_AI_BEGIN__([A-Za-z0-9-]+)__\r?\n/);
        if (!beginMatch) {
          break;
        }

        state.activeId = beginMatch[1];
        state.capturedOutput = '';
        state.buffer = state.buffer.slice(beginMatch[0].length);
        continue;
      }

      const endPrefix = `${FEEDBACK_END}${state.activeId}__:`; 
      const endIndex = state.buffer.indexOf(endPrefix);
      if (endIndex === -1) {
        if (state.buffer.length > MARKER_TAIL_LENGTH) {
          const flushText = state.buffer.slice(0, state.buffer.length - MARKER_TAIL_LENGTH);
          visible += flushText;
          state.capturedOutput += flushText;
          state.buffer = state.buffer.slice(state.buffer.length - MARKER_TAIL_LENGTH);
        }
        break;
      }

      const beforeEnd = state.buffer.slice(0, endIndex);
      visible += beforeEnd;
      state.capturedOutput += beforeEnd;
      state.buffer = state.buffer.slice(endIndex);
      const endMatch = state.buffer.match(/^__LS_AI_END__([A-Za-z0-9-]+)__:(-?\d+)\r?\n/);
      if (!endMatch) {
        break;
      }

      const exitCode = Number.parseInt(endMatch[2], 10);
      state.buffer = state.buffer.slice(endMatch[0].length);
      void finalizeFeedbackCapture(exitCode);
    }

    return visible;
  }, [finalizeFeedbackCapture]);

  const syncDirectoryFromTerminalBuffer = useCallback(() => {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    const buffer = terminal.buffer.active;
    const endLine = buffer.baseY + buffer.cursorY;
    let startLine = endLine;

    while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) {
      startLine -= 1;
    }

    let promptLine = '';
    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
      promptLine += buffer.getLine(lineIndex)?.translateToString(true) ?? '';
    }

    const normalizedLine = stripAnsi(promptLine).trimEnd();
    if (!normalizedLine) {
      return;
    }

    const usernamePattern = serverUsername
      ? escapeRegExp(serverUsername)
      : '[^@\\r\\n\\s]+';
    const promptPattern = new RegExp(`^${usernamePattern}@[^:\\r\\n]+:(.+?)[#$]\\s*$`);
    const promptMatch = normalizedLine.match(promptPattern);
    if (!promptMatch) {
      return;
    }

    const resolvedPath = resolvePromptPath(promptMatch[1].trim(), serverUsername);
    if (resolvedPath.startsWith('/')) {
      onDirectoryResolved?.(tabId, resolvedPath);
    }
  }, [onDirectoryResolved, serverUsername, tabId]);

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
      xtermRef.current.write(chunk, () => {
        lastActivityAtRef.current = Date.now();
        syncDirectoryFromTerminalBuffer();

        if (pendingOutputRef.current) {
          window.setTimeout(flushChunk, 16);
        } else {
          flushScheduledRef.current = false;
        }
      });
    };

    window.setTimeout(flushChunk, 0);
  }, [syncDirectoryFromTerminalBuffer]);

  const flushTerminalOutput = useCallback((output: string) => {
    if (!output) {
      return;
    }
    if (isActiveRef.current && xtermRef.current) {
      if (pendingOutputRef.current) {
        pendingOutputRef.current += output;
        flushPendingOutput();
      } else {
        xtermRef.current.write(output, () => {
          lastActivityAtRef.current = Date.now();
          syncDirectoryFromTerminalBuffer();
        });
      }
    } else {
      pendingOutputRef.current += output;
      if (pendingOutputRef.current.length > 1024 * 1024) {
        pendingOutputRef.current = pendingOutputRef.current.slice(-512 * 1024);
      }
    }
  }, [flushPendingOutput, syncDirectoryFromTerminalBuffer]);

  const trackCommandLineInput = useCallback((data: string) => {
    if (!data) {
      return;
    }

    let buffer = commandLineBufferRef.current;

    for (const char of data) {
      if (char === '\r') {
        const command = buffer.trim();
        if (command) {
          onCommandEntered?.(tabId, command);
        }
        buffer = '';
        continue;
      }

      if (char === '\u007f') {
        buffer = buffer.slice(0, -1);
        continue;
      }

      if (char === '\u0003' || char === '\u0015') {
        buffer = '';
        continue;
      }

      if (char === '\u001b') {
        continue;
      }

      if (char >= ' ' && char !== '\u007f') {
        buffer += char;
      }
    }

    commandLineBufferRef.current = buffer;
  }, [onCommandEntered, tabId]);

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
        background: '#14161a',
        foreground: '#e7ebf0',
        cursor: '#eef2f6',
        cursorAccent: '#14161a',
        selectionBackground: 'rgba(188, 200, 214, 0.24)',
        black: '#14161a',
        red: '#cd3131',
        green: '#4fb887',
        yellow: '#e5e510',
        blue: '#8f9fb2',
        magenta: '#bc3fbc',
        cyan: '#99aabf',
        white: '#e7ebf0',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#76caa1',
        brightYellow: '#f5f543',
        brightBlue: '#c5d2df',
        brightMagenta: '#d670d6',
        brightCyan: '#d6e1ec',
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
      return true;
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
  }, [serverId, tabId]);

  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !isActive) {
      return;
    }

    const activateTerminal = async () => {
      if (!xtermRef.current || !fitAddonRef.current) {
        return;
      }

      const inactiveDuration = lastInactiveDurationRef.current;

      const recovered = await recoverTerminalConnection({
        inactiveDuration,
        checkingMessage: '正在确认终端连接...',
        reconnectingMessage: '连接已断开，正在重新建立 SSH 会话...',
        manualReason: 'background_timeout',
        manualMessage: '终端空闲超过 30 分钟，需要确认恢复连接。',
      });

      if (!recovered) {
        return;
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
  }, [flushPendingOutput, isActive, recoverTerminalConnection, tabId]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleWindowResume = () => {
      const tabInactiveDuration = inactiveSinceRef.current
        ? Date.now() - inactiveSinceRef.current
        : 0;
      const windowInactiveDuration = lastWindowInactiveAtRef.current
        ? Date.now() - lastWindowInactiveAtRef.current
        : 0;
      const inactiveDuration = Math.max(tabInactiveDuration, windowInactiveDuration);
      lastWindowInactiveAtRef.current = null;
      if (inactiveDuration < WINDOW_RESUME_PROBE_THRESHOLD_MS) {
        return;
      }
      void recoverTerminalConnection({
        inactiveDuration,
        checkingMessage: '正在确认终端连接...',
        reconnectingMessage: '连接已断开，正在重新建立 SSH 会话...',
        manualReason: 'background_timeout',
        manualMessage: '终端空闲超过 30 分钟，需要确认恢复连接。',
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleWindowResume();
      }
    };

    window.addEventListener('focus', handleWindowResume);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowResume);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, recoverTerminalConnection]);

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
      trackCommandLineInput(converted);
      sendInput(converted);
    };

    const disposable = xterm.onData(handleData);

    return () => {
      disposable.dispose();
    };
  }, [sendInput, trackCommandLineInput]);

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
    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const output = await invoke<string>('shell_output', { tabId });
        if (output) {
          lastActivityAtRef.current = Date.now();
          const visibleOutput = processFeedbackChunk(output);
          flushTerminalOutput(visibleOutput);
        }
      } catch (err) {
        if (isRecoverableShellError(err)) {
          if (isActiveRef.current) {
            void recoverTerminalConnection({
              reconnectingMessage: '终端输出中断，正在后台恢复...',
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
  }, [flushTerminalOutput, isRecoverableShellError, processFeedbackChunk, recoverTerminalConnection, tabId]);

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

  const handleOpenFileBrowser = useCallback(() => {
    lastUserInteractionAtRef.current = Date.now();
    void openFileBrowserWindow({
      tabId,
      serverId,
      serverName,
      currentDir,
    });
  }, [currentDir, serverId, serverName, tabId]);

  const showTransientStatus = connectionState === 'checking'
    || connectionState === 'reconnecting'
    || connectionState === 'restoring';
  const terminalStatusLabel = connectionState === 'checking'
    ? '正在恢复中'
    : connectionState === 'reconnecting'
      ? '正在恢复中'
      : connectionState === 'restoring'
        ? '正在恢复中'
      : connectionState === 'manual_required'
        ? '需要手动重连'
        : connectionState === 'error'
          ? '恢复失败'
          : '连接正常';

  return (
    <div className={`terminal-stage ${isActive ? 'active' : 'inactive'}`}>
      <div className="terminal-stage-header">
        <div className="terminal-stage-meta">
          <span className="terminal-stage-kicker">Live Shell</span>
          <div className="terminal-stage-copy">
            <span className="terminal-stage-name">{serverName}</span>
            <span className="terminal-stage-label">{serverId}</span>
          </div>
        </div>
        <div className="terminal-stage-actions">
          <div className={`terminal-stage-status terminal-stage-status-${connectionState}`}>
            <span className="terminal-stage-status-dot" aria-hidden="true" />
            <span>{terminalStatusLabel}</span>
          </div>
          <button
            type="button"
            className="terminal-stage-action-btn"
            onClick={handleOpenFileBrowser}
          >
            文件浏览器
          </button>
          <div className="terminal-stage-indicators" aria-hidden="true">
            <span className="terminal-stage-dot terminal-stage-dot-live" />
            <span className="terminal-stage-dot" />
            <span className="terminal-stage-dot" />
          </div>
        </div>
      </div>
      <div className="terminal-stage-body">
        <div
          ref={terminalRef}
          className={`terminal-xterm ${isActive ? 'active' : 'inactive'}`}
          onClick={focusTerminal}
          onContextMenu={handleContextMenu}
        />
        {isActive && showTransientStatus && connectionMessage && (
          <div className="terminal-reconnect-overlay terminal-reconnect-overlay-soft">
            <div className="terminal-reconnect-card">
              <div className="terminal-reconnect-title">
                {connectionState === 'reconnecting'
                  ? '正在恢复中...'
                  : connectionState === 'restoring'
                    ? '正在恢复中...'
                    : '正在恢复中...'}
              </div>
              <div className="terminal-reconnect-text">{connectionMessage}</div>
              <div className="terminal-reconnect-text terminal-reconnect-text-subtle">
                {connectionState === 'reconnecting'
                  ? (queuedInputRef.current
                    ? '正在重新建立 SSH 与 PTY，会在恢复后自动补发你刚才的输入。'
                    : '正在重新建立 SSH 与 PTY，恢复完成后会继续显示当前终端内容。')
                  : connectionState === 'restoring'
                    ? '正在恢复目录和输入状态，当前 shell 还原完成后会自动回到你刚才的位置。'
                    : '正在检查并恢复终端连接，若 shell 仍存活则不会打断当前会话。'}
              </div>
              {showFastReconnectAction && (
                <div className="terminal-reconnect-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => { void handleReconnect(); }}
                  >
                    立即重连
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
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
    </div>
  );
}
