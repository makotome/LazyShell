import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, FileKey2, Globe2, Plus, RefreshCw, Server, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { SslCertificateRecord, SslCertificateScanResult, SslCertificateStatus } from '../types';

interface SslCertificateManagerProps {
  serverId: string;
  serverName: string;
}

interface ManualDialogState {
  path: string;
  error: string | null;
}

const STATUS_LABELS: Record<SslCertificateStatus, string> = {
  valid: '正常',
  expiring: '即将过期',
  expired: '已过期',
  missing: '不存在',
  unreadable: '无法读取',
};

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleString();
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleDateString();
}

function getStatusIcon(status: SslCertificateStatus) {
  if (status === 'valid') return <ShieldCheck className="ui-icon" aria-hidden="true" />;
  if (status === 'expiring') return <Clock3 className="ui-icon" aria-hidden="true" />;
  if (status === 'expired') return <ShieldAlert className="ui-icon" aria-hidden="true" />;
  if (status === 'missing') return <AlertTriangle className="ui-icon" aria-hidden="true" />;
  return <FileKey2 className="ui-icon" aria-hidden="true" />;
}

function summarizeDomains(record: SslCertificateRecord): string {
  if (record.domains.length === 0) return '未识别域名';
  if (record.domains.length <= 2) return record.domains.join(', ');
  return `${record.domains.slice(0, 2).join(', ')} +${record.domains.length - 2}`;
}

function getExpiryText(record: SslCertificateRecord): string {
  if (record.status === 'missing') return '文件不存在';
  if (record.status === 'unreadable') return '无法解析';
  if (record.daysUntilExpiry == null) return '未知';
  if (record.daysUntilExpiry < 0) return `已过期 ${Math.abs(record.daysUntilExpiry)} 天`;
  if (record.daysUntilExpiry === 0) return '今天过期';
  return `${record.daysUntilExpiry} 天后过期`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SslCertificateManager({ serverId, serverName }: SslCertificateManagerProps) {
  const [records, setRecords] = useState<SslCertificateRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const [manualDialog, setManualDialog] = useState<ManualDialogState | null>(null);

  const selectedRecord = useMemo(() => {
    return records.find((record) => record.path === selectedPath) || records[0] || null;
  }, [records, selectedPath]);

  const applyResult = useCallback((result: SslCertificateScanResult, preferredPath?: string) => {
    setRecords(result.records);
    setScannedAt(result.scannedAt);
    setLastError(result.lastError);
    setSelectedPath((currentPath) => {
      if (preferredPath && result.records.some((record) => record.path === preferredPath)) {
        return preferredPath;
      }
      if (currentPath && result.records.some((record) => record.path === currentPath)) {
        return currentPath;
      }
      return result.records[0]?.path || null;
    });
  }, []);

  const loadCertificates = useCallback(async () => {
    setLoading(true);
    setLoadingLabel('正在读取证书缓存...');
    try {
      const result = await invoke<SslCertificateScanResult>('load_ssl_certificates', { serverId });
      applyResult(result);
      if (result.records.length === 0) {
        setLoadingLabel('正在扫描 Nginx 配置...');
        const scanResult = await invoke<SslCertificateScanResult>('scan_nginx_ssl_certificates', { serverId });
        applyResult(scanResult);
      }
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [applyResult, serverId]);

  const scanCertificates = useCallback(async () => {
    setLoading(true);
    setLoadingLabel('正在扫描 Nginx 配置...');
    try {
      const result = await invoke<SslCertificateScanResult>('scan_nginx_ssl_certificates', { serverId });
      applyResult(result, selectedRecord?.path);
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [applyResult, selectedRecord?.path, serverId]);

  const inspectManualCertificate = useCallback(async () => {
    if (!manualDialog) return;
    const path = manualDialog.path.trim();
    if (!path) {
      setManualDialog({ ...manualDialog, error: '请输入远端证书路径。' });
      return;
    }
    setLoading(true);
    setLoadingLabel('正在读取证书信息...');
    try {
      const result = await invoke<SslCertificateScanResult>('inspect_ssl_certificate', {
        serverId,
        certificatePath: path,
      });
      applyResult(result, path);
      setManualDialog(null);
    } catch (error) {
      setManualDialog({ ...manualDialog, error: getErrorMessage(error) });
    } finally {
      setLoading(false);
      setLoadingLabel(null);
    }
  }, [applyResult, manualDialog, serverId]);

  useEffect(() => {
    void loadCertificates();
  }, [loadCertificates]);

  return (
    <div className="window-shell ssl-cert-window-shell">
      <div className="ssl-cert-manager">
        <header className="ssl-cert-toolbar">
          <div className="ssl-cert-title">
            <span className="ssl-cert-title-icon">
              <ShieldCheck className="ui-icon" aria-hidden="true" />
            </span>
            <div>
              <div className="ssl-cert-title-main">SSL 证书管理</div>
              <div className="ssl-cert-title-sub">
                <Server className="ui-icon" aria-hidden="true" />
                {serverName}
              </div>
            </div>
          </div>
          <div className="ssl-cert-toolbar-meta">
            <CalendarClock className="ui-icon" aria-hidden="true" />
            最后扫描：{formatTimestamp(scannedAt)}
          </div>
          <div className="ssl-cert-toolbar-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setManualDialog({ path: '', error: null })} disabled={loading}>
              <Plus className="ui-icon" aria-hidden="true" />
              手动添加
            </button>
            <button type="button" className="btn btn-primary btn-small" onClick={() => { void scanCertificates(); }} disabled={loading}>
              <RefreshCw className="ui-icon" aria-hidden="true" />
              {loading ? '处理中...' : '刷新扫描'}
            </button>
          </div>
        </header>

        {(lastError || loadingLabel) && (
          <div className={lastError ? 'error-message ssl-cert-banner' : 'success-message ssl-cert-banner'}>
            <span>{lastError || loadingLabel}</span>
          </div>
        )}

        <main className="ssl-cert-shell">
          <aside className="ssl-cert-list-panel">
            <div className="ssl-cert-panel-header">
              <span>
                <FileKey2 className="ui-icon" aria-hidden="true" />
                证书
              </span>
              <span>{records.length} 项</span>
            </div>
            <div className={`ssl-cert-list ${loading ? 'is-pending' : ''}`}>
              {records.length === 0 && !loading && (
                <div className="ssl-cert-empty">
                  <ShieldCheck className="ui-icon" aria-hidden="true" />
                  <div>还没有证书记录</div>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => { void scanCertificates(); }}>
                    <RefreshCw className="ui-icon" aria-hidden="true" />
                    扫描 Nginx 配置
                  </button>
                </div>
              )}
              {records.map((record) => (
                <button
                  key={record.path}
                  type="button"
                  className={`ssl-cert-row ${selectedRecord?.path === record.path ? 'selected' : ''}`}
                  onClick={() => setSelectedPath(record.path)}
                >
                  <span className={`ssl-cert-status-dot ${record.status}`}>{getStatusIcon(record.status)}</span>
                  <span className="ssl-cert-row-main">
                    <span className="ssl-cert-row-name">{record.name}</span>
                    <span className="ssl-cert-row-domains">{summarizeDomains(record)}</span>
                    <span className="ssl-cert-row-path">{record.path}</span>
                  </span>
                  <span className={`ssl-cert-status-pill ${record.status}`}>{STATUS_LABELS[record.status]}</span>
                  <span className="ssl-cert-row-expiry">{getExpiryText(record)}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="ssl-cert-detail-panel">
            {selectedRecord ? (
              <>
                <div className="ssl-cert-detail-header">
                  <div>
                    <div className="ssl-cert-detail-title">{selectedRecord.name}</div>
                    <div className="ssl-cert-detail-path">{selectedRecord.path}</div>
                  </div>
                  <span className={`ssl-cert-status-pill ${selectedRecord.status}`}>
                    {STATUS_LABELS[selectedRecord.status]}
                  </span>
                </div>

                <div className="ssl-cert-detail-grid">
                  <div className="ssl-cert-field">
                    <span>是否存在</span>
                    <strong>{selectedRecord.exists ? '存在' : '不存在'}</strong>
                  </div>
                  <div className="ssl-cert-field">
                    <span>签发日期</span>
                    <strong>{formatDate(selectedRecord.issuedAt)}</strong>
                  </div>
                  <div className="ssl-cert-field">
                    <span>过期日期</span>
                    <strong>{formatDate(selectedRecord.expiresAt)}</strong>
                  </div>
                  <div className="ssl-cert-field">
                    <span>剩余时间</span>
                    <strong>{getExpiryText(selectedRecord)}</strong>
                  </div>
                </div>

                <div className="ssl-cert-section">
                  <div className="ssl-cert-section-title">
                    <Globe2 className="ui-icon" aria-hidden="true" />
                    域名信息
                  </div>
                  <div className="ssl-cert-chip-list">
                    {selectedRecord.domains.length > 0
                      ? selectedRecord.domains.map((domain) => <span key={domain} className="ssl-cert-chip">{domain}</span>)
                      : <span className="ssl-cert-muted">未从证书中读取到 SAN 域名。</span>}
                  </div>
                </div>

                <div className="ssl-cert-section">
                  <div className="ssl-cert-section-title">
                    <CheckCircle2 className="ui-icon" aria-hidden="true" />
                    证书主体
                  </div>
                  <div className="ssl-cert-code-row">Subject: {selectedRecord.subject || '未知'}</div>
                  <div className="ssl-cert-code-row">Issuer: {selectedRecord.issuer || '未知'}</div>
                  {selectedRecord.lastError && (
                    <div className="ssl-cert-detail-error">{selectedRecord.lastError}</div>
                  )}
                </div>

                <div className="ssl-cert-section">
                  <div className="ssl-cert-section-title">
                    <Server className="ui-icon" aria-hidden="true" />
                    Nginx 关联
                  </div>
                  {selectedRecord.bindings.length === 0 ? (
                    <span className="ssl-cert-muted">当前证书没有 Nginx 配置关联，可能来自手动添加。</span>
                  ) : (
                    <div className="ssl-cert-binding-list">
                      {selectedRecord.bindings.map((binding, index) => (
                        <div key={`${binding.configPath}-${index}`} className="ssl-cert-binding">
                          <div className="ssl-cert-binding-path">{binding.configPath}</div>
                          <div className="ssl-cert-binding-meta">
                            <span>域名：{binding.serverNames.length ? binding.serverNames.join(', ') : '未声明'}</span>
                            <span>端口：{binding.listen.length ? binding.listen.join(', ') : '未声明'}</span>
                            <span>私钥：{binding.certificateKeyPath || '未声明'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="ssl-cert-detail-empty">
                <FileKey2 className="ui-icon" aria-hidden="true" />
                选择左侧证书查看详细信息。
              </div>
            )}
          </section>
        </main>
      </div>

      {manualDialog && (
        <div className="modal-overlay" onClick={() => setManualDialog(null)}>
          <div className="modal-content remote-file-input-modal ssl-cert-manual-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <FileKey2 className="ui-icon" aria-hidden="true" />
                手动添加证书
              </h2>
              <button type="button" className="btn btn-icon" onClick={() => setManualDialog(null)} aria-label="关闭">
                <X className="ui-icon" aria-hidden="true" />
              </button>
            </div>
            <div className="card-edit-form">
              <input
                className="card-edit-input"
                value={manualDialog.path}
                placeholder="/etc/letsencrypt/live/example.com/fullchain.pem"
                onChange={(event) => setManualDialog({ path: event.target.value, error: null })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void inspectManualCertificate();
                  }
                }}
                autoFocus
              />
              {manualDialog.error && <div className="error-message">{manualDialog.error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setManualDialog(null)}>取消</button>
                <button type="button" className="btn btn-primary" onClick={() => { void inspectManualCertificate(); }} disabled={loading}>
                  <CheckCircle2 className="ui-icon" aria-hidden="true" />
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
