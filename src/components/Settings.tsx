import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { LearningDataEntry } from '../types';

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'security' | 'learning'>('security');
  const [masterPassword, setMasterPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [learningData, setLearningData] = useState<LearningDataEntry[]>([]);

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

  const handleSetMasterPassword = async () => {
    setError(null);
    setSuccess(null);

    if (masterPassword.length < 8) {
      setError('主密码至少需要 8 个字符');
      return;
    }

    if (masterPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    try {
      await invoke('set_master_password', { password: masterPassword });
      setSuccess('主密码已设置');
      setMasterPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败');
    }
  };

  return (
    <div className="settings-overlay">
      <div className="settings-modal">
        <div className="settings-header">
          <h2>设置</h2>
          <button className="btn btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`tab ${activeTab === 'security' ? 'active' : ''}`}
            onClick={() => setActiveTab('security')}
          >
            安全设置
          </button>
          <button
            className={`tab ${activeTab === 'learning' ? 'active' : ''}`}
            onClick={() => setActiveTab('learning')}
          >
            学习数据
          </button>
        </div>

        <div className="settings-content">
          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          {activeTab === 'security' && (
            <div className="security-settings">
              <p className="settings-description">
                设置主密码用于加密存储服务器凭证
              </p>

              <div className="form-group">
                <label>主密码</label>
                <input
                  type="password"
                  value={masterPassword}
                  onChange={(e) => setMasterPassword(e.target.value)}
                  placeholder="至少 8 个字符"
                />
              </div>

              <div className="form-group">
                <label>确认密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                />
              </div>

              <button className="btn btn-primary btn-full" onClick={handleSetMasterPassword}>
                设置主密码
              </button>
            </div>
          )}

          {activeTab === 'learning' && (
            <div className="learning-settings">
              <p className="settings-description">
                管理自然语言到命令的映射学习数据
              </p>

              {learningData.length === 0 ? (
                <div className="empty-state">
                  <p>暂无学习数据</p>
                  <p className="hint">使用AI助手执行命令后会自动记录</p>
                </div>
              ) : (
                <div className="learning-list">
                  {learningData.map((entry) => (
                    <div key={entry.id} className="learning-entry">
                      <div className="learning-nl">{entry.natural_language}</div>
                      <div className="learning-command">{entry.command}</div>
                      <div className="learning-meta">
                        使用 {entry.usage_count} 次 |{' '}
                        {new Date(entry.last_used).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="learning-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const json = JSON.stringify(learningData, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'lazyshell-learning.json';
                    a.click();
                    URL.revokeObjectURL(url);
                    setSuccess('学习数据已导出');
                  }}
                >
                  导出数据
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.json';
                    input.onchange = async (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      try {
                        const imported = JSON.parse(text) as LearningDataEntry[];
                        await invoke('save_learning_data', { entries: imported });
                        setLearningData(imported);
                        setSuccess('学习数据已导入');
                      } catch {
                        setError('导入失败：无效的JSON格式');
                      }
                    };
                    input.click();
                  }}
                >
                  导入数据
                </button>
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (confirm('确定要清空所有学习数据吗？')) {
                      await invoke('save_learning_data', { entries: [] });
                      setLearningData([]);
                      setSuccess('学习数据已清空');
                    }
                  }}
                >
                  清空数据
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
