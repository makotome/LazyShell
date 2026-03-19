import { useMemo, memo, useState } from 'react';
import type { AIProviderManager } from '../providers/aiProvider';
import type { ProviderType } from '../providers/aiProvider';
import { AddProviderModal } from './AddProviderModal';
import './ProviderSelector.css';

interface ProviderSelectorProps {
  providerManager: AIProviderManager;
}

interface ProviderInfo {
  id: string;
  name: string;
  type: ProviderType;
  isActive: boolean;
}

export const ProviderSelector = memo(function ProviderSelector({ providerManager }: ProviderSelectorProps) {
  const providers = useMemo(() => providerManager.getProviders() as ProviderInfo[], [providerManager]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);

  const handleSelectProvider = (providerId: string) => {
    providerManager.setActiveProvider(providerId);
  };

  const handleDeleteProvider = (providerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    providerManager.removeProvider(providerId);
  };

  const handleEditProvider = (provider: ProviderInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProvider(provider);
    setShowAddModal(true);
  };

  const handleAddProvider = () => {
    setEditingProvider(null);
    setShowAddModal(true);
  };

  const handleCloseModal = () => {
    setShowAddModal(false);
    setEditingProvider(null);
  };

  if (providers.length === 0 && !showAddModal) {
    return (
      <div className="provider-selector">
        <div className="provider-selector-header">
          <span className="provider-selector-title">AI 提供商</span>
          <button className="btn btn-small" onClick={handleAddProvider}>+ 添加</button>
        </div>
        <div className="provider-empty">
          <span>暂未配置 AI 提供商</span>
        </div>
        {showAddModal && (
          <AddProviderModal
            providerManager={providerManager}
            editingProvider={editingProvider}
            onClose={handleCloseModal}
          />
        )}
      </div>
    );
  }

  return (
    <div className="provider-selector">
      <div className="provider-selector-header">
        <span className="provider-selector-title">AI 提供商</span>
        <button className="btn btn-small" onClick={handleAddProvider}>+ 添加</button>
      </div>
      <div className="provider-cards">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className={`provider-card ${provider.isActive ? 'active' : ''}`}
            onClick={() => handleSelectProvider(provider.id)}
          >
            <div className="provider-card-content">
              <div className="provider-status">
                <span className={`status-dot ${provider.isActive ? 'active' : ''}`}></span>
              </div>
              <div className="provider-info">
                <span className="provider-name">{provider.name}</span>
                <span className="provider-type">{provider.type}</span>
              </div>
            </div>
            <div className="provider-card-actions">
              <button
                className="btn btn-icon btn-small"
                onClick={(e) => handleEditProvider(provider, e)}
                title="编辑"
              >
                ✏️
              </button>
              <button
                className="btn btn-icon btn-small btn-danger"
                onClick={(e) => handleDeleteProvider(provider.id, e)}
                title="删除"
              >
                🗑️
              </button>
            </div>
          </div>
        ))}
      </div>

      {showAddModal && (
        <AddProviderModal
          providerManager={providerManager}
          editingProvider={editingProvider}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
});
