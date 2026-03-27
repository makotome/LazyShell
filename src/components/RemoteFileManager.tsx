import { useCallback, useEffect, useMemo, useState } from 'react';
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

      setExpandedTreePaths((prev) => ({
        ...prev,
        [payload.currentPath]: true,
      }));
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
      setError(message);
      throw err;
    } finally {
      if (!options?.quiet) {
        setLoading(false);
      }
    }
  }, [serverId, serverName]);

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
              <div className="remote-file-list">
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
    </div>
  );
}
