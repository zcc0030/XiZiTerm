import * as React from 'react';
import type { SftpEntry } from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SftpChmodDialogProps {
  open: boolean;
  entry: SftpEntry | null;
  onClose: () => void;
  onSubmit: (octalMode: string) => Promise<void>;
}

const PRESETS = [
  { mode: '644', label: '644 (普通文件)' },
  { mode: '755', label: '755 (可执行/目录)' },
  { mode: '600', label: '600 (私钥/机密)' },
  { mode: '700', label: '700 (私有目录)' },
];

const ROLES = [
  { label: '所有者 (Owner)', shift: 6 },
  { label: '用户组 (Group)', shift: 3 },
  { label: '其他人 (Other)', shift: 0 },
] as const;

const BITS = [
  { label: '读 (R)', mask: 4 },
  { label: '写 (W)', mask: 2 },
  { label: '执行 (X)', mask: 1 },
] as const;

export function SftpChmodDialog({
  open,
  entry,
  onClose,
  onSubmit,
}: SftpChmodDialogProps) {
  const [octal, setOctal] = React.useState('644');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open && entry) {
      setOctal(entry.octalMode || '644');
      setError(null);
    }
  }, [open, entry]);

  const numericMode = /^[0-7]{3,4}$/.test(octal.trim())
    ? parseInt(octal.trim(), 8) & 0o777
    : 0;

  const toggleBit = (shift: number, mask: number) => {
    const bit = mask << shift;
    const next = numericMode ^ bit;
    setOctal(next.toString(8).padStart(3, '0'));
    setError(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = octal.trim();
    if (!/^[0-7]{3,4}$/.test(cleaned)) {
      setError('请输入有效的 3~4 位八进制权限（例如 755 或 0644）');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(cleaned);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改权限失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="修改文件权限 (chmod)"
      description={entry ? entry.path : undefined}
      className="max-w-md"
    >
      <form onSubmit={handleSave} className="space-y-4">
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="grid grid-cols-4 gap-2 border-b border-slate-800 pb-2 text-[11px] font-medium text-slate-400">
            <span>权限组</span>
            <span className="text-center">读 (4)</span>
            <span className="text-center">写 (2)</span>
            <span className="text-center">执行 (1)</span>
          </div>
          <div className="mt-2 space-y-2">
            {ROLES.map((role) => (
              <div
                key={role.label}
                className="grid grid-cols-4 items-center gap-2 text-xs text-slate-200"
              >
                <span className="text-slate-300">{role.label}</span>
                {BITS.map((b) => {
                  const checked = ((numericMode >> role.shift) & b.mask) !== 0;
                  return (
                    <label
                      key={b.label}
                      className="flex cursor-pointer items-center justify-center"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBit(role.shift, b.mask)}
                        className="h-4 w-4 accent-cyan-500"
                      />
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-300">
            八进制权限值
          </label>
          <Input
            value={octal}
            onChange={(e) => setOctal(e.target.value)}
            placeholder="755"
            className="font-mono"
            maxLength={4}
          />
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.mode}
                type="button"
                onClick={() => setOctal(p.mode)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  octal === p.mode
                    ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
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
            {saving ? '应用中...' : '应用权限'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
