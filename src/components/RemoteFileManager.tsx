import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { RemoteBrowserConnectionState, RemoteDirectoryPayload, RemoteEntry } from '../types';
import { openFileEditorWindow } from '../utils/remoteWindows';

interface TreeNodeState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  children: RemoteEntry[];
  error?: string;
}

interface RemoteFileManagerProps {
  tabId: string;
  serverId: string;
  serverName: string;
  initialDir: string;
}

interface FileContextMenuState {
  x: number;
  y: number;
  entry: RemoteEntry | null;
}

interface FileInputDialogState {
  mode: 'create-file' | 'create-directory' | 'rename' | 'copy-file';
  title: string;
  placeholder: string;
  confirmLabel: string;
  value: string;
  targetEntry?: RemoteEntry | null;
}

interface DeleteDialogState {
  targetEntry: RemoteEntry;
}

interface RemoteActionOptions {
  actionLabel?: string;
  skipConnectionCheck?: boolean;
  retryOnConnectionError?: boolean;
  checkingMessage?: string;
  reconnectingMessage?: string;
  maxReconnectAttempts?: number;
}

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_ESTIMATED_HEIGHT = 180;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;
const SILENT_RECONNECT_WINDOW_MS = 30 * 60_000;
const FAST_RECONNECT_ACTION_DELAY_MS = 1_500;
const AGGRESSIVE_RECONNECT_IDLE_THRESHOLD_MS = 2 * 60_000;
const SERVER_SESSION_CHECK_TIMEOUT_MS = 2_500;
const SERVER_RECONNECT_TIMEOUT_MS = 15_000;
const REMOTE_COMMAND_TIMEOUT_MS = 12_000;

function formatFileSize(size: number | null): string {
  if (size == null) return '目录';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleString();
}

function isDirectory(entry: RemoteEntry): boolean {
  return entry.entryType === 'directory';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConnectionErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.toLowerCase().includes('timeout') || message.includes('超时')) {
    return '操作超时，服务器没有及时响应，请重试连接。';
  }
  return message;
}

function describeQueuedOperation(operationLabel: string | null): string | null {
  if (!operationLabel) {
    return null;
  }

  if (operationLabel.includes('读取目录')) {
    return '连接恢复后将继续读取目录内容。';
  }
  if (operationLabel.includes('加载目录树')) {
    return '连接恢复后将继续刷新目录树。';
  }
  if (operationLabel.includes('上传文件')) {
    return '连接恢复后将继续上传文件。';
  }
  if (operationLabel.includes('下载文件')) {
    return '连接恢复后将继续下载文件。';
  }
  if (operationLabel.includes('创建文件夹')) {
    return '连接恢复后将继续创建文件夹。';
  }
  if (operationLabel.includes('创建文件')) {
    return '连接恢复后将继续创建文件。';
  }
  if (operationLabel.includes('复制文件')) {
    return '连接恢复后将继续复制文件。';
  }
  if (operationLabel.includes('重命名')) {
    return '连接恢复后将继续重命名条目。';
  }
  if (operationLabel.includes('删除')) {
    return '连接恢复后将继续删除条目。';
  }

  return '连接恢复后将继续当前操作。';
}

function isConnectionRelatedError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('超时') ||
    message.includes('服务器响应') ||
    message.includes('not connected') ||
    message.includes('connection failed') ||
    message.includes('failed to open sftp session') ||
    message.includes('authentication failed') ||
    message.includes('auth failed') ||
    message.includes('broken pipe') ||
    message.includes('socket disconnected') ||
    message.includes('transport') ||
    message.includes('channel closed')
  );
}

function getRemotePathChain(path: string): string[] {
  if (!path || path === '/') {
    return ['/'];
  }

  const segments = path.split('/').filter(Boolean);
  const chain = ['/'];
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    chain.push(current);
  }
  return chain;
}

function buildCopyFileName(name: string): string {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex > 0) {
    return `${name.slice(0, extensionIndex)}-copy${name.slice(extensionIndex)}`;
  }
  return `${name}-copy`;
}

async function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
): Promise<T> {
  return await Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error('操作超时，正在等待服务器响应'));
      }, timeoutMs);
    }),
  ]);
}

export function RemoteFileManager({
  tabId,
  serverId,
  serverName,
  initialDir,
}: RemoteFileManagerProps) {
  const [currentPath, setCurrentPath] = useState(initialDir || '/');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'upload' | 'download' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedTreePaths, setExpandedTreePaths] = useState<Record<string, boolean>>({ '/': true });
  const [treeState, setTreeState] = useState<Record<string, TreeNodeState>>({});
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [inputDialog, setInputDialog] = useState<FileInputDialogState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [connectionState, setConnectionState] = useState<RemoteBrowserConnectionState>('checking');
  const [connectionMessage, setConnectionMessage] = useState('正在检查服务器连接...');
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const [showFastReconnectAction, setShowFastReconnectAction] = useState(false);
  const reconnectPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastInteractionAtRef = useRef(Date.now());

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedEntryPath) ?? null,
    [entries, selectedEntryPath]
  );

  const markInteraction = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
  }, []);

  const ensureServerConnection = useCallback(async (options?: {
    forceReconnect?: boolean;
    checkingMessage?: string;
    reconnectingMessage?: string;
    preferFastReconnect?: boolean;
  }) => {
    if (reconnectPromiseRef.current) {
      return reconnectPromiseRef.current;
    }

    const checkingMessage = options?.checkingMessage ?? '正在检查服务器连接...';
    const reconnectingMessage = options?.reconnectingMessage ?? '正在重连服务器连接...';

    const reconnectTask = (async () => {
      setError(null);

      if (!options?.forceReconnect) {
        if (Date.now() - lastInteractionAtRef.current > SILENT_RECONNECT_WINDOW_MS) {
          setConnectionState('manual_required');
          setConnectionMessage('文件浏览器空闲超过 30 分钟，需要确认恢复连接。');
          setError('文件浏览器空闲超过 30 分钟，需要确认恢复连接。');
          return false;
        }

        if (!options?.preferFastReconnect) {
          setConnectionState('checking');
          setConnectionMessage(checkingMessage);

          try {
            const alive = await invokeWithTimeout<boolean>(
              'server_session_is_alive',
              { serverId },
              SERVER_SESSION_CHECK_TIMEOUT_MS,
            );
            if (alive) {
              setConnectionState('ready');
              setConnectionMessage('');
              return true;
            }
          } catch (error) {
            if (!isConnectionRelatedError(error)) {
              throw error;
            }
          }
        }
      }

      setConnectionState('reconnecting');
      setConnectionMessage(reconnectingMessage);

      try {
        await invokeWithTimeout(
          'reconnect_server_session',
          { serverId },
          SERVER_RECONNECT_TIMEOUT_MS,
        );
        markInteraction();
        setConnectionState('ready');
        setConnectionMessage('');
        return true;
      } catch (error) {
        setConnectionState('error');
        setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
        setError(getErrorMessage(error));
        return false;
      }
    })();

    reconnectPromiseRef.current = reconnectTask;

    try {
      return await reconnectTask;
    } finally {
      reconnectPromiseRef.current = null;
    }
  }, [markInteraction, serverId]);

  const runRemoteAction = useCallback(async <T,>(
    action: () => Promise<T>,
    options?: RemoteActionOptions,
  ) => {
    if (options?.actionLabel) {
      setOperationLabel(options.actionLabel);
    }

    try {
      if (!options?.skipConnectionCheck) {
        const idleDuration = Date.now() - lastInteractionAtRef.current;
        const ready = await ensureServerConnection({
          checkingMessage: options?.checkingMessage,
          reconnectingMessage: options?.reconnectingMessage,
          preferFastReconnect: idleDuration >= AGGRESSIVE_RECONNECT_IDLE_THRESHOLD_MS,
        });
        if (!ready) {
          throw new Error('连接恢复失败，请稍后重试。');
        }
      }

      const maxReconnectAttempts = options?.retryOnConnectionError
        ? Math.max(1, options?.maxReconnectAttempts ?? 2)
        : 0;

      for (let reconnectAttempt = 0; ; reconnectAttempt += 1) {
        try {
          const result = await action();
          setConnectionState('ready');
          setConnectionMessage('');
          setError(null);
          markInteraction();
          return result;
        } catch (actionError) {
          if (!options?.retryOnConnectionError || !isConnectionRelatedError(actionError)) {
            throw actionError;
          }

          if (reconnectAttempt >= maxReconnectAttempts) {
            setConnectionState('error');
            setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
            setError(normalizeConnectionErrorMessage(actionError));
            throw actionError;
          }

          const reconnectLabel = reconnectAttempt === 0
            ? (options?.reconnectingMessage ?? '正在自动重连服务器连接...')
            : '连接恢复较慢，正在再次重连服务器连接...';

          const recovered = await ensureServerConnection({
            forceReconnect: true,
            reconnectingMessage: reconnectLabel,
          });

          if (!recovered) {
            setConnectionState('error');
            setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
            setError(normalizeConnectionErrorMessage(actionError));
            throw actionError;
          }
        }
      }
    } finally {
      if (options?.actionLabel) {
        setOperationLabel(null);
      }
    }
  }, [ensureServerConnection, markInteraction]);

  const loadTreeChildren = useCallback(async (path: string, options?: { skipConnectionCheck?: boolean; silent?: boolean }) => {
    setTreeState((prev) => ({
      ...prev,
      [path]: {
        status: 'loading',
        children: prev[path]?.children ?? [],
      },
    }));

    try {
      const payload = await runRemoteAction(
        () => invokeWithTimeout<RemoteDirectoryPayload>('list_remote_directory', { serverId, path }),
        {
          actionLabel: options?.silent ? undefined : '正在加载目录树...',
          skipConnectionCheck: options?.skipConnectionCheck,
          retryOnConnectionError: true,
          checkingMessage: '正在检查文件浏览器连接...',
          reconnectingMessage: '正在恢复文件浏览器连接...',
          maxReconnectAttempts: 2,
        }
      );

      setTreeState((prev) => ({
        ...prev,
        [payload.currentPath]: {
          status: 'loaded',
          children: payload.entries.filter(isDirectory),
        },
      }));

      return payload;
    } catch (error) {
      const message = normalizeConnectionErrorMessage(error);
      if (isConnectionRelatedError(error)) {
        setConnectionState('error');
        setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
      }
      setTreeState((prev) => ({
        ...prev,
        [path]: {
          status: 'error',
          children: prev[path]?.children ?? [],
          error: message,
        },
      }));
      throw error;
    }
  }, [runRemoteAction, serverId]);

  const loadDirectory = useCallback(async (path: string, options?: { quiet?: boolean; skipConnectionCheck?: boolean }) => {
    if (!options?.quiet) {
      setLoading(true);
    }
    setError(null);

    try {
      const payload = await runRemoteAction(
        () => invokeWithTimeout<RemoteDirectoryPayload>('list_remote_directory', { serverId, path }),
        {
          actionLabel: options?.quiet ? undefined : '正在读取目录...',
          skipConnectionCheck: options?.skipConnectionCheck,
          retryOnConnectionError: true,
          checkingMessage: '正在检查目录连接...',
          reconnectingMessage: '正在恢复目录连接...',
          maxReconnectAttempts: 2,
        }
      );

      setCurrentPath(payload.currentPath);
      setParentPath(payload.parentPath);
      setEntries(payload.entries);
      setSelectedEntryPath(null);
      await getCurrentWindow().setTitle(`${serverName} · ${payload.currentPath}`);

      const pathChain = getRemotePathChain(payload.currentPath);
      setExpandedTreePaths((prev) => ({
        ...prev,
        ...Object.fromEntries(pathChain.map((item) => [item, true])),
      }));
      setTreeState((prev) => ({
        ...prev,
        [payload.currentPath]: {
          status: 'loaded',
          children: payload.entries.filter(isDirectory),
        },
      }));

      for (const ancestorPath of pathChain.slice(0, -1)) {
        await loadTreeChildren(ancestorPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      }

      return payload;
    } catch (error) {
      if (isConnectionRelatedError(error)) {
        setConnectionState('error');
        setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
        setError(normalizeConnectionErrorMessage(error));
      } else {
        setError(getErrorMessage(error));
      }
      throw error;
    } finally {
      if (!options?.quiet) {
        setLoading(false);
      }
    }
  }, [loadTreeChildren, runRemoteAction, serverId, serverName]);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      try {
        const ready = await ensureServerConnection({
          checkingMessage: '正在检查文件浏览器连接...',
          reconnectingMessage: '正在恢复文件浏览器连接...',
        });
        if (!ready || cancelled) {
          return;
        }

        await loadDirectory(initialDir || '/', { skipConnectionCheck: true });
        if (!cancelled) {
          await loadTreeChildren('/', { skipConnectionCheck: true, silent: true }).catch(() => undefined);
        }
      } catch (error) {
        if (!cancelled) {
          setError(getErrorMessage(error));
          setConnectionState('error');
          setConnectionMessage('连接恢复失败，请重试或关闭窗口。');
        }
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [ensureServerConnection, initialDir, loadDirectory, loadTreeChildren]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    void getCurrentWindow()
      .listen<{ currentDir: string }>('file-browser:navigate', (event) => {
        const nextDir = event.payload.currentDir || '/';
        void loadDirectory(nextDir);
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, [loadDirectory]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!loading && connectionState === 'ready') {
      setShowSlowHint(false);
      return;
    }

    const timer = window.setTimeout(() => setShowSlowHint(true), 3000);
    return () => window.clearTimeout(timer);
  }, [connectionState, loading]);

  useEffect(() => {
    if (connectionState !== 'checking' && connectionState !== 'reconnecting') {
      setShowFastReconnectAction(false);
      return;
    }

    const timer = window.setTimeout(() => setShowFastReconnectAction(true), FAST_RECONNECT_ACTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connectionState]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu);
    window.addEventListener('keydown', closeMenu);

    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!inputDialog) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInputDialog(null);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [inputDialog]);

  useEffect(() => {
    if (!deleteDialog) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDeleteDialog(null);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [deleteDialog]);

  const handleRefresh = useCallback(async () => {
    await loadDirectory(currentPath);
    const expandedPaths = Object.entries(expandedTreePaths)
      .filter(([, expanded]) => expanded)
      .map(([path]) => path);
    for (const path of expandedPaths) {
      await loadTreeChildren(path, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
    }
    setNotice('目录已刷新');
  }, [currentPath, expandedTreePaths, loadDirectory, loadTreeChildren]);

  const handleNavigateUp = useCallback(async () => {
    if (!parentPath) return;
    await loadDirectory(parentPath);
  }, [loadDirectory, parentPath]);

  const handleEntryDoubleClick = useCallback(async (entry: RemoteEntry) => {
    if (isDirectory(entry)) {
      await loadDirectory(entry.path);
      return;
    }

    if (entry.isTextEditable) {
      await openFileEditorWindow({
        tabId,
        serverId,
        serverName,
        path: entry.path,
      });
      setSelectedEntryPath(entry.path);
    }
  }, [loadDirectory, serverId, serverName, tabId]);

  const handleToggleTreeNode = useCallback(async (path: string) => {
    const nextExpanded = !expandedTreePaths[path];
    setExpandedTreePaths((prev) => ({
      ...prev,
      [path]: nextExpanded,
    }));

    if (nextExpanded && treeState[path]?.status !== 'loaded') {
      await loadTreeChildren(path);
    }
  }, [expandedTreePaths, loadTreeChildren, treeState]);

  const handleSelectTreeNode = useCallback(async (path: string) => {
    await loadDirectory(path);
  }, [loadDirectory]);

  const handleUpload = useCallback(async () => {
    setBusyAction('upload');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: '选择要上传的文件',
      });
      if (!selected || Array.isArray(selected)) {
        return;
      }

      await runRemoteAction(
        () => invokeWithTimeout('upload_remote_file', {
          serverId,
          remoteDir: currentPath,
          localPath: selected,
        }),
        {
          actionLabel: '正在上传文件...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setNotice('文件上传成功');
    } finally {
      setBusyAction(null);
    }
  }, [currentPath, loadDirectory, loadTreeChildren, runRemoteAction, serverId]);

  const handleDownload = useCallback(async () => {
    if (!selectedEntry || isDirectory(selectedEntry)) {
      return;
    }

    setBusyAction('download');
    try {
      const targetPath = await save({
        title: '保存远程文件到本地',
        defaultPath: selectedEntry.name,
      });
      if (!targetPath) {
        return;
      }

      await runRemoteAction(
        () => invokeWithTimeout('download_remote_file', {
          serverId,
          remotePath: selectedEntry.path,
          localPath: targetPath,
        }),
        {
          actionLabel: '正在下载文件...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      setNotice('文件已下载到本地');
    } finally {
      setBusyAction(null);
    }
  }, [runRemoteAction, selectedEntry, serverId]);

  const openContextMenu = useCallback((event: MouseEvent, entry: RemoteEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry) {
      setSelectedEntryPath(entry.path);
    }

    const maxX = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_VIEWPORT_MARGIN
    );
    const maxY = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      window.innerHeight - CONTEXT_MENU_ESTIMATED_HEIGHT - CONTEXT_MENU_VIEWPORT_MARGIN
    );
    setContextMenu({
      x: Math.min(event.clientX, maxX),
      y: Math.min(event.clientY, maxY),
      entry,
    });
  }, []);

  const openFileInputDialog = useCallback((dialog: FileInputDialogState) => {
    setContextMenu(null);
    setInputDialog(dialog);
  }, []);

  const handleCreateTextFile = useCallback(async (fileName: string) => {
    try {
      const createdPath = await runRemoteAction(
        () => invokeWithTimeout<string>('create_remote_text_file', {
          serverId,
          parentDir: currentPath,
          fileName,
        }),
        {
          actionLabel: '正在创建文件...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setSelectedEntryPath(createdPath);
      setNotice(`已创建 ${fileName}`);
      await openFileEditorWindow({
        tabId,
        serverId,
        serverName,
        path: createdPath,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, runRemoteAction, serverId, serverName, tabId]);

  const handleCreateDirectory = useCallback(async (directoryName: string) => {
    try {
      const createdPath = await runRemoteAction(
        () => invokeWithTimeout<string>('create_remote_directory', {
          serverId,
          parentDir: currentPath,
          directoryName,
        }),
        {
          actionLabel: '正在创建文件夹...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setSelectedEntryPath(createdPath);
      setNotice(`已创建文件夹 ${directoryName}`);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, runRemoteAction, serverId]);

  const handleCopyFile = useCallback(async (targetEntry: RemoteEntry, targetName: string) => {
    try {
      const copiedPath = await runRemoteAction(
        () => invokeWithTimeout<string>('copy_remote_file', {
          serverId,
          sourcePath: targetEntry.path,
          targetName,
        }),
        {
          actionLabel: '正在复制文件...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setSelectedEntryPath(copiedPath);
      setNotice(`已复制 ${targetEntry.name}`);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, runRemoteAction, serverId]);

  const canCopyFile = !!contextMenu?.entry && !isDirectory(contextMenu.entry);
  const canManageEntry = !!contextMenu?.entry;

  const handleRenameEntry = useCallback(async () => {
    const targetEntry = contextMenu?.entry;
    setContextMenu(null);
    if (!targetEntry) {
      return;
    }

    openFileInputDialog({
      mode: 'rename',
      title: '重命名',
      placeholder: '输入新的名称',
      confirmLabel: '确认重命名',
      value: targetEntry.name,
      targetEntry,
    });
  }, [contextMenu?.entry, openFileInputDialog]);

  const submitFileInputDialog = useCallback(async () => {
    if (!inputDialog) {
      return;
    }

    const nextValue = inputDialog.value.trim();
    if (!nextValue) {
      return;
    }

    setInputDialog(null);
    try {
      if (inputDialog.mode === 'create-file') {
        await handleCreateTextFile(nextValue);
        return;
      }

      if (inputDialog.mode === 'create-directory') {
        await handleCreateDirectory(nextValue);
        return;
      }

      const targetEntry = inputDialog.targetEntry;
      if (!targetEntry) {
        return;
      }

      if (inputDialog.mode === 'copy-file') {
        if (nextValue === targetEntry.name) {
          return;
        }
        await handleCopyFile(targetEntry, nextValue);
        return;
      }

      if (nextValue === targetEntry.name) {
        return;
      }

      const renamedPath = await runRemoteAction(
        () => invokeWithTimeout<string>('rename_remote_entry', {
          serverId,
          path: targetEntry.path,
          newName: nextValue,
        }),
        {
          actionLabel: '正在重命名...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setSelectedEntryPath(renamedPath);
      setNotice(`${targetEntry.name} 已重命名为 ${nextValue}`);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [currentPath, handleCopyFile, handleCreateDirectory, handleCreateTextFile, inputDialog, loadDirectory, loadTreeChildren, runRemoteAction, serverId]);

  const handleDeleteEntry = useCallback(async () => {
    const targetEntry = contextMenu?.entry;
    setContextMenu(null);
    if (!targetEntry) {
      return;
    }
    setDeleteDialog({ targetEntry });
  }, [contextMenu?.entry]);

  const confirmDeleteEntry = useCallback(async () => {
    const targetEntry = deleteDialog?.targetEntry;
    setDeleteDialog(null);
    if (!targetEntry) {
      return;
    }

    try {
      await runRemoteAction(
        () => invokeWithTimeout('delete_remote_entry', {
          serverId,
          path: targetEntry.path,
        }),
        {
          actionLabel: '正在删除...',
          retryOnConnectionError: true,
          maxReconnectAttempts: 2,
        }
      );
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath, { skipConnectionCheck: true, silent: true }).catch(() => undefined);
      setSelectedEntryPath((prev) => (prev === targetEntry.path ? null : prev));
      setNotice(`${targetEntry.name} 已删除`);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  }, [currentPath, deleteDialog?.targetEntry, loadDirectory, loadTreeChildren, runRemoteAction, serverId]);

  const handleRetryConnection = useCallback(async () => {
    setError(null);
    setNotice(null);
    const ready = await ensureServerConnection({
      forceReconnect: true,
      reconnectingMessage: '正在重连服务器连接...',
    });
    if (ready) {
      await loadDirectory(currentPath, { skipConnectionCheck: true });
      await loadTreeChildren('/', { skipConnectionCheck: true, silent: true }).catch(() => undefined);
    }
  }, [currentPath, ensureServerConnection, loadDirectory, loadTreeChildren]);

  const renderTreeNode = useCallback((path: string, label: string, level: number) => {
    const node = treeState[path];
    const expanded = !!expandedTreePaths[path];
    const children = node?.children ?? [];
    const isCurrent = currentPath === path;

    return (
      <div key={path} className="remote-tree-node">
        <div
          className={`remote-tree-row ${isCurrent ? 'active' : ''}`}
          style={{ paddingLeft: `${level * 14 + 10}px` }}
        >
          <button
            type="button"
            className="remote-tree-toggle"
            onClick={() => { void handleToggleTreeNode(path); }}
            disabled={node?.status === 'loading' || connectionState === 'checking' || connectionState === 'reconnecting'}
            aria-label={expanded ? '收起目录' : '展开目录'}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className="remote-tree-label"
            onClick={() => { void handleSelectTreeNode(path); }}
            disabled={connectionState === 'checking' || connectionState === 'reconnecting'}
          >
            <span className="remote-tree-icon">📁</span>
            <span>{label}</span>
          </button>
        </div>
        {expanded && (
          <div className="remote-tree-children">
            {node?.status === 'loading' && (
              <div className="remote-tree-status" style={{ paddingLeft: `${level * 14 + 34}px` }}>
                正在加载...
              </div>
            )}
            {node?.status === 'error' && (
              <div className="remote-tree-status error" style={{ paddingLeft: `${level * 14 + 34}px` }}>
                {node.error || '目录加载失败'}
              </div>
            )}
            {node?.status === 'loaded' && children.length === 0 && (
              <div className="remote-tree-status" style={{ paddingLeft: `${level * 14 + 34}px` }}>
                空目录
              </div>
            )}
            {node?.status === 'loaded' && children.map((child) => (
              renderTreeNode(child.path, child.name, level + 1)
            ))}
          </div>
        )}
      </div>
    );
  }, [connectionState, currentPath, expandedTreePaths, handleSelectTreeNode, handleToggleTreeNode, treeState]);

  const isConnectionBusy = connectionState === 'checking' || connectionState === 'reconnecting';
  const isRemoteActionDisabled = loading || busyAction !== null || isConnectionBusy;
  const queuedOperationMessage = describeQueuedOperation(operationLabel);
  const statusPrimaryMessage = error
    || (connectionState !== 'ready' ? connectionMessage : (operationLabel || notice));
  const statusSecondaryMessage = error
    ? (showSlowHint ? '服务器响应较慢。你可以继续等待，也可以稍后重试连接。' : null)
    : (connectionState !== 'ready'
      ? (queuedOperationMessage || (showSlowHint ? '服务器响应较慢，窗口仍然保持可用。' : null))
      : (loading
        ? (showSlowHint ? '目录内容仍在读取，旧内容会暂时保留。' : '目录内容读取完成后会自动刷新。')
        : null));
  const hasBanner = Boolean(statusPrimaryMessage || statusSecondaryMessage);
  const listOverlayMessage = connectionState !== 'ready'
    ? connectionMessage
    : (operationLabel || (loading ? '正在读取目录...' : null));
  const listOverlayDetail = connectionState !== 'ready'
    ? (queuedOperationMessage || (showSlowHint ? '服务器响应较慢，正在继续恢复连接。' : null))
    : (showSlowHint ? '目录内容仍在加载，旧内容会暂时保留。' : '读取完成后将自动刷新当前列表。');

  return (
    <div className="window-shell window-shell-browser">
      <div className="remote-file-manager remote-file-manager-window">
        <div className="remote-file-toolbar">
          <div className="remote-file-toolbar-main">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { void handleNavigateUp(); }}
              disabled={!parentPath || isRemoteActionDisabled}
            >
              返回上一级
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { void handleRefresh(); }}
              disabled={isRemoteActionDisabled}
            >
              刷新
            </button>
            <div className="remote-file-breadcrumb" title={currentPath}>
              <span className="remote-file-breadcrumb-kicker">Remote Finder</span>
              <span className="remote-file-breadcrumb-path">{currentPath}</span>
            </div>
          </div>
          <div className="remote-file-toolbar-actions">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { void handleUpload(); }}
              disabled={busyAction !== null || isConnectionBusy}
            >
              {busyAction === 'upload' ? '上传中...' : '上传文件'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { void handleDownload(); }}
              disabled={busyAction !== null || isConnectionBusy || !selectedEntry || isDirectory(selectedEntry)}
            >
              {busyAction === 'download' ? '下载中...' : '下载到本地'}
            </button>
          </div>
        </div>

        {hasBanner && (
          <div className={(error || connectionState === 'manual_required') ? 'error-message remote-file-banner' : 'success-message remote-file-banner'}>
            <div className="remote-file-banner-content">
              <div className="remote-file-banner-copy">
                {statusPrimaryMessage && (
                  <span className="remote-file-banner-primary">{statusPrimaryMessage}</span>
                )}
                {statusSecondaryMessage && (
                  <span className="remote-file-banner-secondary">{statusSecondaryMessage}</span>
                )}
              </div>
              {(connectionState === 'error' || connectionState === 'manual_required' || showFastReconnectAction) && (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => { void handleRetryConnection(); }}>
                  立即重连
                </button>
              )}
            </div>
          </div>
        )}

        <div className="remote-file-shell remote-file-shell-window">
          <aside className="remote-file-sidebar">
            <div className="remote-file-sidebar-header">文件系统</div>
            <div className="remote-file-tree">
              {renderTreeNode('/', '/', 0)}
            </div>
          </aside>

          <section className="remote-file-content remote-file-content-single">
            <div className="remote-file-list-panel remote-file-list-panel-window">
              <div className="remote-file-panel-header">
                <span>当前目录</span>
                <span>{entries.length} 项</span>
              </div>
              <div className="remote-file-list-header">
                <span>名称</span>
                <span>类型</span>
                <span>大小</span>
                <span>修改时间</span>
              </div>
              <div
                className={`remote-file-list ${loading || isConnectionBusy ? 'is-pending' : ''}`}
                onContextMenu={(event) => openContextMenu(event, null)}
              >
                {entries.length === 0 && !loading && !isConnectionBusy && (
                  <div className="remote-file-empty">
                    {connectionState === 'error' ? '连接恢复失败，请点击上方重试连接。' : '这个目录当前没有文件。'}
                  </div>
                )}
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`remote-file-row ${selectedEntryPath === entry.path ? 'selected' : ''}`}
                    onClick={() => setSelectedEntryPath(entry.path)}
                    onDoubleClick={() => { void handleEntryDoubleClick(entry); }}
                    onContextMenu={(event) => openContextMenu(event, entry)}
                    disabled={isRemoteActionDisabled}
                  >
                    <span className="remote-file-name">
                      <span className="remote-file-icon">{isDirectory(entry) ? '📁' : '📄'}</span>
                      <span>{entry.name}</span>
                    </span>
                    <span>{entry.entryType === 'directory' ? '文件夹' : entry.isTextEditable ? '文本文件' : '文件'}</span>
                    <span>{formatFileSize(entry.size)}</span>
                    <span>{formatTimestamp(entry.modifiedAt)}</span>
                  </button>
                ))}
                {(loading || isConnectionBusy) && (
                  <div className="remote-file-list-overlay">
                    <div className="remote-file-list-overlay-card">
                      <div className="remote-file-list-overlay-title">
                        {listOverlayMessage || '正在读取目录...'}
                      </div>
                      {listOverlayDetail && (
                        <div className="remote-file-list-overlay-detail">
                          {listOverlayDetail}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {contextMenu && (
        <div className="context-menu remote-file-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <button
            type="button"
            onClick={() => openFileInputDialog({
              mode: 'create-file',
              title: '新建文本文件',
              placeholder: '例如：notes.txt',
              confirmLabel: '创建并打开',
              value: 'untitled.txt',
            })}
          >
            新建文本文件
          </button>
          <button
            type="button"
            onClick={() => openFileInputDialog({
              mode: 'create-directory',
              title: '新建文件夹',
              placeholder: '例如：logs',
              confirmLabel: '创建文件夹',
              value: 'untitled-folder',
            })}
          >
            新建文件夹
          </button>
          <button
            type="button"
            onClick={() => {
              const targetEntry = contextMenu?.entry;
              if (!targetEntry || isDirectory(targetEntry)) {
                return;
              }
              openFileInputDialog({
                mode: 'copy-file',
                title: '复制文件',
                placeholder: '输入新文件名',
                confirmLabel: '确认复制',
                value: buildCopyFileName(targetEntry.name),
                targetEntry,
              });
            }}
            disabled={!canCopyFile || isConnectionBusy}
          >
            复制文件
          </button>
          <button type="button" onClick={() => { void handleRenameEntry(); }} disabled={!canManageEntry || isConnectionBusy}>
            重命名
          </button>
          <button type="button" onClick={() => { void handleDeleteEntry(); }} disabled={!canManageEntry || isConnectionBusy}>
            删除
          </button>
        </div>
      )}
      {inputDialog && (
        <div className="modal-overlay" onClick={() => setInputDialog(null)}>
          <div className="modal-content remote-file-input-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{inputDialog.title}</h2>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitFileInputDialog();
              }}
            >
              <input
                className="card-edit-input"
                type="text"
                value={inputDialog.value}
                placeholder={inputDialog.placeholder}
                autoFocus
                onChange={(event) => setInputDialog((prev) => (prev ? { ...prev, value: event.target.value } : prev))}
              />
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setInputDialog(null)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={!inputDialog.value.trim()}>
                  {inputDialog.confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {deleteDialog && (
        <div className="modal-overlay" onClick={() => setDeleteDialog(null)}>
          <div className="modal-content remote-file-input-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>确认删除</h2>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirmDeleteEntry();
              }}
            >
              <div className="remote-file-delete-message">
                {isDirectory(deleteDialog.targetEntry)
                  ? `确定要删除文件夹“${deleteDialog.targetEntry.name}”及其内部所有内容吗？`
                  : `确定要删除文件“${deleteDialog.targetEntry.name}”吗？`}
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setDeleteDialog(null)}>
                  取消
                </button>
                <button type="submit" className="btn btn-danger">
                  确认删除
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
