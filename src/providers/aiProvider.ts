import type { AIProvider, AIResponse, TerminalContext } from '../types';
import { invoke } from '@tauri-apps/api/core';

export type ProviderType = 'minimax' | 'openai' | 'anthropic';

interface ProviderConfig {
  type: ProviderType;
  name: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

const PROVIDER_DEFAULTS: Record<ProviderType, { baseUrl: string; model: string }> = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.7',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
  },
};

export function createProvider(config: ProviderConfig): AIProvider {
  const defaults = PROVIDER_DEFAULTS[config.type];

  return {
    name: config.name,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || defaults.baseUrl,
    model: config.model || defaults.model,
    complete: async (prompt: string, context: TerminalContext): Promise<AIResponse> => {
      return invoke<AIResponse>('call_ai', {
        params: {
          api_key: config.apiKey,
          base_url: config.baseUrl || defaults.baseUrl,
          model: config.model || defaults.model,
          prompt,
          context: {
            current_dir: context.currentDir,
            recent_commands: context.recentCommands.map(cmd => ({
              command: cmd.command,
              output: cmd.output,
              exit_code: cmd.exitCode,
              timestamp: cmd.timestamp,
            })),
            session_state: {
              connected_server: context.sessionState.connectedServer,
              is_connected: context.sessionState.isConnected,
            },
          },
        },
      });
    },
  };
}

export class AIProviderManager {
  private providers: Map<string, AIProvider> = new Map();
  private activeProviderId: string | null = null;

  addProvider(id: string, provider: AIProvider): void {
    this.providers.set(id, provider);
    if (!this.activeProviderId) {
      this.activeProviderId = id;
    }
  }

  removeProvider(id: string): void {
    this.providers.delete(id);
    if (this.activeProviderId === id) {
      this.activeProviderId = this.providers.keys().next().value || null;
    }
  }

  setActiveProvider(id: string): void {
    if (this.providers.has(id)) {
      this.activeProviderId = id;
    }
  }

  getActiveProvider(): AIProvider | null {
    if (!this.activeProviderId) return null;
    return this.providers.get(this.activeProviderId) || null;
  }

  getProvider(id: string): AIProvider | null {
    return this.providers.get(id) || null;
  }

  listProviders(): Array<{ id: string; name: string }> {
    return Array.from(this.providers.entries()).map(([id, p]) => ({ id, name: p.name }));
  }

  getProviders(): Array<{ id: string; name: string; type: ProviderType; isActive: boolean }> {
    return Array.from(this.providers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      type: (p as unknown as { type: ProviderType }).type,
      isActive: id === this.activeProviderId,
    }));
  }
}
