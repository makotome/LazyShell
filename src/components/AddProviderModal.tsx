import { useState } from 'react';
import { AIProviderManager, createProvider } from '../providers/aiProvider';
import type { ManagedProviderInfo, ProviderType } from '../providers/aiProvider';
import { invoke } from '@tauri-apps/api/core';

interface AddProviderModalProps {
  providerManager: AIProviderManager;
  editingProvider?: ManagedProviderInfo | null;
  onClose: () => void;
}

export function AddProviderModal({ providerManager, editingProvider, onClose }: AddProviderModalProps) {
  const [name, setName] = useState(editingProvider?.name || '');
  const [type, setType] = useState<ProviderType>(editingProvider?.type || 'minimax');
  const [apiKey, setApiKey] = useState(editingProvider?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(editingProvider?.baseUrl || '');
  const [model, setModel] = useState(editingProvider?.model || '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isEditing = !!editingProvider;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!apiKey.trim()) {
      setError('API Key 不能为空');
      return;
    }

    setLoading(true);

    try {
      const provider = createProvider({
        type,
        name: name || type,
        apiKey,
        baseUrl: baseUrl || undefined,
        model: model || 'default',
      });

      if (isEditing) {
        providerManager.removeProvider(editingProvider.id);
      }
      providerManager.addProvider(editingProvider?.id || `provider-${Date.now()}`, provider);

      // Persist to backend
      const providers = providerManager.getProviders();

      await invoke('save_provider_config', {
        providers: providers.map(p => ({
          id: p.id,
          type: p.type,
          name: p.name,
          api_key: p.apiKey,
          base_url: p.baseUrl || null,
          model: p.model || null,
        })),
      });

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleTypeChange = (newType: ProviderType) => {
    setType(newType);
    if (newType === 'minimax' && !baseUrl) {
      setBaseUrl('https://api.minimaxi.com/anthropic');
      setModel('MiniMax-M2.7');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isEditing ? '编辑 AI 提供商' : '添加 AI 提供商'}</h2>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <label>类型</label>
            <select value={type} onChange={(e) => handleTypeChange(e.target.value as ProviderType)}>
              <option value="minimax">MiniMax</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>

          <div className="form-group">
            <label>名称（可选）</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 'minimax' ? 'MiniMax' : type === 'openai' ? 'OpenAI' : 'Anthropic'}
            />
          </div>

          <div className="form-group">
            <label>API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="form-group">
            <label>Base URL（可选）</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="默认留空"
            />
          </div>

          <div className="form-group">
            <label>模型（可选）</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="默认使用各提供商最佳模型"
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
