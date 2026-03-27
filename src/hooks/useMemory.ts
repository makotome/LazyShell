import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatHistoryEntry, CommandCard, DangerLevel } from '../types';

interface UseMemoryOptions {
  serverId: string;
}

interface ChatHistoryFile {
  serverId: string;
  entries: ChatHistoryEntry[];
  version: string;
}

interface CommandCardFile {
  serverId: string;
  cards: CommandCard[];
  version: string;
}

export function useMemory({ serverId }: UseMemoryOptions) {
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [commandCards, setCommandCards] = useState<CommandCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  // Load chat history
  const loadChatHistory = useCallback(async (offset = 0, limit = 50) => {
    try {
      const result = await invoke<ChatHistoryFile>('load_chat_history', {
        serverId,
        offset,
        limit,
      });
      setChatHistory(prev => offset === 0 ? result.entries : [...result.entries, ...prev]);
      setHasMoreHistory(result.entries.length >= limit);
      return result;
    } catch (err) {
      console.error('Failed to load chat history:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Append chat entry
  const appendChatEntry = useCallback(async (entry: Omit<ChatHistoryEntry, 'id' | 'timestamp'>) => {
    const newEntry: ChatHistoryEntry = {
      ...entry,
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      timestamp: Date.now(),
    };

    try {
      await invoke('append_chat_entry', { serverId, entry: newEntry });
      setChatHistory(prev => [...prev, newEntry]);
      return newEntry;
    } catch (err) {
      console.error('Failed to append chat entry:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Load command cards
  const loadCommandCards = useCallback(async () => {
    try {
      const result = await invoke<CommandCardFile>('load_command_cards', { serverId });
      setCommandCards(result.cards);
      return result.cards;
    } catch (err) {
      console.error('Failed to load command cards:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Add command card
  const addCommandCard = useCallback(async (card: Omit<CommandCard, 'id' | 'usageCount' | 'createdAt' | 'lastUsed'>) => {
    const newCard: CommandCard = {
      ...card,
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };

    try {
      await invoke('add_command_card', { card: newCard });
      setCommandCards(prev => [...prev, newCard]);
      return newCard;
    } catch (err) {
      console.error('Failed to add command card:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  const updateCommandCard = useCallback(async (card: CommandCard) => {
    try {
      await invoke('update_command_card', { card });
      setCommandCards(prev => prev.map(existing => (
        existing.id === card.id ? { ...card } : existing
      )));
      return card;
    } catch (err) {
      console.error('Failed to update command card:', err);
      setError(String(err));
      throw err;
    }
  }, []);

  // Remove command card
  const removeCommandCard = useCallback(async (cardId: string) => {
    try {
      await invoke('remove_command_card', { cardId, serverId });
      setCommandCards(prev => prev.filter(c => c.id !== cardId));
    } catch (err) {
      console.error('Failed to remove command card:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Update card usage
  const updateCardUsage = useCallback(async (cardId: string) => {
    try {
      await invoke('update_card_usage', { cardId, serverId });
      setCommandCards(prev => prev.map(c =>
        c.id === cardId
          ? { ...c, usageCount: c.usageCount + 1, lastUsed: Date.now() }
          : c
      ));
    } catch (err) {
      console.error('Failed to update card usage:', err);
      // Non-critical, don't throw
    }
  }, [serverId]);

  // Determine danger level
  const getDangerLevel = useCallback(async (command: string): Promise<DangerLevel> => {
    try {
      const level = await invoke<string>('determine_command_danger_level', { command });
      return level as DangerLevel;
    } catch (err) {
      console.error('Failed to determine danger level:', err);
      return 'yellow'; // Default to yellow on error
    }
  }, []);

  // Initial load
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        await Promise.all([loadChatHistory(0, 100), loadCommandCards()]);
      } catch {
        // Errors handled in individual functions
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [serverId, loadChatHistory, loadCommandCards]);

  return {
    chatHistory,
    commandCards,
    isLoading,
    error,
    hasMoreHistory,
    loadChatHistory,
    appendChatEntry,
    loadCommandCards,
    addCommandCard,
    updateCommandCard,
    removeCommandCard,
    updateCardUsage,
    getDangerLevel,
  };
}
