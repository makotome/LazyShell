import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CommandDatabase, BuiltinCommand } from '../types';

export function useCommandDatabase() {
  const [db, setDb] = useState<CommandDatabase | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadDb = async () => {
      try {
        const data = await invoke<CommandDatabase>('load_commands_db');
        setDb(data);
      } catch (err) {
        console.error('Failed to load commands database:', err);
      } finally {
        setIsLoading(false);
      }
    };
    loadDb();
  }, []);

  const search = useCallback(async (keyword: string): Promise<BuiltinCommand[]> => {
    if (!keyword.trim()) return [];
    try {
      return await invoke<BuiltinCommand[]>('search_commands', { keyword });
    } catch (err) {
      console.error('Failed to search commands:', err);
      return [];
    }
  }, []);

  const getSuggestions = useCallback(async (partial: string): Promise<string[]> => {
    if (!partial.trim()) return [];
    try {
      return await invoke<string[]>('get_command_suggestions', { partial });
    } catch (err) {
      console.error('Failed to get suggestions:', err);
      return [];
    }
  }, []);

  const getCommandByName = useCallback(async (name: string): Promise<BuiltinCommand | null> => {
    try {
      return await invoke<BuiltinCommand | null>('get_command_by_name', { name });
    } catch (err) {
      console.error('Failed to get command:', err);
      return null;
    }
  }, []);

  return {
    db,
    isLoading,
    search,
    getSuggestions,
    getCommandByName,
  };
}