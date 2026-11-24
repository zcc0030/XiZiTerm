import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type {
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshStateEvent,
  SshTestConnectionRequest,
  SshTestConnectionResult,
} from '@xiziterm/shared';
import { vaultService } from './vault.service';

interface ActiveSshSession {
  sessionId: string;
  hostId: string;
  client: Client;
  shell: ClientChannel | null;
  intentionalClose: boolean;
}

type DataCallback = (event: SshDataEvent) => void;
type StateCallback = (event: SshStateEvent) => void;

export class SshService {
  private sessions = new Map<string, ActiveSshSession>();
  private dataCallback: DataCallback | null = null;
  private stateCallback: StateCallback | null = null;

  setCallbacks(onData: DataCallback, onState: StateCallback): void {
    this.dataCallback = onData;
    this.stateCallback = onState;
  }

  private emitData(sessionId: string, data: string): void {
    this.dataCallback?.({ sessionId, data });
  }

  private emitState(event: SshStateEvent): void {
    this.stateCallback?.(event);
  }

  /**
   * Expose underlying ssh2.Client for Phase 2 (SFTP) & Phase 3 (Monitor) channel multiplexing.
   */
  getClient(sessionId: string): Client | null {
    return this.sessions.get(sessionId)?.client ?? null;
  }

  async connect(req: SshConnectRequest): Promise<SshConnectResult> {
    const host = vaultService.getHostById(req.hostId);
    if (!host) {
      return { ok: false, error: '找不到主机配置，或保险库已锁定' };
    }

    // Clean up any stale session with the same sessionId before reconnecting
    if (this.sessions.has(req.sessionId)) {
      await this.disconnect(req.sessionId);
    }

    const client = new Client();
    const session: ActiveSshSession = {
      sessionId: req.sessionId,
      hostId: req.hostId,
      client,
      shell: null,
      intentionalClose: false,
    };
    this.sessions.set(req.sessionId, session);

    this.emitState({
      sessionId: req.sessionId,
      state: 'connecting',
      message: `正在连接 ${host.username}@${host.hostname}:${host.port} ...`,
    });

    const connectConfig: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      readyTimeout: 20_000,
      keepaliveInterval:
        host.keepAliveInterval > 0 ? host.keepAliveInterval * 1000 : 0,
      keepaliveCountMax: 3,
      tryKeyboard: host.authType === 'password',
    };

    if (host.authType === 'password') {
      connectConfig.password = host.password ?? '';
    } else {
      if (!host.privateKey?.trim()) {
        this.sessions.delete(req.sessionId);
        return { ok: false, error: '该主机未配置 SSH 私钥内容' };
      }
      connectConfig.privateKey = host.privateKey;
      if (host.passphrase) {
        connectConfig.passphrase = host.passphrase;
      }
    }

    return new Promise<SshConnectResult>((resolve) => {
      let settled = false;
      const finish = (result: SshConnectResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      client.on(
        'keyboard-interactive',
        (_name, _instructions, _lang, prompts, finishAuth) => {
          if (host.authType === 'password' && prompts.length > 0) {
            finishAuth(prompts.map(() => host.password ?? ''));
          } else {
            finishAuth([]);
          }
        }
      );

      client.on('ready', () => {
        client.shell(
          {
            term: 'xterm-256color',
            cols: Math.max(20, req.cols || 80),
            rows: Math.max(5, req.rows || 24),
          },
          (err, stream) => {
            if (err) {
              this.emitState({
                sessionId: req.sessionId,
                state: 'error',
                message: `打开 Shell 通道失败: ${err.message}`,
              });
              client.end();
              this.sessions.delete(req.sessionId);
              finish({ ok: false, error: err.message });
              return;
            }

            session.shell = stream;
            this.emitState({
              sessionId: req.sessionId,
              state: 'connected',
              message: `已连接到 ${host.username}@${host.hostname}:${host.port}`,
            });

            stream.on('data', (chunk: Buffer) => {
              this.emitData(req.sessionId, chunk.toString('utf8'));
            });

            stream.stderr.on('data', (chunk: Buffer) => {
              this.emitData(req.sessionId, chunk.toString('utf8'));
            });

            stream.on('close', (code?: number | null) => {
              const current = this.sessions.get(req.sessionId);
              if (current?.client === client) {
                this.sessions.delete(req.sessionId);
                client.end();
                this.emitState({
                  sessionId: req.sessionId,
                  state: 'disconnected',
                  message: session.intentionalClose
                    ? '会话已关闭'
                    : 'SSH 会话已断开',
                  code: code ?? null,
                });
              }
            });

            finish({ ok: true });
          }
        );
      });

      client.on('error', (err) => {
        const current = this.sessions.get(req.sessionId);
        if (current?.client === client) {
          this.sessions.delete(req.sessionId);
        }
        const message = formatSshError(err);
        this.emitState({
          sessionId: req.sessionId,
          state: 'error',
          message,
        });
        finish({ ok: false, error: message });
      });

      client.on('close', () => {
        const current = this.sessions.get(req.sessionId);
        if (current?.client === client) {
          this.sessions.delete(req.sessionId);
          this.emitState({
            sessionId: req.sessionId,
            state: 'disconnected',
            message: session.intentionalClose
              ? '连接已断开'
              : '与服务器的连接已中断',
          });
        }
      });

      try {
        client.connect(connectConfig);
      } catch (err) {
        const message =
          err instanceof Error ? formatSshError(err) : 'SSH 连接初始化失败';
        this.sessions.delete(req.sessionId);
        this.emitState({
          sessionId: req.sessionId,
          state: 'error',
          message,
        });
        finish({ ok: false, error: message });
      }
    });
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.shell && session.shell.writable) {
      session.shell.write(data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.shell) {
      try {
        session.shell.setWindow(
          Math.max(5, Math.floor(rows)),
          Math.max(20, Math.floor(cols)),
          0,
          0
        );
      } catch {
        // Ignore resize error when channel is closing
      }
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.intentionalClose = true;
    this.sessions.delete(sessionId);
    try {
      session.shell?.end();
    } catch {
      // ignore
    }
    try {
      session.client.end();
    } catch {
      // ignore
    }
  }

  disconnectAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      void this.disconnect(sessionId);
    }
  }

  async testConnection(
    req: SshTestConnectionRequest
  ): Promise<SshTestConnectionResult> {
    const hostname = req.hostname?.trim();
    const username = req.username?.trim();
    const port = Number(req.port);

    if (!hostname) {
      return { ok: false, error: '请先输入主机地址 (IP 或域名)' };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: '端口必须是 1-65535 之间的整数' };
    }
    if (!username) {
      return { ok: false, error: '请先输入 SSH 用户名' };
    }
    if (req.authType === 'privateKey' && !req.privateKey?.trim()) {
      return { ok: false, error: '请粘贴或导入 SSH 私钥内容后再测试' };
    }

    const connectConfig: ConnectConfig = {
      host: hostname,
      port,
      username,
      readyTimeout: 10_000,
      tryKeyboard: req.authType === 'password',
    };

    if (req.authType === 'password') {
      connectConfig.password = req.password ?? '';
    } else {
      connectConfig.privateKey = req.privateKey!;
      if (req.passphrase) {
        connectConfig.passphrase = req.passphrase;
      }
    }

    const startedAt = Date.now();
    const client = new Client();

    return new Promise<SshTestConnectionResult>((resolve) => {
      let settled = false;
      const finish = (res: SshTestConnectionResult) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          // ignore
        }
        resolve(res);
      };

      const overallTimer = setTimeout(() => {
        finish({
          ok: false,
          error: '连接超时：10 秒内未能完成握手，请检查地址、端口与防火墙',
        });
      }, 11_500);

      client.on(
        'keyboard-interactive',
        (_name, _instructions, _lang, prompts, finishAuth) => {
          if (req.authType === 'password' && prompts.length > 0) {
            finishAuth(prompts.map(() => req.password ?? ''));
          } else {
            finishAuth([]);
          }
        }
      );

      client.on('ready', () => {
        const latencyMs = Date.now() - startedAt;
        // Best-effort lightweight remote OS probe (2s cap; still succeeds on shell-restricted hosts)
        const execTimer = setTimeout(() => {
          clearTimeout(overallTimer);
          finish({ ok: true, latencyMs });
        }, 2000);

        client.exec('uname -srm 2>/dev/null', (err, stream) => {
          if (err) {
            clearTimeout(execTimer);
            clearTimeout(overallTimer);
            finish({ ok: true, latencyMs });
            return;
          }
          let out = '';
          stream.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8');
          });
          stream.stderr.on('data', () => {
            // ignore stderr
          });
          stream.on('close', () => {
            clearTimeout(execTimer);
            clearTimeout(overallTimer);
            const remoteInfo = out.trim().split(/\r?\n/)[0]?.slice(0, 80);
            finish({
              ok: true,
              latencyMs,
              remoteInfo: remoteInfo || undefined,
            });
          });
        });
      });

      client.on('error', (err) => {
        clearTimeout(overallTimer);
        finish({ ok: false, error: formatSshError(err) });
      });

      try {
        client.connect(connectConfig);
      } catch (err) {
        clearTimeout(overallTimer);
        finish({
          ok: false,
          error: err instanceof Error ? formatSshError(err) : 'SSH 连接初始化失败',
        });
      }
    });
  }
}

function formatSshError(err: Error & { level?: string; code?: string }): string {
  if (err.level === 'client-authentication') {
    return '身份认证失败：请检查用户名、密码或 SSH 私钥/Passphrase';
  }
  if (
    err.message?.includes('Cannot parse privateKey') ||
    err.message?.includes('Encrypted private OpenSSH key') ||
    err.message?.includes('bad decrypt')
  ) {
    return 'SSH 私钥解析失败：请检查私钥格式，或确认私钥口令 (Passphrase) 是否正确';
  }
  if (err.code === 'ECONNREFUSED') {
    return '连接被拒绝：请检查目标 IP、端口以及 SSH 服务是否开启';
  }
  if (err.code === 'ETIMEDOUT' || err.message.includes('Timed out')) {
    return '连接超时：无法到达目标服务器，请检查网络或防火墙';
  }
  if (err.code === 'ENOTFOUND') {
    return '无法解析主机名：请检查域名或 IP 地址是否正确';
  }
  return err.message || 'SSH 连接出错';
}

export const sshService = new SshService();
