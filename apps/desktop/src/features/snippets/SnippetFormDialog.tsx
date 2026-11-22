import * as React from 'react';
import type { Snippet, SnippetInput } from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useVaultStore } from '@/stores/vault.store';

interface SnippetFormDialogProps {
  open: boolean;
  editingSnippet: Snippet | null;
  defaultCategory?: string;
  onClose: () => void;
}

const SUGGESTED_CATEGORIES = [
  '系统排查',
  'Docker',
  'Nginx',
  '网络诊断',
  '数据库',
  '部署脚本',
];

export function SnippetFormDialog({
  open,
  editingSnippet,
  defaultCategory = '系统排查',
  onClose,
}: SnippetFormDialogProps) {
  const snippets = useVaultStore((s) => s.snippets);
  const saveSnippet = useVaultStore((s) => s.saveSnippet);

  const [title, setTitle] = React.useState('');
  const [category, setCategory] = React.useState(defaultCategory);
  const [tagsText, setTagsText] = React.useState('');
  const [command, setCommand] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const existingCategories = React.useMemo(() => {
    const set = new Set<string>(SUGGESTED_CATEGORIES);
    for (const s of snippets) {
      if (s.category) set.add(s.category);
    }
    return Array.from(set);
  }, [snippets]);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingSnippet) {
      setTitle(editingSnippet.title);
      setCategory(editingSnippet.category);
      setTagsText(editingSnippet.tags.join(', '));
      setCommand(editingSnippet.command);
      setDescription(editingSnippet.description);
    } else {
      setTitle('');
      setCategory(defaultCategory || '系统排查');
      setTagsText('');
      setCommand('');
      setDescription('');
    }
  }, [open, editingSnippet, defaultCategory]);

  const handleCommandKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = `${command.slice(0, start)}  ${command.slice(end)}`;
      setCommand(next);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const input: SnippetInput = {
      id: editingSnippet?.id,
      title: title.trim(),
      category: category.trim() || '常用命令',
      command,
      tags: tagsText
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      description: description.trim(),
    };

    if (!input.title) {
      setError('请输入快捷命令标题');
      return;
    }
    if (!input.command.trim()) {
      setError('请输入命令或脚本内容');
      return;
    }

    setSaving(true);
    try {
      const res = await saveSnippet(input);
      if (!res.ok) {
        setError(res.error ?? '保存失败');
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const lineCount = command ? command.split('\n').length : 0;

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={editingSnippet ? '编辑快捷命令 (Snippet)' : '新建快捷命令 (Snippet)'}
      description="支持单行命令与多行 Shell 脚本，数据加密保存并纳入 Phase 5 云同步"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-7 space-y-1">
            <label className="text-xs font-medium text-slate-300">
              标题 *
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如: 查看端口监听 / 重载 Nginx"
              required
              autoFocus
            />
          </div>
          <div className="col-span-5 space-y-1">
            <label className="text-xs font-medium text-slate-300">分类</label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="例如: Docker"
            />
          </div>
        </div>

        {/* Category Quick Picks */}
        <div className="flex flex-wrap gap-1.5">
          {existingCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                category === cat
                  ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                  : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-slate-300">
              命令 / 多行脚本 *
            </label>
            <span className="font-mono text-[10px] text-slate-500">
              {lineCount} 行 · 支持 Tab 缩进
            </span>
          </div>
          <Textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleCommandKeyDown}
            placeholder={'#!/usr/bin/env bash\ndocker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"'}
            spellCheck={false}
            className="min-h-[140px] font-mono text-xs leading-relaxed"
            required
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-300">
            标签（多个以逗号分隔）
          </label>
          <Input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="network, port, linux"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-300">
            说明备注（可选）
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简述命令用途或注意事项"
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
            {saving ? '保存中...' : editingSnippet ? '保存修改' : '添加命令'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
