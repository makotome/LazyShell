import { useState, useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, AIResponse, TerminalContext, LearningDataEntry, BuiltinCommand } from '../types';
import { AIProviderManager } from '../providers/aiProvider';

interface AIChatProps {
  providerManager: AIProviderManager;
  context: TerminalContext;
  onCommandExecute: (command: string, naturalLanguage?: string) => void;
  onCommandFill?: (command: string) => void;
  commandDb?: {
    search: (keyword: string) => Promise<BuiltinCommand[]>;
  };
}

export function AIChat({ providerManager, context, onCommandExecute, onCommandFill, commandDb }: AIChatProps) {
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
  const [lastUserInput, setLastUserInput] = useState<string>('');
  const [learningData, setLearningData] = useState<LearningDataEntry[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        content: `${response.explanation} [${source}]`,
        command: response.command,
        explanation: response.explanation,
        isDangerous: response.isDangerous,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, aiMessage]);

      if (response.isDangerous) {
        setPendingCommand(response);
      } else if (onCommandFill && response.command) {
        // Fill command to terminal for user review
        onCommandFill(response.command);
      } else {
        // Fallback to direct execution
        onCommandExecute(response.command, input);
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
  }, [input, isLoading, providerManager, context, onCommandExecute, onCommandFill, commandDb, findLearningMatch]);

  const handleCommandConfirm = useCallback(() => {
    if (pendingCommand) {
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

  return (
    <div className="ai-chat">
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
    </div>
  );
}
