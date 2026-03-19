import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AIProviderManager, createProvider } from './providers/aiProvider';
import { AIChat } from './components/AIChat';
import { InteractiveTerminal } from './components/InteractiveTerminal';
import { ServerList } from './components/ServerList';
import { Settings } from './components/Settings';
import { ProviderSelector } from './components/ProviderSelector';
import { TabBar } from './components/TabBar';
import { ServerStatus } from './components/ServerStatus';
import { UnlockScreen } from './components/UnlockScreen';
import { useCommandDatabase } from './hooks/useCommandDatabase';
import type { ServerInfo, CommandHistory, TerminalContext, CommandOutput, ServerTab, ServerBanner } from './types';
import './App.css';

function App() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [tabs, setTabs] = useState<ServerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [providerManager] = useState(() => new AIProviderManager());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiSectionWidth, setAiSectionWidth] = useState(350);
  const [isLocked, setIsLocked] = useState(true);
  const [commandToFill, setCommandToFill] = useState<string>('');
  const isDraggingRef = useRef(false);

  // Command database hook
  const { search: searchCommands } = useCommandDatabase();

  // Get active tab's state
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId]);

  // Get command history for active tab
  const [commandHistoryMap, setCommandHistoryMap] = useState<Record<string, CommandHistory[]>>({});
  const [currentOutputMap, setCurrentOutputMap] = useState<Record<string, string>>({});
  const [welcomeBannerMap, setWelcomeBannerMap] = useState<Record<string, ServerBanner>>({});
  const [serverHostnameMap, setServerHostnameMap] = useState<Record<string, string>>({});

  const commandHistory = activeTab ? (commandHistoryMap[activeTab.id] || []) : [];
  const currentOutput = activeTab ? (currentOutputMap[activeTab.id] || '') : '';

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

  const loadServers = useCallback(async () => {
    try {
      const serverList = await invoke<ServerInfo[]>('load_servers');
      setServers(serverList);
    } catch (err) {
      console.error('Failed to load servers:', err);
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

  useEffect(() => {
    checkMasterPassword();
    loadProviderConfig();
  }, [checkMasterPassword, loadProviderConfig]);

  // Keyboard shortcuts: Cmd+B for sidebar, Cmd+1-9 for tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
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
        };
        setCommandHistoryMap(prev => ({
          ...prev,
          [activeTab.id]: [...(prev[activeTab.id] || []), historyEntry],
        }));
        setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: '' }));

        // Update current directory if the command changed it
        const dirMatch = command.match(/^cd\s+(.+)$/);
        if (dirMatch) {
          const newDir = dirMatch[1];
          setTabs(prev => prev.map(t =>
            t.id === activeTab.id ? { ...t, currentDir: newDir } : t
          ));
        }
      } else if (result.error) {
        setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: `错误: ${result.error}` }));
      }
    } catch (err) {
      setCurrentOutputMap(prev => ({ ...prev, [activeTab.id]: `执行失败: ${err instanceof Error ? err.message : 'Unknown error'}` }));
    }
  }, [activeTab, activeTabId]);

  const handleCommandComplete = useCallback(async (partial: string): Promise<string[]> => {
    try {
      return await invoke<string[]>('get_command_suggestions', { partial });
    } catch {
      return [];
    }
  }, []);

  const handleCommandFill = useCallback((command: string) => {
    setCommandToFill(command);
  }, []);

  const handleServerSelect = useCallback((serverId: string) => {
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
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setCommandHistoryMap(prev => ({ ...prev, [newTab.id]: [] }));
    setCurrentOutputMap(prev => ({ ...prev, [newTab.id]: '' }));

    // Fetch welcome banner for this server
    invoke<ServerBanner>('get_server_banner', { serverId })
      .then(banner => {
        setWelcomeBannerMap(prev => ({ ...prev, [newTab.id]: banner }));
        setServerHostnameMap(prev => ({ ...prev, [newTab.id]: banner.hostname }));
      })
      .catch(err => {
        console.error('Failed to fetch server banner:', err);
      });
  }, [servers, tabs]);

  const handleTabSelect = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const handleTabClose = useCallback((tabId: string) => {
    if (tabs.length <= 1) return; // Keep at least one tab

    const tabIndex = tabs.findIndex(t => t.id === tabId);
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
      const newIndex = Math.min(tabIndex, tabs.length - 2);
      setActiveTabId(tabs[newIndex]?.id || null);
    }
  }, [tabs, activeTabId]);

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
          <button className="btn btn-icon" onClick={() => setShowSettings(true)} title="设置">
            ⚙️
          </button>
        </div>
        <div className="sidebar-content">
          <ServerList
            servers={servers}
            selectedServer={activeTab?.serverId || null}
            onServerSelect={handleServerSelect}
            onServersChange={fetchServers}
          />
          <ServerStatus serverId={activeTab?.serverId || null} />
        </div>
      </aside>

      <main className="main-content">
        <div className="content-area">
          <div className="terminal-section">
            {tabs.length > 0 && (
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId || ''}
                onTabSelect={handleTabSelect}
                onTabClose={handleTabClose}
                onNewTab={handleNewTab}
              />
            )}
            <div className="terminal-container">
              {activeTab ? (
                <InteractiveTerminal
                  history={commandHistory}
                  currentOutput={currentOutput}
                  serverTab={activeTab}
                  serverUsername={servers.find(s => s.id === activeTab.serverId)?.username}
                  serverHostname={activeTab ? serverHostnameMap[activeTab.id] : undefined}
                  commandToFill={commandToFill}
                  welcomeBanner={activeTab ? welcomeBannerMap[activeTab.id] : undefined}
                  onCommandSubmit={handleCommandSubmit}
                  onCommandComplete={handleCommandComplete}
                  onCommandFill={handleCommandFill}
                />
              ) : (
                <div className="terminal-empty">
                  <p>请从左侧选择一个服务器开始</p>
                  <p className="hint">或者点击 + 新建标签页</p>
                </div>
              )}
            </div>
          </div>
          <div className="resize-handle resize-handle-right" onMouseDown={handleResizeMouseDown} />
          <div className="ai-section" style={{ width: aiSectionWidth }}>
            <ProviderSelector providerManager={providerManager} />
            <AIChat
              providerManager={providerManager}
              context={terminalContext}
              onCommandExecute={handleCommandSubmit}
              onCommandFill={handleCommandFill}
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
