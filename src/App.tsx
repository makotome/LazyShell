import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AIProviderManager, createProvider } from './providers/aiProvider';
import { AIChat } from './components/AIChat';
import { Terminal } from './components/Terminal';
import { ServerList } from './components/ServerList';
import { Settings } from './components/Settings';
import { ProviderSelector } from './components/ProviderSelector';
import { TabBar } from './components/TabBar';
import { ServerStatus } from './components/ServerStatus';
import { UnlockScreen } from './components/UnlockScreen';
import { useCommandDatabase } from './hooks/useCommandDatabase';
import type { ServerInfo, CommandHistory, CommandHistoryFile, TerminalContext, CommandOutput, ServerTab, LayoutMode } from './types';
import './App.css';

function normalizePosixPath(path: string): string {
  if (!path.trim()) {
    return '/';
  }

  const absolute = path.startsWith('/');
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (absolute) {
    return joined ? `/${joined}` : '/';
  }

  return joined ? `/${joined}` : '/';
}

function resolveNextDirectory(command: string, currentDir: string, previousDir?: string): { currentDir: string; previousDir?: string } | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const [head, ...rest] = parts;
  const target = rest.join(' ').trim();

  const resolveTarget = (value: string) => {
    if (!value || value === '~') {
      return '/';
    }
    if (value.startsWith('/')) {
      return normalizePosixPath(value);
    }
    return normalizePosixPath(`${currentDir}/${value}`);
  };

  if (head === 'cd') {
    if (target === '-') {
      return previousDir ? { currentDir: previousDir, previousDir: currentDir } : null;
    }

    return {
      currentDir: resolveTarget(target),
      previousDir: currentDir,
    };
  }

  if (head === 'pushd' && target) {
    return {
      currentDir: resolveTarget(target),
      previousDir: currentDir,
    };
  }

  if (head === 'popd' && previousDir) {
    return {
      currentDir: previousDir,
      previousDir: currentDir,
    };
  }

  return null;
}

function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [tabs, setTabs] = useState<ServerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isServerFormOpen, setIsServerFormOpen] = useState(false);
  const [isServerListExpanded, setIsServerListExpanded] = useState(false);
  const [providerManager] = useState(() => new AIProviderManager());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiSectionCollapsed, setAiSectionCollapsed] = useState(false);
  const [aiSectionWidth, setAiSectionWidth] = useState(350);
  const [isLocked, setIsLocked] = useState(true);
  const [shellSessions, setShellSessions] = useState<Record<string, boolean>>({});
  const isDraggingRef = useRef(false);
  const recentHistoryWriteRef = useRef<Record<string, { command: string; timestamp: number }>>({});
  const shellSessionsRef = useRef<Record<string, boolean>>({});

  // Compute layout mode from sidebar/ai collapsed states
  const layoutMode = useMemo<LayoutMode>(() => {
    if (!sidebarCollapsed && aiSectionCollapsed) return 'sidebar-terminal';
    if (!sidebarCollapsed && !aiSectionCollapsed) return 'all';
    if (sidebarCollapsed && !aiSectionCollapsed) return 'terminal-ai';
    return 'terminal-fullscreen';
  }, [sidebarCollapsed, aiSectionCollapsed]);

  const handleLayoutChange = useCallback((mode: LayoutMode) => {
    switch (mode) {
      case 'sidebar-terminal':
        setSidebarCollapsed(false);
        setAiSectionCollapsed(true);
        break;
      case 'all':
        setSidebarCollapsed(false);
        setAiSectionCollapsed(false);
        break;
      case 'terminal-ai':
        setSidebarCollapsed(true);
        setAiSectionCollapsed(false);
        break;
      case 'terminal-fullscreen':
        setSidebarCollapsed(true);
        setAiSectionCollapsed(true);
        break;
    }
  }, []);

  // Command database hook
  const { search: searchCommands } = useCommandDatabase();

  // Get active tab's state
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId]);
  const activeServerInfo = useMemo(
    () => servers.find(server => server.id === activeTab?.serverId) || null,
    [servers, activeTab?.serverId]
  );

  // Get command history for active tab
  const [commandHistoryMap, setCommandHistoryMap] = useState<Record<string, CommandHistory[]>>({});
  const [, setCurrentOutputMap] = useState<Record<string, string>>({});

  const commandHistory = activeTab ? (commandHistoryMap[activeTab.id] || []) : [];

  const terminalContext = useMemo<TerminalContext>(() => ({
    currentDir: activeTab?.currentDir || '/',
    recentCommands: commandHistory.slice(-10),
    sessionState: {
      connectedServer: activeTab?.serverName || servers.find(s => s.id === activeTab?.serverId)?.name,
      isConnected: !!activeTab,
    },
  }), [commandHistory, activeTab, servers]);

  const fetchServers = useCallback(async () => {
    try {
      const serverList = await invoke<ServerInfo[]>('list_servers');
      setServers(serverList);
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    }
  }, []);

  const loadProviderConfig = useCallback(async () => {
    try {
      const providers = await invoke<Array<{
        id: string;
        type: string;
        name: string;
        api_key: string;
        base_url: string | null;
        model: string | null;
      }>>('load_provider_config');

      for (const p of providers) {
        const aiProvider = createProvider({
          type: p.type as 'minimax' | 'openai' | 'anthropic',
          name: p.name,
          apiKey: p.api_key,
          baseUrl: p.base_url || undefined,
          model: p.model || 'default',
        });
        providerManager.addProvider(p.id, aiProvider);
      }
    } catch (err) {
      console.error('Failed to load provider config:', err);
    }
  }, [providerManager]);

  const checkMasterPassword = useCallback(async () => {
    try {
      const hasPassword = await invoke<boolean>('has_master_password');
      // If no password is set, we stay locked (UnlockScreen will show setup mode)
      // If password is set, UnlockScreen will show unlock mode
      console.log('Has master password:', hasPassword);
    } catch {
      // Auth file doesn't exist, will show setup mode
    }
  }, []);

  const handleUnlock = useCallback(async () => {
    setIsLocked(false);
    // Load servers after unlocking
    try {
      const serverList = await invoke<ServerInfo[]>('load_servers');
      setServers(serverList);
      // Also refresh the server list
      await fetchServers();
    } catch (err) {
      console.error('Failed to load servers after unlock:', err);
    }
  }, [fetchServers]);

  const appendHistoryEntry = useCallback((tabId: string, serverId: string, entry: CommandHistory) => {
    const recent = recentHistoryWriteRef.current[tabId];
    const isNearDuplicate =
      recent &&
      recent.command.trim() === entry.command.trim() &&
      entry.timestamp - recent.timestamp < 1200;

    if (isNearDuplicate) {
      return;
    }

    recentHistoryWriteRef.current[tabId] = {
      command: entry.command,
      timestamp: entry.timestamp,
    };

    setCommandHistoryMap(prev => ({
      ...prev,
      [tabId]: [...(prev[tabId] || []), entry],
    }));

    invoke('append_command_history', {
      serverId,
      entry,
    }).catch(err => {
      console.error('Failed to persist command history:', err);
    });
  }, []);

  useEffect(() => {
    checkMasterPassword();
    loadProviderConfig();
  }, [checkMasterPassword, loadProviderConfig]);

  // Keyboard shortcuts: Cmd+B for sidebar, Cmd+Shift+I for AI, Cmd+1-9 for tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        setAiSectionCollapsed((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        if (index < tabs.length) {
          setActiveTabId(tabs[index].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs]);

  const handleCommandSubmit = useCallback(async (command: string) => {
    if (!activeTab) {
      setCurrentOutputMap(prev => ({ ...prev, [activeTabId || '']: '错误: 请先选择一台服务器' }));
      return;
    }

    setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: `正在执行: ${command}\n` }));

    try {
      const result = await invoke<{
        success: boolean;
        output?: CommandOutput;
        error?: string;
        requires_confirmation?: boolean;
      }>('execute_command', {
        request: {
          server_id: activeTab.serverId,
          command,
          force_dangerous: false,
        },
      });

      if (result.requires_confirmation) {
        return;
      }

      if (result.success && result.output) {
        const historyEntry: CommandHistory = {
          command,
          output: result.output.stdout + (result.output.stderr ? '\n' + result.output.stderr : ''),
          exitCode: result.output.exit_code,
          timestamp: Date.now(),
          source: 'direct',
        };
        appendHistoryEntry(activeTab.id, activeTab.serverId, historyEntry);
        setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: '' }));

        // Update current directory if the command changed it
        const nextDirectory = resolveNextDirectory(command, activeTab.currentDir, activeTab.previousDir);
        if (nextDirectory) {
          setTabs(prev => prev.map(t =>
            t.id === activeTab.id ? { ...t, ...nextDirectory } : t
          ));
        }
      } else if (result.error) {
        setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: `错误: ${result.error}` }));
      }
    } catch (err) {
      setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: `执行失败: ${err instanceof Error ? err.message : 'Unknown error'}` }));
    }
  }, [activeTab, activeTabId, appendHistoryEntry]);

  const handleTerminalExecute = useCallback((command: string, source: CommandHistory['source'] = 'terminal') => {
    if (!activeTabId || !activeTab) return;

    invoke('shell_input', { tabId: activeTabId, data: `${command}\r` }).catch(err => {
      console.error('Failed to send command to terminal:', err);
    });

    const historyEntry: CommandHistory = {
      command,
      output: '通过终端执行，输出将在交互式会话中显示。',
      exitCode: 0,
      timestamp: Date.now(),
      source,
    };

    appendHistoryEntry(activeTab.id, activeTab.serverId, historyEntry);

    const nextDirectory = resolveNextDirectory(command, activeTab.currentDir, activeTab.previousDir);
    if (nextDirectory) {
      setTabs(prev => prev.map(t =>
        t.id === activeTab.id ? { ...t, ...nextDirectory } : t
      ));
    }
  }, [activeTab, activeTabId, appendHistoryEntry]);

  const reloadActiveCommandHistory = useCallback(async () => {
    if (!activeTab) return;

    try {
      const persistedHistory = await invoke<CommandHistoryFile>('load_command_history', {
        serverId: activeTab.serverId,
      });
      setCommandHistoryMap(prev => ({
        ...prev,
        [activeTab.id]: persistedHistory.entries,
      }));
    } catch (err) {
      console.error('Failed to reload command history:', err);
    }
  }, [activeTab]);

  const clearActiveCommandHistory = useCallback(() => {
    if (!activeTab) return;

    setCommandHistoryMap(prev => ({
      ...prev,
      [activeTab.id]: [],
    }));
  }, [activeTab]);

  const handleServerSelect = useCallback(async (serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;

    // Check if there's already a tab for this server
    const existingTab = tabs.find(t => t.serverId === serverId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    // Create a new tab
    const newTab: ServerTab = {
      id: `tab-${Date.now()}`,
      serverId: server.id,
      serverName: server.name,
      currentDir: '/',
      previousDir: undefined,
    };

    // Create shell session for the new tab FIRST
    const tabId = newTab.id;
    try {
      await invoke('create_shell_session', {
        serverId: server.id,
        tabId,
        rows: 24,
        cols: 80,
      });

      // Only add tab to state AFTER shell is created successfully
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
      try {
        const persistedHistory = await invoke<CommandHistoryFile>('load_command_history', {
          serverId: server.id,
        });
        setCommandHistoryMap(prev => ({ ...prev, [newTab.id]: persistedHistory.entries }));
      } catch (err) {
        console.error('Failed to load persisted command history:', err);
        setCommandHistoryMap(prev => ({ ...prev, [newTab.id]: [] }));
      }
      setCurrentOutputMap(prev => ({ ...prev, [newTab.id]: '' }));
      setShellSessions(prev => ({ ...prev, [tabId]: true }));
    } catch (err) {
      console.error('Failed to create shell session:', err);
      // No orphaned tab since we didn't add it yet
      return;
    }

  }, [servers, tabs]);

  const handleTabSelect = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleTabClose = useCallback((tabId: string) => {
    // Close shell session for this tab
    invoke('close_shell_session', { tabId }).catch(err => {
      console.error('Failed to close shell session:', err);
    });
    setShellSessions(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });

    setTabs(prev => prev.filter(t => t.id !== tabId));

    // Clean up state for closed tab
    setCommandHistoryMap(prev => {
      const newMap = { ...prev };
      delete newMap[tabId];
      return newMap;
    });
    setCurrentOutputMap(prev => {
      const newMap = { ...prev };
      delete newMap[tabId];
      return newMap;
    });

    // If closing active tab, select another
    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(t => t.id !== tabId);
      setActiveTabId(remainingTabs[0]?.id || null);
    }
  }, [activeTabId, tabs]);

  const handleNewTab = useCallback(() => {
    // If there are servers, open a dialog to select one
    // For now, just use the first server if available
    if (servers.length > 0) {
      handleServerSelect(servers[0].id);
    }
  }, [servers, handleServerSelect]);

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  // Cleanup: Close all shell sessions on unmount
  useEffect(() => {
    shellSessionsRef.current = shellSessions;
  }, [shellSessions]);

  useEffect(() => {
    return () => {
      Object.keys(shellSessionsRef.current).forEach(tabId => {
        invoke('close_shell_session', { tabId }).catch(console.error);
      });
    };
  }, []);

  // Drag handlers for AI section resize
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const windowWidth = window.innerWidth;
      const newWidth = windowWidth - e.clientX;
      if (newWidth >= 280 && newWidth <= 500) {
        setAiSectionWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  if (isLocked) {
    return <UnlockScreen onUnlock={handleUnlock} />;
  }

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <h1 className="app-title">LazyShell</h1>
        </div>
        <div className="sidebar-content">
          <div className="sidebar-status-section">
            <ServerStatus
              serverId={activeTab?.serverId || null}
              serverName={activeServerInfo?.name || null}
              serverHost={activeServerInfo?.host || null}
            />
          </div>
          <div className="sidebar-spacer" />
          <div className="sidebar-list-section">
            <button
              className={`sidebar-section-header sidebar-section-toggle ${isServerListExpanded ? 'expanded' : ''}`}
              type="button"
              onClick={() => setIsServerListExpanded(prev => !prev)}
            >
              <span className="sidebar-section-title">服务器</span>
              <span className="sidebar-section-meta">{servers.length} 台</span>
              <span className="sidebar-section-caret">{isServerListExpanded ? '▾' : '▴'}</span>
            </button>
            <div className={`sidebar-list-panel ${isServerListExpanded ? 'expanded' : ''}`}>
              <ServerList
                servers={servers}
                selectedServer={activeTab?.serverId || null}
                onServerSelect={(serverId) => {
                  handleServerSelect(serverId);
                  setIsServerListExpanded(false);
                }}
                onServersChange={fetchServers}
                showHeader={false}
                addFormOpen={isServerFormOpen}
                onAddFormOpenChange={setIsServerFormOpen}
              />
            </div>
          </div>
          <div className="sidebar-actions">
            <button
              className={`btn btn-primary btn-full ${isServerFormOpen ? 'sidebar-add-btn-open' : ''}`}
              onClick={() => setIsServerFormOpen(prev => !prev)}
            >
              {isServerFormOpen ? '收起添加服务器' : '添加服务器'}
            </button>
          </div>
          <div className="sidebar-footer">
            <button className="btn btn-secondary btn-full" onClick={() => setShowSettings(true)} title="设置">
              设置
            </button>
          </div>
        </div>
      </aside>

      <button
        className="collapse-btn collapse-btn-sidebar"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {sidebarCollapsed ? '▶' : '◀'}
      </button>

      <main className="main-content">
        <div className="content-area">
          <div className="terminal-section">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId || ''}
              onTabSelect={handleTabSelect}
              onTabClose={handleTabClose}
              onNewTab={handleNewTab}
              layoutMode={layoutMode}
              onLayoutChange={handleLayoutChange}
            />
            <div className="terminal-container">
              {tabs.map((tab) => (
                <Terminal
                  key={tab.id}
                  tabId={tab.id}
                  serverId={tab.serverId}
                  serverName={tab.serverName}
                  currentDir={tab.currentDir}
                  isActive={tab.id === activeTabId}
                />
              ))}
            </div>
          </div>
          <button
            className="collapse-btn collapse-btn-ai"
            onClick={() => setAiSectionCollapsed(!aiSectionCollapsed)}
            title={aiSectionCollapsed ? "展开 AI 助手" : "收起 AI 助手"}
          >
            {aiSectionCollapsed ? '◀' : '▶'}
          </button>

          {!aiSectionCollapsed && (
            <div className="resize-handle resize-handle-right" onMouseDown={handleResizeMouseDown} />
          )}

          <div className={`ai-section ${aiSectionCollapsed ? 'collapsed' : ''}`} style={{ width: aiSectionCollapsed ? 0 : aiSectionWidth }}>
            <ProviderSelector providerManager={providerManager} />
            <AIChat
              providerManager={providerManager}
              context={terminalContext}
              tabId={activeTabId || ''}
              serverId={activeTab?.serverId || ''}
              commandHistory={commandHistory}
              onCommandExecute={handleCommandSubmit}
              onTerminalExecute={handleTerminalExecute}
              onCommandHistoryReload={reloadActiveCommandHistory}
              onCommandHistoryClear={clearActiveCommandHistory}
              commandDb={{ search: searchCommands }}
            />
          </div>
        </div>
      </main>

      {showSettings && <Settings onClose={handleCloseSettings} />}
    </div>
  );
}

export default App;
