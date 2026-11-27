import { promises as fsp } from 'fs';
import os from 'os';
import type { Client } from 'ssh2';
import type {
  DiskPartitionUsage,
  HostMetricsSnapshot,
  MonitorErrorEvent,
  NetInterfaceRate,
} from '@xiziterm/shared';
import { sshService } from './ssh.service';
import { localPtyService } from './local-pty.service';

const PROBE_COMMAND = [
  'printf "===CPU===\\n"',
  'head -n 1 /proc/stat 2>/dev/null',
  'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1',
  'printf "===MEM===\\n"',
  "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
  'printf "===LOAD===\\n"',
  'cat /proc/loadavg 2>/dev/null',
  'cat /proc/uptime 2>/dev/null',
  'printf "===NET===\\n"',
  'cat /proc/net/dev 2>/dev/null',
  'printf "===DISK===\\n"',
  'df -P -k 2>/dev/null',
  'printf "===SYS===\\n"',
  'hostname 2>/dev/null',
  'uname -r 2>/dev/null',
  "grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null",
].join('; ');

const IGNORED_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'udev',
  'none',
  'efivarfs',
  'cgroup',
  'cgroup2',
  'proc',
  'sysfs',
  'nsfs',
  'mqueue',
  'hugetlbfs',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'configfs',
  'fusectl',
  'binfmt_misc',
  'ramfs',
  'devpts',
  'autofs',
  'bpf',
]);

interface CpuRaw {
  total: number;
  idle: number;
}

interface NetRawMap {
  [iface: string]: { rx: number; tx: number };
}

interface SessionMonitor {
  sessionId: string;
  isLocal: boolean;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  inFlight: boolean;
  sampleCount: number;
  prevCpu: CpuRaw | null;
  prevNet: { timestamp: number; ifaces: NetRawMap } | null;
}

type SampleCallback = (snapshot: HostMetricsSnapshot) => void;
type ErrorCallback = (event: MonitorErrorEvent) => void;

function execCommand(
  client: Client,
  command: string,
  timeoutMs = 6000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('指标采集超时'));
      }
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }

      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (!stdout && stderr) {
            reject(new Error(stderr.trim()));
          } else {
            resolve(stdout);
          }
        }
      });
    });
  });
}

function splitSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /^===([A-Z]+)===$/gm;
  const matches: Array<{ name: string; index: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    matches.push({
      name: m[1],
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const stop = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    sections[matches[i].name] = raw.slice(start, stop).trim();
  }
  return sections;
}

function parseCpuSection(text: string): { raw: CpuRaw | null; cores: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let raw: CpuRaw | null = null;
  let cores = 1;

  for (const line of lines) {
    if (line.startsWith('cpu ')) {
      const nums = line
        .slice(4)
        .trim()
        .split(/\s+/)
        .map((n) => Number(n) || 0);
      const user = nums[0] ?? 0;
      const nice = nums[1] ?? 0;
      const system = nums[2] ?? 0;
      const idle = nums[3] ?? 0;
      const iowait = nums[4] ?? 0;
      const irq = nums[5] ?? 0;
      const softirq = nums[6] ?? 0;
      const steal = nums[7] ?? 0;
      raw = {
        total: user + nice + system + idle + iowait + irq + softirq + steal,
        idle: idle + iowait,
      };
    } else if (/^\d+$/.test(line)) {
      cores = Math.max(1, parseInt(line, 10));
    }
  }
  return { raw, cores };
}

function parseMemSection(text: string) {
  const values: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) {
      values[m[1]] = Number(m[2]) * 1024; // kB -> bytes
    }
  }
  const memTotalBytes = values.MemTotal ?? 0;
  const memAvailableBytes =
    values.MemAvailable ??
    (values.MemFree ?? 0) + (values.Buffers ?? 0) + (values.Cached ?? 0);
  const memUsedBytes = Math.max(0, memTotalBytes - memAvailableBytes);
  const memUsagePercent =
    memTotalBytes > 0
      ? Math.min(100, Math.max(0, (memUsedBytes / memTotalBytes) * 100))
      : 0;

  const swapTotalBytes = values.SwapTotal ?? 0;
  const swapFreeBytes = values.SwapFree ?? 0;
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
  const swapUsagePercent =
    swapTotalBytes > 0
      ? Math.min(100, Math.max(0, (swapUsedBytes / swapTotalBytes) * 100))
      : 0;

  return {
    memTotalBytes,
    memUsedBytes,
    memAvailableBytes,
    memUsagePercent,
    swapTotalBytes,
    swapUsedBytes,
    swapUsagePercent,
  };
}

function parseLoadSection(text: string): {
  loadAverage: [number, number, number];
  uptimeSeconds: number;
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let loadAverage: [number, number, number] = [0, 0, 0];
  let uptimeSeconds = 0;

  if (lines[0]) {
    const parts = lines[0].split(/\s+/);
    loadAverage = [
      parseFloat(parts[0]) || 0,
      parseFloat(parts[1]) || 0,
      parseFloat(parts[2]) || 0,
    ];
  }
  if (lines[1]) {
    const parts = lines[1].split(/\s+/);
    uptimeSeconds = Math.floor(parseFloat(parts[0]) || 0);
  }
  return { loadAverage, uptimeSeconds };
}

function parseNetSection(text: string): NetRawMap {
  const result: NetRawMap = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const iface = line.slice(0, colonIdx).trim();
    if (!iface || iface === 'lo') continue;
    const fields = line
      .slice(colonIdx + 1)
      .trim()
      .split(/\s+/);
    if (fields.length < 9) continue;
    const rx = Number(fields[0]) || 0;
    const tx = Number(fields[8]) || 0;
    result[iface] = { rx, tx };
  }
  return result;
}

function parseDiskSection(text: string): DiskPartitionUsage[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const seenMounts = new Set<string>();
  const disks: DiskPartitionUsage[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 6) continue;
    const filesystem = parts[0];
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    const mount = parts.slice(5).join(' ');

    if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
    if (seenMounts.has(mount)) continue;

    const fsLower = filesystem.toLowerCase();
    if (mount !== '/') {
      if (IGNORED_FS.has(fsLower)) continue;
      if (
        mount.startsWith('/snap/') ||
        mount.startsWith('/sys') ||
        mount.startsWith('/proc') ||
        mount.startsWith('/dev') ||
        mount.startsWith('/run')
      ) {
        continue;
      }
      if (fsLower === 'overlay' || fsLower.startsWith('shm')) {
        continue;
      }
    }

    seenMounts.add(mount);
    const totalBytes = totalKb * 1024;
    const usedBytes = Math.max(0, usedKb * 1024);
    const availableBytes = Math.max(0, availKb * 1024);
    const usedPercent =
      totalBytes > 0
        ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100))
        : 0;

    disks.push({
      filesystem,
      mount,
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent,
    });
  }

  disks.sort((a, b) => {
    if (a.mount === '/') return -1;
    if (b.mount === '/') return 1;
    return b.totalBytes - a.totalBytes;
  });

  return disks;
}

function parseSysSection(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hostname = lines[0] || 'linux-host';
  const kernel = lines[1] || '';
  let osPrettyName = 'Linux';
  for (const line of lines.slice(2)) {
    if (line.startsWith('PRETTY_NAME=')) {
      osPrettyName = line.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '');
      break;
    }
  }
  return { hostname, kernel, osPrettyName };
}

export class MonitorService {
  private monitors = new Map<string, SessionMonitor>();
  private sampleCallback: SampleCallback | null = null;
  private errorCallback: ErrorCallback | null = null;

  setCallbacks(onSample: SampleCallback, onError: ErrorCallback): void {
    this.sampleCallback = onSample;
    this.errorCallback = onError;
  }

  start(sessionId: string, intervalMs = 2500): void {
    const safeInterval = Math.min(15000, Math.max(1500, intervalMs));
    const existing = this.monitors.get(sessionId);
    if (existing && !existing.stopped) {
      existing.intervalMs = safeInterval;
      return;
    }

    const isLocal = localPtyService.hasSession(sessionId);
    const client = isLocal ? null : sshService.getClient(sessionId);
    if (!isLocal && !client) {
      throw new Error('当前终端会话未连接，无法启动实时监控');
    }

    const monitor: SessionMonitor = {
      sessionId,
      isLocal,
      intervalMs: safeInterval,
      timer: null,
      stopped: false,
      inFlight: false,
      sampleCount: 0,
      prevCpu: null,
      prevNet: null,
    };
    this.monitors.set(sessionId, monitor);

    if (isLocal) {
      localPtyService.onSessionClosed(sessionId, () => {
        this.stop(sessionId);
      });
    } else if (client) {
      client.once('close', () => {
        this.stop(sessionId);
      });
    }

    void this.pollOnce(monitor);
  }

  stop(sessionId: string): void {
    const monitor = this.monitors.get(sessionId);
    if (!monitor) return;
    monitor.stopped = true;
    if (monitor.timer) {
      clearTimeout(monitor.timer);
      monitor.timer = null;
    }
    this.monitors.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of Array.from(this.monitors.keys())) {
      this.stop(sessionId);
    }
  }

  private scheduleNext(monitor: SessionMonitor, delayMs: number): void {
    if (monitor.stopped) return;
    monitor.timer = setTimeout(() => {
      void this.pollOnce(monitor);
    }, delayMs);
  }

  private async pollLocalOnce(monitor: SessionMonitor): Promise<void> {
    if (!localPtyService.hasSession(monitor.sessionId)) {
      this.stop(monitor.sessionId);
      return;
    }

    monitor.inFlight = true;
    try {
      const now = Date.now();
      const cpus = os.cpus();
      let total = 0;
      let idle = 0;
      for (const c of cpus) {
        const t = c.times;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
        idle += t.idle;
      }

      let cpuUsagePercent = 0;
      if (monitor.prevCpu) {
        const dTotal = total - monitor.prevCpu.total;
        const dIdle = idle - monitor.prevCpu.idle;
        if (dTotal > 0) {
          cpuUsagePercent = Math.min(
            100,
            Math.max(0, ((dTotal - dIdle) / dTotal) * 100)
          );
        }
      }
      monitor.prevCpu = { total, idle };

      const memTotalBytes = os.totalmem();
      const memAvailableBytes = os.freemem();
      const memUsedBytes = Math.max(0, memTotalBytes - memAvailableBytes);
      const memUsagePercent =
        memTotalBytes > 0
          ? Math.min(100, Math.max(0, (memUsedBytes / memTotalBytes) * 100))
          : 0;

      const disks: DiskPartitionUsage[] = [];
      const candidateRoots =
        process.platform === 'win32'
          ? ['C:\\', 'D:\\', 'E:\\']
          : ['/'];
      for (const rootPath of candidateRoots) {
        try {
          const st = await fsp.statfs(rootPath);
          const totalBytes = st.blocks * st.bsize;
          const availBytes = st.bavail * st.bsize;
          if (totalBytes > 0) {
            const usedBytes = Math.max(0, totalBytes - availBytes);
            disks.push({
              filesystem: process.platform === 'win32' ? 'NTFS' : 'LocalFS',
              mount: rootPath,
              totalBytes,
              usedBytes,
              availableBytes: availBytes,
              usedPercent: Math.min(
                100,
                Math.max(0, (usedBytes / totalBytes) * 100)
              ),
            });
          }
        } catch {
          // ignore non-existent drives
        }
      }

      const rawLoad = os.loadavg();
      const loadAverage: [number, number, number] = [
        rawLoad[0] ?? 0,
        rawLoad[1] ?? 0,
        rawLoad[2] ?? 0,
      ];

      const osPrettyName =
        process.platform === 'win32'
          ? `Windows (${os.release()})`
          : process.platform === 'darwin'
            ? `macOS (${os.release()})`
            : `${os.type()} (${os.release()})`;

      monitor.sampleCount += 1;
      const snapshot: HostMetricsSnapshot = {
        sessionId: monitor.sessionId,
        timestamp: now,
        hostname: os.hostname(),
        osPrettyName,
        kernel: `${os.platform()}-${os.arch()}`,
        uptimeSeconds: Math.floor(os.uptime()),
        cpuCores: Math.max(1, cpus.length),
        cpuUsagePercent,
        loadAverage,
        memTotalBytes,
        memUsedBytes,
        memAvailableBytes,
        memUsagePercent,
        swapTotalBytes: 0,
        swapUsedBytes: 0,
        swapUsagePercent: 0,
        disks,
        netRxBytesPerSec: 0,
        netTxBytesPerSec: 0,
        netInterfaces: [],
      };

      this.sampleCallback?.(snapshot);
      const nextDelay = monitor.sampleCount === 1 ? 650 : monitor.intervalMs;
      this.scheduleNext(monitor, nextDelay);
    } finally {
      monitor.inFlight = false;
    }
  }

  private async pollOnce(monitor: SessionMonitor): Promise<void> {
    if (monitor.stopped || monitor.inFlight) return;
    if (monitor.isLocal) {
      await this.pollLocalOnce(monitor);
      return;
    }

    const client = sshService.getClient(monitor.sessionId);
    if (!client) {
      this.stop(monitor.sessionId);
      return;
    }

    monitor.inFlight = true;
    try {
      const rawOutput = await execCommand(client, PROBE_COMMAND);
      if (monitor.stopped) return;

      const now = Date.now();
      const sections = splitSections(rawOutput);
      const { raw: cpuRaw, cores: cpuCores } = parseCpuSection(
        sections.CPU ?? ''
      );
      const mem = parseMemSection(sections.MEM ?? '');
      const { loadAverage, uptimeSeconds } = parseLoadSection(
        sections.LOAD ?? ''
      );
      const netRaw = parseNetSection(sections.NET ?? '');
      const disks = parseDiskSection(sections.DISK ?? '');
      const sys = parseSysSection(sections.SYS ?? '');

      // Calculate CPU delta %
      let cpuUsagePercent = 0;
      if (cpuRaw && monitor.prevCpu) {
        const dTotal = cpuRaw.total - monitor.prevCpu.total;
        const dIdle = cpuRaw.idle - monitor.prevCpu.idle;
        if (dTotal > 0) {
          cpuUsagePercent = Math.min(
            100,
            Math.max(0, ((dTotal - dIdle) / dTotal) * 100)
          );
        }
      }
      monitor.prevCpu = cpuRaw;

      // Calculate network RX/TX bytes per second
      let netRxBytesPerSec = 0;
      let netTxBytesPerSec = 0;
      const netInterfaces: NetInterfaceRate[] = [];

      if (monitor.prevNet) {
        const deltaSec = Math.max(0.1, (now - monitor.prevNet.timestamp) / 1000);
        for (const [iface, cur] of Object.entries(netRaw)) {
          const prev = monitor.prevNet.ifaces[iface];
          if (!prev) continue;
          const rxRate = Math.max(0, (cur.rx - prev.rx) / deltaSec);
          const txRate = Math.max(0, (cur.tx - prev.tx) / deltaSec);
          netRxBytesPerSec += rxRate;
          netTxBytesPerSec += txRate;
          netInterfaces.push({
            name: iface,
            rxBytesPerSec: rxRate,
            txBytesPerSec: txRate,
          });
        }
        netInterfaces.sort(
          (a, b) =>
            b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec)
        );
      } else {
        for (const iface of Object.keys(netRaw)) {
          netInterfaces.push({ name: iface, rxBytesPerSec: 0, txBytesPerSec: 0 });
        }
      }
      monitor.prevNet = { timestamp: now, ifaces: netRaw };

      monitor.sampleCount += 1;

      const snapshot: HostMetricsSnapshot = {
        sessionId: monitor.sessionId,
        timestamp: now,
        hostname: sys.hostname,
        osPrettyName: sys.osPrettyName,
        kernel: sys.kernel,
        uptimeSeconds,
        cpuCores,
        cpuUsagePercent,
        loadAverage,
        ...mem,
        disks,
        netRxBytesPerSec,
        netTxBytesPerSec,
        netInterfaces: netInterfaces.slice(0, 4),
      };

      this.sampleCallback?.(snapshot);

      // Run second sample quickly (650ms) so CPU & network delta appear almost instantly
      const nextDelay = monitor.sampleCount === 1 ? 650 : monitor.intervalMs;
      this.scheduleNext(monitor, nextDelay);
    } catch (err) {
      if (!monitor.stopped) {
        this.errorCallback?.({
          sessionId: monitor.sessionId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
        this.scheduleNext(monitor, Math.max(monitor.intervalMs, 4000));
      }
    } finally {
      monitor.inFlight = false;
    }
  }
}

export const monitorService = new MonitorService();
