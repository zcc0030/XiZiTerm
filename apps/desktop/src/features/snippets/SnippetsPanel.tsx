import * as React from 'react';
import {
  Check,
  Code2,
  Copy,
  CornerDownRight,
  Pencil,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Snippet,
  SnippetInput,
  SshConnectionState,
} from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useVaultStore } from '@/stores/vault.store';
import { SnippetFormDialog } from './SnippetFormDialog';

interface SnippetsPanelProps {
  sessionId: string;
  hostName: string;
  connectionState: SshConnectionState;
  onClose: () => void;
}

const STARTER_SNIPPETS: SnippetInput[] = [
  {
    title: '查看监听端口与进程',
    category: '网络诊断',
    tags: ['port', 'ss', 'network'],
    description: '列出所有 TCP/UDP 监听端口及对应进程',
    command: 'ss -tulpn',
  },
  {
    title: '当前目录磁盘占用 Top 10',
    category: '系统排查',
    tags: ['disk', 'du'],
    description: '按体积从大到小排查当前目录下最大的 10 个文件/文件夹',
    command: 'du -sh * 2>/dev/null | sort -rh | head -n 10',
  },
  {
    title: 'Docker 容器运行状态',
    category: 'Docker',
    tags: ['docker', 'containers'],
    description: '格式化展示所有容器名称、运行状态与映射端口',
    command:
      'docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
  },
  {
    title: '系统实时巡检脚本',
    category: '系统排查',
    tags: ['health', 'script'],
    description: '多行脚本示例：一次性输出主机名、负载、内存与根分区占用',
    command: [
      'echo "=== Host: $(hostname) ($(uptime -p)) ==="',
      'free -h',
      'df -h /',
    ].join('\n'),
  },
  {
    title: '测试并平滑重载 Nginx',
    category: 'Nginx',
    tags: ['nginx', 'reload'],
    description: '先校验配置文件语法无误后再 reload',
    command: 'sudo nginx -t && sudo systemctl reload nginx',
  },
];

export function SnippetsPanel({
  sessionId,
  hostName,
  connectionState,
  onClose,
}: SnippetsPanelProps) {
  const snippets = useVaultStore((s) => s.snippets);
  const saveSnippet = useVaultStore((s) => s.saveSnippet);
  const deleteSnippet = useVaultStore((s) => s.deleteSnippet);

  const [search, setSearch] = React.useState('');
  const [selectedCategory, setSelectedCategory] = React.useState<string>('ALL');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingSnippet, setEditingSnippet] = React.useState<Snippet | null>(
    null
  );
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [seeding, setSeeding] = React.useState(false);

  const categories = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const item of snippets) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [snippets]);

  const filteredSnippets = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return snippets.filter((s) => {
      if (selectedCategory !== 'ALL' && s.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [snippets, selectedCategory, search]);

  const showToast = (msg: string) => {
    setFeedback(msg);
    window.setTimeout(() => {
      setFeedback((cur) => (cur === msg ? null : cur));
    }, 1800);
  };

  const handleSendToTerminal = (snippet: Snippet, execute: boolean) => {
    if (connectionState !== 'connected') {
      showToast('当前终端未连接，无法发送命令');
      return;
    }

    const normalized = snippet.command.replace(/\r\n/g, '\n');
    const payload = execute
      ? `${normalized.replace(/\n+$/, '')}\r`
      : normalized.replace(/\n+$/, '');

    window.xiziterm.ssh.write(sessionId, payload);
    showToast(
      execute
        ? `已执行「${snippet.title}」→ ${hostName}`
        : `已输入「${snippet.title}」→ ${hostName}（未回车）`
    );
  };

  const handleCopy = (snippet: Snippet) => {
    void navigator.clipboard.writeText(snippet.command);
    setCopiedId(snippet.id);
    window.setTimeout(() => {
      setCopiedId((cur) => (cur === snippet.id ? null : cur));
    }, 1500);
  };

  const handleDelete = async (snippet: Snippet) => {
    if (!window.confirm(`确定删除快捷命令「${snippet.title}」？`)) return;
    await deleteSnippet(snippet.id);
  };

  const handleImportStarters = async () => {
    setSeeding(true);
    try {
      for (const item of STARTER_SNIPPETS) {
        await saveSnippet(item);
      }
      showToast('已导入 5 条常用运维模板');
    } finally {
      setSeeding(false);
    }
  };

  const canSend = connectionState === 'connected';

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-theme-border bg-theme-sidebar">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-theme-border bg-theme-elevated/55 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Code2 className="h-3.5 w-3.5 shrink-0 text-theme-accent" />
          <span className="truncate text-xs font-semibold text-theme-primary">
            快捷命令 (Snippets)
          </span>
          <span className="rounded bg-theme-elevated px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
            {snippets.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            onClick={() => {
              setEditingSnippet(null);
              setFormOpen(true);
            }}
            className="h-6 px-2 text-[11px]"
          >
            <Plus className="h-3 w-3" />
            新建
          </Button>
          <button
            type="button"
            onClick={onClose}
            title="收起快捷命令面板"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Search & Category Filter */}
      <div className="space-y-2 border-b border-theme-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题、命令内容或标签..."
            className="h-7 w-full rounded-md border border-theme-border bg-theme-input pl-8 pr-2.5 text-xs text-theme-primary placeholder:text-theme-muted/75 focus:border-theme-accent focus:outline-none"
          />
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                selectedCategory === 'ALL'
                  ? 'bg-theme-accent-soft text-theme-accent'
                  : 'bg-theme-elevated text-theme-muted hover:text-theme-primary'
              }`}
            >
              全部 ({snippets.length})
            </button>
            {categories.map(([cat, count]) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  selectedCategory === cat
                    ? 'bg-theme-accent-soft text-theme-accent'
                    : 'bg-theme-elevated text-theme-muted hover:text-theme-primary'
                }`}
              >
                {cat} ({count})
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Send Feedback Banner */}
      {feedback && (
        <div className="shrink-0 border-b border-theme-online/35 bg-theme-online-soft px-3 py-1.5 text-[11px] text-theme-online">
          {feedback}
        </div>
      )}

      {/* Snippets List */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {snippets.length === 0 ? (
          <div className="mt-8 flex flex-col items-center px-3 text-center">
            <Code2 className="mb-2 h-8 w-8 text-theme-muted opacity-50" />
            <p className="text-xs font-medium text-theme-primary">
              还没有保存任何快捷命令
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-theme-muted">
              把常用 Linux 巡检、Docker、Nginx 命令存成 Snippet，支持一键输入或直接执行。
            </p>
            <div className="mt-4 flex w-full flex-col gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setEditingSnippet(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                新建第一条命令
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={seeding}
                onClick={() => void handleImportStarters()}
              >
                <Sparkles className="h-3.5 w-3.5 text-theme-warn" />
                {seeding ? '导入中...' : '导入 5 条常用运维模板'}
              </Button>
            </div>
          </div>
        ) : filteredSnippets.length === 0 ? (
          <div className="mt-8 text-center text-xs text-theme-muted">
            没有找到匹配的快捷命令
          </div>
        ) : (
          filteredSnippets.map((snippet) => {
            const lines = snippet.command.split('\n');
            const isMultiLine = lines.length > 1;
            return (
              <div
                key={snippet.id}
                className="group rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5 transition-colors hover:border-theme-accent/45"
              >
                {/* Card Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-theme-primary">
                        {snippet.title}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge variant="default" className="text-[9px]">
                        {snippet.category}
                      </Badge>
                      {isMultiLine && (
                        <Badge variant="amber" className="text-[9px]">
                          {lines.length} 行脚本
                        </Badge>
                      )}
                      {snippet.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="cyan" className="text-[9px]">
                          #{tag}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Card Mini Actions */}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-65 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => handleCopy(snippet)}
                      title="复制命令"
                      className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
                    >
                      {copiedId === snippet.id ? (
                        <Check className="h-3 w-3 text-theme-online" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSnippet(snippet);
                        setFormOpen(true);
                      }}
                      title="编辑"
                      className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(snippet)}
                      title="删除"
                      className="rounded p-1 text-theme-muted hover:bg-theme-error-soft hover:text-theme-error"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {snippet.description && (
                  <p className="mt-1.5 text-[11px] text-theme-muted">
                    {snippet.description}
                  </p>
                )}

                {/* Command Preview */}
                <pre className="mt-2 max-h-24 overflow-x-auto overflow-y-auto rounded border border-theme-border bg-theme-input px-2 py-1.5 font-mono text-[11px] leading-relaxed text-theme-accent">
                  {snippet.command}
                </pre>

                {/* Two 1-Click Send Options */}
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => handleSendToTerminal(snippet, false)}
                    title={
                      canSend
                        ? `仅输入到 ${hostName}（不按回车，方便继续修改参数）`
                        : '当前终端未连接'
                    }
                    className="flex flex-1 items-center justify-center gap-1 rounded border border-theme-border bg-theme-elevated px-2 py-1 text-[11px] font-medium text-theme-primary transition-colors hover:border-theme-accent/55 hover:text-theme-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <CornerDownRight className="h-3 w-3 text-theme-accent" />
                    仅输入不回车
                  </button>
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => handleSendToTerminal(snippet, true)}
                    title={
                      canSend
                        ? `输入并立即在 ${hostName} 执行`
                        : '当前终端未连接'
                    }
                    className="flex flex-1 items-center justify-center gap-1 rounded border border-theme-online/45 bg-theme-online-soft px-2 py-1 text-[11px] font-medium text-theme-online transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Play className="h-3 w-3" />
                    输入并执行
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Target Footer Hint */}
      <div className="shrink-0 border-t border-theme-border bg-theme-elevated/55 px-3 py-1.5 text-[10px] text-theme-muted">
        当前目标终端：
        <span className="ml-1 font-mono text-theme-primary">{hostName}</span>
        {!canSend && (
          <span className="ml-1.5 text-theme-warn">(未连接)</span>
        )}
      </div>

      <SnippetFormDialog
        open={formOpen}
        editingSnippet={editingSnippet}
        defaultCategory={
          selectedCategory !== 'ALL' ? selectedCategory : '系统排查'
        }
        onClose={() => setFormOpen(false)}
      />
    </aside>
  );
}
