import * as React from 'react';
import {
  CloudDownload,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { SyncProviderType } from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVaultStore } from '@/stores/vault.store';
import { ThemeDropdown } from '@/features/theme/ThemeSwitcher';

function getPasswordStrength(pw: string): {
  label: string;
  color: string;
  width: string;
} {
  if (!pw) return { label: '', color: 'bg-theme-border', width: 'w-0' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  if (score <= 1) return { label: '弱', color: 'bg-theme-error', width: 'w-1/4' };
  if (score <= 2) return { label: '一般', color: 'bg-theme-warn', width: 'w-2/4' };
  if (score <= 3) return { label: '较强', color: 'bg-theme-accent', width: 'w-3/4' };
  return { label: '极强', color: 'bg-theme-online', width: 'w-full' };
}

export function VaultLockScreen() {
  const status = useVaultStore((s) => s.status);
  const initializeVault = useVaultStore((s) => s.initializeVault);
  const unlockVault = useVaultStore((s) => s.unlockVault);
  const restoreVaultFromCloud = useVaultStore((s) => s.restoreVaultFromCloud);

  const isInitMode = !status?.initialized;
  const [setupMode, setSetupMode] = React.useState<'local' | 'restore'>('local');

  // Local init / unlock state
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);

  // Cloud restore state
  const [restoreProvider, setRestoreProvider] =
    React.useState<SyncProviderType>('webdav');
  const [serverUrl, setServerUrl] = React.useState('http://127.0.0.1:8787');
  const [webdavUrl, setWebdavUrl] = React.useState(
    'https://dav.jianguoyun.com/dav/'
  );
  const [webdavDir, setWebdavDir] = React.useState('/XiZiTerm');
  const [restoreAuthMode, setRestoreAuthMode] = React.useState<
    'password' | 'token'
  >('password');
  const [vpsUsername, setVpsUsername] = React.useState('');
  const [vpsPassword, setVpsPassword] = React.useState('');
  const [vpsToken, setVpsToken] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const strength = getPasswordStrength(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isInitMode && setupMode === 'restore') {
      if (!password) {
        setError('请输入你的云端保险库主密码');
        return;
      }
      setSubmitting(true);
      try {
        const res =
          restoreProvider === 'webdav'
            ? await restoreVaultFromCloud({
                provider: 'webdav',
                serverUrl: webdavUrl,
                webdavRemoteDir: webdavDir,
                mode: 'password',
                username: vpsUsername,
                password: vpsPassword,
                masterPassword: password,
              })
            : await restoreVaultFromCloud({
                provider: 'self-hosted',
                serverUrl,
                mode: restoreAuthMode,
                username:
                  restoreAuthMode === 'password' ? vpsUsername : undefined,
                password:
                  restoreAuthMode === 'password' ? vpsPassword : undefined,
                token: restoreAuthMode === 'token' ? vpsToken : undefined,
                masterPassword: password,
              });
        if (!res.ok) {
          setError(res.error ?? '云端恢复失败');
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (password.length < 6) {
      setError('主密码长度至少为 6 位');
      return;
    }

    if (isInitMode && password !== confirmPassword) {
      setError('两次输入的主密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      const res = isInitMode
        ? await initializeVault(password)
        : await unlockVault(password);
      if (!res.ok) {
        setError(res.error ?? '操作失败');
      } else {
        setPassword('');
        setConfirmPassword('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-y-auto bg-theme-base p-6 text-theme-primary">
      {/* Top-right Theme Switcher */}
      <div className="absolute right-5 top-4 z-20">
        <ThemeDropdown />
      </div>

      {/* Ambient theme glow */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 transform-gpu rounded-full bg-theme-accent/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 right-1/4 h-80 w-80 transform-gpu rounded-full bg-theme-online/10 blur-3xl" />

      <div
        style={{ boxShadow: 'var(--panel-shadow)' }}
        className="relative z-10 w-full max-w-md rounded-2xl border border-theme-border bg-theme-sidebar p-7"
      >
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-theme-accent/35 bg-theme-accent-soft text-theme-accent">
            {isInitMode && setupMode === 'restore' ? (
              <CloudDownload className="h-7 w-7" />
            ) : isInitMode ? (
              <ShieldCheck className="h-7 w-7" />
            ) : (
              <Lock className="h-7 w-7" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-theme-accent" />
            <h1 className="text-xl font-bold tracking-tight text-theme-primary">
              XiZiTerm
            </h1>
          </div>
          <p className="mt-1.5 text-xs text-theme-muted">
            {isInitMode
              ? setupMode === 'restore'
                ? '连接 WebDAV 网盘或自托管 VPS，本地解密恢复你的保险库'
                : '首次使用，请设置本地加密保险库主密码（Master Password）'
              : '保险库已锁定，请输入主密码以解密主机与凭据'}
          </p>
        </div>

        {/* Init Mode Switcher: New Local Vault vs Restore from Cloud */}
        {isInitMode && (
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-theme-border bg-theme-input p-1 text-xs">
            <button
              type="button"
              onClick={() => {
                setSetupMode('local');
                setError(null);
              }}
              className={`rounded py-1.5 font-medium transition-colors ${
                setupMode === 'local'
                  ? 'bg-theme-accent-soft text-theme-accent'
                  : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              新建本地保险库
            </button>
            <button
              type="button"
              onClick={() => {
                setSetupMode('restore');
                setError(null);
              }}
              className={`rounded py-1.5 font-medium transition-colors ${
                setupMode === 'restore'
                  ? 'bg-theme-accent-soft text-theme-accent'
                  : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              从云端恢复保险库
            </button>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5">
          {isInitMode && setupMode === 'restore' && (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">云端存储类型</span>
                <div className="inline-flex rounded border border-slate-800 bg-slate-900 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => {
                      setRestoreProvider('webdav');
                      setError(null);
                    }}
                    className={`rounded px-2.5 py-0.5 font-medium ${
                      restoreProvider === 'webdav'
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400'
                    }`}
                  >
                    WebDAV 网盘
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRestoreProvider('self-hosted');
                      setError(null);
                    }}
                    className={`rounded px-2.5 py-0.5 font-medium ${
                      restoreProvider === 'self-hosted'
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400'
                    }`}
                  >
                    自托管 VPS
                  </button>
                </div>
              </div>

              {restoreProvider === 'webdav' ? (
                <>
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-8 space-y-1">
                      <label className="text-xs font-medium text-slate-300">
                        WebDAV 地址
                      </label>
                      <Input
                        value={webdavUrl}
                        onChange={(e) => setWebdavUrl(e.target.value)}
                        placeholder="https://dav.jianguoyun.com/dav/"
                        className="font-mono text-xs"
                        required
                        disabled={submitting}
                      />
                    </div>
                    <div className="col-span-4 space-y-1">
                      <label className="text-xs font-medium text-slate-300">
                        同步目录
                      </label>
                      <Input
                        value={webdavDir}
                        onChange={(e) => setWebdavDir(e.target.value)}
                        placeholder="/XiZiTerm"
                        className="font-mono text-xs"
                        required
                        disabled={submitting}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-xs text-slate-300">
                        WebDAV 账号
                      </label>
                      <Input
                        value={vpsUsername}
                        onChange={(e) => setVpsUsername(e.target.value)}
                        placeholder="邮箱或用户名"
                        required
                        disabled={submitting}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-300">
                        WebDAV 应用密码
                      </label>
                      <Input
                        type="password"
                        value={vpsPassword}
                        onChange={(e) => setVpsPassword(e.target.value)}
                        placeholder="应用专用密码"
                        required
                        disabled={submitting}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-300">
                      VPS 同步服务器地址 (URL)
                    </label>
                    <Input
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://sync.yourdomain.com 或 http://ip:8787"
                      className="font-mono text-xs"
                      required
                      disabled={submitting}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">VPS 认证方式</span>
                    <div className="inline-flex rounded border border-slate-800 bg-slate-900 p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setRestoreAuthMode('password')}
                        className={`rounded px-2 py-0.5 ${
                          restoreAuthMode === 'password'
                            ? 'bg-cyan-500/20 text-cyan-300'
                            : 'text-slate-400'
                        }`}
                      >
                        账号密码
                      </button>
                      <button
                        type="button"
                        onClick={() => setRestoreAuthMode('token')}
                        className={`rounded px-2 py-0.5 ${
                          restoreAuthMode === 'token'
                            ? 'bg-cyan-500/20 text-cyan-300'
                            : 'text-slate-400'
                        }`}
                      >
                        Token
                      </button>
                    </div>
                  </div>

                  {restoreAuthMode === 'password' ? (
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-300">
                          VPS 用户名
                        </label>
                        <Input
                          value={vpsUsername}
                          onChange={(e) => setVpsUsername(e.target.value)}
                          placeholder="username"
                          required
                          disabled={submitting}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-300">
                          VPS 登录密码
                        </label>
                        <Input
                          type="password"
                          value={vpsPassword}
                          onChange={(e) => setVpsPassword(e.target.value)}
                          placeholder="VPS 密码"
                          required
                          disabled={submitting}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <label className="text-xs text-slate-300">
                        认证 Bearer Token
                      </label>
                      <Input
                        type="password"
                        value={vpsToken}
                        onChange={(e) => setVpsToken(e.target.value)}
                        placeholder="nt_..."
                        className="font-mono text-xs"
                        required
                        disabled={submitting}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-theme-primary">
              主密码 (Master Password)
            </label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-muted" />
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  isInitMode && setupMode === 'local'
                    ? '至少 6 位，建议混合大小写与数字'
                    : '输入你的主密码（仅用于本地解密）'
                }
                className="pl-9 pr-9 font-mono"
                autoFocus={!(isInitMode && setupMode === 'restore')}
                disabled={submitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-primary"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {isInitMode && setupMode === 'local' && password.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-theme-border">
                  <div
                    className={`h-full transition-all duration-200 ${strength.color} ${strength.width}`}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-theme-muted">
                  <span>密钥派生: PBKDF2-SHA512 (600,000 次)</span>
                  <span>强度: {strength.label}</span>
                </div>
              </div>
            )}
          </div>

          {isInitMode && setupMode === 'local' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-theme-primary">
                确认主密码
              </label>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入主密码"
                className="font-mono"
                disabled={submitting}
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-theme-error/40 bg-theme-error-soft px-3 py-2 text-xs text-theme-error">
              {error}
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !password}
          >
            {submitting
              ? setupMode === 'restore'
                ? '正在拉取密文并本地解密...'
                : '正在执行密钥派生...'
              : isInitMode
                ? setupMode === 'restore'
                  ? '连接云端并解密恢复'
                  : '创建加密保险库并进入'
                : '解锁保险库'}
          </Button>
        </form>

        <div className="mt-5 rounded-lg border border-theme-border bg-theme-input p-3 text-[11px] leading-relaxed text-theme-muted">
          <div className="flex items-center gap-1.5 font-medium text-theme-accent">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>端到端零知识加密 (AES-256-GCM)</span>
          </div>
          <p className="mt-1">
            所有 SSH 密码与私钥均使用主密码在本地派生密钥加密，主密码永不落盘也不上传至任何服务器。请务必妥善保管。
          </p>
        </div>
      </div>
    </div>
  );
}
