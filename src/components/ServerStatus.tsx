import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ServerStatusProps {
  serverId: string | null;
  serverName?: string | null;
  serverHost?: string | null;
}

interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
  mountedOn: string;
}

interface MemoryUsage {
  total: number;
  used: number;
  free: number;
  usePercent: number;
}

interface NetworkStats {
  interface: string;
  rxSpeed: number;
  txSpeed: number;
}

interface ListeningProcess {
  port: number;
  protocol: string;
}

interface ServerStatus {
  disk: DiskUsage[];
  memory: MemoryUsage;
  network: NetworkStats[];
  processes: ListeningProcess[];
}

interface ServerStatusSnapshot {
  disk_stdout: string;
  memory_stdout: string;
  network_stdout: string;
}

export function ServerStatus({ serverId, serverName, serverHost }: ServerStatusProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);
  const prevNetworkRef = useRef<Record<string, { rx: number; tx: number }>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!serverId) return;

    const isInitialLoad = !hasLoadedRef.current;
    if (isInitialLoad) {
      setError(null);
    }

    try {
      const snapshot = await invoke<ServerStatusSnapshot>('get_server_status', {
        serverId,
      });

      const disk = parseDisk(snapshot.disk_stdout);
      const memory = parseMemory(snapshot.memory_stdout);
      const network = parseNetwork(snapshot.network_stdout, prevNetworkRef.current);

      setStatus({ disk, memory, network, processes: [] });
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      console.error('Failed to fetch server status:', err);
      if (!hasLoadedRef.current) {
        setError('无法获取状态');
      }
    }
  }, [serverId]);

  useEffect(() => {
    hasLoadedRef.current = false;
    setStatus(null);
    setError(null);
  }, [serverId]);

  // Poll status in background when expanded
  useEffect(() => {
    if (isExpanded && serverId) {
      fetchStatus();
      pollIntervalRef.current = setInterval(fetchStatus, 15000);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isExpanded, serverId, fetchStatus]);

  if (!serverId) {
    return (
      <div className="server-status">
        <div className="status-header">
          <div className="status-header-copy">
            <span className="status-title">服务器状态</span>
            <span className="status-subtitle">未连接服务器</span>
          </div>
        </div>
        <div className="status-content status-content-empty">
          <div className="status-empty-block">
            <div className="status-empty-title">未连接服务器</div>
            <div className="status-empty-hint">选择左侧服务器后，这里会显示磁盘、内存和网络状态。</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="server-status">
      <div className="status-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="status-header-copy">
          <span className="status-title">服务器状态</span>
          <span className="status-subtitle">{serverName || '当前服务器'} · {serverHost || '未知地址'}</span>
        </div>
        <div className="status-header-meta">
          {error && <span className="status-error">错误</span>}
          <span className="status-toggle">{isExpanded ? '收起' : '展开'}</span>
        </div>
      </div>

      {isExpanded && status && (
        <div className="status-content">
          {/* Disk Usage */}
          <div className="status-section">
            <h4 className="section-title">磁盘使用</h4>
            <div className="disk-list">
              {status.disk.length === 0 ? (
                <div className="status-empty">无数据</div>
              ) : (
                status.disk.map((disk, idx) => (
                  <div key={idx} className="disk-item">
                    <div className="disk-info">
                      <span className="disk-fs">{disk.filesystem}</span>
                      <span className="disk-size">{disk.size}</span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className={`progress-fill ${disk.usePercent > 90 ? 'danger' : disk.usePercent > 70 ? 'warning' : ''}`}
                        style={{ width: `${disk.usePercent}%` }}
                      />
                    </div>
                    <div className="disk-usage">
                      {disk.used} / {disk.available} 可用 ({disk.usePercent}%)
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Memory Usage */}
          <div className="status-section">
            <h4 className="section-title">内存使用</h4>
            <div className="memory-item">
              <div className="progress-bar">
                <div
                  className={`progress-fill ${status.memory.usePercent > 90 ? 'danger' : status.memory.usePercent > 70 ? 'warning' : ''}`}
                  style={{ width: `${status.memory.usePercent}%` }}
                />
              </div>
              <div className="memory-usage">
                {status.memory.used} MB / {status.memory.total} MB ({status.memory.usePercent}%)
              </div>
            </div>
          </div>

          {/* Network Stats */}
          {status.network.length > 0 && (
            <div className="status-section">
              <h4 className="section-title">网络</h4>
              <div className="network-list">
                {status.network.map((net, idx) => (
                  <div key={idx} className="network-item">
                    <span className="net-iface">{net.interface}</span>
                    <span className="net-rx">↓ {formatBytes(net.rxSpeed)}/s</span>
                    <span className="net-tx">↑ {formatBytes(net.txSpeed)}/s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseDisk(output: string): DiskUsage[] {
  const lines = output.split('\n');
  const disks: DiskUsage[] = [];

  for (const line of lines) {
    if (line.startsWith('Filesystem') || !line.trim()) continue;
    if (!line.startsWith('/')) continue;

    const parts = line.split(/\s+/);
    if (parts.length >= 6) {
      const usePercent = parseInt(parts[4].replace('%', '')) || 0;
      disks.push({
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        usePercent,
        mountedOn: parts[5] || '',
      });
    }
  }

  return disks;
}

function parseMemory(output: string): MemoryUsage {
  const lines = output.split('\n');
  let total = 0, used = 0, free = 0;

  for (const line of lines) {
    if (line.startsWith('Mem:')) {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        total = parseInt(parts[1]) || 0;
        used = parseInt(parts[2]) || 0;
        free = parseInt(parts[3]) || 0;
      }
      break;
    }
  }

  return {
    total,
    used,
    free,
    usePercent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

function parseNetwork(output: string, prevStats: Record<string, { rx: number; tx: number }>): NetworkStats[] {
  const lines = output.split('\n');
  const stats: NetworkStats[] = [];
  const ifaces = ['eth0', 'ens33', 'enp0s3', 'wlo1', 'wlp2s0'];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    for (const iface of ifaces) {
      if (trimmedLine.startsWith(iface + ':')) {
        const parts = trimmedLine.split(':');
        if (parts.length < 2) continue;

        const values = parts[1].trim().split(/\s+/);
        if (values.length < 10) continue;

        const rxBytes = parseInt(values[0]) || 0;
        const txBytes = parseInt(values[8]) || 0;

        const prev = prevStats[iface] || { rx: rxBytes, tx: txBytes };
        const timeDelta = 5;

        stats.push({
          interface: iface,
          rxSpeed: Math.max(0, (rxBytes - prev.rx) / timeDelta),
          txSpeed: Math.max(0, (txBytes - prev.tx) / timeDelta),
        });

        prevStats[iface] = { rx: rxBytes, tx: txBytes };
        break;
      }
    }
  }

  return stats;
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
