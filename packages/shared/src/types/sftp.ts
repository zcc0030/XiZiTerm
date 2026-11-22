export interface SftpEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
  permissions: string; // e.g. "rwxr-xr-x"
  octalMode: string; // e.g. "755"
  uid: number;
  gid: number;
  modifiedAt: number; // UTC ms
}

export interface SftpListResult {
  cwd: string;
  entries: SftpEntry[];
}

export interface SftpReadTextResult {
  path: string;
  content: string;
  size: number;
}

export type SftpTransferDirection = 'upload' | 'download';
export type SftpTransferStatus = 'running' | 'completed' | 'error';

export interface SftpTransferProgressEvent {
  transferId: string;
  sessionId: string;
  direction: SftpTransferDirection;
  fileName: string;
  remotePath: string;
  localPath: string;
  transferred: number;
  total: number;
  status: SftpTransferStatus;
  error?: string;
}
