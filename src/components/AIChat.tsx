import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, AIResponse, TerminalContext, LearningDataEntry, BuiltinCommand, AICommandOption, CommandCard, CommandCategory, CommandDatabase, CommandHistory } from '../types';
import { AIProviderManager } from '../providers/aiProvider';
import { useMemory } from '../hooks/useMemory';

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  file: '文件', text: '文本', system: '系统', network: '网络',
  process: '进程', archive: '压缩', disk: '磁盘', package: '包管理', other: '其他',
};

interface AIChatProps {
  providerManager: AIProviderManager;
  context: TerminalContext;
  tabId: string;
  serverId: string;
  commandHistory: CommandHistory[];
  onCommandExecute: (command: string, naturalLanguage?: string) => void;
  onTerminalExecute: (command: string, source?: CommandHistory['source']) => void;
  onCommandHistoryReload: () => Promise<void>;
  onCommandHistoryClear: () => void;
  commandDb?: {
    search: (keyword: string) => Promise<BuiltinCommand[]>;
  };
}

export function AIChat({ providerManager, context, tabId, serverId, commandHistory, onCommandExecute, onTerminalExecute, onCommandHistoryReload, onCommandHistoryClear, commandDb }: AIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'ai',
      content: '你好！我是 LazyShell AI 助手。告诉我你想在服务器上执行什么操作，我会帮你生成相应的命令。',
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<AIResponse | null>(null);
  const [commandOptions, setCommandOptions] = useState<AICommandOption[]>([]);
  const [lastUserInput, setLastUserInput] = useState<string>('');
  const [learningData, setLearningData] = useState<LearningDataEntry[]>([]);
  const [clarificationContext, setClarificationContext] = useState<string | null>(null);
  const [executedOptionIndexes, setExecutedOptionIndexes] = useState<Set<number>>(new Set());
  const [addedOptionIndexes, setAddedOptionIndexes] = useState<Set<number>>(new Set());
  const [builtinCommands, setBuiltinCommands] = useState<BuiltinCommand[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historySourceFilter, setHistorySourceFilter] = useState<'all' | NonNullable<CommandHistory['source']>>('all');
  const [historyDedupe, setHistoryDedupe] = useState(true);
  const [isConfirmingClearHistory, setIsConfirmingClearHistory] = useState(false);
  const [historyTrimCount, setHistoryTrimCount] = useState<'50' | '100' | '300'>('100');
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editingCardDraft, setEditingCardDraft] = useState<Pick<CommandCard, 'naturalLanguage' | 'command' | 'description'> | null>(null);
  const [executionEditor, setExecutionEditor] = useState<{
    source: 'history' | 'builtin' | 'favorite' | 'ai';
    title: string;
    description?: string;
    command: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<'chat' | 'history' | 'commands' | 'builtin'>('chat');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Use memory hook
  const {
    chatHistory,
    commandCards,
    hasMoreHistory,
    loadChatHistory,
    appendChatEntry,
    addCommandCard,
    updateCommandCard,
    removeCommandCard,
    updateCardUsage,
    getDangerLevel,
  } = useMemory({ serverId });

  // Load learning data on mount
  useEffect(() => {
    const loadLearning = async () => {
      try {
        const data = await invoke<LearningDataEntry[]>('load_learning_data');
        setLearningData(data);
      } catch (err) {
        console.error('Failed to load learning data:', err);
      }
    };
    loadLearning();
  }, []);

  // Load built-in commands database
  useEffect(() => {
    invoke<CommandDatabase>('load_commands_db')
      .then(db => setBuiltinCommands(db.commands))
      .catch(err => console.error('Failed to load commands db:', err));
  }, []);

  // Reset history state when server changes
  useEffect(() => {
    setHistoryLoaded(false);
    setMessages([{
      id: 'welcome',
      role: 'ai',
      content: '你好！我是 LazyShell AI 助手。告诉我你想在服务器上执行什么操作，我会帮你生成相应的命令。',
      timestamp: Date.now(),
    }]);
  }, [serverId]);

  // Integrate chat history into messages on initial load
  useEffect(() => {
    if (historyLoaded || chatHistory.length === 0) return;
    const historyMessages: ChatMessage[] = chatHistory.map(entry => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      command: entry.command,
      explanation: entry.explanation,
      dangerLevel: entry.dangerLevel,
      options: entry.options,
      timestamp: entry.timestamp,
    }));
    historyMessages.push({
      id: 'history-divider',
      role: 'ai',
      content: '── 以上为历史对话 ──',
      timestamp: Date.now(),
    });
    setMessages(prev => {
      // Remove welcome message if we have history
      const withoutWelcome = prev.filter(m => m.id !== 'welcome');
      return [...historyMessages, ...withoutWelcome];
    });
    setHistoryLoaded(true);
  }, [chatHistory, historyLoaded]);

  // Save learning data helper
  const saveLearningData = useCallback(async (entries: LearningDataEntry[]) => {
    try {
      await invoke('save_learning_data', { entries });
      setLearningData(entries);
    } catch (err) {
      console.error('Failed to save learning data:', err);
    }
  }, []);

  // Find matching command from learning data
  const findLearningMatch = useCallback((input: string): string | null => {
    const normalizedInput = input.toLowerCase().trim();

    // Find exact or close match
    for (const entry of learningData) {
      const normalizedEntry = entry.natural_language.toLowerCase().trim();
      if (normalizedInput === normalizedEntry) {
        return entry.command;
      }
      // Partial match - input contains entry or entry contains input
      if (normalizedInput.includes(normalizedEntry) || normalizedEntry.includes(normalizedInput)) {
        return entry.command;
      }
    }
    return null;
  }, [learningData]);

  // Record successful command mapping
  const recordLearning = useCallback((input: string, command: string) => {
    const normalizedInput = input.toLowerCase().trim();
    const now = Date.now();

    const existingIndex = learningData.findIndex(
      e => e.natural_language.toLowerCase().trim() === normalizedInput && e.command === command
    );

    let newData: LearningDataEntry[];
    if (existingIndex >= 0) {
      // Update existing entry
      newData = learningData.map((entry, idx) =>
        idx === existingIndex
          ? { ...entry, usage_count: entry.usage_count + 1, last_used: now }
          : entry
      );
    } else {
      // Add new entry
      const newEntry: LearningDataEntry = {
        id: `learn-${now}`,
        natural_language: input.trim(),
        command,
        server_os: 'linux',
        usage_count: 1,
        last_used: now,
      };
      newData = [...learningData, newEntry];
    }

    saveLearningData(newData);
  }, [learningData, saveLearningData]);

  // Build enriched context with memory for AI calls
  const contextWithMemory = useMemo<TerminalContext>(() => ({
    ...context,
    memoryContext: {
      frequentCommands: [...commandCards]
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 5)
        .map(c => ({ command: c.command, description: c.description, usageCount: c.usageCount })),
      recentChatSummary: chatHistory
        .filter(e => e.command)
        .slice(-3)
        .map(e => `${e.content}${e.command ? ` → ${e.command}` : ''}`),
    },
  }), [context, commandCards, chatHistory]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll-to-top to load more history
  const handleChatScroll = useCallback(async () => {
    const container = chatContainerRef.current;
    if (!container || !hasMoreHistory || loadingMoreHistory) return;
    if (container.scrollTop > 0) return;

    setLoadingMoreHistory(true);
    const prevScrollHeight = container.scrollHeight;
    try {
      const result = await loadChatHistory(chatHistory.length, 50);
      if (result && result.entries.length > 0) {
        const olderMessages: ChatMessage[] = result.entries.map(entry => ({
          id: entry.id,
          role: entry.role,
          content: entry.content,
          command: entry.command,
          explanation: entry.explanation,
          dangerLevel: entry.dangerLevel,
          options: entry.options,
          timestamp: entry.timestamp,
        }));
        setMessages(prev => [...olderMessages, ...prev]);
        // Restore scroll position after prepending
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        });
      }
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [hasMoreHistory, loadingMoreHistory, chatHistory.length, loadChatHistory]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setLastUserInput(input);
    setInput('');
    setIsLoading(true);
    setCommandOptions([]);
    setExecutedOptionIndexes(new Set());
    setAddedOptionIndexes(new Set());

    try {
      let response: AIResponse | null = null;
      let source = '';

      // If in clarification multi-turn mode, skip local checks and send combined context to AI
      if (clarificationContext) {
        const provider = providerManager.getActiveProvider();
        if (!provider) {
          throw new Error('No AI provider configured');
        }
        const combinedPrompt = `之前的问题: ${clarificationContext}\n用户回答: ${input}`;
        response = await provider.complete(combinedPrompt, contextWithMemory);
        source = 'AI';
        setClarificationContext(null);
      } else {
        // 1. First check local command database
        if (commandDb) {
          const localMatches = await commandDb.search(input);
          if (localMatches.length > 0) {
            const match = localMatches[0];
            response = {
              command: match.name,
              explanation: `${match.description}。示例: ${match.examples[0]?.command || match.name}`,
              isDangerous: false,
              intent: 'single',
            };
            source = '本地命令库';
          }
        }

        // 2. Then check learning data for a match
        if (!response) {
          const learnedCommand = findLearningMatch(input);
          if (learnedCommand) {
            response = {
              command: learnedCommand,
              explanation: '（来自历史学习）',
              isDangerous: false,
              intent: 'single',
            };
            source = '历史学习';
          }
        }

        // 3. Finally call AI provider
        if (!response) {
          const provider = providerManager.getActiveProvider();
          if (!provider) {
            throw new Error('No AI provider configured');
          }
          response = await provider.complete(input, contextWithMemory);
          source = 'AI';
        }
      }

      const limitedOptions = response.options && response.options.length > 0
        ? response.options.slice(0, 5)
        : undefined;

      const aiMessage: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'ai',
        content: `${response.explanation || ''} [${source}]`,
        command: response.command,
        explanation: response.explanation,
        isDangerous: response.isDangerous,
        options: limitedOptions,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, aiMessage]);

      // Save to chat history
      try {
        const dangerLevel = await getDangerLevel(response.command || '');
        await appendChatEntry({
          serverId,
          role: 'user',
          content: input,
          dangerLevel: 'green',
        });
        await appendChatEntry({
          serverId,
          role: 'ai',
          content: `${response.explanation || ''} [${source}]`,
          command: response.command,
          explanation: response.explanation,
          dangerLevel,
          options: limitedOptions,
        });
      } catch (err) {
        console.error('Failed to save chat history:', err);
      }

      // Handle multiple options mode
      if (limitedOptions && limitedOptions.length > 0) {
        setCommandOptions(limitedOptions);
      } else if (response.intent === 'clarification') {
        // Clarification mode: save context for multi-turn follow-up
        setClarificationContext(response.explanation || input);
      } else if (response.isDangerous) {
        // Dangerous command: show warning + execute button
        setPendingCommand(response);
      } else if (response.command) {
        recordLearning(input, response.command);
        onTerminalExecute(response.command, 'ai');
      }
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'ai',
        content: `错误: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, providerManager, contextWithMemory, onCommandExecute, onTerminalExecute, tabId, commandDb, findLearningMatch, clarificationContext, serverId, getDangerLevel, appendChatEntry, recordLearning]);

  const handleCommandConfirm = useCallback(async () => {
    if (pendingCommand && pendingCommand.command) {
      const command = pendingCommand.command;
      const explanation = pendingCommand.explanation || '';

      // Execute the command
      onCommandExecute(command, lastUserInput);
      recordLearning(lastUserInput, command);

      // Add to messages for persistence in chat
      const dangerLevel = await getDangerLevel(command);
      const executedMessage: ChatMessage = {
        id: `executed-${Date.now()}`,
        role: 'ai',
        content: `执行命令: ${explanation}`,
        command: command,
        explanation: explanation,
        isDangerous: true,
        dangerLevel,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, executedMessage]);

      // Save to chat history
      try {
        await appendChatEntry({
          serverId,
          role: 'ai',
          content: `执行命令: ${explanation}`,
          command: command,
          explanation: explanation,
          dangerLevel,
        });
      } catch (err) {
        console.error('Failed to save chat history:', err);
      }

      setPendingCommand(null);
    }
  }, [pendingCommand, onCommandExecute, lastUserInput, serverId, getDangerLevel, appendChatEntry, recordLearning]);

  const handleCommandCancel = useCallback(() => {
    setPendingCommand(null);
    const cancelMessage: ChatMessage = {
      id: `cancel-${Date.now()}`,
      role: 'ai',
      content: '命令已取消。',
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, cancelMessage]);
  }, []);

  const handleOptionExecute = useCallback(async (option: AICommandOption, index: number) => {
    if (option.isDangerous) {
      // Dangerous option also needs confirmation
      setPendingCommand({
        command: option.command,
        explanation: option.description,
        isDangerous: true,
        intent: 'single',
      });
      return;
    }

    // Execute the command
    onTerminalExecute(option.command, 'ai');
    recordLearning(lastUserInput, option.command);

    // Get danger level and add to chat history
    const dangerLevel = await getDangerLevel(option.command);

    // Add executed command as a message to persist in chat
    const executedMessage: ChatMessage = {
      id: `executed-${Date.now()}`,
      role: 'ai',
      content: `执行命令: ${option.description}`,
      command: option.command,
      explanation: option.description,
      isDangerous: option.isDangerous,
      dangerLevel,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, executedMessage]);

    // Save to chat history
    try {
      await appendChatEntry({
        serverId,
        role: 'ai',
        content: `执行命令: ${option.description}`,
        command: option.command,
        explanation: option.description,
        dangerLevel,
      });
    } catch (err) {
      console.error('Failed to save chat history:', err);
    }

    // Mark as executed (keep card visible)
    setExecutedOptionIndexes(prev => new Set(prev).add(index));
  }, [serverId, getDangerLevel, appendChatEntry, lastUserInput, recordLearning, onTerminalExecute]);

  const handleAddToFavorites = useCallback(async (option: AICommandOption, index?: number) => {
    // Check if command already exists in favorites
    const existing = commandCards.find(c => c.command.trim() === option.command.trim());
    if (existing) {
      const infoMessage: ChatMessage = {
        id: `info-${Date.now()}`,
        role: 'ai',
        content: `该命令已在常用列表中（已使用 ${existing.usageCount} 次）`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, infoMessage]);
      if (index !== undefined) {
        setAddedOptionIndexes(prev => new Set(prev).add(index));
      }
      return;
    }
    try {
      const dangerLevel = await getDangerLevel(option.command);
      await addCommandCard({
        serverId,
        naturalLanguage: option.description,
        command: option.command,
        description: option.description,
        dangerLevel,
        category: 'system',
      });
      const successMessage: ChatMessage = {
        id: `added-${Date.now()}`,
        role: 'ai',
        content: `✅ 已添加到常用命令：${option.command}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, successMessage]);
      if (index !== undefined) {
        setAddedOptionIndexes(prev => new Set(prev).add(index));
      }
    } catch (err) {
      console.error('Failed to add to favorites:', err);
    }
  }, [serverId, addCommandCard, getDangerLevel, commandCards]);

  const handleCardExecute = useCallback((card: CommandCard) => {
    onTerminalExecute(card.command, 'favorite');
    updateCardUsage(card.id);
  }, [onTerminalExecute, updateCardUsage]);

  const handleCardEditStart = useCallback((card: CommandCard) => {
    setEditingCardId(card.id);
    setEditingCardDraft({
      naturalLanguage: card.naturalLanguage,
      command: card.command,
      description: card.description,
    });
  }, []);

  const handleCardEditCancel = useCallback(() => {
    setEditingCardId(null);
    setEditingCardDraft(null);
  }, []);

  const handleCardDraftChange = useCallback((field: 'naturalLanguage' | 'command' | 'description', value: string) => {
    setEditingCardDraft(prev => prev ? { ...prev, [field]: value } : prev);
  }, []);

  const handleCardSave = useCallback(async (card: CommandCard, executeAfterSave = false) => {
    if (!editingCardDraft) {
      return;
    }

    const nextCommand = editingCardDraft.command.trim();
    if (!nextCommand) {
      return;
    }

    try {
      const dangerLevel = await getDangerLevel(nextCommand);
      const updatedCard: CommandCard = {
        ...card,
        naturalLanguage: editingCardDraft.naturalLanguage.trim() || editingCardDraft.description.trim() || nextCommand,
        command: nextCommand,
        description: editingCardDraft.description.trim(),
        dangerLevel,
      };

      await updateCommandCard(updatedCard);
      setEditingCardId(null);
      setEditingCardDraft(null);

      if (executeAfterSave) {
        onTerminalExecute(updatedCard.command, 'favorite');
        updateCardUsage(updatedCard.id);
      }
    } catch (err) {
      console.error('Failed to save command card:', err);
    }
  }, [editingCardDraft, getDangerLevel, onTerminalExecute, updateCardUsage, updateCommandCard]);

  // Group command cards by category
  const groupedCards = useMemo(() => {
    const groups = new Map<CommandCategory, CommandCard[]>();
    for (const card of commandCards) {
      const cat = (card.category || 'other') as CommandCategory;
      const list = groups.get(cat) || [];
      list.push(card);
      groups.set(cat, list);
    }
    return groups;
  }, [commandCards]);

  // Group builtin commands by category
  const groupedBuiltinCommands = useMemo(() => {
    const groups = new Map<string, BuiltinCommand[]>();
    for (const cmd of builtinCommands) {
      const cat = cmd.category || 'other';
      const list = groups.get(cat) || [];
      list.push(cmd);
      groups.set(cat, list);
    }
    return groups;
  }, [builtinCommands]);

  const handleBuiltinExecute = useCallback((cmd: BuiltinCommand) => {
    const command = cmd.examples[0]?.command || cmd.name;
    onTerminalExecute(command, 'builtin');
  }, [onTerminalExecute]);

  const handleBuiltinAddToFavorites = useCallback(async (cmd: BuiltinCommand) => {
    const option: AICommandOption = {
      command: cmd.name,
      description: cmd.description,
      isDangerous: false,
    };
    await handleAddToFavorites(option);
  }, [handleAddToFavorites]);

  const toggleCategory = useCallback((cat: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }, []);

  const getSourceLabel = (source?: CommandHistory['source']) => {
    switch (source) {
      case 'ai': return 'AI';
      case 'history': return '历史';
      case 'favorite': return '常用';
      case 'builtin': return '内置';
      case 'direct': return '直连';
      case 'terminal': return '终端';
      default: return '未知';
    }
  };

  const recentCommandHistory = useMemo(() => {
    const normalizedQuery = historyQuery.trim().toLowerCase();
    const filtered = commandHistory
      .slice()
      .reverse()
      .filter(entry => {
        if (historySourceFilter !== 'all' && entry.source !== historySourceFilter) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        return (
          entry.command.toLowerCase().includes(normalizedQuery) ||
          entry.output.toLowerCase().includes(normalizedQuery) ||
          getSourceLabel(entry.source).toLowerCase().includes(normalizedQuery)
        );
      });

    return historyDedupe
      ? filtered.filter((entry, index, arr) =>
          arr.findIndex(candidate => candidate.command.trim() === entry.command.trim()) === index
        )
      : filtered;
  }, [commandHistory, historyQuery, historySourceFilter, historyDedupe]);

  const handleHistoryExecute = useCallback((entry: CommandHistory) => {
    onTerminalExecute(entry.command, 'history');
  }, [onTerminalExecute]);

  const handleHistoryAddToFavorites = useCallback(async (entry: CommandHistory) => {
    const option: AICommandOption = {
      command: entry.command,
      description: entry.command,
      isDangerous: false,
    };
    await handleAddToFavorites(option);
  }, [handleAddToFavorites]);

  const openExecutionEditor = useCallback((editor: {
    source: 'history' | 'builtin' | 'favorite' | 'ai';
    title: string;
    description?: string;
    command: string;
  }) => {
    setExecutionEditor(editor);
  }, []);

  const closeExecutionEditor = useCallback(() => {
    setExecutionEditor(null);
  }, []);

  const updateExecutionEditorCommand = useCallback((command: string) => {
    setExecutionEditor(prev => prev ? { ...prev, command } : prev);
  }, []);

  const handleExecutionEditorRun = useCallback(() => {
    if (!executionEditor?.command.trim()) {
      return;
    }

    const sourceMap: Record<'history' | 'builtin' | 'favorite' | 'ai', NonNullable<CommandHistory['source']>> = {
      history: 'history',
      builtin: 'builtin',
      favorite: 'favorite',
      ai: 'ai',
    };

    onTerminalExecute(executionEditor.command.trim(), sourceMap[executionEditor.source]);
    setExecutionEditor(null);
  }, [executionEditor, onTerminalExecute]);

  const handleTrimHistory = useCallback(async () => {
    try {
      await invoke('cleanup_command_history', {
        serverId,
        keepLast: Number(historyTrimCount),
      });
      await onCommandHistoryReload();
    } catch (err) {
      console.error('Failed to trim command history:', err);
    }
  }, [serverId, historyTrimCount, onCommandHistoryReload]);

  const handleClearHistoryRequest = useCallback(() => {
    console.log('[AIChat] Clear history requested', { serverId });
    setIsConfirmingClearHistory(true);
  }, [serverId]);

  const handleClearHistoryCancel = useCallback(() => {
    console.log('[AIChat] Clear history cancelled', { serverId });
    setIsConfirmingClearHistory(false);
  }, [serverId]);

  const handleClearHistoryConfirm = useCallback(async () => {
    console.log('[AIChat] Clear history confirmed', { serverId, beforeCount: commandHistory.length });
    try {
      onCommandHistoryClear();
      setIsConfirmingClearHistory(false);
      await invoke('save_command_history', {
        serverId,
        entries: [],
      });
      console.log('[AIChat] Clear history persisted', { serverId });
      await onCommandHistoryReload();
    } catch (err) {
      console.error('Failed to clear command history:', err);
      await onCommandHistoryReload();
    }
  }, [serverId, commandHistory.length, onCommandHistoryReload, onCommandHistoryClear]);

  return (
    <div className="ai-chat">
      {/* Floating tabs */}
      <div className="ai-chat-tabs">
        <button
          className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          聊天
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          历史
        </button>
        <button
          className={`tab-btn ${activeTab === 'commands' ? 'active' : ''}`}
          onClick={() => setActiveTab('commands')}
        >
          常用
        </button>
        <button
          className={`tab-btn ${activeTab === 'builtin' ? 'active' : ''}`}
          onClick={() => setActiveTab('builtin')}
        >
          内置
        </button>
      </div>

      <div className="ai-chat-content">
        {/* Main content area */}
        <div className="ai-chat-main">
          {/* Chat tab */}
          {activeTab === 'chat' && (
            <>
              <div className="chat-messages" ref={chatContainerRef} onScroll={handleChatScroll}>
                {loadingMoreHistory && (
                  <div className="history-loading-indicator">加载更多历史...</div>
                )}
                {messages.map((msg) => (
                  <div key={msg.id} className={`message message-${msg.role}${msg.id === 'history-divider' ? ' history-divider' : ''}`}>
                    <div className="message-role">{msg.role === 'user' ? '你' : 'AI'}</div>
                    <div className="message-content">
                      {msg.content}
                      {msg.command && (
                        <div className="command-preview">
                          <code>{msg.command}</code>
                        </div>
                      )}
                    </div>
                    {msg.options && msg.options.length > 0 && !commandOptions.length && (
                      <div className="command-options">
                        <div className="options-header">命令选项：</div>
                        {msg.options.map((option, idx) => (
                          <div key={idx} className={`command-option-card danger-${option.isDangerous ? 'red' : 'green'}`}>
                            <div className="option-card-header">
                              <span className={`danger-badge danger-${option.isDangerous ? 'red' : 'green'}`}>
                                {option.isDangerous ? '危险' : '安全'}
                              </span>
                              <span className="option-description">{option.description}</span>
                            </div>
                            <div className="option-card-body">
                              <code className="option-command">{option.command}</code>
                            </div>
                            {option.reason && <div className="option-reason">{option.reason}</div>}
                            <div className="option-card-actions">
                              <button
                                className={`btn ${option.isDangerous ? 'btn-danger' : 'btn-primary'}`}
                                onClick={() => handleOptionExecute(option, idx)}
                              >
                                执行
                              </button>
                              <button
                                className="btn btn-secondary"
                                onClick={() => handleAddToFavorites(option)}
                              >
                                添加到常用
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="message message-ai loading">
                    <div className="message-role">AI</div>
                    <div className="message-content">思考中...</div>
                  </div>
                )}
                {pendingCommand && (
                  <div className="command-confirm-dialog">
                    <div className="danger-warning">
                      <span className="warning-icon">⚠️</span>
                      <span>这是一个危险命令，请确认是否执行</span>
                    </div>
                    <div className="command-preview">
                      <code>{pendingCommand.command}</code>
                    </div>
                    <div className="command-explanation">{pendingCommand.explanation}</div>
                    <div className="command-actions">
                      <button className="btn btn-primary" onClick={handleCommandConfirm}>
                        执行
                      </button>
                      <button className="btn btn-secondary" onClick={handleCommandCancel}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
                {commandOptions.length > 0 && (
                  <div className="command-options">
                    <div className="options-header">请选择要执行的命令：</div>
                    {executionEditor?.source === 'ai' && (
                      <div className="command-editor-bar">
                        <div className="command-editor-header">
                          <span className="command-editor-title">调整命令后执行</span>
                          <span className="command-editor-subtitle">{executionEditor.title}</span>
                        </div>
                        <textarea
                          className="command-editor-textarea"
                          value={executionEditor.command}
                          onChange={(e) => updateExecutionEditorCommand(e.target.value)}
                          rows={3}
                        />
                        <div className="card-actions">
                          <button
                            className="btn btn-primary btn-small"
                            onClick={handleExecutionEditorRun}
                            disabled={!executionEditor.command.trim()}
                          >
                            执行调整后的命令
                          </button>
                          <button
                            className="btn btn-secondary btn-small"
                            onClick={closeExecutionEditor}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                    {commandOptions.map((option, idx) => {
                      const isExecuted = executedOptionIndexes.has(idx);
                      const isAdded = addedOptionIndexes.has(idx);
                      return (
                        <div key={idx} className={`command-option-card danger-${option.isDangerous ? 'red' : 'green'}${isExecuted ? ' executed' : ''}`}>
                          <div className="option-card-header">
                            <span className={`danger-badge danger-${option.isDangerous ? 'red' : 'green'}`}>
                              {isExecuted ? '已执行 ✓' : option.isDangerous ? '危险' : '安全'}
                            </span>
                            <span className="option-description">{option.description}</span>
                          </div>
                          <div className="option-card-body">
                            <code className="option-command">{option.command}</code>
                          </div>
                          {option.reason && <div className="option-reason">{option.reason}</div>}
                          <div className="option-card-actions">
                            <button
                              className={`btn ${option.isDangerous ? 'btn-danger' : 'btn-primary'}`}
                              onClick={() => handleOptionExecute(option, idx)}
                              disabled={isExecuted}
                            >
                              {isExecuted ? '已执行' : '执行'}
                            </button>
                            <button
                              className="btn btn-secondary btn-small btn-chip"
                              onClick={() => openExecutionEditor({
                                source: 'ai',
                                title: option.description,
                                description: option.reason,
                                command: option.command,
                              })}
                            >
                              调整
                            </button>
                            <button
                              className="btn btn-secondary btn-small btn-chip"
                              onClick={() => handleAddToFavorites(option, idx)}
                              disabled={isAdded}
                            >
                              {isAdded ? '已收藏' : '收藏'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {commandOptions.length > 1 && (
                      <button
                        className="btn btn-secondary batch-add-btn"
                        onClick={() => commandOptions.forEach(opt => handleAddToFavorites(opt))}
                      >
                        全部添加到常用
                      </button>
                    )}
                  </div>
                )}
                {clarificationContext && (
                  <div className="clarification-hint">
                    💡 AI 需要更多信息，请在下方输入补充说明
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <form className="chat-input-form" onSubmit={handleSubmit}>
                <input
                  type="text"
                  className="chat-input"
                  placeholder={clarificationContext ? "请补充说明..." : "描述你想执行的服务器操作..."}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={isLoading}
                />
                <button type="submit" className="btn btn-primary" disabled={isLoading || !input.trim()}>
                  发送
                </button>
              </form>
            </>
          )}

          {/* History tab */}
          {activeTab === 'history' && (
            <div className="commands-panel">
              <div className="panel-header panel-header-actions">
                <span>历史命令 ({recentCommandHistory.length})</span>
                <div className="panel-actions">
                  <select
                    className="history-trim-select"
                    value={historyTrimCount}
                    onChange={(e) => setHistoryTrimCount(e.target.value as '50' | '100' | '300')}
                  >
                    <option value="50">最近 50 条</option>
                    <option value="100">最近 100 条</option>
                    <option value="300">最近 300 条</option>
                  </select>
                  <button className="btn btn-secondary btn-small" onClick={handleTrimHistory}>
                    裁剪历史
                  </button>
                  <button className="btn btn-danger btn-small" onClick={handleClearHistoryRequest}>
                    清空历史
                  </button>
                </div>
              </div>
              {isConfirmingClearHistory && (
                <div className="history-confirm-bar">
                  <span className="history-confirm-text">确定要清空当前服务器的所有命令历史吗？此操作不可撤销。</span>
                  <div className="history-confirm-actions">
                    <button className="btn btn-danger btn-small" onClick={handleClearHistoryConfirm}>
                      确认清空
                    </button>
                    <button className="btn btn-secondary btn-small" onClick={handleClearHistoryCancel}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {executionEditor?.source === 'history' && (
                <div className="command-editor-bar">
                  <div className="command-editor-header">
                    <span className="command-editor-title">调整命令后执行</span>
                    <span className="command-editor-subtitle">{executionEditor.title}</span>
                  </div>
                  <textarea
                    className="command-editor-textarea"
                    value={executionEditor.command}
                    onChange={(e) => updateExecutionEditorCommand(e.target.value)}
                    rows={3}
                  />
                  <div className="card-actions">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={handleExecutionEditorRun}
                      disabled={!executionEditor.command.trim()}
                    >
                      执行调整后的命令
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={closeExecutionEditor}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              <div className="history-toolbar">
                <input
                  className="history-search"
                  type="text"
                  placeholder="搜索命令、输出或来源"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                />
                <select
                  className="history-filter"
                  value={historySourceFilter}
                  onChange={(e) => setHistorySourceFilter(e.target.value as 'all' | NonNullable<CommandHistory['source']>)}
                >
                  <option value="all">全部来源</option>
                  <option value="ai">AI</option>
                  <option value="terminal">终端</option>
                  <option value="history">历史</option>
                  <option value="favorite">常用</option>
                  <option value="builtin">内置</option>
                  <option value="direct">直连</option>
                </select>
                <label className="history-toggle">
                  <input
                    type="checkbox"
                    checked={historyDedupe}
                    onChange={(e) => setHistoryDedupe(e.target.checked)}
                  />
                  去重
                </label>
              </div>
              {recentCommandHistory.length === 0 ? (
                <div className="empty-state">
                  <div>{historyQuery || historySourceFilter !== 'all' ? '没有匹配的历史命令' : '暂无命令历史'}</div>
                  <div className="hint">执行过的命令会显示在这里，并跨会话保留</div>
                </div>
              ) : (
                <div className="commands-list">
                  {recentCommandHistory.map((entry, index) => (
                    <div key={`${entry.timestamp}-${index}`} className="builtin-command-item">
                      <div className="builtin-cmd-header">
                        <span className="builtin-cmd-name">{entry.command}</span>
                        <span className={`builtin-cmd-category ${entry.exitCode === 0 ? 'history-success' : 'history-error'}`}>
                          exit {entry.exitCode}
                        </span>
                      </div>
                      <div className="builtin-cmd-desc">
                        {getSourceLabel(entry.source)} · {new Date(entry.timestamp).toLocaleString()}
                      </div>
                      {entry.output && (
                        <div className="builtin-cmd-example">
                          <code>{entry.output.length > 140 ? `${entry.output.slice(0, 140)}...` : entry.output}</code>
                        </div>
                      )}
                      <div className="card-actions">
                        <button
                          className="btn btn-primary"
                          onClick={() => handleHistoryExecute(entry)}
                        >
                          执行
                        </button>
                        <button
                          className="btn btn-secondary btn-small btn-chip"
                          onClick={() => openExecutionEditor({
                            source: 'history',
                            title: entry.command,
                            description: getSourceLabel(entry.source),
                            command: entry.command,
                          })}
                        >
                          调整
                        </button>
                        <button
                          className="btn btn-secondary btn-small btn-chip"
                          onClick={() => handleHistoryAddToFavorites(entry)}
                        >
                          收藏
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Commands tab */}
          {activeTab === 'commands' && (
            <div className="commands-panel">
              <div className="panel-header">常用命令</div>
              {executionEditor?.source === 'favorite' && (
                <div className="command-editor-bar">
                  <div className="command-editor-header">
                    <span className="command-editor-title">调整命令后执行</span>
                    <span className="command-editor-subtitle">{executionEditor.title}</span>
                  </div>
                  <textarea
                    className="command-editor-textarea"
                    value={executionEditor.command}
                    onChange={(e) => updateExecutionEditorCommand(e.target.value)}
                    rows={3}
                  />
                  <div className="card-actions">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={handleExecutionEditorRun}
                      disabled={!executionEditor.command.trim()}
                    >
                      执行调整后的命令
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={closeExecutionEditor}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {commandCards.length === 0 ? (
                <div className="empty-state">
                  <div>暂无常用命令</div>
                  <div className="hint">在命令选项中点击"添加到常用"来保存命令</div>
                </div>
              ) : (
                <div className="commands-list">
                  {Array.from(groupedCards.entries()).map(([category, cards]) => (
                    <div key={category} className="category-group">
                      <div
                        className="category-header"
                        onClick={() => toggleCategory(category)}
                      >
                        <span className="category-toggle">
                          {collapsedCategories.has(category) ? '▶' : '▼'}
                        </span>
                        <span className="category-name">{CATEGORY_LABELS[category] || category}</span>
                        <span className="category-count">{cards.length}</span>
                      </div>
                      {!collapsedCategories.has(category) && (
                        <div className="category-cards">
                          {cards.map((card) => (
                            <div key={card.id} className={`command-card-item danger-${card.dangerLevel}`}>
                              <div className="card-header">
                                <span className={`danger-badge danger-${card.dangerLevel}`}>
                                  {card.dangerLevel === 'red' ? '危险' : card.dangerLevel === 'yellow' ? '注意' : '安全'}
                                </span>
                                <span className="card-usage">使用 {card.usageCount} 次</span>
                              </div>
                              {editingCardId === card.id && editingCardDraft ? (
                                <>
                                  <div className="card-edit-form">
                                    <input
                                      className="card-edit-input"
                                      type="text"
                                      value={editingCardDraft.naturalLanguage}
                                      onChange={(e) => handleCardDraftChange('naturalLanguage', e.target.value)}
                                      placeholder="卡片标题"
                                    />
                                    <textarea
                                      className="card-edit-textarea card-edit-command"
                                      value={editingCardDraft.command}
                                      onChange={(e) => handleCardDraftChange('command', e.target.value)}
                                      placeholder="命令"
                                      rows={3}
                                    />
                                    <textarea
                                      className="card-edit-textarea"
                                      value={editingCardDraft.description}
                                      onChange={(e) => handleCardDraftChange('description', e.target.value)}
                                      placeholder="说明"
                                      rows={2}
                                    />
                                  </div>
                                  <div className="card-actions">
                                    <button
                                      className={`btn ${card.dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`}
                                      onClick={() => void handleCardSave(card, true)}
                                      disabled={!editingCardDraft.command.trim()}
                                    >
                                      保存并执行
                                    </button>
                                    <button
                                      className="btn btn-secondary"
                                      onClick={() => void handleCardSave(card, false)}
                                      disabled={!editingCardDraft.command.trim()}
                                    >
                                      保存
                                    </button>
                                    <button
                                      className="btn btn-secondary"
                                      onClick={handleCardEditCancel}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="card-description" onDoubleClick={() => handleCardEditStart(card)}>
                                    {card.description}
                                  </div>
                                  <div className="card-command" onDoubleClick={() => handleCardEditStart(card)}>
                                    <code>{card.command}</code>
                                  </div>
                                  <div className="card-actions">
                                    <button
                                      className={`btn ${card.dangerLevel === 'red' ? 'btn-danger' : 'btn-primary'}`}
                                      onClick={() => handleCardExecute(card)}
                                    >
                                      执行
                                    </button>
                                    <button
                                      className="btn btn-secondary btn-small btn-chip"
                                      onClick={() => handleCardEditStart(card)}
                                    >
                                      编辑
                                    </button>
                                    <button
                                      className="btn btn-secondary btn-small btn-chip"
                                      onClick={() => removeCommandCard(card.id)}
                                    >
                                      删除
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Builtin commands tab */}
          {activeTab === 'builtin' && (
            <div className="commands-panel">
              <div className="panel-header">内置命令 ({builtinCommands.length})</div>
              {executionEditor?.source === 'builtin' && (
                <div className="command-editor-bar">
                  <div className="command-editor-header">
                    <span className="command-editor-title">调整命令后执行</span>
                    <span className="command-editor-subtitle">{executionEditor.title}</span>
                  </div>
                  <textarea
                    className="command-editor-textarea"
                    value={executionEditor.command}
                    onChange={(e) => updateExecutionEditorCommand(e.target.value)}
                    rows={3}
                  />
                  <div className="card-actions">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={handleExecutionEditorRun}
                      disabled={!executionEditor.command.trim()}
                    >
                      执行调整后的命令
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={closeExecutionEditor}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {builtinCommands.length === 0 ? (
                <div className="empty-state">
                  <div>正在加载...</div>
                </div>
              ) : (
                <div className="commands-list">
                  {Array.from(groupedBuiltinCommands.entries()).map(([category, cmds]) => (
                    <div key={category} className="category-group">
                      <div
                        className="category-header"
                        onClick={() => toggleCategory(`builtin-${category}`)}
                      >
                        <span className="category-toggle">
                          {collapsedCategories.has(`builtin-${category}`) ? '▶' : '▼'}
                        </span>
                        <span className="category-name">
                          {CATEGORY_LABELS[category as CommandCategory] || category}
                        </span>
                        <span className="category-count">{cmds.length}</span>
                      </div>
                      {!collapsedCategories.has(`builtin-${category}`) && (
                        <div className="category-cards">
                          {cmds.map((cmd) => (
                            <div key={cmd.name} className="builtin-command-item">
                              <div className="builtin-cmd-header">
                                <span className="builtin-cmd-name">{cmd.name}</span>
                                <span className="builtin-cmd-category">
                                  {CATEGORY_LABELS[cmd.category as CommandCategory] || cmd.category}
                                </span>
                              </div>
                              <div className="builtin-cmd-desc">{cmd.description}</div>
                              {cmd.examples[0] && (
                                <div className="builtin-cmd-example">
                                  <code>{cmd.examples[0].command}</code>
                                  <span className="example-desc">{cmd.examples[0].description}</span>
                                </div>
                              )}
                              <div className="card-actions">
                                <button
                                  className="btn btn-primary"
                                  onClick={() => handleBuiltinExecute(cmd)}
                                >
                                  执行
                                </button>
                                <button
                                  className="btn btn-secondary btn-small btn-chip"
                                  onClick={() => openExecutionEditor({
                                    source: 'builtin',
                                    title: cmd.name,
                                    description: cmd.description,
                                    command: cmd.examples[0]?.command || cmd.name,
                                  })}
                                >
                                  调整
                                </button>
                                <button
                                  className="btn btn-secondary btn-small btn-chip"
                                  onClick={() => handleBuiltinAddToFavorites(cmd)}
                                >
                                  收藏
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
