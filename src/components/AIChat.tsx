import { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, AIResponse, TerminalContext, LearningDataEntry, BuiltinCommand, AICommandOption, CommandCard, DangerLevel } from '../types';
import { AIProviderManager } from '../providers/aiProvider';
import { useMemory } from '../hooks/useMemory';

interface AIChatProps {
  providerManager: AIProviderManager;
  context: TerminalContext;
  tabId: string;
  serverId: string;
  onCommandExecute: (command: string, naturalLanguage?: string) => void;
  commandDb?: {
    search: (keyword: string) => Promise<BuiltinCommand[]>;
  };
}

export function AIChat({ providerManager, context, tabId, serverId, onCommandExecute, commandDb }: AIChatProps) {
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<'chat' | 'history' | 'commands'>('chat');
  const [historyPanelCollapsed, setHistoryPanelCollapsed] = useState(true);

  // Use memory hook
  const {
    chatHistory,
    commandCards,
    appendChatEntry,
    addCommandCard,
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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

    try {
      let response: AIResponse | null = null;
      let source = '';

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
        response = await provider.complete(input, context);
        source = 'AI';
      }

      const aiMessage: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'ai',
        content: `${response.explanation || ''} [${source}]`,
        command: response.command,
        explanation: response.explanation,
        isDangerous: response.isDangerous,
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
        });
        await appendChatEntry({
          serverId,
          role: 'ai',
          content: `${response.explanation || ''} [${source}]`,
          command: response.command,
          explanation: response.explanation,
          dangerLevel,
        });
      } catch (err) {
        console.error('Failed to save chat history:', err);
      }

      // Handle multiple options mode
      if (response.options && response.options.length > 0) {
        // Limit to 5 options max
        setCommandOptions(response.options.slice(0, 5));
      } else if (response.intent === 'clarification') {
        // Clarification mode: show AI's question, don't execute
        // Just display the clarification content
      } else if (response.isDangerous) {
        // Dangerous command: show warning + execute button
        setPendingCommand(response);
      } else if (response.command) {
        // Safe single command: auto-send to terminal directly via shell_input
        invoke('shell_input', { tabId, data: response.command + '\r' })
          .catch(err => console.error('Failed to execute command:', err));
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
  }, [input, isLoading, providerManager, context, onCommandExecute, tabId, commandDb, findLearningMatch]);

  const handleCommandConfirm = useCallback(() => {
    if (pendingCommand && pendingCommand.command) {
      onCommandExecute(pendingCommand.command, lastUserInput);
      setPendingCommand(null);
    }
  }, [pendingCommand, onCommandExecute, lastUserInput]);

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

  const handleOptionExecute = useCallback((option: AICommandOption) => {
    if (option.isDangerous) {
      // Dangerous option also needs confirmation
      setPendingCommand({
        command: option.command,
        explanation: option.description,
        isDangerous: true,
        intent: 'single',
      });
    } else {
      invoke('shell_input', { tabId, data: option.command + '\r' })
        .catch(err => console.error('Failed to execute command:', err));
    }
    setCommandOptions([]);
  }, [tabId]);

  const handleAddToFavorites = useCallback(async (option: AICommandOption) => {
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
    } catch (err) {
      console.error('Failed to add to favorites:', err);
    }
  }, [serverId, addCommandCard, getDangerLevel]);

  const handleCardExecute = useCallback((card: CommandCard) => {
    invoke('shell_input', { tabId, data: card.command + '\r' })
      .catch(err => console.error('Failed to execute command:', err));
    updateCardUsage(card.id);
  }, [tabId, updateCardUsage]);

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
        {!historyPanelCollapsed && (
          <button
            className="tab-btn history-toggle"
            onClick={() => setHistoryPanelCollapsed(true)}
            style={{ marginLeft: 'auto' }}
          >
            隐藏侧边
          </button>
        )}
        {historyPanelCollapsed && (
          <button
            className="tab-btn history-toggle"
            onClick={() => setHistoryPanelCollapsed(false)}
            style={{ marginLeft: 'auto' }}
          >
            显示侧边
          </button>
        )}
      </div>

      <div className="ai-chat-content">
        {/* Main content area */}
        <div className="ai-chat-main">
          {/* Chat tab */}
          {activeTab === 'chat' && (
            <>
              <div className="chat-messages">
                {messages.map((msg) => (
                  <div key={msg.id} className={`message message-${msg.role}`}>
                    <div className="message-role">{msg.role === 'user' ? '你' : 'AI'}</div>
                    <div className="message-content">
                      {msg.content}
                      {msg.command && (
                        <div className="command-preview">
                          <code>{msg.command}</code>
                        </div>
                      )}
                    </div>
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
                    {commandOptions.map((option, idx) => (
                      <div key={idx} className={`command-option-card danger-${option.isDangerous ? 'high' : 'low'}`}>
                        <div className="option-card-header">
                          <span className={`danger-badge danger-${option.isDangerous ? 'high' : 'low'}`}>
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
                            onClick={() => handleOptionExecute(option)}
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
                <div ref={messagesEndRef} />
              </div>

              <form className="chat-input-form" onSubmit={handleSubmit}>
                <input
                  type="text"
                  className="chat-input"
                  placeholder="描述你想执行的服务器操作..."
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
            <div className="history-panel">
              <div className="panel-header">聊天历史</div>
              {chatHistory.length === 0 ? (
                <div className="empty-state">
                  <div>暂无历史记录</div>
                  <div className="hint">在聊天中发送消息会自动保存历史</div>
                </div>
              ) : (
                <div className="history-list">
                  {chatHistory.slice().reverse().map((entry) => (
                    <div key={entry.id} className={`history-item danger-${entry.dangerLevel}`}>
                      <div className="history-item-header">
                        <span className="history-role">{entry.role === 'user' ? '你' : 'AI'}</span>
                        <span className="history-time">
                          {new Date(entry.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <div className="history-content">{entry.content}</div>
                      {entry.command && (
                        <div className="history-command">{entry.command}</div>
                      )}
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
              {commandCards.length === 0 ? (
                <div className="empty-state">
                  <div>暂无常用命令</div>
                  <div className="hint">在命令选项中点击"添加到常用"来保存命令</div>
                </div>
              ) : (
                <div className="commands-list">
                  {commandCards.map((card) => (
                    <div key={card.id} className={`command-card-item danger-${card.dangerLevel}`}>
                      <div className="card-header">
                        <span className={`danger-badge danger-${card.dangerLevel}`}>
                          {card.dangerLevel === 'red' ? '危险' : card.dangerLevel === 'yellow' ? '注意' : '安全'}
                        </span>
                        <span className="card-usage">使用 {card.usageCount} 次</span>
                      </div>
                      <div className="card-description">{card.description}</div>
                      <div className="card-command">
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
                          className="btn btn-secondary"
                          onClick={() => removeCommandCard(card.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* History panel (collapsible) */}
        {!historyPanelCollapsed && activeTab === 'chat' && (
          <div className="ai-chat-history-panel">
            <div className="history-header">
              <span>最近对话</span>
              <button onClick={() => setHistoryPanelCollapsed(true)}>×</button>
            </div>
            <div className="history-list">
              {chatHistory.slice(-20).reverse().map((entry) => (
                <div key={entry.id} className="history-entry">
                  <span className="history-role">{entry.role === 'user' ? '你' : 'AI'}</span>
                  <span className="history-content">{entry.content.slice(0, 50)}...</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
