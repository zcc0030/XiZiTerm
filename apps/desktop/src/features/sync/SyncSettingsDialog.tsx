import * as React from 'react';
import {
  BookOpen,
  Check,
  CheckCircle2,
  Cloud,
  CloudOff,
  Copy,
  Eye,
  EyeOff,
  FolderSync,
  HardDrive,
  KeyRound,
  Loader2,
  LogIn,
  RefreshCw,
  Server,
  ShieldCheck,
  Unlink,
  UserPlus,
} from 'lucide-react';
import type { SyncProviderType } from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVaultStore } from '@/stores/vault.store';

interface SyncSettingsDialogProps {
  open: boolean;
  prefillServerUrl?: string;
  prefillProvider?: SyncProviderType;
  onClose: () => void;
  onOpenGuide: () => void;
}

type BindTab = 'register' | 'login' | 'token';

const NEED_REMOTE_PW_PREFIX = 'NEED_REMOTE_MASTER_PASSWORD:';

const WEBDAV_PRESETS = [
  {
    id: 'jianguoyun',
    label: '坚果云',
    url: 'https://dav.jianguoyun.com/dav/',
    hint: '坚果云提示：请登录坚果云网页版 → 右上角「账户信息」→「安全选项」→「第三方应用管理」添加应用并生成专用应用密码（勿填坚果云登录密码）。',
  },
  {
    id: 'alist',
    label: 'Alist / OpenList',
    url: 'http://127.0.0.1:5244/dav/',
    hint: 'Alist 提示：URL 末尾需带 /dav/（或指定挂载目录如 /dav/aliyun/），并确保该用户勾选了 WebDAV 读取与写入权限。',
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    url: 'https://cloud.example.com/remote.php/dav/files/username/',
    hint: 'Nextcloud 提示：将域名与 username 替换为你的实际账号，建议在「个人设置 → 安全」中创建应用密码。',
  },
  {
    id: 'nas',
    label: '群晖 / 飞牛 NAS',
    url: 'http://192.168.1.100:5005/',
    hint: '飞牛 fnOS / 群晖提示：NAS 的 WebDAV 根目录仅列出共享文件夹，不允许直接在根目录新建 /XiZiTerm。请将「远程同步目录」设为「/共享文件夹名/XiZiTerm」（填好账号密码后点「测试 WebDAV 连通性」可自动列出你的共享文件夹一键点选）。',
  },
] as const;

function formatSyncTime(ms: number | null): string {
  if (!ms) return '尚未同步';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SyncSettingsDialog({
  open,
  prefillServerUrl,
  prefillProvider,
  onClose,
  onOpenGuide,
}: SyncSettingsDialogProps) {
  const syncStatus = useVaultStore((s) => s.syncStatus);
  const loadSyncStatus = useVaultStore((s) => s.loadSyncStatus);
  const refreshData = useVaultStore((s) => s.refreshData);

  const [providerTab, setProviderTab] =
    React.useState<SyncProviderType>('webdav');

  // Self-hosted form state
  const [tab, setTab] = React.useState<BindTab>('register');
  const [serverUrl, setServerUrl] = React.useState('http://127.0.0.1:8787');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [inviteCode, setInviteCode] = React.useState('');
  const [tokenInput, setTokenInput] = React.useState('');

  // WebDAV form state
  const [webdavPreset, setWebdavPreset] = React.useState<string>('jianguoyun');
  const [webdavUrl, setWebdavUrl] = React.useState(
    'https://dav.jianguoyun.com/dav/'
  );
  const [webdavDir, setWebdavDir] = React.useState('/XiZiTerm');
  const [webdavUser, setWebdavUser] = React.useState('');
  const [webdavPass, setWebdavPass] = React.useState('');
  const [showWebdavPass, setShowWebdavPass] = React.useState(false);

  // Remote KDF adoption state (when remote already has a vault with different salt)
  const [needRemoteMasterPw, setNeedRemoteMasterPw] = React.useState(false);
  const [remoteMasterPw, setRemoteMasterPw] = React.useState('');

  const [testing, setTesting] = React.useState(false);
  const [testOkMsg, setTestOkMsg] = React.useState<string | null>(null);
  const [detectedShares, setDetectedShares] = React.useState<string[]>([]);
  const [shareWarnMsg, setShareWarnMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [syncMsg, setSyncMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedToken, setCopiedToken] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setTestOkMsg(null);
    setDetectedShares([]);
    setShareWarnMsg(null);
    setSyncMsg(null);
    setNeedRemoteMasterPw(false);
    setRemoteMasterPw('');
    void loadSyncStatus();

    if (prefillProvider) {
      setProviderTab(prefillProvider);
    } else if (syncStatus?.provider) {
      setProviderTab(syncStatus.provider);
    }

    if (prefillServerUrl) {
      setServerUrl(prefillServerUrl);
      setProviderTab('self-hosted');
    } else if (syncStatus?.serverUrl) {
      if (syncStatus.provider === 'webdav') {
        setWebdavUrl(syncStatus.serverUrl);
        if (syncStatus.webdavRemoteDir) {
          setWebdavDir(syncStatus.webdavRemoteDir);
        }
        if (syncStatus.username) {
          setWebdavUser(syncStatus.username);
        }
      } else {
        setServerUrl(syncStatus.serverUrl);
        if (syncStatus.username) {
          setUsername(syncStatus.username);
        }
      }
    }
  }, [
    open,
    prefillServerUrl,
    prefillProvider,
    loadSyncStatus,
    syncStatus?.provider,
    syncStatus?.serverUrl,
    syncStatus?.username,
    syncStatus?.webdavRemoteDir,
  ]);

  const handleBindError = (rawError?: string) => {
    const msg = rawError ?? '绑定云同步失败';
    if (msg.startsWith(NEED_REMOTE_PW_PREFIX)) {
      setNeedRemoteMasterPw(true);
      setError(msg.slice(NEED_REMOTE_PW_PREFIX.length));
    } else {
      setError(msg);
    }
  };

  const handleTestSelfHosted = async () => {
    setTesting(true);
    setError(null);
    setTestOkMsg(null);
    try {
      const res = await window.xiziterm.sync.testServer(serverUrl);
      if (!res.ok || !res.data) {
        setError(res.error ?? '无法连接到云同步服务端');
        return;
      }
      setTestOkMsg(`连接成功 · 自建服务端版本 v${res.data.version}`);
    } finally {
      setTesting(false);
    }
  };

  const runWebdavTest = async (targetDirOverride?: string) => {
    setTesting(true);
    setError(null);
    setTestOkMsg(null);
    setShareWarnMsg(null);
    try {
      const res = await window.xiziterm.sync.testWebdav({
        serverUrl: webdavUrl,
        username: webdavUser,
        password: webdavPass,
        remoteDir: targetDirOverride ?? webdavDir,
      });
      if (!res.ok || !res.data) {
        setError(res.error ?? '无法连接到 WebDAV 服务器');
        return;
      }
      if (!res.data.writable) {
        setShareWarnMsg(res.data.message);
        setDetectedShares(res.data.availableShares ?? []);
        return;
      }
      setDetectedShares([]);
      setTestOkMsg(res.data.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSelfHostedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSyncMsg(null);
    try {
      let res;
      if (tab === 'register') {
        res = await window.xiziterm.sync.register({
          serverUrl,
          username,
          password,
          inviteCode: inviteCode.trim() || undefined,
        });
      } else if (tab === 'login') {
        res = await window.xiziterm.sync.login({
          serverUrl,
          username,
          password,
          masterPassword: needRemoteMasterPw
            ? remoteMasterPw || undefined
            : undefined,
        });
      } else {
        res = await window.xiziterm.sync.bindToken({
          serverUrl,
          token: tokenInput,
          masterPassword: needRemoteMasterPw
            ? remoteMasterPw || undefined
            : undefined,
        });
      }

      if (!res.ok) {
        handleBindError(res.error);
        return;
      }

      setPassword('');
      setTokenInput('');
      setRemoteMasterPw('');
      setNeedRemoteMasterPw(false);
      await loadSyncStatus();
      await refreshData();
      setSyncMsg('自托管云同步已绑定并完成首次端到端加密同步！');
    } finally {
      setBusy(false);
    }
  };

  const handleWebdavSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSyncMsg(null);
    try {
      const res = await window.xiziterm.sync.bindWebdav({
        serverUrl: webdavUrl,
        username: webdavUser,
        password: webdavPass,
        remoteDir: webdavDir,
        masterPassword: needRemoteMasterPw
          ? remoteMasterPw || undefined
          : undefined,
      });

      if (!res.ok) {
        handleBindError(res.error);
        return;
      }

      setWebdavPass('');
      setRemoteMasterPw('');
      setNeedRemoteMasterPw(false);
      await loadSyncStatus();
      await refreshData();
      setSyncMsg('WebDAV 云盘同步已开启并完成端到端加密同步！');
    } finally {
      setBusy(false);
    }
  };

  const handleManualSync = async (forceFull: boolean) => {
    setBusy(true);
    setError(null);
    setSyncMsg(null);
    try {
      const res = await window.xiziterm.sync.syncNow({ forceFull });
      if (!res.ok || !res.data) {
        setError(res.error ?? '同步失败');
        return;
      }
      await loadSyncStatus();
      await refreshData();
      const { pulledCount, pushedCount, conflictCount } = res.data;
      setSyncMsg(
        `同步完成：拉取 ${pulledCount} 条 · 推送 ${pushedCount} 条${
          conflictCount > 0 ? ` · 处理冲突 ${conflictCount} 条` : ''
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  const handleToggleOption = async (
    key: 'autoSyncOnUnlock' | 'autoPushOnChange',
    value: boolean
  ) => {
    const res = await window.xiziterm.sync.updateOptions({ [key]: value });
    if (res.ok) {
      await loadSyncStatus();
    }
  };

  const handleCopyToken = async () => {
    const res = await window.xiziterm.sync.getToken();
    if (res.ok && res.data) {
      await navigator.clipboard.writeText(res.data);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 1800);
    }
  };

  const handleDisconnect = async () => {
    if (
      !window.confirm(
        '确定断开当前设备的云同步？本地所有主机、分组和快捷命令数据都会完整保留。'
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSyncMsg(null);
    try {
      await window.xiziterm.sync.disconnect();
      await loadSyncStatus();
    } finally {
      setBusy(false);
    }
  };

  const isConnected = Boolean(syncStatus?.enabled);
  const activePresetHint = WEBDAV_PRESETS.find(
    (p) => p.id === webdavPreset
  )?.hint;

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="云端加密同步 (E2EE)"
      description="支持免服务器 WebDAV 网盘（坚果云 / NAS / Alist）与自托管 Ubuntu VPS 双模式零知识加密同步"
    >
      <div className="space-y-4">
        {isConnected && syncStatus ? (
          <>
            {/* Connected Status Card */}
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-emerald-300">
                  {syncStatus.provider === 'webdav' ? (
                    <FolderSync className="h-4 w-4" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                  <span>
                    {syncStatus.provider === 'webdav'
                      ? '已连接 WebDAV 云盘同步'
                      : '已连接自托管 VPS 云同步'}
                  </span>
                </div>
                <span className="rounded bg-slate-900 px-2 py-0.5 font-mono text-[10px] text-cyan-300">
                  {syncStatus.provider === 'webdav' ? 'Rev' : 'Seq'} #
                  {syncStatus.lastServerSeq}
                </span>
              </div>
              <div className="mt-2.5 space-y-1 font-mono text-[11px] text-slate-300">
                <div className="truncate">地址: {syncStatus.serverUrl}</div>
                {syncStatus.provider === 'webdav' && (
                  <div className="truncate">
                    远程目录: {syncStatus.webdavRemoteDir || '/XiZiTerm'}/xiziterm-vault.enc.json
                  </div>
                )}
                <div>同步账号: {syncStatus.username}</div>
                <div className="text-slate-400">
                  最近同步: {formatSyncTime(syncStatus.lastSyncedAt)}
                  {syncStatus.pendingCount > 0 && (
                    <span className="ml-2 text-amber-300">
                      ({syncStatus.pendingCount} 条待推送)
                    </span>
                  )}
                </div>
              </div>
              {syncStatus.lastError && (
                <div className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
                  上次同步异常: {syncStatus.lastError}
                </div>
              )}
            </div>

            {/* Sync Action Buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void handleManualSync(false)}
                disabled={busy}
                className="flex-1"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                立即同步
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleManualSync(true)}
                disabled={busy}
              >
                强制全量同步
              </Button>
            </div>

            {/* Auto-Sync Toggles */}
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs">
              <label className="flex cursor-pointer items-center justify-between">
                <span className="text-slate-300">启动解锁保险库时自动同步</span>
                <input
                  type="checkbox"
                  checked={syncStatus.autoSyncOnUnlock}
                  onChange={(e) =>
                    void handleToggleOption('autoSyncOnUnlock', e.target.checked)
                  }
                  className="h-4 w-4 accent-cyan-500"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between">
                <span className="text-slate-300">
                  主机 / 分组 / 快捷命令变更后自动推送
                </span>
                <input
                  type="checkbox"
                  checked={syncStatus.autoPushOnChange}
                  onChange={(e) =>
                    void handleToggleOption('autoPushOnChange', e.target.checked)
                  }
                  className="h-4 w-4 accent-cyan-500"
                />
              </label>
            </div>

            {/* Footer Controls */}
            <div className="flex items-center justify-between border-t border-slate-800 pt-3">
              <div className="flex items-center gap-2">
                {syncStatus.provider === 'self-hosted' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopyToken()}
                  >
                    {copiedToken ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedToken ? '已复制 Token' : '复制认证 Token'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onOpenGuide}
                  className="text-slate-400 hover:text-cyan-300"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  同步说明 / 部署指南
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void handleDisconnect()}
                className="text-rose-400 hover:bg-rose-500/15 hover:text-rose-300"
              >
                <Unlink className="h-3.5 w-3.5" />
                断开云同步
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Top Provider Mode Switcher: WebDAV vs Self-Hosted VPS */}
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-slate-800 bg-slate-950/80 p-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setProviderTab('webdav');
                  setError(null);
                  setTestOkMsg(null);
                  setNeedRemoteMasterPw(false);
                }}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 font-medium transition-colors ${
                  providerTab === 'webdav'
                    ? 'bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <HardDrive className="h-3.5 w-3.5 text-cyan-400" />
                <span>WebDAV 网盘（免自建服务器）</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setProviderTab('self-hosted');
                  setError(null);
                  setTestOkMsg(null);
                  setNeedRemoteMasterPw(false);
                }}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 font-medium transition-colors ${
                  providerTab === 'self-hosted'
                    ? 'bg-cyan-500/20 text-cyan-200 ring-1 ring-inset ring-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Server className="h-3.5 w-3.5 text-emerald-400" />
                <span>自托管 VPS 服务端</span>
              </button>
            </div>

            {providerTab === 'webdav' ? (
              /* === WEBDAV BIND FORM === */
              <form
                onSubmit={(e) => void handleWebdavSubmit(e)}
                className="space-y-3.5"
              >
                {/* Quick Provider Presets */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      快捷选择服务商模板
                    </span>
                    <button
                      type="button"
                      onClick={onOpenGuide}
                      className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                    >
                      <BookOpen className="h-3 w-3" />
                      查看配置说明
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEBDAV_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setWebdavPreset(preset.id);
                          setWebdavUrl(preset.url);
                          setTestOkMsg(null);
                          setError(null);
                        }}
                        className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          webdavPreset === preset.id
                            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                            : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setWebdavPreset('custom');
                        setTestOkMsg(null);
                      }}
                      className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        webdavPreset === 'custom'
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                          : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      自定义 WebDAV
                    </button>
                  </div>
                  {activePresetHint && (
                    <p className="rounded-md border border-slate-800/90 bg-slate-950/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-400">
                      {activePresetHint}
                    </p>
                  )}
                </div>

                {/* WebDAV Endpoint + Remote Dir */}
                <div className="grid grid-cols-12 gap-2.5">
                  <div className="col-span-8 space-y-1">
                    <label className="text-xs font-medium text-slate-300">
                      WebDAV 服务器地址 (URL) *
                    </label>
                    <Input
                      value={webdavUrl}
                      onChange={(e) => {
                        setWebdavUrl(e.target.value);
                        setWebdavPreset('custom');
                      }}
                      placeholder="https://dav.jianguoyun.com/dav/"
                      className="font-mono text-xs"
                      required
                    />
                  </div>
                  <div className="col-span-4 space-y-1">
                    <label className="text-xs font-medium text-slate-300">
                      远程同步目录 *
                    </label>
                    <Input
                      value={webdavDir}
                      onChange={(e) => setWebdavDir(e.target.value)}
                      placeholder="/XiZiTerm"
                      className="font-mono text-xs"
                      required
                    />
                  </div>
                </div>

                {/* WebDAV Credentials */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-300">
                      WebDAV 账号 / 邮箱 *
                    </label>
                    <Input
                      value={webdavUser}
                      onChange={(e) => setWebdavUser(e.target.value)}
                      placeholder="例如: your@email.com"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-300">
                      应用专用密码 / WebDAV 密码 *
                    </label>
                    <div className="relative">
                      <Input
                        type={showWebdavPass ? 'text' : 'password'}
                        value={webdavPass}
                        onChange={(e) => setWebdavPass(e.target.value)}
                        placeholder="输入 WebDAV 应用密码"
                        className="pr-8 font-mono text-xs"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowWebdavPass((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                        tabIndex={-1}
                      >
                        {showWebdavPass ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Test Connection Button & Status */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={
                        testing ||
                        !webdavUrl.trim() ||
                        !webdavUser.trim() ||
                        !webdavPass
                      }
                      onClick={() => void runWebdavTest()}
                    >
                      {testing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        '测试 WebDAV 连通性'
                      )}
                    </Button>
                    {testOkMsg && (
                      <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{testOkMsg}</span>
                      </div>
                    )}
                  </div>

                  {shareWarnMsg && (
                    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
                      <div>{shareWarnMsg}</div>
                      {detectedShares.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {detectedShares.map((share) => {
                            const nextDir = `/${share}/XiZiTerm`;
                            return (
                              <button
                                key={share}
                                type="button"
                                onClick={() => {
                                  setWebdavDir(nextDir);
                                  void runWebdavTest(nextDir);
                                }}
                                className="rounded border border-amber-400/40 bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20"
                              >
                                {nextDir}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Conditional Remote Master Password Input for Existing Remote Vault */}
                {needRemoteMasterPw && (
                  <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                    <label className="text-xs font-medium text-amber-200">
                      请输入该云端保险库的主密码（用于验证并合并本地与云端数据）*
                    </label>
                    <Input
                      type="password"
                      value={remoteMasterPw}
                      onChange={(e) => setRemoteMasterPw(e.target.value)}
                      placeholder="输入创建该云端保险库时设置的主密码"
                      className="font-mono text-xs"
                      autoFocus
                      required
                    />
                  </div>
                )}

                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[11px] leading-relaxed text-slate-400">
                  <div className="flex items-center gap-1.5 font-medium text-cyan-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>端到端零知识加密 · 网盘零明文</span>
                  </div>
                  <p className="mt-1">
                    所有主机密码、SSH 私钥、快捷命令均在本地使用主密码执行{' '}
                    <strong>AES-256-GCM</strong> 加密后打包为单个密文文件写入 WebDAV；坚果云 / 网盘服务商无法读取任何明文内容，WebDAV 密码在本地由系统安全凭据库加密保护。
                  </p>
                </div>

                <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
                  <Button type="button" variant="ghost" onClick={onClose}>
                    取消
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderSync className="h-4 w-4" />
                    )}
                    {needRemoteMasterPw
                      ? '验证主密码并合并同步'
                      : '连接 WebDAV 并开启同步'}
                  </Button>
                </div>
              </form>
            ) : (
              /* === SELF-HOSTED VPS BIND FORM === */
              <form
                onSubmit={(e) => void handleSelfHostedSubmit(e)}
                className="space-y-3.5"
              >
                <div className="flex items-center justify-between rounded-lg border border-slate-800/90 bg-slate-950/60 px-3 py-2 text-xs">
                  <span className="text-slate-400">
                    还没部署 VPS 同步服务端？查看 Docker 指南或使用 SSH 一键部署
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenGuide}
                    className="h-7 shrink-0 text-[11px]"
                  >
                    <BookOpen className="h-3.5 w-3.5 text-cyan-400" />
                    搭建指南 / 一键部署
                  </Button>
                </div>

                {/* Server URL + Test */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">
                    自建 VPS 同步服务器地址 (URL) *
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="https://sync.yourdomain.com 或 http://1.2.3.4:8787"
                      className="font-mono text-xs"
                      required
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={testing || !serverUrl.trim()}
                      onClick={() => void handleTestSelfHosted()}
                    >
                      {testing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        '测试连通'
                      )}
                    </Button>
                  </div>
                  {testOkMsg && (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>{testOkMsg}</span>
                    </div>
                  )}
                </div>

                {/* Auth Mode Switcher */}
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-950/70 p-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setTab('register');
                      setError(null);
                      setNeedRemoteMasterPw(false);
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded py-1.5 font-medium transition-colors ${
                      tab === 'register'
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    首次注册
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('login');
                      setError(null);
                      setNeedRemoteMasterPw(false);
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded py-1.5 font-medium transition-colors ${
                      tab === 'login'
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    账号登录
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('token');
                      setError(null);
                      setNeedRemoteMasterPw(false);
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded py-1.5 font-medium transition-colors ${
                      tab === 'token'
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Token 绑定
                  </button>
                </div>

                {tab === 'token' ? (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-300">
                      认证 Bearer Token *
                    </label>
                    <Input
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="nt_..."
                      className="font-mono text-xs"
                      required
                    />
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-300">
                          VPS 同步用户名 *
                        </label>
                        <Input
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="例如: admin"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-300">
                          VPS 登录密码 *
                        </label>
                        <Input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="至少 6 位（与主密码隔离）"
                          required
                        />
                      </div>
                    </div>
                    {tab === 'register' && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-300">
                          注册邀请码（若服务端未设置可留空）
                        </label>
                        <Input
                          value={inviteCode}
                          onChange={(e) => setInviteCode(e.target.value)}
                          placeholder="可选 INVITE_CODE"
                          className="font-mono text-xs"
                        />
                      </div>
                    )}
                  </>
                )}

                {needRemoteMasterPw && (
                  <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                    <label className="text-xs font-medium text-amber-200">
                      请输入该云端账号的主密码（用于验证并合并本地与云端数据）*
                    </label>
                    <Input
                      type="password"
                      value={remoteMasterPw}
                      onChange={(e) => setRemoteMasterPw(e.target.value)}
                      placeholder="输入云端保险库的主密码"
                      className="font-mono text-xs"
                      autoFocus
                      required
                    />
                  </div>
                )}

                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[11px] leading-relaxed text-slate-400">
                  <div className="flex items-center gap-1.5 font-medium text-cyan-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>零知识端到端加密保障</span>
                  </div>
                  <p className="mt-1">
                    VPS 登录密码仅用于接口鉴权，绝不参与本地数据加密；你的主密码（Master Password）永远不会发送到服务器，VPS 数据库中仅存储 AES-256-GCM 密文与元数据。
                  </p>
                </div>

                <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
                  <Button type="button" variant="ghost" onClick={onClose}>
                    取消
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Cloud className="h-4 w-4" />
                    )}
                    {tab === 'register'
                      ? '注册并首次加密上传'
                      : tab === 'login'
                        ? '登录并立即同步'
                        : '验证 Token 并同步'}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}

        {syncMsg && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{syncMsg}</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            <CloudOff className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
