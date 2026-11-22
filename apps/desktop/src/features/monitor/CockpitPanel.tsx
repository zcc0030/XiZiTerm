import * as React from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Clock,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Server,
  X,
} from 'lucide-react';
import type {
  HostMetricsSnapshot,
  SshConnectionState,
} from '@xiziterm/shared';
import { useThemeStore } from '@/stores/theme.store';
import type { ThemeChartColors } from '@/theme/themes';

interface CockpitPanelProps {
  sessionId: string;
  hostName: string;
  connectionState: SshConnectionState;
  onClose: () => void;
}

const HISTORY_LIMIT = 30;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const val = bytes / Math.pow(1024, exp);
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[exp]}`;
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}时 ${mins}分`;
  if (hours > 0) return `${hours}时 ${mins}分`;
  return `${mins} 分钟`;
}

function usageColorText(pct: number): string {
  if (pct >= 85) return 'text-theme-error';
  if (pct >= 65) return 'text-theme-warn';
  return 'text-theme-accent';
}

function usageColorBar(pct: number): string {
  if (pct >= 85) return 'bg-theme-error';
  if (pct >= 65) return 'bg-theme-warn';
  return 'bg-theme-accent';
}

function usageStrokeColor(
  pct: number,
  normalColor: string,
  charts: ThemeChartColors
): string {
  if (pct >= 85) return charts.error;
  if (pct >= 65) return charts.warn;
  return normalColor;
}

function RadialGauge({
  percent,
  label,
  charts,
}: {
  percent: number;
  label: string;
  charts: ThemeChartColors;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  const size = 68;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const strokeColor = usageStrokeColor(clamped, charts.cpu, charts);

  return (
    <div className="relative flex h-[68px] w-[68px] shrink-0 items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-color)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-300"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-xs font-bold text-theme-primary">
          {clamped.toFixed(0)}%
        </span>
        <span className="text-[9px] uppercase tracking-wider text-theme-muted">
          {label}
        </span>
      </div>
    </div>
  );
}

function Sparkline({
  series,
  maxValue,
  height = 42,
}: {
  series: Array<{ data: number[]; color: string; fill?: string }>;
  maxValue?: number;
  height?: number;
}) {
  const width = 220;
  const padY = 3;
  const allVals = series.flatMap((s) => s.data);
  const computedMax =
    maxValue ?? Math.max(1024, ...allVals, 1) * 1.15;

  const buildPath = (data: number[]) => {
    if (data.length === 0) return '';
    const pts = data.map((v, i) => {
      const x =
        data.length === 1
          ? width
          : (i / Math.max(1, HISTORY_LIMIT - 1)) * width;
      const ratio = Math.min(1, Math.max(0, v / computedMax));
      const y = height - padY - ratio * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M ${pts.join(' L ')}`;
  };

  const buildArea = (data: number[]) => {
    if (data.length < 2) return '';
    const line = buildPath(data);
    const lastX =
      ((data.length - 1) / Math.max(1, HISTORY_LIMIT - 1)) * width;
    return `${line} L ${lastX.toFixed(1)},${height} L 0,${height} Z`;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full overflow-visible rounded border border-theme-border/60 bg-theme-input"
      style={{ height: `${height}px` }}
    >
      {/* Subtle horizontal gridline */}
      <line
        x1={0}
        y1={height * 0.5}
        x2={width}
        y2={height * 0.5}
        stroke="var(--border-color)"
        strokeOpacity={0.55}
        strokeDasharray="3 3"
      />
      {series.map((s, idx) => (
        <React.Fragment key={idx}>
          {s.fill && s.data.length >= 2 && (
            <path d={buildArea(s.data)} fill={s.fill} />
          )}
          {s.data.length >= 2 && (
            <path
              d={buildPath(s.data)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
        </React.Fragment>
      ))}
    </svg>
  );
}

export function CockpitPanel({
  sessionId,
  hostName,
  connectionState,
  onClose,
}: CockpitPanelProps) {
  const theme = useThemeStore((s) => s.theme);
  const charts = theme.charts;

  const [intervalMs, setIntervalMs] = React.useState(2500);
  const [snapshot, setSnapshot] = React.useState<HostMetricsSnapshot | null>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);
  const [cpuHistory, setCpuHistory] = React.useState<number[]>([]);
  const [memHistory, setMemHistory] = React.useState<number[]>([]);
  const [rxHistory, setRxHistory] = React.useState<number[]>([]);
  const [txHistory, setTxHistory] = React.useState<number[]>([]);

  // Subscribe to metric samples & errors for active session
  React.useEffect(() => {
    setSnapshot(null);
    setError(null);
    setCpuHistory([]);
    setMemHistory([]);
    setRxHistory([]);
    setTxHistory([]);

    const offSample = window.xiziterm.monitor.onSample((sample) => {
      if (sample.sessionId !== sessionId) return;
      setError(null);
      setSnapshot(sample);
      setCpuHistory((prev) =>
        [...prev, sample.cpuUsagePercent].slice(-HISTORY_LIMIT)
      );
      setMemHistory((prev) =>
        [...prev, sample.memUsagePercent].slice(-HISTORY_LIMIT)
      );
      setRxHistory((prev) =>
        [...prev, sample.netRxBytesPerSec].slice(-HISTORY_LIMIT)
      );
      setTxHistory((prev) =>
        [...prev, sample.netTxBytesPerSec].slice(-HISTORY_LIMIT)
      );
    });

    const offError = window.xiziterm.monitor.onError((ev) => {
      if (ev.sessionId !== sessionId) return;
      setError(ev.error);
    });

    return () => {
      offSample();
      offError();
    };
  }, [sessionId]);

  // Start / stop polling cleanly with active session & interval
  React.useEffect(() => {
    if (connectionState !== 'connected') {
      void window.xiziterm.monitor.stop(sessionId);
      return;
    }

    let cancelled = false;
    void window.xiziterm.monitor.start(sessionId, intervalMs).then((res) => {
      if (!cancelled && !res.ok) {
        setError(res.error ?? '无法启动主机监控');
      }
    });

    return () => {
      cancelled = true;
      void window.xiziterm.monitor.stop(sessionId);
    };
  }, [sessionId, connectionState, intervalMs]);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-theme-border bg-theme-sidebar">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-theme-border bg-theme-elevated/55 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-3.5 w-3.5 shrink-0 text-theme-accent" />
          <span className="truncate text-xs font-semibold text-theme-primary">
            主机座舱
          </span>
          {connectionState === 'connected' && snapshot && (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-theme-online" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="采集频率"
            className="h-6 rounded border border-theme-border bg-theme-input px-1.5 font-mono text-[10px] text-theme-primary outline-none focus:border-theme-accent"
          >
            <option value={2000}>2s</option>
            <option value={2500}>2.5s</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
          </select>
          <button
            type="button"
            onClick={onClose}
            title="收起座舱面板"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {connectionState !== 'connected' ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-xs text-theme-muted">
            <Server className="h-6 w-6 opacity-50" />
            <span>SSH 连接就绪后自动开始无 Agent 实时监控</span>
          </div>
        ) : !snapshot ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-xs text-theme-muted">
            <Loader2 className="h-5 w-5 animate-spin text-theme-accent" />
            <span>正在采集 {hostName} 指标...</span>
            {error && (
              <span className="mt-1 rounded border border-theme-error/35 bg-theme-error-soft px-2 py-1 text-[11px] text-theme-error">
                {error}
              </span>
            )}
          </div>
        ) : (
          <>
            {error && (
              <div className="rounded-md border border-theme-warn/35 bg-theme-warn-soft px-2.5 py-1.5 text-[11px] text-theme-warn">
                采集波动: {error}
              </div>
            )}

            {/* System Overview Card */}
            <div className="rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs font-semibold text-theme-primary">
                  {snapshot.hostname}
                </div>
                <span className="shrink-0 rounded bg-theme-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-theme-accent">
                  {snapshot.cpuCores} vCPU
                </span>
              </div>
              <div
                className="mt-1 truncate text-[11px] text-theme-muted"
                title={snapshot.osPrettyName}
              >
                {snapshot.osPrettyName}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-theme-border/70 pt-1.5 font-mono text-[10px] text-theme-muted">
                <span className="truncate" title={snapshot.kernel}>
                  {snapshot.kernel || 'Linux'}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Clock className="h-3 w-3 opacity-75" />
                  {formatUptime(snapshot.uptimeSeconds)}
                </span>
              </div>
            </div>

            {/* CPU & Load Card */}
            <div className="rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-theme-primary">
                  <Cpu
                    className="h-3.5 w-3.5"
                    style={{ color: charts.cpu }}
                  />
                  CPU & 负载
                </span>
                <span
                  className={`font-mono text-xs font-semibold ${usageColorText(
                    snapshot.cpuUsagePercent
                  )}`}
                >
                  {snapshot.cpuUsagePercent.toFixed(1)}%
                </span>
              </div>

              <div className="flex items-center gap-3">
                <RadialGauge
                  percent={snapshot.cpuUsagePercent}
                  label="CPU"
                  charts={charts}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <Sparkline
                    maxValue={100}
                    height={38}
                    series={[
                      {
                        data: cpuHistory,
                        color: usageStrokeColor(
                          snapshot.cpuUsagePercent,
                          charts.cpu,
                          charts
                        ),
                        fill: charts.cpuFill,
                      },
                    ]}
                  />
                  <div className="grid grid-cols-3 gap-1 text-center font-mono text-[10px]">
                    <div className="rounded border border-theme-border/50 bg-theme-input py-0.5">
                      <div className="text-theme-muted">1m</div>
                      <div className="text-theme-primary">
                        {snapshot.loadAverage[0].toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded border border-theme-border/50 bg-theme-input py-0.5">
                      <div className="text-theme-muted">5m</div>
                      <div className="text-theme-primary">
                        {snapshot.loadAverage[1].toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded border border-theme-border/50 bg-theme-input py-0.5">
                      <div className="text-theme-muted">15m</div>
                      <div className="text-theme-primary">
                        {snapshot.loadAverage[2].toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Memory & Swap Card */}
            <div className="space-y-2.5 rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-theme-primary">
                  <MemoryStick
                    className="h-3.5 w-3.5"
                    style={{ color: charts.mem }}
                  />
                  内存 & Swap
                </span>
                <span
                  className={`font-mono text-xs font-semibold ${usageColorText(
                    snapshot.memUsagePercent
                  )}`}
                >
                  {snapshot.memUsagePercent.toFixed(1)}%
                </span>
              </div>

              <div>
                <div className="mb-1 flex justify-between font-mono text-[10px] text-theme-muted">
                  <span>RAM</span>
                  <span>
                    {formatBytes(snapshot.memUsedBytes)} /{' '}
                    {formatBytes(snapshot.memTotalBytes)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-theme-border/75">
                  <div
                    className="h-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, snapshot.memUsagePercent)}%`,
                      backgroundColor: usageStrokeColor(
                        snapshot.memUsagePercent,
                        charts.mem,
                        charts
                      ),
                    }}
                  />
                </div>
              </div>

              <Sparkline
                maxValue={100}
                height={32}
                series={[
                  {
                    data: memHistory,
                    color: charts.mem,
                    fill: charts.memFill,
                  },
                ]}
              />

              <div className="border-t border-theme-border/70 pt-2">
                <div className="mb-1 flex justify-between font-mono text-[10px] text-theme-muted">
                  <span>SWAP</span>
                  <span>
                    {snapshot.swapTotalBytes > 0
                      ? `${formatBytes(snapshot.swapUsedBytes)} / ${formatBytes(
                          snapshot.swapTotalBytes
                        )} (${snapshot.swapUsagePercent.toFixed(0)}%)`
                      : '未启用'}
                  </span>
                </div>
                {snapshot.swapTotalBytes > 0 && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-theme-border/75">
                    <div
                      className={`h-full transition-all duration-300 ${usageColorBar(
                        snapshot.swapUsagePercent
                      )}`}
                      style={{
                        width: `${Math.min(100, snapshot.swapUsagePercent)}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Network Real-time Throughput Card */}
            <div className="space-y-2 rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-theme-primary">
                  <Network className="h-3.5 w-3.5 text-theme-online" />
                  实时网络速率
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="rounded border border-theme-border bg-theme-input px-2 py-1.5">
                  <div
                    className="flex items-center gap-1 text-[10px]"
                    style={{ color: charts.rx }}
                  >
                    <ArrowDown className="h-3 w-3" />
                    下行 RX
                  </div>
                  <div className="mt-0.5 truncate font-semibold text-theme-primary">
                    {formatRate(snapshot.netRxBytesPerSec)}
                  </div>
                </div>
                <div className="rounded border border-theme-border bg-theme-input px-2 py-1.5">
                  <div
                    className="flex items-center gap-1 text-[10px]"
                    style={{ color: charts.tx }}
                  >
                    <ArrowUp className="h-3 w-3" />
                    上行 TX
                  </div>
                  <div className="mt-0.5 truncate font-semibold text-theme-primary">
                    {formatRate(snapshot.netTxBytesPerSec)}
                  </div>
                </div>
              </div>

              <Sparkline
                height={42}
                series={[
                  {
                    data: rxHistory,
                    color: charts.rx,
                    fill: charts.rxFill,
                  },
                  {
                    data: txHistory,
                    color: charts.tx,
                    fill: charts.txFill,
                  },
                ]}
              />

              {snapshot.netInterfaces.length > 0 && (
                <div className="space-y-1 border-t border-theme-border/70 pt-1.5 font-mono text-[10px] text-theme-muted">
                  {snapshot.netInterfaces.map((nic) => (
                    <div
                      key={nic.name}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate text-theme-primary">
                        {nic.name}
                      </span>
                      <span className="shrink-0 text-theme-muted">
                        ↓{formatRate(nic.rxBytesPerSec)} · ↑
                        {formatRate(nic.txBytesPerSec)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Disk Partitions Card */}
            <div className="space-y-2 rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-theme-primary">
                  <HardDrive className="h-3.5 w-3.5 text-theme-warn" />
                  磁盘分区 ({snapshot.disks.length})
                </span>
              </div>

              {snapshot.disks.length === 0 ? (
                <div className="text-[11px] text-theme-muted">
                  未检测到挂载分区
                </div>
              ) : (
                <div className="space-y-2">
                  {snapshot.disks.map((disk) => (
                    <div key={disk.mount} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                        <span
                          className="truncate font-medium text-theme-primary"
                          title={`${disk.filesystem} -> ${disk.mount}`}
                        >
                          {disk.mount}
                        </span>
                        <span
                          className={`shrink-0 ${usageColorText(
                            disk.usedPercent
                          )}`}
                        >
                          {disk.usedPercent.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-theme-border/75">
                        <div
                          className={`h-full transition-all duration-300 ${usageColorBar(
                            disk.usedPercent
                          )}`}
                          style={{
                            width: `${Math.min(100, disk.usedPercent)}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between font-mono text-[10px] text-theme-muted">
                        <span className="truncate">{disk.filesystem}</span>
                        <span className="shrink-0">
                          {formatBytes(disk.usedBytes)} /{' '}
                          {formatBytes(disk.totalBytes)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
