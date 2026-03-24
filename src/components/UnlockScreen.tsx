import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './UnlockScreen.css';

interface UnlockScreenProps {
  onUnlock: () => void;
}

export function UnlockScreen({ onUnlock }: UnlockScreenProps) {
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Check if master password exists on mount
  useState(() => {
    invoke<boolean>('has_master_password')
      .then(hasPassword => {
        setIsSetupMode(!hasPassword);
      })
      .catch(() => {
        setIsSetupMode(true);
      });
  });

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (isSetupMode) {
        // Setup mode: create new password
        if (password.length < 8) {
          setError('密码长度至少为 8 个字符');
          setIsLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError('两次输入的密码不一致');
          setIsLoading(false);
          return;
        }

        await invoke('setup_master_password', { password });
        onUnlock();
      } else {
        // Unlock mode: verify password
        const success = await invoke<boolean>('unlock_with_password', { password });
        if (success) {
          onUnlock();
        } else {
          setError('密码错误，请重试');
        }
      }
    } catch (err) {
      setError(`操作失败: ${err}`);
    } finally {
      setIsLoading(false);
    }
  }, [isSetupMode, password, confirmPassword, onUnlock]);

  return (
    <div className="unlock-screen">
      <div className="unlock-container">
        <div className="unlock-header">
          <div className="unlock-kicker">Mission Control</div>
          <div className="unlock-icon">▣</div>
          <h1 className="unlock-title">LazyShell</h1>
          <p className="unlock-subtitle">
            {isSetupMode ? '设置主密码以保护您的服务器配置' : '请输入主密码解锁'}
          </p>
        </div>

        <form className="unlock-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="password">
              {isSetupMode ? '设置密码' : '主密码'}
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetupMode ? '至少 8 个字符' : '输入密码'}
              autoFocus
              disabled={isLoading}
            />
          </div>

          {isSetupMode && (
            <div className="form-group">
              <label htmlFor="confirmPassword">确认密码</label>
              <input
                type="password"
                id="confirmPassword"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                disabled={isLoading}
              />
            </div>
          )}

          {error && <div className="unlock-error">{error}</div>}

          <button
            type="submit"
            className="unlock-button"
            disabled={isLoading || !password}
          >
            {isLoading ? '处理中...' : (isSetupMode ? '设置密码' : '解锁')}
          </button>
        </form>

        {!isSetupMode && (
          <div className="unlock-hint">
            <p>忘记密码？删除 <code>auth.bin</code> 文件可重置</p>
            <p className="hint-path">数据位置: ~/.local/share/LazyShell/auth.bin</p>
          </div>
        )}

        {isSetupMode && (
          <div className="unlock-hint">
            <p>主密码用于加密您的服务器配置</p>
            <p>请牢记密码，忘记后将无法恢复数据</p>
          </div>
        )}
      </div>
    </div>
  );
}
