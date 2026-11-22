import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  HardDrive,
  Loader2,
  Rocket,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type {
  SyncDeployLogEvent,
  SyncDeployTemplates,
  SyncOneClickDeployResult,
  SyncProviderType,
} from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVaultStore } from '@/stores/vault.store';

export const SKIP_SYNC_GUIDE_KEY = 'xiziterm.skipSyncGuide';
export const LEGACY_SKIP_SYNC_GUIDE_KEY = 'nexusterm.skipSyncGuide';

interface SyncOnboardingDialogProps {
  open: boolean;
  onClose: () => void;
  onProceedToSyncConfig: (options?: {
    prefillUrl?: string;
    provider?: SyncProviderType;
  }) => void;
}

type GuideMode = 'webdav' | 'manual' | 'auto';
type TemplateTab = 'compose' | 'dockerfile' | 'env';

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative rounded-md border border-slate-800 bg-[#080c15] px-3 py-2 font-mono text-[11px] leading-relaxed text-cyan-200/95">
      <pre className="overflow-x-auto pr-8 whitespace-pre-wrap break-all">
        {command}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        title="复制命令"
        className="absolute right-2 top-2 rounded border border-slate-700/80 bg-slate-900/90 p-1 text-slate-400 hover:text-cyan-300"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}

export function SyncOnboardingDialog({
  open,
  onClose,
  onProceedToSyncConfig,
}: SyncOnboardingDialogProps) {
  const hosts = useVaultStore((s) => s.hosts);

  const [mode, setMode] = React.useState<GuideMode>('manual');
  const [dontShowAgain, setDontShowAgain] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SKIP_SYNC_GUIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Manual guide template viewer
  const [templates, setTemplates] = React.useState<SyncDeployTemplates | null>(
    null
  );
  const [templateTab, setTemplateTab] = React.useState<TemplateTab>('compose');
  const [copiedTemplate, setCopiedTemplate] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [exportNotice, setExportNotice] = React.useState<string | null>(null);

  // Auto one-click deploy state
  const [riskAccepted, setRiskAccepted] = React.useState(false);
  const [vpsHost, setVpsHost] = React.useState('');
  const [sshPort, setSshPort] = React.useState('22');
  const [sshUser, setSshUser] = React.useState('root');
  const [sshPass, setSshPass] = React.useState('');
  const [showPass, setShowPass] = React.useState(false);
  const [syncPort, setSyncPort] = React.useState('8787');
  const [remoteDir, setRemoteDir] = React.useState('~/xiziterm-sync');
  const [inviteCode, setInviteCode] = React.useState('');

  const [deploying, setDeploying] = React.useState(false);
  const [logs, setLogs] = React.useState<SyncDeployLogEvent[]>([]);
  const [deployResult, setDeployResult] =
    React.useState<SyncOneClickDeployResult | null>(null);
  const [deployError, setDeployError] = React.useState<string | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setExportNotice(null);
    void window.xiziterm.sync.getDeployTemplates().then((res) => {
      if (res.ok && res.data) {
        setTemplates(res.data);
      }
    });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const off = window.xiziterm.sync.onDeployLog((ev) => {
      setLogs((prev) => [...prev, ev]);
    });
    return off;
  }, [open]);

  React.useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleToggleDontShow = (checked: boolean) => {
    setDontShowAgain(checked);
    try {
      if (checked) {
        window.localStorage.setItem(SKIP_SYNC_GUIDE_KEY, '1');
      } else {
        window.localStorage.removeItem(SKIP_SYNC_GUIDE_KEY);
      }
    } catch {
      // ignore
    }
  };

  const activeTemplateContent = React.useMemo(() => {
    if (!templates) return '正在加载模板文件...';
    if (templateTab === 'compose') return templates.dockerCompose;
    if (templateTab === 'dockerfile') return templates.dockerfile;
    return templates.envExample;
  }, [templates, templateTab]);

  const handleCopyTemplate = () => {
    if (!templates) return;
    void navigator.clipboard.writeText(activeTemplateContent);
    setCopiedTemplate(true);
    window.setTimeout(() => setCopiedTemplate(false), 1500);
  };

  const handleExportBundle = async () => {
    setExporting(true);
    setExportNotice(null);
    try {
      const res = await window.xiziterm.sync.exportDeployBundle();
      if (!res.ok) {
        setExportNotice(`导出失败: ${res.error}`);
        return;
      }
      if (res.data) {
        setExportNotice(
          `已导出完整部署包（${res.data.fileCount} 个文件）至: ${res.data.targetDir}`
        );
      }
    } finally {
      setExporting(false);
    }
  };

  const handlePickSavedHost = (hostId: string) => {
    const found = hosts.find((h) => h.id === hostId);
    if (!found) return;
    setVpsHost(found.hostname);
    setSshPort(String(found.port));
    setSshUser(found.username);
    if (found.authType === 'password' && found.password) {
      setSshPass(found.password);
    }
  };

  const handleOneClickDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!riskAccepted || deploying) return;

    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);
    setLogs([]);

    try {
      const res = await window.xiziterm.sync.oneClickDeploy({
        host: vpsHost.trim(),
        sshPort: Number(sshPort) || 22,
        username: sshUser.trim(),
        password: sshPass,
        syncPort: Number(syncPort) || 8787,
        remoteDir: remoteDir.trim() || '~/xiziterm-sync',
        inviteCode: inviteCode.trim() || undefined,
      });

      if (!res.ok || !res.data) {
        setDeployError(res.error ?? '一键部署失败');
        return;
      }

      setDeployResult(res.data);
      // Clear password from UI state immediately after deployment finishes
      setSshPass('');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="云端加密同步 — 方案选择与搭建引导"
      description="支持免服务器 WebDAV 网盘同步，以及自托管 Linux VPS 同步服务（所有数据均在本地 AES-256-GCM 零知识加密）"
      className="max-w-3xl"
    >
      <div className="space-y-4">
        {/* Prerequisites Notice */}
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3.5 text-xs leading-relaxed text-slate-300">
          <div className="flex items-center gap-2 font-semibold text-cyan-300">
            <Server className="h-4 w-4 shrink-0" />
            <span>同步架构与前置须知</span>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-slate-300/90">
            <li>
              <strong>没有自己的服务器？</strong> 直接选择{' '}
              <strong className="text-emerald-300">WebDAV 网盘同步</strong>
              （支持坚果云、群晖/飞牛 NAS、Nextcloud、Alist 等），免运维、零门槛。
            </li>
            <li>
              <strong>希望完全私有自建？</strong> 需自备一台{' '}
              <strong>Linux VPS / 内网服务器</strong>（具备{' '}
              <code className="rounded bg-slate-900 px-1 py-0.5 text-cyan-300">
                Docker
              </code>{' '}
              与{' '}
              <code className="rounded bg-slate-900 px-1 py-0.5 text-cyan-300">
                Docker Compose
              </code>
              ，有一定 Linux 基础），可手动部署或使用 SSH 一键部署。
            </li>
            <li>
              <strong>端到端零知识加密</strong>：无论使用 WebDAV 还是自建 VPS，所有密码与私钥均在本地由主密码派生密钥加密后再上传，云端仅存密文。
            </li>
          </ul>
        </div>

        {/* 3-Choice Mode Selector */}
        <div className="grid grid-cols-3 gap-2.5">
          <button
            type="button"
            onClick={() => setMode('webdav')}
            className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
              mode === 'webdav'
                ? 'border-emerald-500/70 bg-emerald-500/10 shadow-sm shadow-emerald-500/10'
                : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
            }`}
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                WebDAV 网盘
              </span>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                免服务器
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              无需购买 VPS 和配置 Docker，支持坚果云、NAS、Nextcloud、Alist，1 分钟即可开通。
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode('manual')}
            className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
              mode === 'manual'
                ? 'border-cyan-500/70 bg-cyan-500/10 shadow-sm shadow-cyan-500/10'
                : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
            }`}
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                <BookOpen className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                手动自建 VPS
              </span>
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
                自主可控
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              适合有 Linux 基础的用户。附上完整 Docker 文件与命令，自行部署零密码暴露。
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode('auto')}
            className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
              mode === 'auto'
                ? 'border-amber-500/70 bg-amber-500/10 shadow-sm shadow-amber-500/10'
                : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
            }`}
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                <Rocket className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                SSH 一键部署
              </span>
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                注意风险
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              有 VPS 但不熟命令行？提供 SSH 账号密码，自动安装 Docker、避开占用端口并测试连通。
            </p>
          </button>
        </div>

        {/* === MODE 0: WEBDAV SERVERLESS GUIDE === */}
        {mode === 'webdav' ? (
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs">
            <div className="font-semibold text-slate-100">
              WebDAV 免服务器同步配置步骤（以国内直连最快的「坚果云」为例）
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-[11px] leading-relaxed text-slate-300">
              <li>
                登录坚果云网页版 → 点击右上角账户名进入<strong>「账户信息」</strong> → 切换至<strong>「安全选项」</strong>。
              </li>
              <li>
                在底部<strong>「第三方应用管理」</strong>中点击「添加应用」，名称填写 <code className="rounded bg-slate-900 px-1 text-cyan-300">XiZiTerm</code>，点击生成并复制<strong>应用专用密码</strong>。
              </li>
              <li>
                点击下方按钮进入同步设置，选择「坚果云」预设，填入你的坚果云邮箱账号与刚刚生成的<strong>应用密码</strong>即可（同步目录 <code className="rounded bg-slate-900 px-1 text-cyan-300">/XiZiTerm</code> 会通过 WebDAV 自动创建）。
              </li>
            </ol>
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-[11px] text-slate-400">
              同样支持：<strong>Alist / OpenList</strong>（可间接挂载阿里云盘、夸克、百度网盘、OneDrive）、<strong>群晖 / 飞牛 NAS</strong> WebDAV 套件、以及 <strong>Nextcloud / OwnCloud</strong>。
            </div>
            <div className="flex justify-end pt-1">
              <Button
                type="button"
                onClick={() => onProceedToSyncConfig({ provider: 'webdav' })}
              >
                去配置 WebDAV 账号并开启同步
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : mode === 'manual' ? (
          <div className="space-y-4">
            {/* Step-by-step commands */}
            <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-100">
                  手动部署完整步骤（Ubuntu / Debian 示例）
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={exporting}
                  onClick={() => void handleExportBundle()}
                >
                  {exporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5 text-cyan-400" />
                  )}
                  一键导出完整 Docker 部署包到本地
                </Button>
              </div>

              {exportNotice && (
                <div className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 font-mono text-[11px] text-emerald-300">
                  {exportNotice}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="font-medium text-slate-300">
                  第 1 步：在 VPS 上安装 Docker 与 Docker Compose v2（已有可跳过）
                </div>
                <CopyableCommand command="sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 && sudo systemctl enable --now docker" />
              </div>

              <div className="space-y-1.5">
                <div className="font-medium text-slate-300">
                  第 2 步：将导出的 <code className="text-cyan-300">xiziterm-sync-deploy</code> 文件夹上传至 VPS（可用本软件内置 SFTP 或 scp）并修改端口配置
                </div>
                <CopyableCommand
                  command={
                    'cd ~/xiziterm-sync-deploy\n# 如 8787 端口已被占用，可在 .env 中修改 XIZITERM_PORT\ncp -n apps/server/.env.example .env && nano .env'
                  }
                />
              </div>

              <div className="space-y-1.5">
                <div className="font-medium text-slate-300">
                  第 3 步：一键构建并后台启动同步服务端
                </div>
                <CopyableCommand command="sudo docker compose up -d --build" />
              </div>

              <div className="space-y-1.5">
                <div className="font-medium text-slate-300">
                  第 4 步：验证健康检查并确认安全组/防火墙已放行对应端口（默认 TCP 8787）
                </div>
                <CopyableCommand command="curl http://127.0.0.1:8787/api/health" />
              </div>

              <div className="space-y-1.5">
                <div className="font-medium text-slate-300">
                  第 5 步（安全加固）：在客户端注册完个人账号后，关闭公开注册
                </div>
                <CopyableCommand
                  command={
                    "sed -i 's/ALLOW_REGISTRATION=true/ALLOW_REGISTRATION=false/' .env && sudo docker compose up -d"
                  }
                />
              </div>
            </div>

            {/* Attached Docker Config Files Viewer */}
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#080c15]">
              <div className="flex items-center justify-between border-b border-slate-800 bg-[#0d1322] px-3 py-2">
                <div className="flex items-center gap-1">
                  <FileCode2 className="mr-1.5 h-3.5 w-3.5 text-cyan-400" />
                  {(
                    [
                      { id: 'compose', label: 'docker-compose.yml' },
                      { id: 'dockerfile', label: 'Dockerfile' },
                      { id: 'env', label: '.env.example' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTemplateTab(item.id)}
                      className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                        templateTab === item.id
                          ? 'bg-cyan-500/20 text-cyan-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleCopyTemplate}
                  className="h-6 px-2 text-[11px]"
                >
                  {copiedTemplate ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedTemplate ? '已复制' : '复制文件'}
                </Button>
              </div>
              <pre className="max-h-52 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {activeTemplateContent}
              </pre>
            </div>
          </div>
        ) : (
          /* === MODE 2: AUTO ONE-CLICK SSH DEPLOY === */
          <div className="space-y-4">
            {/* Explicit Privacy & Security Risk Warning */}
            <div className="rounded-xl border border-amber-500/45 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-100">
              <div className="flex items-center gap-2 font-semibold text-amber-300">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>隐私与安全风险告知（请务必阅读）</span>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-amber-100/90">
                <li>
                  <strong>凭据使用范围</strong>：你输入的 VPS SSH 用户名与密码仅在<strong>本机客户端内存</strong>中用于直连你的服务器，绝不会上传至任何第三方；部署结束后密码会立即从界面清空。
                </li>
                <li>
                  <strong>高权限操作风险</strong>：一键脚本会以 <code className="rounded bg-black/30 px-1">sudo</code> 权限在你的 VPS 上安装 Docker 软件包并启动容器（系统会先检测目标端口是否已被占用，若冲突会自动中止，避免影响原有业务）。
                </li>
                <li>
                  <strong>隐私泄露防范建议</strong>：通过密码自动化登录高权限主机本身存在本地内存残留或误配置风险。<strong>强烈建议部署成功后立即修改 VPS 登录密码或改用 SSH 私钥认证</strong>；若你追求最高安全隔离，请切回「方案一：手动自建部署」。
                </li>
              </ul>

              <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-amber-500/30 bg-black/25 px-3 py-2 text-xs font-medium text-amber-200">
                <input
                  type="checkbox"
                  checked={riskAccepted}
                  onChange={(e) => setRiskAccepted(e.target.checked)}
                  className="h-4 w-4 accent-amber-400"
                />
                <span>
                  我已充分了解上述隐私与安全风险，确认该 VPS 归本人所有，自愿授权本机执行自动一键部署
                </span>
              </label>
            </div>

            {/* Deployment Form */}
            <form
              onSubmit={(e) => void handleOneClickDeploy(e)}
              className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4"
            >
              {hosts.length > 0 && (
                <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5 text-xs">
                  <span className="text-slate-400">
                    快捷填充（可选，从已保存主机读取）：
                  </span>
                  <select
                    defaultValue=""
                    onChange={(e) => handlePickSavedHost(e.target.value)}
                    disabled={deploying}
                    className="h-7 max-w-[260px] rounded border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200 outline-none focus:border-cyan-500"
                  >
                    <option value="">-- 选择已有 SSH 主机 --</option>
                    {hosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} ({h.username}@{h.hostname})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-6 space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    VPS IP / 域名 *
                  </label>
                  <Input
                    value={vpsHost}
                    onChange={(e) => setVpsHost(e.target.value)}
                    placeholder="例如: 203.0.113.10"
                    className="font-mono text-xs"
                    required
                    disabled={deploying}
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    SSH 端口
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    className="font-mono text-xs"
                    required
                    disabled={deploying}
                  />
                </div>
                <div className="col-span-4 space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    同步服务端口 *
                  </label>
                  <Input
                    type="number"
                    min={1024}
                    max={65535}
                    value={syncPort}
                    onChange={(e) => setSyncPort(e.target.value)}
                    placeholder="8787"
                    className="font-mono text-xs"
                    required
                    disabled={deploying}
                  />
                </div>
              </div>

              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-4 space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    SSH 用户名 *
                  </label>
                  <Input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root / ubuntu"
                    className="font-mono text-xs"
                    required
                    disabled={deploying}
                  />
                </div>
                <div className="col-span-8 space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    SSH 登录密码（需具备 sudo 权限）*
                  </label>
                  <div className="relative">
                    <Input
                      type={showPass ? 'text' : 'password'}
                      value={sshPass}
                      onChange={(e) => setSshPass(e.target.value)}
                      placeholder="仅本次本机部署使用，不保存"
                      className="pr-9 font-mono text-xs"
                      required
                      disabled={deploying}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                      tabIndex={-1}
                    >
                      {showPass ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    VPS 部署目录
                  </label>
                  <Input
                    value={remoteDir}
                    onChange={(e) => setRemoteDir(e.target.value)}
                    placeholder="~/xiziterm-sync"
                    className="font-mono text-xs"
                    disabled={deploying}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    可选：设置注册邀请码 (INVITE_CODE)
                  </label>
                  <Input
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="留空则不限制邀请码"
                    className="font-mono text-xs"
                    disabled={deploying}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-500">
                  部署脚本会自动检测端口占用，避免干扰 VPS 上已有服务
                </span>
                <Button
                  type="submit"
                  disabled={!riskAccepted || deploying}
                >
                  {deploying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  {deploying
                    ? '正在自动部署并检测连通性...'
                    : '开始自动一键部署并测试连通'}
                </Button>
              </div>
            </form>

            {/* Live Deployment Console */}
            {logs.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#070b14]">
                <div className="flex items-center justify-between border-b border-slate-800 bg-[#0d1322] px-3 py-1.5 text-[11px] text-slate-400">
                  <span className="flex items-center gap-1.5 font-medium text-slate-200">
                    <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                    实时部署日志
                  </span>
                  {deploying && (
                    <span className="flex items-center gap-1 text-cyan-300">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      执行中
                    </span>
                  )}
                </div>
                <div
                  ref={logContainerRef}
                  className="max-h-44 space-y-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
                >
                  {logs.map((log, i) => (
                    <div
                      key={`${log.timestamp}_${i}`}
                      className={
                        log.level === 'step'
                          ? 'font-semibold text-cyan-300'
                          : log.level === 'success'
                            ? 'text-emerald-400'
                            : log.level === 'warn'
                              ? 'text-amber-300'
                              : log.level === 'error'
                                ? 'text-rose-400'
                                : 'text-slate-400'
                      }
                    >
                      {log.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Deploy Error */}
            {deployError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{deployError}</span>
              </div>
            )}

            {/* Deploy Result Card */}
            {deployResult && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold text-emerald-300">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      {deployResult.clientReachable
                        ? '一键部署成功且本机连通测试通过！'
                        : 'VPS 内部部署成功（需放行防火墙端口）'}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      onProceedToSyncConfig({
                        prefillUrl: deployResult.serverUrl,
                        provider: 'self-hosted',
                      })
                    }
                  >
                    填入地址并立即注册绑定
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="mt-1.5 font-mono text-[11px] text-slate-200">
                  云同步地址: {deployResult.serverUrl}
                </div>
                {deployResult.warning && (
                  <p className="mt-1.5 text-[11px] text-amber-300">
                    {deployResult.warning}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer: Don't show again checkbox + Proceed */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400 hover:text-slate-200">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => handleToggleDontShow(e.target.checked)}
              className="h-4 w-4 accent-cyan-500"
            />
            <span>下次打开云同步时不再自动弹出此说明（随时可在同步弹窗中重开）</span>
          </label>

          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              稍后再说
            </Button>
            <Button
              type="button"
              onClick={() =>
                onProceedToSyncConfig({
                  prefillUrl: deployResult?.serverUrl,
                  provider: mode === 'webdav' ? 'webdav' : 'self-hosted',
                })
              }
            >
              <ShieldCheck className="h-4 w-4" />
              直接去配置连接
            </Button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
