import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import type * as PtyNamespace from '@lydell/node-pty';
import type {
  LocalShellProfile,
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshStateEvent,
} from '@xiziterm/shared';

const nodeRequire = createRequire(__filename);

function loadNodePty(): typeof PtyNamespace {
  try {
    const resolved = nodeRequire.resolve('@lydell/node-pty');
    const unpacked = resolved.replace(
      /([\\/])app\.asar([\\/])/,
      '$1app.asar.unpacked$2'
    );
    return nodeRequire(unpacked) as typeof PtyNamespace;
  } catch {
    return nodeRequire('@lydell/node-pty') as typeof PtyNamespace;
  }
}

const pty = loadNodePty();

interface ActiveLocalSession {
  sessionId: string;
  shell: LocalShellProfile;
  ptyProcess: PtyNamespace.IPty;
  intentionalClose: boolean;
}

type DataCallback = (event: SshDataEvent) => void;
type StateCallback = (event: SshStateEvent) => void;

function findExecutableInPath(binName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);

  if (process.platform === 'win32') {
    const exts = binName.includes('.')
      ? ['']
      : (process.env.PATHEXT || '.EXE;.CMD;.BAT')
          .split(';')
          .filter(Boolean);

    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, `${binName}${ext}`);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return full;
          }
        } catch {
          // ignore inaccessible PATH entries
        }
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const full = path.join(dir, binName);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) {
        return full;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function firstExistingFile(candidates: Array<string | null | undefined>): string | null {
  for (const item of candidates) {
    if (!item) continue;
    try {
      if (fs.existsSync(item) && fs.statSync(item).isFile()) {
        return item;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function discoverWindowsShells(): LocalShellProfile[] {
  const profiles: LocalShellProfile[] = [];
  const home = os.homedir();
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  // 1. PowerShell 7+ (pwsh)
  const pwsh = firstExistingFile([
    findExecutableInPath('pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(home, 'scoop', 'apps', 'pwsh', 'current', 'pwsh.exe'),
  ]);
  if (pwsh) {
    profiles.push({
      id: 'pwsh',
      label: 'PowerShell 7 (pwsh)',
      command: pwsh,
      args: ['-NoLogo'],
      platform: 'win32',
    });
  }

  // 2. Windows PowerShell 5.1
  const winPs = firstExistingFile([
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    findExecutableInPath('powershell.exe'),
  ]);
  if (winPs) {
    profiles.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      command: winPs,
      args: ['-NoLogo'],
      platform: 'win32',
    });
  }

  // 3. Command Prompt (CMD)
  const cmdExe = firstExistingFile([
    process.env.COMSPEC,
    path.join(sysRoot, 'System32', 'cmd.exe'),
  ]);
  if (cmdExe) {
    profiles.push({
      id: 'cmd',
      label: '命令提示符 (CMD)',
      command: cmdExe,
      args: [],
      platform: 'win32',
    });
  }

  // 4. Git Bash
  const gitBash = firstExistingFile([
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(home, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ]);
  if (gitBash) {
    profiles.push({
      id: 'git-bash',
      label: 'Git Bash',
      command: gitBash,
      args: ['--login', '-i'],
      platform: 'win32',
    });
  }

  // 5. WSL (Windows Subsystem for Linux) + installed distros
  const wslExe = firstExistingFile([
    path.join(sysRoot, 'System32', 'wsl.exe'),
    findExecutableInPath('wsl.exe'),
  ]);
  if (wslExe) {
    let distros: string[] = [];
    try {
      const rawBuf = execFileSync(wslExe, ['-l', '-q'], {
        timeout: 1500,
        windowsHide: true,
      });
      // wsl.exe outputs UTF-16LE on Windows
      const decoded = rawBuf.includes(0)
        ? rawBuf.toString('utf16le')
        : rawBuf.toString('utf8');
      distros = decoded
        .replace(/\uFEFF/g, '')
        .split(/\r?\n/)
        .map((s) => s.replace(/\0/g, '').trim())
        .filter(
          (name) =>
            Boolean(name) &&
            !name.toLowerCase().startsWith('docker-desktop')
        );
    } catch {
      distros = [];
    }

    if (distros.length > 0) {
      for (const distro of distros) {
        profiles.push({
          id: `wsl:${distro}`,
          label: `WSL · ${distro}`,
          command: wslExe,
          args: ['-d', distro, '--cd', '~'],
          platform: 'win32',
        });
      }
    } else {
      // Offer generic WSL entry only if wsl.exe exists (user may start default distro)
      profiles.push({
        id: 'wsl',
        label: 'WSL (Linux 子系统)',
        command: wslExe,
        args: ['--cd', '~'],
        platform: 'win32',
      });
    }
  }

  // 6. MSYS2 Bash (if installed)
  const msysBash = firstExistingFile(['C:\\msys64\\usr\\bin\\bash.exe']);
  if (msysBash) {
    profiles.push({
      id: 'msys2',
      label: 'MSYS2 Bash',
      command: msysBash,
      args: ['--login', '-i'],
      platform: 'win32',
    });
  }

  return profiles;
}

function discoverUnixShells(platform: 'darwin' | 'linux'): LocalShellProfile[] {
  const profiles: LocalShellProfile[] = [];
  const seenCommands = new Set<string>();

  const addCandidate = (
    id: string,
    label: string,
    candidates: Array<string | null | undefined>,
    args: string[]
  ) => {
    const resolved = firstExistingFile(candidates);
    if (!resolved || seenCommands.has(resolved)) return;
    seenCommands.add(resolved);
    profiles.push({ id, label, command: resolved, args, platform });
  };

  // Honor user's default $SHELL first
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    const base = path.basename(envShell).toLowerCase();
    const args = base === 'pwsh' ? ['-NoLogo'] : ['-l'];
    addCandidate(
      `default:${base}`,
      `${base.toUpperCase()} (系统默认)`,
      [envShell],
      args
    );
  }

  if (platform === 'darwin') {
    addCandidate(
      'zsh',
      'Zsh',
      ['/opt/homebrew/bin/zsh', '/usr/local/bin/zsh', '/bin/zsh'],
      ['-l']
    );
    addCandidate(
      'bash',
      'Bash',
      ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'],
      ['-l']
    );
  } else {
    addCandidate('bash', 'Bash', ['/bin/bash', '/usr/bin/bash'], ['-l']);
    addCandidate('zsh', 'Zsh', ['/usr/bin/zsh', '/bin/zsh'], ['-l']);
  }

  addCandidate(
    'fish',
    'Fish Shell',
    [
      findExecutableInPath('fish'),
      '/opt/homebrew/bin/fish',
      '/usr/local/bin/fish',
      '/usr/bin/fish',
    ],
    ['-l']
  );

  addCandidate(
    'pwsh',
    'PowerShell (pwsh)',
    [
      findExecutableInPath('pwsh'),
      '/opt/homebrew/bin/pwsh',
      '/usr/local/bin/pwsh',
      '/usr/bin/pwsh',
    ],
    ['-NoLogo']
  );

  addCandidate(
    'nu',
    'Nushell (nu)',
    [findExecutableInPath('nu'), '/opt/homebrew/bin/nu', '/usr/bin/nu'],
    []
  );

  addCandidate('sh', 'POSIX Sh (/bin/sh)', ['/bin/sh'], []);

  return profiles;
}

export class LocalPtyService {
  private sessions = new Map<string, ActiveLocalSession>();
  private cachedShells: LocalShellProfile[] | null = null;
  private dataCallback: DataCallback | null = null;
  private stateCallback: StateCallback | null = null;

  setCallbacks(onData: DataCallback, onState: StateCallback): void {
    this.dataCallback = onData;
    this.stateCallback = onState;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  onSessionClosed(sessionId: string, cb: () => void): void {
    const active = this.sessions.get(sessionId);
    if (!active) return;
    active.ptyProcess.onExit(() => cb());
  }

  listShells(refresh = false): LocalShellProfile[] {
    if (!refresh && this.cachedShells && this.cachedShells.length > 0) {
      return this.cachedShells;
    }

    if (process.platform === 'win32') {
      this.cachedShells = discoverWindowsShells();
    } else if (process.platform === 'darwin') {
      this.cachedShells = discoverUnixShells('darwin');
    } else {
      this.cachedShells = discoverUnixShells('linux');
    }

    return this.cachedShells;
  }

  connect(req: SshConnectRequest): SshConnectResult {
    if (this.sessions.has(req.sessionId)) {
      this.disconnect(req.sessionId);
    }

    const shells = this.listShells();
    if (shells.length === 0) {
      return { ok: false, error: '未能在当前系统检测到可用的本地终端程序' };
    }

    const chosen =
      (req.shellId ? shells.find((s) => s.id === req.shellId) : undefined) ??
      shells[0];

    const cols = Math.max(20, Math.floor(req.cols || 80));
    const rows = Math.max(5, Math.floor(req.rows || 24));
    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') {
        env[k] = v;
      }
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    try {
      const ptyProcess = pty.spawn(chosen.command, chosen.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });

      const session: ActiveLocalSession = {
        sessionId: req.sessionId,
        shell: chosen,
        ptyProcess,
        intentionalClose: false,
      };
      this.sessions.set(req.sessionId, session);

      this.stateCallback?.({
        sessionId: req.sessionId,
        state: 'connected',
        message: `已启动本机终端: ${chosen.label}`,
      });

      ptyProcess.onData((data) => {
        this.dataCallback?.({
          sessionId: req.sessionId,
          data,
        });
      });

      ptyProcess.onExit(({ exitCode }) => {
        const current = this.sessions.get(req.sessionId);
        if (current?.ptyProcess === ptyProcess) {
          this.sessions.delete(req.sessionId);
          this.stateCallback?.({
            sessionId: req.sessionId,
            state: 'disconnected',
            message: session.intentionalClose
              ? '本机终端已关闭'
              : `本机终端进程已退出 (退出码 ${exitCode})`,
            code: exitCode,
          });
        }
      });

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.stateCallback?.({
        sessionId: req.sessionId,
        state: 'error',
        message: `启动本机终端失败: ${msg}`,
      });
      return { ok: false, error: `启动本机终端失败: ${msg}` };
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.ptyProcess.write(data);
      } catch {
        // ignore write on closing pty
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.ptyProcess.resize(
          Math.max(20, Math.floor(cols)),
          Math.max(5, Math.floor(rows))
        );
      } catch {
        // ignore transient ConPTY resize error
      }
    }
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.intentionalClose = true;
    this.sessions.delete(sessionId);
    try {
      session.ptyProcess.kill();
    } catch {
      // ignore if already exited
    }
  }

  disconnectAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.disconnect(sessionId);
    }
  }
}

export const localPtyService = new LocalPtyService();
