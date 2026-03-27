import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const [masterPassword, setMasterPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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

        <div className="settings-content">
          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="security-settings">
            <p className="settings-description">
              设置主密码用于加密存储服务器凭证。AI 学习与经验沉淀现在全部走后端自动处理，不再需要手工导入学习数据。
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
        </div>
      </div>
    </div>
  );
}
