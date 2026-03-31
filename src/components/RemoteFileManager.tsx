import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { RemoteDirectoryPayload, RemoteEntry } from '../types';
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

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_ESTIMATED_HEIGHT = 180;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;

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

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedEntryPath) ?? null,
    [entries, selectedEntryPath]
  );

  const loadTreeChildren = useCallback(async (path: string) => {
    setTreeState((prev) => ({
      ...prev,
      [path]: {
        status: 'loading',
        children: prev[path]?.children ?? [],
      },
    }));

    try {
      const payload = await invoke<RemoteDirectoryPayload>('list_remote_directory', { serverId, path });
      setTreeState((prev) => ({
        ...prev,
        [payload.currentPath]: {
          status: 'loaded',
          children: payload.entries.filter(isDirectory),
        },
      }));
      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTreeState((prev) => ({
        ...prev,
        [path]: {
          status: 'error',
          children: prev[path]?.children ?? [],
          error: message,
        },
      }));
      throw err;
    }
  }, [serverId]);

  const loadDirectory = useCallback(async (path: string, options?: { quiet?: boolean }) => {
    if (!options?.quiet) {
      setLoading(true);
    }
    setError(null);

    try {
      const payload = await invoke<RemoteDirectoryPayload>('list_remote_directory', { serverId, path });
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
        await loadTreeChildren(ancestorPath).catch(() => undefined);
      }
      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      if (!options?.quiet) {
        setLoading(false);
      }
    }
  }, [loadTreeChildren, serverId, serverName]);

  useEffect(() => {
    void Promise.allSettled([
      loadTreeChildren('/'),
      loadDirectory(initialDir || '/'),
    ]);
  }, [initialDir, loadDirectory, loadTreeChildren]);

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
    await Promise.allSettled(expandedPaths.map((path) => loadTreeChildren(path)));
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

      await invoke('upload_remote_file', {
        serverId,
        remoteDir: currentPath,
        localPath: selected,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setNotice('文件上传成功');
    } finally {
      setBusyAction(null);
    }
  }, [currentPath, loadDirectory, loadTreeChildren, serverId]);

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

      await invoke('download_remote_file', {
        serverId,
        remotePath: selectedEntry.path,
        localPath: targetPath,
      });
      setNotice('文件已下载到本地');
    } finally {
      setBusyAction(null);
    }
  }, [selectedEntry, serverId]);

  const openContextMenu = useCallback((event: MouseEvent, entry: RemoteEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry) {
      setSelectedEntryPath(entry.path);
    }

    const maxX = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_VIEWPORT_MARGIN);
    const maxY = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, window.innerHeight - CONTEXT_MENU_ESTIMATED_HEIGHT - CONTEXT_MENU_VIEWPORT_MARGIN);
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
      const createdPath = await invoke<string>('create_remote_text_file', {
        serverId,
        parentDir: currentPath,
        fileName,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setSelectedEntryPath(createdPath);
      setNotice(`已创建 ${fileName}`);
      await openFileEditorWindow({
        tabId,
        serverId,
        serverName,
        path: createdPath,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, serverId, serverName, tabId]);

  const handleCreateDirectory = useCallback(async (directoryName: string) => {
    try {
      const createdPath = await invoke<string>('create_remote_directory', {
        serverId,
        parentDir: currentPath,
        directoryName,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setSelectedEntryPath(createdPath);
      setNotice(`已创建文件夹 ${directoryName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, serverId]);

  const handleCopyFile = useCallback(async (targetEntry: RemoteEntry, targetName: string) => {
    try {
      const copiedPath = await invoke<string>('copy_remote_file', {
        serverId,
        sourcePath: targetEntry.path,
        targetName,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setSelectedEntryPath(copiedPath);
      setNotice(`已复制 ${targetEntry.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, loadDirectory, loadTreeChildren, serverId]);

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

      const renamedPath = await invoke<string>('rename_remote_entry', {
        serverId,
        path: targetEntry.path,
        newName: nextValue,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setSelectedEntryPath(renamedPath);
      setNotice(`${targetEntry.name} 已重命名为 ${nextValue}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, handleCopyFile, handleCreateDirectory, handleCreateTextFile, inputDialog, loadDirectory, loadTreeChildren, serverId]);

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
      await invoke('delete_remote_entry', {
        serverId,
        path: targetEntry.path,
      });
      await loadDirectory(currentPath, { quiet: true });
      await loadTreeChildren(currentPath).catch(() => {});
      setSelectedEntryPath((prev) => (prev === targetEntry.path ? null : prev));
      setNotice(`${targetEntry.name} 已删除`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentPath, deleteDialog?.targetEntry, loadDirectory, loadTreeChildren, serverId]);

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
            disabled={node?.status === 'loading'}
            aria-label={expanded ? '收起目录' : '展开目录'}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className="remote-tree-label"
            onClick={() => { void handleSelectTreeNode(path); }}
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
  }, [currentPath, expandedTreePaths, handleSelectTreeNode, handleToggleTreeNode, treeState]);

  return (
    <div className="window-shell window-shell-browser">
      <div className="remote-file-manager remote-file-manager-window">
        <div className="remote-file-toolbar">
          <div className="remote-file-toolbar-main">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { void handleNavigateUp(); }} disabled={!parentPath || loading}>
              返回上一级
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { void handleRefresh(); }} disabled={loading}>
              刷新
            </button>
            <div className="remote-file-breadcrumb" title={currentPath}>
              <span className="remote-file-breadcrumb-kicker">Remote Finder</span>
              <span className="remote-file-breadcrumb-path">{currentPath}</span>
            </div>
          </div>
          <div className="remote-file-toolbar-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { void handleUpload(); }} disabled={busyAction !== null}>
              {busyAction === 'upload' ? '上传中...' : '上传文件'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => { void handleDownload(); }}
              disabled={busyAction !== null || !selectedEntry || isDirectory(selectedEntry)}
            >
              {busyAction === 'download' ? '下载中...' : '下载到本地'}
            </button>
          </div>
        </div>

        {(notice || error) && (
          <div className={error ? 'error-message remote-file-banner' : 'success-message remote-file-banner'}>
            {error || notice}
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
              <div className="remote-file-list" onContextMenu={(event) => openContextMenu(event, null)}>
                {loading && (
                  <div className="remote-file-empty">正在读取目录...</div>
                )}
                {!loading && entries.length === 0 && (
                  <div className="remote-file-empty">这个目录当前没有文件。</div>
                )}
                {!loading && entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`remote-file-row ${selectedEntryPath === entry.path ? 'selected' : ''}`}
                    onClick={() => setSelectedEntryPath(entry.path)}
                    onDoubleClick={() => { void handleEntryDoubleClick(entry); }}
                    onContextMenu={(event) => openContextMenu(event, entry)}
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
            disabled={!canCopyFile}
          >
            复制文件
          </button>
          <button type="button" onClick={() => { void handleRenameEntry(); }} disabled={!canManageEntry}>
            重命名
          </button>
          <button type="button" onClick={() => { void handleDeleteEntry(); }} disabled={!canManageEntry}>
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
