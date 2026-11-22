import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import type { SFTPWrapper, Stats } from 'ssh2';
import type {
  SftpEntry,
  SftpListResult,
  SftpReadTextResult,
  SftpTransferProgressEvent,
} from '@xiziterm/shared';
import { sshService } from './ssh.service';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB

type ProgressCallback = (event: SftpTransferProgressEvent) => void;

function formatPermissions(mode: number): string {
  const bits = mode & 0o777;
  const chars = ['r', 'w', 'x'];
  let out = '';
  for (let i = 8; i >= 0; i--) {
    out += (bits & (1 << i)) !== 0 ? chars[(8 - i) % 3] : '-';
  }
  return out;
}

function formatOctalMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function parseOctalMode(input: string): number {
  const cleaned = input.trim();
  if (!/^[0-7]{3,4}$/.test(cleaned)) {
    throw new Error('权限格式无效，请输入 3~4 位八进制数（例如 755 或 0644）');
  }
  return parseInt(cleaned, 8);
}

export class SftpService {
  private wrappers = new Map<string, SFTPWrapper>();
  private pending = new Map<string, Promise<SFTPWrapper>>();
  private progressCallback: ProgressCallback | null = null;

  setProgressCallback(cb: ProgressCallback): void {
    this.progressCallback = cb;
  }

  private emitProgress(event: SftpTransferProgressEvent): void {
    this.progressCallback?.(event);
  }

  private async getSftp(sessionId: string): Promise<SFTPWrapper> {
    const client = sshService.getClient(sessionId);
    if (!client) {
      this.wrappers.delete(sessionId);
      throw new Error('当前 SSH 会话未连接，无法打开 SFTP 通道');
    }

    const existing = this.wrappers.get(sessionId);
    if (existing) {
      return existing;
    }

    const inflight = this.pending.get(sessionId);
    if (inflight) {
      return inflight;
    }

    const promise = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        this.pending.delete(sessionId);
        if (err) {
          reject(new Error(`启动 SFTP 子系统失败: ${err.message}`));
          return;
        }
        this.wrappers.set(sessionId, sftp);
        const cleanup = () => {
          if (this.wrappers.get(sessionId) === sftp) {
            this.wrappers.delete(sessionId);
          }
        };
        sftp.once('close', cleanup);
        sftp.once('end', cleanup);
        client.once('close', cleanup);
        resolve(sftp);
      });
    });

    this.pending.set(sessionId, promise);
    return promise;
  }

  private realpath(sftp: SFTPWrapper, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      sftp.realpath(target, (err, absPath) => {
        if (err) reject(err);
        else resolve(absPath);
      });
    });
  }

  private stat(sftp: SFTPWrapper, target: string): Promise<Stats> {
    return new Promise((resolve, reject) => {
      sftp.stat(target, (err, stats) => {
        if (err) reject(err);
        else resolve(stats);
      });
    });
  }

  private readdirRaw(sftp: SFTPWrapper, dirPath: string) {
    return new Promise<
      Array<{ filename: string; attrs: { mode: number; uid: number; gid: number; size: number; mtime: number } }>
    >((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) reject(err);
        else resolve(list);
      });
    });
  }

  async list(sessionId: string, remotePath?: string): Promise<SftpListResult> {
    const sftp = await this.getSftp(sessionId);
    const requested = remotePath?.trim();
    const target = !requested || requested === '~' ? '.' : requested;
    const cwd = await this.realpath(sftp, target);
    const rawList = await this.readdirRaw(sftp, cwd);

    const entries: SftpEntry[] = await Promise.all(
      rawList
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map(async (item) => {
          const fullPath = path.posix.join(cwd, item.filename);
          const fileType = item.attrs.mode & S_IFMT;
          const isSymlink = fileType === S_IFLNK;
          let isDirectory = fileType === S_IFDIR;
          let size = item.attrs.size ?? 0;

          if (isSymlink) {
            try {
              const targetStats = await this.stat(sftp, fullPath);
              isDirectory = targetStats.isDirectory();
              if (!isDirectory) {
                size = targetStats.size ?? size;
              }
            } catch {
              // Broken symlink: treat as non-directory
            }
          }

          return {
            name: item.filename,
            path: fullPath,
            isDirectory,
            isSymlink,
            size,
            mode: item.attrs.mode,
            permissions: formatPermissions(item.attrs.mode),
            octalMode: formatOctalMode(item.attrs.mode),
            uid: item.attrs.uid ?? 0,
            gid: item.attrs.gid ?? 0,
            modifiedAt: (item.attrs.mtime ?? 0) * 1000,
          };
        })
    );

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { cwd, entries };
  }

  async mkdir(sessionId: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async ensureRemoteDir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    try {
      const st = await this.stat(sftp, remotePath);
      if (st.isDirectory()) return;
    } catch {
      // Directory does not exist yet
    }
    const parent = path.posix.dirname(remotePath);
    if (parent && parent !== remotePath && parent !== '/') {
      await this.ensureRemoteDir(sftp, parent);
    }
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (!err) {
          resolve();
          return;
        }
        // Ignore if created concurrently
        this.stat(sftp, remotePath)
          .then((st) => (st.isDirectory() ? resolve() : reject(err)))
          .catch(() => reject(err));
      });
    });
  }

  async createFile(sessionId: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, Buffer.alloc(0), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async rename(
    sessionId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async deleteEntry(
    sessionId: string,
    remotePath: string,
    isDirectory: boolean
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    if (remotePath === '/' || remotePath.trim() === '') {
      throw new Error('拒绝删除根目录');
    }
    if (!isDirectory) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return;
    }
    await this.deleteDirRecursive(sftp, remotePath);
  }

  private async deleteDirRecursive(
    sftp: SFTPWrapper,
    dirPath: string
  ): Promise<void> {
    const list = await this.readdirRaw(sftp, dirPath);
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue;
      const childPath = path.posix.join(dirPath, item.filename);
      const isDir = (item.attrs.mode & S_IFMT) === S_IFDIR;
      if (isDir) {
        await this.deleteDirRecursive(sftp, childPath);
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(childPath, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async chmod(
    sessionId: string,
    remotePath: string,
    octalMode: string
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    const numericMode = parseOctalMode(octalMode);
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(remotePath, numericMode, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async uploadLocalPaths(
    sessionId: string,
    localPaths: string[],
    remoteDir: string
  ): Promise<{ uploadedCount: number }> {
    const sftp = await this.getSftp(sessionId);
    let uploadedCount = 0;

    for (const localPath of localPaths) {
      if (!localPath) continue;
      const stat = await fs.stat(localPath);
      const baseName = path.basename(localPath);
      const targetRemote = path.posix.join(remoteDir, baseName);

      if (stat.isDirectory()) {
        uploadedCount += await this.uploadDirectoryRecursive(
          sessionId,
          sftp,
          localPath,
          targetRemote
        );
      } else {
        await this.uploadSingleFile(
          sessionId,
          sftp,
          localPath,
          targetRemote,
          stat.size
        );
        uploadedCount += 1;
      }
    }

    return { uploadedCount };
  }

  private async uploadDirectoryRecursive(
    sessionId: string,
    sftp: SFTPWrapper,
    localDir: string,
    remoteDir: string
  ): Promise<number> {
    await this.ensureRemoteDir(sftp, remoteDir);
    const entries = await fs.readdir(localDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      const localChild = path.join(localDir, entry.name);
      const remoteChild = path.posix.join(remoteDir, entry.name);
      if (entry.isDirectory()) {
        count += await this.uploadDirectoryRecursive(
          sessionId,
          sftp,
          localChild,
          remoteChild
        );
      } else if (entry.isFile()) {
        const st = await fs.stat(localChild);
        await this.uploadSingleFile(
          sessionId,
          sftp,
          localChild,
          remoteChild,
          st.size
        );
        count += 1;
      }
    }
    return count;
  }

  private uploadSingleFile(
    sessionId: string,
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
    totalSize: number
  ): Promise<void> {
    const transferId = `up_${crypto.randomUUID()}`;
    const fileName = path.basename(localPath);
    let lastEmit = 0;

    this.emitProgress({
      transferId,
      sessionId,
      direction: 'upload',
      fileName,
      remotePath,
      localPath,
      transferred: 0,
      total: totalSize,
      status: 'running',
    });

    return new Promise((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferred, _chunk, total) => {
            const now = Date.now();
            if (now - lastEmit >= 80 || transferred >= total) {
              lastEmit = now;
              this.emitProgress({
                transferId,
                sessionId,
                direction: 'upload',
                fileName,
                remotePath,
                localPath,
                transferred,
                total,
                status: 'running',
              });
            }
          },
        },
        (err) => {
          if (err) {
            this.emitProgress({
              transferId,
              sessionId,
              direction: 'upload',
              fileName,
              remotePath,
              localPath,
              transferred: 0,
              total: totalSize,
              status: 'error',
              error: err.message,
            });
            reject(err);
            return;
          }
          this.emitProgress({
            transferId,
            sessionId,
            direction: 'upload',
            fileName,
            remotePath,
            localPath,
            transferred: totalSize,
            total: totalSize,
            status: 'completed',
          });
          resolve();
        }
      );
    });
  }

  async downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    const stats = await this.stat(sftp, remotePath);
    const totalSize = stats.size ?? 0;
    const transferId = `dl_${crypto.randomUUID()}`;
    const fileName = path.posix.basename(remotePath);
    let lastEmit = 0;

    this.emitProgress({
      transferId,
      sessionId,
      direction: 'download',
      fileName,
      remotePath,
      localPath,
      transferred: 0,
      total: totalSize,
      status: 'running',
    });

    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (transferred, _chunk, total) => {
            const now = Date.now();
            if (now - lastEmit >= 80 || transferred >= total) {
              lastEmit = now;
              this.emitProgress({
                transferId,
                sessionId,
                direction: 'download',
                fileName,
                remotePath,
                localPath,
                transferred,
                total,
                status: 'running',
              });
            }
          },
        },
        (err) => {
          if (err) {
            this.emitProgress({
              transferId,
              sessionId,
              direction: 'download',
              fileName,
              remotePath,
              localPath,
              transferred: 0,
              total: totalSize,
              status: 'error',
              error: err.message,
            });
            reject(err);
            return;
          }
          this.emitProgress({
            transferId,
            sessionId,
            direction: 'download',
            fileName,
            remotePath,
            localPath,
            transferred: totalSize,
            total: totalSize,
            status: 'completed',
          });
          resolve();
        }
      );
    });
  }

  async readTextFile(
    sessionId: string,
    remotePath: string
  ): Promise<SftpReadTextResult> {
    const sftp = await this.getSftp(sessionId);
    const stats = await this.stat(sftp, remotePath);
    if (stats.isDirectory()) {
      throw new Error('不能以文本模式打开目录');
    }
    if (stats.size > MAX_INLINE_TEXT_BYTES) {
      throw new Error(
        `文件过大（${(stats.size / 1024 / 1024).toFixed(2)} MB），在线编辑器仅支持 2 MB 以内的文本文件`
      );
    }

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    // Basic binary guard: check first 8KB for NUL bytes
    const sampleLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < sampleLen; i++) {
      if (buffer[i] === 0) {
        throw new Error('检测到二进制文件内容，请使用下载功能在本地查看');
      }
    }

    return {
      path: remotePath,
      content: buffer.toString('utf8'),
      size: buffer.length,
    };
  }

  async writeTextFile(
    sessionId: string,
    remotePath: string,
    content: string
  ): Promise<void> {
    const sftp = await this.getSftp(sessionId);
    const buf = Buffer.from(content, 'utf8');
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, buf, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export const sftpService = new SftpService();
