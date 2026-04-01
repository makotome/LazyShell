import { useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ServerInfo, AddServerRequest, AuthMethodInput, EditServerRequest } from '../types';

interface ServerListProps {
  servers: ServerInfo[];
  selectedServer: string | null;
  onServerSelect: (serverId: string) => void;
  onServersChange: () => void;
  showHeader?: boolean;
  addFormOpen?: boolean;
  onAddFormOpenChange?: (open: boolean) => void;
}

export function ServerList({
  servers,
  selectedServer,
  onServerSelect,
  onServersChange,
  showHeader = true,
  addFormOpen,
  onAddFormOpenChange,
}: ServerListProps) {
  const [internalShowAddForm, setInternalShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password' as 'password' | 'private_key',
    password: '',
    keyData: '',
    passphrase: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const isAddFormOpen = addFormOpen ?? internalShowAddForm;

  const setAddFormOpen = (open: boolean) => {
    if (onAddFormOpenChange) {
      onAddFormOpenChange(open);
      return;
    }
    setInternalShowAddForm(open);
  };

  const handleAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const authMethod: AuthMethodInput =
      formData.authType === 'password'
        ? { type: 'Password', password: formData.password }
        : { type: 'PrivateKey', key_data: formData.keyData, passphrase: formData.passphrase || undefined };

    const request: AddServerRequest = {
      name: formData.name,
      host: formData.host,
      port: formData.port,
      username: formData.username,
      auth_method: authMethod,
    };

    try {
      await invoke('add_server', { request });
      setAddFormOpen(false);
      resetForm();
      onServersChange();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('Master password') || errorMsg.includes('not set')) {
        setError('请先在设置中设置主密码');
      } else {
        setError(errorMsg);
      }
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      password: '',
      keyData: '',
      passphrase: '',
    });
    setError(null);
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await invoke('remove_server', { serverId });
      onServersChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove server');
    }
  };

  const handleEditServer = (server: ServerInfo) => {
    setEditingServerId(server.id);
    // Default to password auth type when editing
    setFormData({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      authType: 'password',
      password: '',
      keyData: '',
      passphrase: '',
    });
    setAddFormOpen(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingServerId) return;

    setError(null);

    const authMethod: AuthMethodInput =
      formData.authType === 'password'
        ? { type: 'Password', password: formData.password }
        : { type: 'PrivateKey', key_data: formData.keyData, passphrase: formData.passphrase || undefined };

    const request: EditServerRequest = {
      id: editingServerId,
      name: formData.name,
      host: formData.host,
      port: formData.port,
      username: formData.username,
      auth_method: authMethod,
    };

    try {
      await invoke('update_server', { request });
      setAddFormOpen(false);
      setEditingServerId(null);
      resetForm();
      onServersChange();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('Master password') || errorMsg.includes('not set')) {
        setError('请先在设置中设置主密码');
      } else {
        setError(errorMsg);
      }
    }
  };

  const groupedServers = useMemo(() => {
    const groups: Record<string, ServerInfo[]> = {};
    servers.forEach((server) => {
      const group = groups[server.host] || [];
      group.push(server);
      groups[server.host] = group;
    });
    return groups;
  }, [servers]);

  const formTitle = editingServerId ? '编辑服务器' : '添加服务器';

  return (
    <div className="server-list">
      {showHeader && (
        <div className="server-list-header">
          <h2>服务器</h2>
          <button
            className="btn btn-small"
            onClick={() => {
              setAddFormOpen(!isAddFormOpen);
              if (isAddFormOpen && editingServerId) {
                setEditingServerId(null);
                resetForm();
              }
            }}
          >
            {isAddFormOpen ? (editingServerId ? '取消编辑' : '取消') : '+ 添加'}
          </button>
        </div>
      )}

      <div className="server-list-hint">可点击服务器卡片，或使用“连接服务器”按钮进入</div>

      {error && <div className="error-message">{error}</div>}

      {isAddFormOpen && (
        <div
          className="server-form-overlay"
          onClick={() => {
            setAddFormOpen(false);
            if (editingServerId) {
              setEditingServerId(null);
              resetForm();
            }
          }}
        >
          <div className="server-form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="server-form-header">
              <h3>{formTitle}</h3>
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => {
                  setAddFormOpen(false);
                  if (editingServerId) {
                    setEditingServerId(null);
                    resetForm();
                  }
                }}
                title="关闭"
              >
                ✕
              </button>
            </div>

            <form className="add-server-form" onSubmit={editingServerId ? handleSaveEdit : handleAddServer}>
              <div className="server-form-body">
                <div className="form-group">
                  <label>名称</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="生产服务器-1"
                    required
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck="false"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>主机</label>
                    <input
                      type="text"
                      value={formData.host}
                      onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                      placeholder="192.168.1.100"
                      required
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck="false"
                    />
                  </div>
                  <div className="form-group port">
                    <label>端口</label>
                    <input
                      type="number"
                      value={formData.port}
                      onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) || 22 })}
                      min={1}
                      max={65535}
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>用户名</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="root"
                    required
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck="false"
                  />
                </div>

                <div className="form-group">
                  <label>认证方式</label>
                  <select
                    value={formData.authType}
                    onChange={(e) => setFormData({ ...formData, authType: e.target.value as 'password' | 'private_key' })}
                  >
                    <option value="password">密码</option>
                    <option value="private_key">私钥</option>
                  </select>
                </div>

                {formData.authType === 'password' ? (
                  <div className="form-group">
                    <label>密码</label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      placeholder="••••••••"
                      required
                    />
                  </div>
                ) : (
                  <>
                    <div className="form-group">
                      <label>私钥内容</label>
                      <textarea
                        value={formData.keyData}
                        onChange={(e) => setFormData({ ...formData, keyData: e.target.value })}
                        placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                        rows={8}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>私钥密码（可选）</label>
                      <input
                        type="password"
                        value={formData.passphrase}
                        onChange={(e) => setFormData({ ...formData, passphrase: e.target.value })}
                        placeholder="••••••••"
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="server-form-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setAddFormOpen(false);
                    if (editingServerId) {
                      setEditingServerId(null);
                      resetForm();
                    }
                  }}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingServerId ? '保存修改' : '添加服务器'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="server-groups">
        {Object.entries(groupedServers).map(([host, hostServers]) => (
          <div key={host} className="server-group">
            <div className="server-group-header">
              <span className="server-icon">🖥️</span>
              <span className="group-name">{host}</span>
            </div>
            <div className="server-group-items">
              {hostServers.map((server) => (
                <div
                  key={server.id}
                  className={`server-item ${selectedServer === server.id ? 'selected' : ''}`}
                  onClick={() => onServerSelect(server.id)}
                >
                  <div className="server-main">
                    <span className="server-name">{server.name}</span>
                    <span className="server-enter-arrow" aria-hidden="true">→</span>
                  </div>
                  <span className="server-user">@{server.username}</span>
                  <div className="server-actions">
                    <button
                      className="btn btn-secondary btn-small server-connect-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onServerSelect(server.id);
                      }}
                      title="连接服务器"
                    >
                      连接服务器
                    </button>
                    <button
                      className="btn btn-icon server-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditServer(server);
                      }}
                      title="编辑"
                    >
                      ✏️
                    </button>
                    <button
                      className="btn btn-icon server-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveServer(server.id);
                      }}
                      title="删除"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {servers.length === 0 && !isAddFormOpen && (
          <div className="empty-state">
            <p>暂无服务器</p>
            <p className="hint">点击下方“添加服务器”开始配置第一台机器</p>
          </div>
        )}
      </div>
    </div>
  );
}
