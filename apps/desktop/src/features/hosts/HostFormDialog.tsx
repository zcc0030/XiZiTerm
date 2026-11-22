import * as React from 'react';
import { FileKey2, KeyRound, Lock } from 'lucide-react';
import type { HostAuthType, HostConfig, HostInput } from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useVaultStore } from '@/stores/vault.store';

interface HostFormDialogProps {
  open: boolean;
  editingHost: HostConfig | null;
  defaultGroupId?: string | null;
  onClose: () => void;
}

export function HostFormDialog({
  open,
  editingHost,
  defaultGroupId = null,
  onClose,
}: HostFormDialogProps) {
  const groups = useVaultStore((s) => s.groups);
  const saveHost = useVaultStore((s) => s.saveHost);

  const [name, setName] = React.useState('');
  const [groupId, setGroupId] = React.useState<string>('');
  const [hostname, setHostname] = React.useState('');
  const [port, setPort] = React.useState('22');
  const [username, setUsername] = React.useState('root');
  const [authType, setAuthType] = React.useState<HostAuthType>('password');
  const [password, setPassword] = React.useState('');
  const [privateKey, setPrivateKey] = React.useState('');
  const [passphrase, setPassphrase] = React.useState('');
  const [tagsText, setTagsText] = React.useState('');
  const [keepAliveInterval, setKeepAliveInterval] = React.useState('15');
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingHost) {
      setName(editingHost.name);
      setGroupId(editingHost.groupId ?? '');
      setHostname(editingHost.hostname);
      setPort(String(editingHost.port));
      setUsername(editingHost.username);
      setAuthType(editingHost.authType);
      setPassword(editingHost.password ?? '');
      setPrivateKey(editingHost.privateKey ?? '');
      setPassphrase(editingHost.passphrase ?? '');
      setTagsText(editingHost.tags.join(', '));
      setKeepAliveInterval(String(editingHost.keepAliveInterval));
      setNotes(editingHost.notes ?? '');
    } else {
      setName('');
      setGroupId(defaultGroupId ?? '');
      setHostname('');
      setPort('22');
      setUsername('root');
      setAuthType('password');
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      setTagsText('');
      setKeepAliveInterval('15');
      setNotes('');
    }
  }, [open, editingHost, defaultGroupId]);

  const handleImportKeyFile = async () => {
    const res = await window.xiziterm.dialog.openPrivateKeyFile();
    if (!res.ok) {
      setError(res.error ?? '读取私钥文件失败');
      return;
    }
    if (res.data) {
      setPrivateKey(res.data.content);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError('端口必须是 1-65535 之间的整数');
      return;
    }

    const input: HostInput = {
      id: editingHost?.id,
      groupId: groupId || null,
      name: name.trim() || `${username.trim()}@${hostname.trim()}`,
      hostname: hostname.trim(),
      port: parsedPort,
      username: username.trim(),
      authType,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'privateKey' ? privateKey : undefined,
      passphrase: authType === 'privateKey' ? passphrase : undefined,
      tags: tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      notes,
      keepAliveInterval: Math.max(0, Number(keepAliveInterval) || 0),
    };

    setSaving(true);
    try {
      const res = await saveHost(input);
      if (!res.ok) {
        setError(res.error ?? '保存失败');
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={editingHost ? '编辑 SSH 主机' : '新建 SSH 主机'}
      description="敏感凭据将在本地以 AES-256-GCM 独立加密后持久化存储"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">
              主机名称 / 别名 *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: Ubuntu 生产节点-01"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">所属分组</label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-slate-700/90 bg-slate-900/90 px-3 text-sm text-slate-100 focus:border-cyan-500/80 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            >
              <option value="">未分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-6 space-y-1">
            <label className="text-xs font-medium text-slate-300">
              主机地址 (IP / 域名) *
            </label>
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="192.168.1.100 或 vps.example.com"
              className="font-mono"
              required
            />
          </div>
          <div className="col-span-2 space-y-1">
            <label className="text-xs font-medium text-slate-300">端口 *</label>
            <Input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="font-mono"
              required
            />
          </div>
          <div className="col-span-4 space-y-1">
            <label className="text-xs font-medium text-slate-300">用户名 *</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root / ubuntu"
              className="font-mono"
              required
            />
          </div>
        </div>

        {/* Auth Type Switcher */}
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">认证方式</span>
            <div className="inline-flex rounded-md border border-slate-800 bg-slate-900 p-0.5">
              <button
                type="button"
                onClick={() => setAuthType('password')}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  authType === 'password'
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Lock className="h-3.5 w-3.5" />
                密码认证
              </button>
              <button
                type="button"
                onClick={() => setAuthType('privateKey')}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  authType === 'privateKey'
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <KeyRound className="h-3.5 w-3.5" />
                SSH 私钥
              </button>
            </div>
          </div>

          {authType === 'password' ? (
            <div className="space-y-1 pt-1">
              <label className="text-xs text-slate-400">登录密码</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入 SSH 密码"
                className="font-mono"
              />
            </div>
          ) : (
            <div className="space-y-2.5 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">
                  私钥内容 (PEM / OpenSSH 格式)
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleImportKeyFile}
                >
                  <FileKey2 className="h-3.5 w-3.5" />
                  从本地导入私钥文件
                </Button>
              </div>
              <Textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                className="min-h-[110px] font-mono text-xs"
              />
              <div className="space-y-1">
                <label className="text-xs text-slate-400">
                  私钥口令 Passphrase（如私钥无加密可留空）
                </label>
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="可选 Passphrase"
                  className="font-mono"
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-8 space-y-1">
            <label className="text-xs font-medium text-slate-300">
              标签（多个以逗号分隔）
            </label>
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="prod, ubuntu, docker"
            />
          </div>
          <div className="col-span-4 space-y-1">
            <label className="text-xs font-medium text-slate-300">
              KeepAlive (秒)
            </label>
            <Input
              type="number"
              min={0}
              max={600}
              value={keepAliveInterval}
              onChange={(e) => setKeepAliveInterval(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-300">备注</label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="记录服务器用途、端口转发信息或运维注意事项..."
            className="min-h-[64px]"
          />
        </div>

        {error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '加密保存中...' : editingHost ? '保存修改' : '添加主机'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
