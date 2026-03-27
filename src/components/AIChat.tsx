import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  ChatMessage,
  TerminalContext,
  BuiltinCommand,
  AICommandOption,
  CommandCard,
  CommandCategory,
  CommandDatabase,
  CommandHistory,
  AiDecision,
} from '../types';
import { AIProviderManager } from '../providers/aiProvider';
import { useMemory } from '../hooks/useMemory';
import type { AIInputMode } from './AIIntentTabs';
import { AIComposer } from './AIComposer';
import { AIPendingActionCard, mapOptionDangerLevel, type PendingActionOption } from './AIPendingActionCard';
import { AIConversationPanel } from './AIConversationPanel';
import { AIHistoryPanel } from './AIHistoryPanel';
import { AIFavoritesPanel } from './AIFavoritesPanel';
import { AIBuiltinPanel } from './AIBuiltinPanel';

interface AIChatProps {
  providerManager: AIProviderManager;
  context: TerminalContext;
  tabId: string;
  serverId: string;
  commandHistory: CommandHistory[];
  onCommandExecute: (command: string, naturalLanguage?: string) => void;
  onTerminalExecute: (
    command: string,
    source?: CommandHistory['source'],
    feedback?: { userIntent: string; suggestedCommand?: string }
  ) => void;
  onCommandHistoryReload: () => Promise<void>;
  onCommandHistoryClear: () => void;
  commandDb?: {
    search: (keyword: string) => Promise<BuiltinCommand[]>;
  };
}

interface PendingActionState {
  kind: 'single' | 'multiple';
  title: string;
  summary?: string;
  command?: string;
  options?: PendingActionOption[];
  source: 'ai';
  dangerLevel: CommandCard['dangerLevel'];
}

const INPUT_MODE_PLACEHOLDERS: Record<AIInputMode, string> = {
  execute: '描述你想在当前机器上执行什么操作',
  diagnose: '描述现象、报错、最近变更和你想排查的问题',
  explain: '输入命令、日志或现象，让 AI 帮你解释',
  script: '描述你想生成的脚本、目标环境和约束',
  answer: '只让 AI 给建议，不生成执行动作',
};

const INPUT_MODE_PROMPTS: Record<AIInputMode, string> = {
  execute: '你现在处于执行命令模式。优先给出最直接、可执行的命令或少量备选命令。',
  diagnose: '你现在处于故障排查模式。先给出排查思路和需要执行的诊断命令，避免直接做破坏性操作。',
  explain: '你现在处于解释模式。优先解释命令、日志或系统现象；除非必要，不要直接给执行命令。',
  script: '你现在处于脚本生成模式。优先生成可直接保存或执行的脚本，并说明用途与风险。',
  answer: '你现在处于只回答模式。不要默认执行或建议立刻执行命令，优先给分析和建议。',
};

const DRAFT_STORAGE_KEY = 'lazy-shell-ai-drafts';
const PROMPT_HISTORY_STORAGE_KEY = 'lazy-shell-ai-prompts';

function getOpenclawGroupLabel(command: BuiltinCommand): string {
  const match = command.description.match(/^([^｜|]+)[｜|]/);
  return match ? match[1].trim() : '其他';
}

export function AIChat({
  providerManager,
  context,
  serverId,
  commandHistory,
  onTerminalExecute,
  onCommandHistoryReload,
  onCommandHistoryClear,
}: AIChatProps) {
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
  const [pendingAction, setPendingAction] = useState<PendingActionState | null>(null);
  const [inputMode, setInputMode] = useState<AIInputMode>('execute');
  const [clarificationContext, setClarificationContext] = useState<string | null>(null);
  const [executedOptionIndexes, setExecutedOptionIndexes] = useState<Set<string>>(new Set());
  const [addedOptionIndexes, setAddedOptionIndexes] = useState<Set<string>>(new Set());
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
    originalCommand?: string;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'history' | 'commands' | 'builtin' | 'openclaw'>('chat');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    invoke<CommandDatabase>('load_commands_db')
      .then(db => setBuiltinCommands(db.commands))
      .catch(err => console.error('Failed to load commands db:', err));
  }, []);

  useEffect(() => {
    setHistoryLoaded(false);
    setMessages([{
      id: 'welcome',
      role: 'ai',
      content: '你好！我是 LazyShell AI 助手。告诉我你想在服务器上执行什么操作，我会帮你生成相应的命令。',
      timestamp: Date.now(),
    }]);
    setPendingAction(null);
    setClarificationContext(null);
  }, [serverId]);

  useEffect(() => {
    try {
      const drafts = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}') as Record<string, string>;
      setInput(drafts[serverId] || '');
    } catch {
      setInput('');
    }
  }, [serverId]);

  useEffect(() => {
    try {
      const drafts = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}') as Record<string, string>;
      drafts[serverId] = input;
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      // ignore local persistence errors
    }
  }, [input, serverId]);

  useEffect(() => {
    if (historyLoaded || chatHistory.length === 0) return;
    const historyMessages: ChatMessage[] = chatHistory.map(entry => ({
      id: entry.id,
      role: entry.role,
      content: entry.content,
      sourceLabel: entry.sourceLabel,
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
      const withoutWelcome = prev.filter(message => message.id !== 'welcome');
      return [...historyMessages, ...withoutWelcome];
    });
    setHistoryLoaded(true);
  }, [chatHistory, historyLoaded]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

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
          sourceLabel: entry.sourceLabel,
          command: entry.command,
          explanation: entry.explanation,
          dangerLevel: entry.dangerLevel,
          options: entry.options,
          timestamp: entry.timestamp,
        }));
        setMessages(prev => [...olderMessages, ...prev]);
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        });
      }
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [chatHistory.length, hasMoreHistory, loadChatHistory, loadingMoreHistory]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const persistRecentPrompt = useCallback((prompt: string) => {
    const normalized = prompt.trim();
    if (!normalized) return;
    try {
      const promptMap = JSON.parse(localStorage.getItem(PROMPT_HISTORY_STORAGE_KEY) || '{}') as Record<string, string[]>;
      const current = promptMap[serverId] || [];
      promptMap[serverId] = [normalized, ...current.filter(item => item !== normalized)].slice(0, 10);
      localStorage.setItem(PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(promptMap));
    } catch {
      // ignore local persistence errors
    }
  }, [serverId]);

  const clearDraftForServer = useCallback(() => {
    try {
      const drafts = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}') as Record<string, string>;
      drafts[serverId] = '';
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    } catch {
      // ignore local persistence errors
    }
  }, [serverId]);

  const pushUserAndAiHistory = useCallback(async (userInput: string, decision: AiDecision, source: string) => {
    try {
      const dangerLevel = decision.command
        ? await getDangerLevel(decision.command)
        : decision.riskLevel || 'yellow';
      await appendChatEntry({
        serverId,
        role: 'user',
        content: userInput,
        dangerLevel: 'green',
      });
      await appendChatEntry({
        serverId,
        role: 'ai',
        content: decision.responseText || '',
        sourceLabel: source,
        command: decision.command,
        explanation: decision.responseText,
        dangerLevel,
        options: decision.options?.slice(0, 5),
      });
    } catch (err) {
      console.error('Failed to save chat history:', err);
    }
  }, [appendChatEntry, getDangerLevel, serverId]);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || isLoading) return;

    const userInput = input;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userInput,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    clearDraftForServer();
    persistRecentPrompt(userInput);
    setIsLoading(true);
    setPendingAction(null);
    setExecutedOptionIndexes(new Set());
    setAddedOptionIndexes(new Set());

    try {
      const activeProvider = providerManager.getProviders().find(provider => provider.isActive);
      if (!activeProvider) {
        throw new Error('No AI provider configured');
      }

      const prompt = clarificationContext
        ? `${INPUT_MODE_PROMPTS[inputMode]}\n\n之前的问题: ${clarificationContext}\n用户回答: ${userInput}`
        : `${INPUT_MODE_PROMPTS[inputMode]}\n\n用户请求: ${userInput}`;

      const decision = await invoke<AiDecision>('call_ai_orchestrated', {
        params: {
          apiKey: activeProvider.apiKey,
          baseUrl: activeProvider.baseUrl,
          model: activeProvider.model,
          prompt,
          context,
          serverId,
          inputMode,
        },
      });

      const source = decision.sourceLabels?.length ? decision.sourceLabels.join(' + ') : 'AI';
      const limitedOptions = decision.options?.slice(0, 5) || [];
      const aiMessage: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'ai',
        content: decision.responseText || '',
        sourceLabel: source,
        command: decision.command,
        explanation: decision.responseText,
        isDangerous: decision.riskLevel === 'red',
        options: limitedOptions.length ? limitedOptions : undefined,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, aiMessage]);
      await pushUserAndAiHistory(userInput, decision, source);
      setClarificationContext(null);

      if (limitedOptions.length > 0) {
        setPendingAction({
          kind: 'multiple',
          title: userInput,
          summary: decision.responseText,
          source: 'ai',
          dangerLevel: decision.riskLevel === 'red' || limitedOptions.some(option => option.isDangerous) ? 'red' : 'green',
          options: limitedOptions.map(option => ({
            command: option.command,
            description: option.description,
            reason: option.reason,
            dangerLevel: mapOptionDangerLevel(option),
          })),
        });
      } else if (decision.intent === 'clarification' || decision.mode === 'clarification') {
        setClarificationContext(decision.responseText || userInput);
      } else if (decision.command) {
        const dangerLevel = decision.riskLevel || await getDangerLevel(decision.command);
        setPendingAction({
          kind: 'single',
          title: userInput,
          summary: decision.responseText,
          command: decision.command,
          source: 'ai',
          dangerLevel,
        });
      }
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'ai',
        content: `错误: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [
    input,
    isLoading,
    clearDraftForServer,
    clarificationContext,
    getDangerLevel,
    inputMode,
    persistRecentPrompt,
    providerManager,
    pushUserAndAiHistory,
    serverId,
    context,
  ]);

  const handleAddToFavorites = useCallback(async (option: AICommandOption, key?: string) => {
    const existing = commandCards.find(card => card.command.trim() === option.command.trim());
    if (existing) {
      setMessages(prev => [
        ...prev,
        {
          id: `info-${Date.now()}`,
          role: 'ai',
          content: `该命令已在常用列表中（已使用 ${existing.usageCount} 次）`,
          timestamp: Date.now(),
        },
      ]);
      if (key) {
        setAddedOptionIndexes(prev => new Set(prev).add(key));
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
      setMessages(prev => [
        ...prev,
        {
          id: `added-${Date.now()}`,
          role: 'ai',
          content: `已添加到常用命令：${option.command}`,
          timestamp: Date.now(),
        },
      ]);
      if (key) {
        setAddedOptionIndexes(prev => new Set(prev).add(key));
      }
    } catch (err) {
      console.error('Failed to add to favorites:', err);
    }
  }, [addCommandCard, commandCards, getDangerLevel, serverId]);

  const handlePendingActionExecute = useCallback(() => {
    if (!pendingAction || pendingAction.kind !== 'single' || !pendingAction.command) return;
    onTerminalExecute(pendingAction.command, 'ai', {
      userIntent: pendingAction.title,
      suggestedCommand: pendingAction.command,
    });
    setPendingAction(null);
  }, [onTerminalExecute, pendingAction]);

  const handlePendingActionClose = useCallback(() => {
    setPendingAction(null);
    if (executionEditor?.source === 'ai') {
      setExecutionEditor(null);
    }
  }, [executionEditor]);

  const handlePendingActionSave = useCallback(async () => {
    if (!pendingAction || pendingAction.kind !== 'single' || !pendingAction.command) return;
    await handleAddToFavorites({
      command: pendingAction.command,
      description: pendingAction.summary || pendingAction.title,
      isDangerous: pendingAction.dangerLevel === 'red',
    });
  }, [handleAddToFavorites, pendingAction]);

  const handlePendingActionCopy = useCallback(async () => {
    if (!pendingAction || pendingAction.kind !== 'single' || !pendingAction.command) return;
    try {
      await navigator.clipboard.writeText(pendingAction.command);
    } catch (err) {
      console.error('Failed to copy command:', err);
    }
  }, [pendingAction]);

  const openExecutionEditor = useCallback((editor: {
    source: 'history' | 'builtin' | 'favorite' | 'ai';
    title: string;
    description?: string;
    command: string;
    originalCommand?: string;
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
    if (!executionEditor?.command.trim()) return;
    const sourceMap: Record<'history' | 'builtin' | 'favorite' | 'ai', NonNullable<CommandHistory['source']>> = {
      history: 'history',
      builtin: 'builtin',
      favorite: 'favorite',
      ai: 'ai',
    };
    onTerminalExecute(
      executionEditor.command.trim(),
      sourceMap[executionEditor.source],
      executionEditor.source === 'ai'
        ? {
            userIntent: executionEditor.title,
            suggestedCommand: executionEditor.originalCommand || executionEditor.command,
          }
        : undefined
    );
    setExecutionEditor(null);
  }, [executionEditor, onTerminalExecute]);

  const handlePendingActionEdit = useCallback(() => {
    if (!pendingAction || pendingAction.kind !== 'single' || !pendingAction.command) return;
    openExecutionEditor({
      source: 'ai',
      title: pendingAction.title,
      description: pendingAction.summary,
      command: pendingAction.command,
      originalCommand: pendingAction.command,
    });
  }, [openExecutionEditor, pendingAction]);

  const handlePendingOptionExecute = useCallback(async (option: PendingActionOption) => {
    onTerminalExecute(option.command, 'ai', {
      userIntent: option.description,
      suggestedCommand: option.command,
    });
    setExecutedOptionIndexes(prev => new Set(prev).add(option.command));
    setPendingAction(prev => prev && prev.kind === 'multiple' && prev.options
      ? {
          ...prev,
          options: prev.options.map(candidate =>
            candidate.command === option.command ? { ...candidate, isExecuted: true } : candidate
          ),
        }
      : prev);
  }, [onTerminalExecute]);

  const handlePendingOptionSave = useCallback(async (option: PendingActionOption) => {
    await handleAddToFavorites({
      command: option.command,
      description: option.description,
      isDangerous: option.dangerLevel === 'red',
    }, option.command);
    setPendingAction(prev => prev && prev.kind === 'multiple' && prev.options
      ? {
          ...prev,
          options: prev.options.map(candidate =>
            candidate.command === option.command ? { ...candidate, isSaved: true } : candidate
          ),
        }
      : prev);
  }, [handleAddToFavorites]);

  const handlePendingOptionEdit = useCallback((option: PendingActionOption) => {
    openExecutionEditor({
      source: 'ai',
      title: option.description,
      description: option.reason,
      command: option.command,
      originalCommand: option.command,
    });
  }, [openExecutionEditor]);

  const handleComposerSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;
    const syntheticEvent = { preventDefault() {} } as React.FormEvent;
    void handleSubmit(syntheticEvent);
  }, [handleSubmit, input, isLoading]);

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
    if (!editingCardDraft) return;
    const nextCommand = editingCardDraft.command.trim();
    if (!nextCommand) return;
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

  const groupedCards = useMemo(() => {
    const groups = new Map<CommandCategory, CommandCard[]>();
    for (const card of commandCards) {
      const category = (card.category || 'other') as CommandCategory;
      const list = groups.get(category) || [];
      list.push(card);
      groups.set(category, list);
    }
    return groups;
  }, [commandCards]);

  const builtinReferenceCommands = useMemo(
    () => builtinCommands.filter(command => command.category !== 'openclaw'),
    [builtinCommands]
  );

  const openclawCommands = useMemo(
    () => builtinCommands.filter(command => command.category === 'openclaw'),
    [builtinCommands]
  );

  const groupedReferenceCommands = useMemo(() => {
    const groups = new Map<string, BuiltinCommand[]>();
    for (const command of builtinReferenceCommands) {
      const category = command.category || 'other';
      const list = groups.get(category) || [];
      list.push(command);
      groups.set(category, list);
    }
    return groups;
  }, [builtinReferenceCommands]);

  const groupedOpenclawCommands = useMemo(() => {
    const groups = new Map<string, BuiltinCommand[]>();
    for (const command of openclawCommands) {
      const category = getOpenclawGroupLabel(command);
      const list = groups.get(category) || [];
      list.push(command);
      groups.set(category, list);
    }
    return groups;
  }, [openclawCommands]);

  useEffect(() => {
    setCollapsedCategories(prev => {
      if (prev.size > 0) {
        return prev;
      }

      const next = new Set<string>();
      for (const category of groupedReferenceCommands.keys()) {
        next.add(`builtin-${category}`);
      }
      for (const category of groupedOpenclawCommands.keys()) {
        next.add(`builtin-${category}`);
      }
      return next;
    });
  }, [groupedOpenclawCommands, groupedReferenceCommands]);

  const handleBuiltinExecute = useCallback((cmd: BuiltinCommand) => {
    onTerminalExecute(cmd.examples[0]?.command || cmd.name, 'builtin');
  }, [onTerminalExecute]);

  const handleBuiltinCopy = useCallback(async (cmd: BuiltinCommand) => {
    const value = cmd.examples[0]?.command || cmd.name;
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      console.error('Failed to copy builtin command:', err);
    }
  }, []);

  const handleBuiltinAddToFavorites = useCallback(async (cmd: BuiltinCommand) => {
    await handleAddToFavorites({
      command: cmd.examples[0]?.command || cmd.name,
      description: cmd.description,
      isDangerous: false,
    });
  }, [handleAddToFavorites]);

  const toggleCategory = useCallback((category: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const getSourceLabel = useCallback((source?: CommandHistory['source']) => {
    switch (source) {
      case 'ai': return 'AI';
      case 'history': return '历史';
      case 'favorite': return '常用';
      case 'builtin': return '内置';
      case 'direct': return '直连';
      case 'terminal': return '终端';
      default: return '未知';
    }
  }, []);

  const recentCommandHistory = useMemo(() => {
    const normalizedQuery = historyQuery.trim().toLowerCase();
    const filtered = commandHistory
      .slice()
      .reverse()
      .filter(entry => {
        if (historySourceFilter !== 'all' && entry.source !== historySourceFilter) {
          return false;
        }
        if (!normalizedQuery) return true;
        return (
          entry.command.toLowerCase().includes(normalizedQuery) ||
          entry.output.toLowerCase().includes(normalizedQuery) ||
          getSourceLabel(entry.source).toLowerCase().includes(normalizedQuery)
        );
      });

    return historyDedupe
      ? filtered.filter((entry, index, entries) =>
          entries.findIndex(candidate => candidate.command.trim() === entry.command.trim()) === index
        )
      : filtered;
  }, [commandHistory, getSourceLabel, historyDedupe, historyQuery, historySourceFilter]);

  const handleHistoryExecute = useCallback((entry: CommandHistory) => {
    onTerminalExecute(entry.command, 'history');
  }, [onTerminalExecute]);

  const handleHistoryAddToFavorites = useCallback(async (entry: CommandHistory) => {
    await handleAddToFavorites({
      command: entry.command,
      description: entry.command,
      isDangerous: false,
    });
  }, [handleAddToFavorites]);

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
  }, [historyTrimCount, onCommandHistoryReload, serverId]);

  const handleClearHistoryConfirm = useCallback(async () => {
    try {
      onCommandHistoryClear();
      setIsConfirmingClearHistory(false);
      await invoke('save_command_history', { serverId, entries: [] });
      await onCommandHistoryReload();
    } catch (err) {
      console.error('Failed to clear command history:', err);
      await onCommandHistoryReload();
    }
  }, [onCommandHistoryClear, onCommandHistoryReload, serverId]);

  return (
    <div className="ai-chat">
      <div className="ai-chat-tabs">
        <button className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>聊天</button>
        <button className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>历史</button>
        <button className={`tab-btn ${activeTab === 'commands' ? 'active' : ''}`} onClick={() => setActiveTab('commands')}>常用</button>
        <button className={`tab-btn ${activeTab === 'builtin' ? 'active' : ''}`} onClick={() => setActiveTab('builtin')}>内置</button>
        <button className={`tab-btn ${activeTab === 'openclaw' ? 'active' : ''}`} onClick={() => setActiveTab('openclaw')}>OPENCLAW</button>
      </div>

      <div className="ai-chat-content">
        <div className="ai-chat-main">
          {activeTab === 'chat' && (
            <>
              <div className="ai-chat-control-panel">
                {pendingAction && (
                  <AIPendingActionCard
                    title={pendingAction.title}
                    summary={pendingAction.summary}
                    command={pendingAction.command}
                    dangerLevel={pendingAction.dangerLevel}
                    options={pendingAction.options?.map(option => ({
                      ...option,
                      isExecuted: executedOptionIndexes.has(option.command) || option.isExecuted,
                      isSaved: addedOptionIndexes.has(option.command) || option.isSaved,
                    }))}
                    onClose={handlePendingActionClose}
                    onExecute={handlePendingActionExecute}
                    onSave={() => void handlePendingActionSave()}
                    onCopy={() => void handlePendingActionCopy()}
                    onEdit={handlePendingActionEdit}
                    onOptionExecute={(option) => void handlePendingOptionExecute(option)}
                    onOptionSave={(option) => void handlePendingOptionSave(option)}
                    onOptionEdit={handlePendingOptionEdit}
                  />
                )}
              </div>
              {executionEditor?.source === 'ai' && (
                <div className="ai-chat-control-panel ai-chat-control-panel-secondary">
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
                      <button className="btn btn-primary btn-small" onClick={handleExecutionEditorRun} disabled={!executionEditor.command.trim()}>
                        执行调整后的命令
                      </button>
                      <button className="btn btn-secondary btn-small" onClick={closeExecutionEditor}>取消</button>
                    </div>
                  </div>
                </div>
              )}
              <AIConversationPanel
                messages={messages}
                isLoading={isLoading}
                loadingMoreHistory={loadingMoreHistory}
                clarificationContext={clarificationContext}
                chatContainerRef={chatContainerRef}
                messagesEndRef={messagesEndRef}
                onScroll={() => void handleChatScroll()}
              />
              <form className="chat-input-form" onSubmit={handleSubmit}>
                <AIComposer
                  value={input}
                  onChange={setInput}
                  onSubmit={handleComposerSubmit}
                  placeholder={clarificationContext ? '请补充说明...' : INPUT_MODE_PLACEHOLDERS[inputMode]}
                  disabled={isLoading}
                  clarificationMode={!!clarificationContext}
                  inputMode={inputMode}
                  onInputModeChange={setInputMode}
                />
              </form>
            </>
          )}

          {activeTab === 'history' && (
            <AIHistoryPanel
              entries={recentCommandHistory}
              historyQuery={historyQuery}
              historySourceFilter={historySourceFilter}
              historyDedupe={historyDedupe}
              historyTrimCount={historyTrimCount}
              isConfirmingClearHistory={isConfirmingClearHistory}
              executionEditor={executionEditor?.source === 'history' ? { title: executionEditor.title, command: executionEditor.command } : null}
              getSourceLabel={getSourceLabel}
              onHistoryQueryChange={setHistoryQuery}
              onHistorySourceFilterChange={setHistorySourceFilter}
              onHistoryDedupeChange={setHistoryDedupe}
              onHistoryTrimCountChange={setHistoryTrimCount}
              onTrimHistory={() => void handleTrimHistory()}
              onClearHistoryRequest={() => setIsConfirmingClearHistory(true)}
              onClearHistoryConfirm={() => void handleClearHistoryConfirm()}
              onClearHistoryCancel={() => setIsConfirmingClearHistory(false)}
              onExecute={handleHistoryExecute}
              onEdit={(entry) => openExecutionEditor({
                source: 'history',
                title: entry.command,
                description: getSourceLabel(entry.source),
                command: entry.command,
              })}
              onSave={(entry) => void handleHistoryAddToFavorites(entry)}
              onExecutionEditorCommandChange={updateExecutionEditorCommand}
              onExecutionEditorRun={handleExecutionEditorRun}
              onExecutionEditorClose={closeExecutionEditor}
            />
          )}

          {activeTab === 'commands' && (
            <AIFavoritesPanel
              groupedCards={groupedCards}
              collapsedCategories={collapsedCategories}
              editingCardId={editingCardId}
              editingCardDraft={editingCardDraft}
              executionEditor={executionEditor?.source === 'favorite' ? { title: executionEditor.title, command: executionEditor.command } : null}
              onToggleCategory={toggleCategory}
              onExecute={handleCardExecute}
              onEditStart={handleCardEditStart}
              onEditCancel={handleCardEditCancel}
              onEditDraftChange={handleCardDraftChange}
              onSave={(card, executeAfterSave) => void handleCardSave(card, executeAfterSave)}
              onRemove={removeCommandCard}
              onExecutionEditorCommandChange={updateExecutionEditorCommand}
              onExecutionEditorRun={handleExecutionEditorRun}
              onExecutionEditorClose={closeExecutionEditor}
            />
          )}

          {activeTab === 'builtin' && (
            <AIBuiltinPanel
              title="内置命令"
              groupedBuiltinCommands={groupedReferenceCommands}
              builtinCommandsCount={builtinReferenceCommands.length}
              collapsedCategories={collapsedCategories}
              executionEditor={executionEditor?.source === 'builtin' ? { title: executionEditor.title, command: executionEditor.command } : null}
              onToggleCategory={toggleCategory}
              onExecute={handleBuiltinExecute}
              onCopy={(cmd) => void handleBuiltinCopy(cmd)}
              onEdit={(cmd) => openExecutionEditor({
                source: 'builtin',
                title: cmd.name,
                description: cmd.description,
                command: cmd.examples[0]?.command || cmd.name,
              })}
              onSave={(cmd) => void handleBuiltinAddToFavorites(cmd)}
              onExecutionEditorCommandChange={updateExecutionEditorCommand}
              onExecutionEditorRun={handleExecutionEditorRun}
              onExecutionEditorClose={closeExecutionEditor}
            />
          )}

          {activeTab === 'openclaw' && (
            <AIBuiltinPanel
              title="OPENCLAW"
              groupedBuiltinCommands={groupedOpenclawCommands}
              builtinCommandsCount={openclawCommands.length}
              collapsedCategories={collapsedCategories}
              executionEditor={executionEditor?.source === 'builtin' ? { title: executionEditor.title, command: executionEditor.command } : null}
              onToggleCategory={toggleCategory}
              onExecute={handleBuiltinExecute}
              onCopy={(cmd) => void handleBuiltinCopy(cmd)}
              onEdit={(cmd) => openExecutionEditor({
                source: 'builtin',
                title: cmd.name,
                description: cmd.description,
                command: cmd.examples[0]?.command || cmd.name,
              })}
              onSave={(cmd) => void handleBuiltinAddToFavorites(cmd)}
              onExecutionEditorCommandChange={updateExecutionEditorCommand}
              onExecutionEditorRun={handleExecutionEditorRun}
              onExecutionEditorClose={closeExecutionEditor}
            />
          )}
        </div>
      </div>
    </div>
  );
}
