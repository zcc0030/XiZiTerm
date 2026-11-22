export interface DiskPartitionUsage {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface NetInterfaceRate {
  name: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface HostMetricsSnapshot {
  sessionId: string;
  timestamp: number;
  hostname: string;
  osPrettyName: string;
  kernel: string;
  uptimeSeconds: number;
  cpuCores: number;
  cpuUsagePercent: number;
  loadAverage: [number, number, number];
  memTotalBytes: number;
  memUsedBytes: number;
  memAvailableBytes: number;
  memUsagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapUsagePercent: number;
  disks: DiskPartitionUsage[];
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  netInterfaces: NetInterfaceRate[];
}

export interface MonitorErrorEvent {
  sessionId: string;
  error: string;
  timestamp: number;
}
