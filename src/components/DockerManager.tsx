import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Box, Clock3, FolderOpen, HardDrive, Layers, Network, RefreshCw, Server, SquareTerminal } from 'lucide-react';
import type { DockerContainerRecord, DockerDetailsSnapshot } from '../types';

interface DockerManagerProps {
  serverId: string;
  serverName: string;
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '未知';
  return new Date(timestamp * 1000).toLocaleString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string | null | undefined, max = 96): string {
  if (!value) return '-';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function statusLabel(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === 'running') return '运行中';
  if (normalized === 'exited') return '已退出';
  if (normalized === 'paused') return '已暂停';
  if (normalized === 'restarting') return '重启中';
  if (normalized === 'created') return '已创建';
  return state || '未知';
}

function statusClass(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'exited' || normalized === 'dead') return 'stopped';
  return 'other';
}

function fullCommand(record: DockerContainerRecord): string {
  return [record.command, ...record.args].filter(Boolean).join(' ') || '-';
}

function portSummary(record: DockerContainerRecord): string {
  if (record.ports.length === 0) return '无端口映射';
  return record.ports
    .map((port) => {
      const publicSide = port.publicPort ? `${port.publicHost || '0.0.0.0'}:${port.publicPort}->` : '';
      return `${publicSide}${port.privatePort}/${port.protocol}`;
    })
    .join(', ');
}

function composeSummary(record: DockerContainerRecord): string {
  if (!record.compose) return '非 Compose 容器';
  return [record.compose.project, record.compose.service].filter(Boolean).join(' / ') || 'Compose 容器';
}

function relationSummary(record: DockerContainerRecord): string {
  if (record.relatedContainers.length === 0) return '无明显关联';
  const composeCount = record.relatedContainers.filter((item) => item.relationType === 'compose').length;
  const networkCount = record.relatedContainers.filter((item) => item.relationType === 'network').length;
  const envCount = record.relatedContainers.filter((item) => item.relationType === 'envReference').length;
  return [
    composeCount ? `同项目 ${composeCount}` : null,
    networkCount ? `同网络 ${networkCount}` : null,
    envCount ? `引用 ${envCount}` : null,
  ].filter(Boolean).join(' · ') || `${record.relatedContainers.length} 个关联`;
}

function relationTypeLabel(type: string): string {
  if (type === 'compose') return 'Compose';
  if (type === 'network') return '网络';
  if (type === 'envReference') return '引用';
  return type;
}

function maskEnv(value: string): string {
  const [key, ...rest] = value.split('=');
  const envValue = rest.join('=');
  if (!envValue) return value;
  if (/password|passwd|secret|token|key|credential/i.test(key)) {
    return `${key}=******`;
  }
  return value;
}

export function DockerManager({ serverId, serverName }: DockerManagerProps) {
  const [snapshot, setSnapshot] = useState<DockerDetailsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const selected = useMemo(() => {
    return snapshot?.containers.find((item) => item.id === selectedId) || snapshot?.containers[0] || null;
  }, [selectedId, snapshot]);

  const loadDocker = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    try {
      const result = await invoke<DockerDetailsSnapshot>('get_docker_details', { serverId });
      setSnapshot(result);
      setLastError(result.lastError);
      setSelectedId((currentId) => {
        if (currentId && result.containers.some((item) => item.id === currentId)) return currentId;
        return result.containers[0]?.id || null;
      });
    } catch (error) {
      setLastError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void loadDocker();
  }, [loadDocker]);

  return (
    <div className="window-shell docker-manager-window-shell">
      <div className="docker-manager">
        <header className="docker-manager-toolbar">
          <div className="docker-manager-title">
            <span className="docker-manager-title-icon">
              <Box className="ui-icon" aria-hidden="true" />
            </span>
            <div>
              <div className="docker-manager-title-main">Docker 容器</div>
              <div className="docker-manager-title-sub">
                <Server className="ui-icon" aria-hidden="true" />
                {serverName}
              </div>
            </div>
          </div>
          <div className="docker-manager-toolbar-meta">
            Docker：{snapshot?.dockerVersion || '未知'} · 扫描：{formatTimestamp(snapshot?.scannedAt || null)}
          </div>
          <button type="button" className="btn btn-primary btn-small" onClick={() => { void loadDocker(); }} disabled={loading}>
            <RefreshCw className="ui-icon" aria-hidden="true" />
            {loading ? '扫描中...' : '刷新'}
          </button>
        </header>

        {(lastError || loading) && (
          <div className={lastError ? 'error-message docker-manager-banner' : 'success-message docker-manager-banner'}>
            <span>{lastError || '正在读取 Docker 容器状态...'}</span>
          </div>
        )}

        <main className="docker-manager-shell">
          <aside className="docker-manager-list-panel">
            <div className="docker-manager-panel-header">
              <span>
                <Layers className="ui-icon" aria-hidden="true" />
                容器列表
              </span>
              <span>{snapshot?.containers.length || 0} 项</span>
            </div>
            <div className={`docker-manager-list ${loading ? 'is-pending' : ''}`}>
              {snapshot && snapshot.containers.length === 0 && !loading && (
                <div className="docker-manager-empty">
                  <Box className="ui-icon" aria-hidden="true" />
                  <div>没有发现 Docker 容器。</div>
                </div>
              )}
              {snapshot?.containers.map((container) => (
                <button
                  type="button"
                  key={container.id}
                  className={`docker-manager-row ${selected?.id === container.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(container.id)}
                >
                  <span className={`docker-manager-status-dot ${statusClass(container.state)}`} />
                  <span className="docker-manager-row-main">
                    <span className="docker-manager-row-title">{container.name}</span>
                    <span className="docker-manager-row-sub">{container.image}</span>
                    <span className="docker-manager-row-command">{composeSummary(container)} · {relationSummary(container)} · {truncate(portSummary(container), 64)}</span>
                  </span>
                  <span className={`docker-manager-status-pill ${statusClass(container.state)}`}>{statusLabel(container.state)}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="docker-manager-detail-panel">
            {selected ? (
              <DockerDetail container={selected} />
            ) : (
              <div className="docker-manager-detail-empty">
                <Box className="ui-icon" aria-hidden="true" />
                <div>选择左侧容器查看运行状态、Compose 路径、端口和挂载详情。</div>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function DockerDetail({ container }: { container: DockerContainerRecord }) {
  return (
    <>
      <div className="docker-manager-detail-header">
        <div>
          <div className="docker-manager-detail-title">{container.name}</div>
          <div className="docker-manager-detail-path">{container.shortId} · {container.image}</div>
        </div>
        <span className={`docker-manager-status-pill ${statusClass(container.state)}`}>{statusLabel(container.state)}</span>
      </div>

      <div className="docker-manager-detail-grid">
        <DetailField label="运行时间" value={formatDuration(container.uptimeSeconds)} />
        <DetailField label="启动时间" value={container.startedAt ? new Date(container.startedAt).toLocaleString() : '-'} />
        <DetailField label="重启次数" value={String(container.restartCount)} />
        <DetailField label="重启策略" value={container.restartPolicy || '-'} />
        <DetailField label="网络模式" value={container.networkMode || '-'} />
        <DetailField label="工作目录" value={container.workingDir || '-'} />
        <DetailField label="对外暴露" value={container.externallyExposed ? '是' : '否'} />
      </div>

      {container.compose && (
        <div className="docker-manager-section">
          <div className="docker-manager-section-title">
            <FolderOpen className="ui-icon" aria-hidden="true" />
            Docker Compose
          </div>
          <div className="docker-manager-compose-card">
            <DetailField label="项目" value={container.compose.project || '-'} />
            <DetailField label="服务" value={container.compose.service || '-'} />
            <DetailField label="编号" value={container.compose.containerNumber || '-'} />
            <DetailField label="运行目录" value={container.compose.workingDir || '-'} />
            <div className="docker-manager-compose-files">
              <span>配置文件</span>
              <strong>{container.compose.configFiles.length > 0 ? container.compose.configFiles.join('\n') : '-'}</strong>
            </div>
          </div>
        </div>
      )}

      <CodeSection title="启动命令" icon={<SquareTerminal className="ui-icon" aria-hidden="true" />} value={fullCommand(container)} />
      <ListSection
        title="关系推断"
        icon={<Layers className="ui-icon" aria-hidden="true" />}
        empty="没有从 Compose、网络或环境变量中推断出容器关联。"
        rows={container.relatedContainers.map((relation) => ({
          key: `${relation.targetId}-${relation.relationType}-${relation.detail}`,
          title: `${relation.targetName} · ${relationTypeLabel(relation.relationType)}`,
          value: `${relation.source}：${relation.detail}`,
        }))}
      />
      <ListSection
        title="端口映射"
        icon={<Network className="ui-icon" aria-hidden="true" />}
        empty="没有端口映射。"
        rows={container.ports.map((port) => ({
          key: `${port.privatePort}-${port.publicPort}-${port.protocol}`,
          title: `${port.privatePort}/${port.protocol}`,
          value: port.publicPort ? `${port.publicHost || '0.0.0.0'}:${port.publicPort}` : '未发布到宿主机',
        }))}
      />
      <ListSection
        title="挂载"
        icon={<HardDrive className="ui-icon" aria-hidden="true" />}
        empty="没有挂载卷。"
        rows={container.mounts.map((mount) => ({
          key: `${mount.source}-${mount.destination}`,
          title: mount.destination,
          value: `${mount.mountType}${mount.source ? ` · ${mount.source}` : ''}${mount.rw ? ' · 可写' : ' · 只读'}`,
        }))}
      />
      <ListSection
        title="网络"
        icon={<Network className="ui-icon" aria-hidden="true" />}
        empty="没有网络详情。"
        rows={container.networks.map((network) => ({
          key: network.name,
          title: network.name,
          value: [
            network.ipAddress,
            network.gateway ? `网关 ${network.gateway}` : null,
            network.aliases.length > 0 ? `别名 ${network.aliases.join(', ')}` : null,
          ].filter(Boolean).join(' · ') || '-',
        }))}
      />
      <ListSection
        title="环境变量线索"
        icon={<SquareTerminal className="ui-icon" aria-hidden="true" />}
        empty="没有环境变量。"
        rows={container.env.map((item) => {
          const [key] = item.split('=');
          return {
            key: item,
            title: key || item,
            value: maskEnv(item),
          };
        })}
      />
      <CodeSection title="Entrypoint / Args" icon={<Clock3 className="ui-icon" aria-hidden="true" />} value={[container.entrypoint.join(' '), container.args.join(' ')].filter(Boolean).join('\n') || '-'} />
    </>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="docker-manager-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CodeSection({ title, icon, value }: { title: string; icon: ReactNode; value: string }) {
  return (
    <div className="docker-manager-section">
      <div className="docker-manager-section-title">
        {icon}
        {title}
      </div>
      <pre className="docker-manager-code-block">{value}</pre>
    </div>
  );
}

function ListSection({
  title,
  icon,
  empty,
  rows,
}: {
  title: string;
  icon: ReactNode;
  empty: string;
  rows: Array<{ key: string; title: string; value: string }>;
}) {
  return (
    <div className="docker-manager-section">
      <div className="docker-manager-section-title">
        {icon}
        {title}
      </div>
      <div className="docker-manager-list-block">
        {rows.length === 0 && <div className="docker-manager-list-empty">{empty}</div>}
        {rows.map((row) => (
          <div className="docker-manager-list-row" key={row.key}>
            <strong>{row.title}</strong>
            <span>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
