import crypto from 'crypto';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { Client, type SFTPWrapper } from 'ssh2';
import type {
  SyncDeployLogEvent,
  SyncDeployTemplates,
  SyncOneClickDeployPayload,
  SyncOneClickDeployResult,
} from '@xiziterm/shared';

const ROOT_FILES = [
  'package.json',
  'tsconfig.base.json',
  'docker-compose.yml',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'apps/server/package.json',
  'apps/server/tsconfig.json',
  'apps/server/Dockerfile',
  'apps/server/docker-compose.yml',
  'apps/server/.env.example',
];

const SOURCE_DIRS = ['packages/shared/src', 'apps/server/src'];

type LogListener = (event: SyncDeployLogEvent) => void;

function findRepoRoot(): string {
  const candidates = [
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, 'sync-server-bundle')]
      : []),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    process.cwd(),
    path.resolve(process.cwd(), '../..'),
  ];

  for (const dir of candidates) {
    const dockerfile = path.join(dir, 'apps', 'server', 'Dockerfile');
    const sharedIdx = path.join(dir, 'packages', 'shared', 'src', 'index.ts');
    if (fs.existsSync(dockerfile) && fs.existsSync(sharedIdx)) {
      return dir;
    }
  }
  throw new Error('未能定位同步服务端源码目录 (apps/server/Dockerfile)');
}

function collectFilesRecursively(repoRoot: string, relDir: string): string[] {
  const results: string[] = [];
  const absDir = path.join(repoRoot, relDir);
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const childRel = path.posix.join(relDir.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(repoRoot, childRel));
    } else if (entry.isFile()) {
      results.push(childRel);
    }
  }
  return results;
}

function getAllBundleFiles(repoRoot: string): string[] {
  return [
    ...ROOT_FILES,
    ...SOURCE_DIRS.flatMap((d) => collectFilesRecursively(repoRoot, d)),
  ];
}

export class DeployService {
  private logListener: LogListener | null = null;
  private running = false;

  setLogListener(listener: LogListener): void {
    this.logListener = listener;
  }

  private emitLog(
    deployId: string,
    level: SyncDeployLogEvent['level'],
    message: string
  ): void {
    this.logListener?.({
      deployId,
      level,
      message,
      timestamp: Date.now(),
    });
  }

  async getDeployTemplates(): Promise<SyncDeployTemplates> {
    const root = findRepoRoot();
    const [dockerfile, dockerCompose, envExample] = await Promise.all([
      fsp.readFile(path.join(root, 'apps/server/Dockerfile'), 'utf8'),
      fsp.readFile(path.join(root, 'docker-compose.yml'), 'utf8'),
      fsp.readFile(path.join(root, 'apps/server/.env.example'), 'utf8'),
    ]);
    return { dockerfile, dockerCompose, envExample };
  }

  async exportDeployBundle(
    destParentDir: string
  ): Promise<{ targetDir: string; fileCount: number }> {
    const root = findRepoRoot();
    const targetDir = path.join(destParentDir, 'xiziterm-sync-deploy');
    const files = getAllBundleFiles(root);

    await fsp.mkdir(path.join(targetDir, 'apps/server/data'), {
      recursive: true,
    });

    for (const rel of files) {
      const src = path.join(root, rel);
      const dst = path.join(targetDir, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
    }

    // Create default .env ready to edit
    await fsp.copyFile(
      path.join(root, 'apps/server/.env.example'),
      path.join(targetDir, '.env')
    );

    return { targetDir, fileCount: files.length + 1 };
  }

  async oneClickDeploy(
    payload: SyncOneClickDeployPayload
  ): Promise<SyncOneClickDeployResult> {
    if (this.running) {
      throw new Error('当前已有部署任务正在运行，请等待完成');
    }

    const host = payload.host.trim();
    const username = payload.username.trim();
    const password = payload.password ?? '';
    const sshPort = Number(payload.sshPort) || 22;
    const syncPort = Number(payload.syncPort) || 8787;
    const rawRemoteDir = payload.remoteDir.trim() || '~/xiziterm-sync';

    if (!host) throw new Error('请输入 VPS IP 或域名');
    if (!username) throw new Error('请输入 VPS SSH 用户名');
    if (!password) throw new Error('请输入 VPS SSH 密码');
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw new Error('SSH 端口必须在 1-65535 之间');
    }
    if (!Number.isInteger(syncPort) || syncPort < 1024 || syncPort > 65535) {
      throw new Error('云同步服务端口建议在 1024-65535 之间（避免系统保留端口）');
    }

    const repoRoot = findRepoRoot();
    const allFiles = getAllBundleFiles(repoRoot);
    const deployId = `deploy_${crypto.randomUUID()}`;
    this.running = true;

    const client = new Client();

    const connectSsh = () =>
      new Promise<void>((resolve, reject) => {
        client
          .on('ready', () => resolve())
          .on('error', (err) => reject(err))
          .on(
            'keyboard-interactive',
            (_name, _inst, _lang, prompts, finishAuth) => {
              finishAuth(prompts.map(() => password));
            }
          )
          .connect({
            host,
            port: sshPort,
            username,
            password,
            tryKeyboard: true,
            readyTimeout: 20_000,
          });
      });

    const execRemote = (
      cmd: string,
      options: { useSudo?: boolean; streamOutput?: boolean } = {}
    ) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const isRoot = username === 'root';
          const actualCmd =
            options.useSudo && !isRoot
              ? `sudo -S -p '' bash -lc ${JSON.stringify(cmd)}`
              : `bash -lc ${JSON.stringify(cmd)}`;

          client.exec(actualCmd, (err, stream) => {
            if (err) return reject(err);
            let stdout = '';
            let stderr = '';
            let lineBuf = '';

            const flushLines = (chunkStr: string) => {
              lineBuf += chunkStr;
              const parts = lineBuf.split(/\r?\n/);
              lineBuf = parts.pop() ?? '';
              for (const line of parts) {
                const cleaned = line.trim();
                if (cleaned && options.streamOutput) {
                  this.emitLog(deployId, 'info', cleaned);
                }
              }
            };

            stream.on('data', (chunk: Buffer) => {
              const s = chunk.toString('utf8');
              stdout += s;
              flushLines(s);
            });
            stream.stderr.on('data', (chunk: Buffer) => {
              const s = chunk.toString('utf8');
              stderr += s;
              flushLines(s);
            });
            stream.on('close', (code?: number | null) => {
              if (lineBuf.trim() && options.streamOutput) {
                this.emitLog(deployId, 'info', lineBuf.trim());
              }
              resolve({ code: code ?? 0, stdout, stderr });
            });

            if (options.useSudo && !isRoot) {
              stream.write(`${password}\n`);
              stream.end();
            }
          });
        }
      );

    const openSftp = () =>
      new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
      });

    const putFile = (sftp: SFTPWrapper, localPath: string, remotePath: string) =>
      new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) =>
          err ? reject(err) : resolve()
        );
      });

    try {
      this.emitLog(
        deployId,
        'step',
        `[1/6] 正在通过 SSH 连接 ${username}@${host}:${sshPort} ...`
      );
      await connectSsh();
      this.emitLog(deployId, 'success', 'SSH 连接认证成功');

      // Resolve home dir & target remoteDir
      const envRes = await execRemote(
        'echo "HOME=$HOME"; grep -m1 "^PRETTY_NAME=" /etc/os-release 2>/dev/null || uname -a'
      );
      const homeMatch = envRes.stdout.match(/^HOME=(.+)$/m);
      const remoteHome = homeMatch ? homeMatch[1].trim() : `/home/${username}`;
      const remoteDir = rawRemoteDir.startsWith('~/')
        ? path.posix.join(remoteHome, rawRemoteDir.slice(2))
        : rawRemoteDir === '~'
          ? path.posix.join(remoteHome, 'xiziterm-sync')
          : rawRemoteDir;

      const osLine =
        envRes.stdout
          .split(/\r?\n/)
          .find((l) => l.startsWith('PRETTY_NAME='))
          ?.replace(/^PRETTY_NAME=/, '')
          .replace(/^"|"$/g, '') || 'Linux';
      this.emitLog(
        deployId,
        'info',
        `目标系统: ${osLine} · 部署路径: ${remoteDir}`
      );

      // Step 2: Check port conflict safely (never disturb existing services!)
      this.emitLog(
        deployId,
        'step',
        `[2/6] 检测端口 ${syncPort} 是否被其他服务占用...`
      );
      const portCheck = await execRemote(
        `ss -tln 2>/dev/null | grep -E ':${syncPort}[[:space:]]' || true`
      );
      const existingContainer = await execRemote(
        `docker ps --filter "name=sync-server" --format "{{.Names}} {{.Ports}}" 2>/dev/null || true`,
        { useSudo: true }
      );
      const isOwnContainerOnPort =
        (existingContainer.stdout.includes('xiziterm-sync-server') ||
          existingContainer.stdout.includes('nexusterm-sync-server')) &&
        existingContainer.stdout.includes(`:${syncPort}->`);

      if (portCheck.stdout.trim() && !isOwnContainerOnPort) {
        throw new Error(
          `端口 ${syncPort} 已被 VPS 上其他服务占用，已中止部署以避免干扰原服务，请更换其他同步端口后重试！`
        );
      }
      this.emitLog(deployId, 'success', `端口 ${syncPort} 检查通过，不会冲突`);

      // Step 3: Check or install Docker + Docker Compose v2
      this.emitLog(
        deployId,
        'step',
        '[3/6] 检测 Docker 与 Docker Compose 环境...'
      );
      const dockerCheck = await execRemote(
        'docker --version && docker compose version'
      );
      if (dockerCheck.code !== 0) {
        this.emitLog(
          deployId,
          'warn',
          '未检测到完整 Docker / Compose v2 环境，正在尝试通过 apt 自动安装（Ubuntu / Debian）...'
        );
        const installRes = await execRemote(
          `if ! command -v apt-get >/dev/null 2>&1; then echo "UNSUPPORTED_DISTRO"; exit 2; fi; DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 && systemctl enable --now docker && (usermod -aG docker ${username} || true)`,
          { useSudo: true, streamOutput: true }
        );
        if (installRes.code !== 0) {
          if (installRes.stdout.includes('UNSUPPORTED_DISTRO')) {
            throw new Error(
              '目标服务器不是 Ubuntu/Debian（无 apt-get），请先手动安装 Docker 与 Docker Compose v2 后再重试'
            );
          }
          throw new Error(
            `安装 Docker 失败（退出码 ${installRes.code}），请确认该用户具有 sudo 权限且网络正常`
          );
        }
        this.emitLog(
          deployId,
          'success',
          'Docker 与 Docker Compose v2 安装完成'
        );
      } else {
        this.emitLog(
          deployId,
          'success',
          `已就绪: ${dockerCheck.stdout.replace(/\r?\n/g, ' | ').trim()}`
        );
      }

      // Step 4: Upload server source & Docker files via SFTP
      this.emitLog(
        deployId,
        'step',
        `[4/6] 上传云同步服务端源码与 Docker 配置 (${allFiles.length} 个文件)...`
      );
      const dirSet = new Set<string>([
        remoteDir,
        path.posix.join(remoteDir, 'apps/server/data'),
      ]);
      for (const rel of allFiles) {
        dirSet.add(path.posix.dirname(path.posix.join(remoteDir, rel)));
      }
      const mkdirRes = await execRemote(
        `mkdir -p ${Array.from(dirSet)
          .map((d) => JSON.stringify(d))
          .join(' ')}`
      );
      if (mkdirRes.code !== 0) {
        throw new Error(`创建远程目录失败: ${mkdirRes.stderr}`);
      }

      const sftp = await openSftp();
      try {
        for (const rel of allFiles) {
          await putFile(
            sftp,
            path.join(repoRoot, rel),
            path.posix.join(remoteDir, rel)
          );
        }

        // Write .env file with chosen port & optional invite code
        const envLines = [
          `XIZITERM_PORT=${syncPort}`,
          'ALLOW_REGISTRATION=true',
          `INVITE_CODE=${(payload.inviteCode ?? '').trim()}`,
          'TOKEN_TTL_DAYS=365',
          'LOG_LEVEL=info',
          '',
        ].join('\n');

        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(
            path.posix.join(remoteDir, '.env'),
            Buffer.from(envLines, 'utf8'),
            (err) => (err ? reject(err) : resolve())
          );
        });
      } finally {
        sftp.end();
      }
      this.emitLog(deployId, 'success', '服务端文件上传与 .env 配置写入完成');

      // Step 5: Build & Start Docker container
      this.emitLog(
        deployId,
        'step',
        `[5/6] 执行 docker compose up -d --build（端口 ${syncPort}，首次构建约需 15~45 秒）...`
      );
      const upRes = await execRemote(
        `cd ${JSON.stringify(remoteDir)} && docker compose up -d --build`,
        { useSudo: true, streamOutput: true }
      );
      if (upRes.code !== 0) {
        throw new Error(`Docker 构建或启动失败（退出码 ${upRes.code}）`);
      }
      this.emitLog(deployId, 'success', '容器 xiziterm-sync-server 已启动');

      // Step 6: Verify health inside VPS & from local client
      this.emitLog(
        deployId,
        'step',
        `[6/6] 验证服务端健康状态与本机到 http://${host}:${syncPort} 的连通性...`
      );
      await new Promise((r) => setTimeout(r, 2500));

      const localHealth = await execRemote(
        `curl -fsS http://127.0.0.1:${syncPort}/api/health`
      );
      const remoteHealthOk =
        localHealth.code === 0 && localHealth.stdout.includes('"ok"');

      if (!remoteHealthOk) {
        throw new Error(
          `容器已启动但健康检查未通过: ${localHealth.stderr || localHealth.stdout}`
        );
      }
      this.emitLog(
        deployId,
        'success',
        `VPS 内部健康检查通过: ${localHealth.stdout.trim()}`
      );

      const serverUrl = `http://${host}:${syncPort}`;
      let clientReachable = false;
      let version: string | undefined;
      let warning: string | undefined;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(`${serverUrl}/api/health`, {
            signal: controller.signal,
          });
          if (res.ok) {
            const json = (await res.json()) as {
              status?: string;
              version?: string;
            };
            if (json.status === 'ok') {
              clientReachable = true;
              version = json.version;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        clientReachable = false;
      }

      if (clientReachable) {
        this.emitLog(
          deployId,
          'success',
          `本机直连测试通过！云同步地址: ${serverUrl}`
        );
      } else {
        warning = `服务端已在 VPS 内部运行正常，但当前电脑无法直连 ${serverUrl}。请在云厂商安全组或 VPS 防火墙放行 TCP ${syncPort} 端口。`;
        this.emitLog(deployId, 'warn', warning);
      }

      return {
        serverUrl,
        remoteHealthOk,
        clientReachable,
        version,
        warning,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitLog(deployId, 'error', msg);
      throw err;
    } finally {
      this.running = false;
      try {
        client.end();
      } catch {
        // ignore
      }
    }
  }
}

export const deployService = new DeployService();
