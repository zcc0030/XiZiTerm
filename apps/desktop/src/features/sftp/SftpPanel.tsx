import * as React from 'react';
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FilePlus2,
  Folder,
  FolderPlus,
  Home,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type {
  SftpEntry,
  SftpTransferProgressEvent,
  SshConnectionState,
} from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { SftpChmodDialog } from './SftpChmodDialog';
import { SftpFileEditorDialog } from './SftpFileEditorDialog';

interface SftpPanelProps {
  sessionId: string;
  hostName: string;
  connectionState: SshConnectionState;
  isLocal?: boolean;
  onClose: () => void;
}

const TEXT_EXTENSIONS = new Set([
  'conf',
  'cfg',
  'ini',
  'yaml',
  'yml',
  'json',
  'toml',
  'sh',
  'bash',
  'zsh',
  'env',
  'txt',
  'md',
  'log',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'sql',
  'service',
  'socket',
  'timer',
  'list',
  'properties',
]);

const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'hosts',
  'fstab',
  'crontab',
  'bashrc',
  'zshrc',
  'profile',
  'authorized_keys',
  'known_hosts',
  'config',
  '.env',
  '.gitignore',
  '.bashrc',
  '.zshrc',
  'nginx.conf',
  'docker-compose.yml',
  'docker-compose.yaml',
]);

function isLikelyTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  const idx = lower.lastIndexOf('.');
  if (idx === -1) return false;
  return TEXT_EXTENSIONS.has(lower.slice(idx + 1));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function joinPosix(base: string, name: string): string {
  if (base === '/') return `/${name}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

function parentPosix(p: string): string {
  if (!p || p === '/') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

export function SftpPanel({
  sessionId,
  hostName,
  connectionState,
  isLocal = false,
  onClose,
}: SftpPanelProps) {
  // Remember cwd per SSH session so switching tabs/panes preserves directory
  const sessionCwdMapRef = React.useRef<Record<string, string>>({});

  const [cwd, setCwd] = React.useState<string>('');
  const [pathInput, setPathInput] = React.useState<string>('');
  const [editingPath, setEditingPath] = React.useState(false);
  const [entries, setEntries] = React.useState<SftpEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(true);
  const [filterText, setFilterText] = React.useState('');

  // Inline create / rename state
  const [createMode, setCreateMode] = React.useState<'folder' | 'file' | null>(
    null
  );
  const [createName, setCreateName] = React.useState('');
  const [renamingEntry, setRenamingEntry] = React.useState<SftpEntry | null>(
    null
  );
  const [renameValue, setRenameValue] = React.useState('');

  // Chmod & Editor dialogs
  const [chmodEntry, setChmodEntry] = React.useState<SftpEntry | null>(null);
  const [editorState, setEditorState] = React.useState<{
    open: boolean;
    path: string | null;
    content: string;
  }>({ open: false, path: null, content: '' });
  const [openingEditorPath, setOpeningEditorPath] = React.useState<
    string | null
  >(null);

  // Drag & drop + Transfer progress
  const [dragOver, setDragOver] = React.useState(false);
  const dragDepthRef = React.useRef(0);
  const [transfers, setTransfers] = React.useState<SftpTransferProgressEvent[]>(
    []
  );

  const loadDir = React.useCallback(
    async (targetPath?: string) => {
      if (isLocal || connectionState !== 'connected') return;
      setLoading(true);
      setError(null);
      try {
        const res = await window.xiziterm.sftp.list(sessionId, targetPath);
        if (!res.ok || !res.data) {
          setError(res.error ?? '读取远程目录失败');
          return;
        }
        setCwd(res.data.cwd);
        setPathInput(res.data.cwd);
        setEntries(res.data.entries);
        sessionCwdMapRef.current[sessionId] = res.data.cwd;
      } finally {
        setLoading(false);
      }
    },
    [connectionState, isLocal, sessionId]
  );

  // Load directory when session changes or becomes connected
  React.useEffect(() => {
    setEntries([]);
    setError(null);
    setFilterText('');
    setCreateMode(null);
    setRenamingEntry(null);
    if (isLocal) {
      setCwd('');
      setPathInput('');
      return;
    }
    if (connectionState === 'connected') {
      const remembered = sessionCwdMapRef.current[sessionId];
      void loadDir(remembered);
    }
  }, [sessionId, connectionState, isLocal, loadDir]);

  // Listen to SFTP transfer progress events
  React.useEffect(() => {
    const off = window.xiziterm.sftp.onTransferProgress((ev) => {
      if (ev.sessionId !== sessionId) return;
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.transferId === ev.transferId);
        if (idx === -1) {
          return [ev, ...prev].slice(0, 8);
        }
        const copy = [...prev];
        copy[idx] = ev;
        return copy;
      });
    });
    return off;
  }, [sessionId]);

  // Listen to native Tauri window file drag & drop events
  React.useEffect(() => {
    if (!window.xiziterm.sftp.onNativeFileDrop) return;
    if (isLocal || connectionState !== 'connected') {
      setDragOver(false);
      return;
    }

    const off = window.xiziterm.sftp.onNativeFileDrop((ev) => {
      if (ev.type === 'enter' || ev.type === 'over') {
        setDragOver(true);
      } else if (ev.type === 'leave') {
        setDragOver(false);
      } else if (ev.type === 'drop') {
        setDragOver(false);
        const paths = (ev.paths ?? []).filter(Boolean);
        if (paths.length === 0 || !cwd) return;
        setError(null);
        void window.xiziterm.sftp
          .uploadPaths(sessionId, paths, cwd)
          .then((res) => {
            if (!res.ok) {
              setError(res.error ?? '拖拽上传失败');
              return;
            }
            return loadDir(cwd);
          });
      }
    });
    return () => {
      setDragOver(false);
      off();
    };
  }, [connectionState, cwd, isLocal, loadDir, sessionId]);

  const visibleEntries = React.useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return entries.filter((item) => {
      if (!showHidden && item.name.startsWith('.')) return false;
      if (q && !item.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, showHidden, filterText]);

  const breadcrumbs = React.useMemo(() => {
    if (!cwd || cwd === '/') return [{ label: '/', path: '/' }];
    const parts = cwd.split('/').filter(Boolean);
    const items = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [cwd]);

  const handleJumpPath = (e: React.FormEvent) => {
    e.preventDefault();
    setEditingPath(false);
    const trimmed = pathInput.trim();
    if (trimmed) {
      void loadDir(trimmed);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = createName.trim();
    if (!name || !cwd || !createMode) return;
    if (name.includes('/')) {
      setError('名称不能包含斜杠 /');
      return;
    }
    const targetPath = joinPosix(cwd, name);
    const res =
      createMode === 'folder'
        ? await window.xiziterm.sftp.mkdir(sessionId, targetPath)
        : await window.xiziterm.sftp.createFile(sessionId, targetPath);

    if (!res.ok) {
      setError(res.error ?? '创建失败');
      return;
    }
    setCreateMode(null);
    setCreateName('');
    await loadDir(cwd);
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingEntry || !cwd) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName === renamingEntry.name) {
      setRenamingEntry(null);
      return;
    }
    const nextPath = joinPosix(parentPosix(renamingEntry.path), nextName);
    const res = await window.xiziterm.sftp.rename(
      sessionId,
      renamingEntry.path,
      nextPath
    );
    if (!res.ok) {
      setError(res.error ?? '重命名失败');
      return;
    }
    setRenamingEntry(null);
    await loadDir(cwd);
  };

  const handleDelete = async (entry: SftpEntry) => {
    const label = entry.isDirectory
      ? `目录「${entry.name}」及其全部子内容`
      : `文件「${entry.name}」`;
    if (!window.confirm(`确定永久删除远程${label}？此操作不可恢复。`)) {
      return;
    }
    const res = await window.xiziterm.sftp.deleteEntry(
      sessionId,
      entry.path,
      entry.isDirectory
    );
    if (!res.ok) {
      setError(res.error ?? '删除失败');
      return;
    }
    await loadDir(cwd);
  };

  const handleChmodSubmit = async (octalMode: string) => {
    if (!chmodEntry) return;
    const res = await window.xiziterm.sftp.chmod(
      sessionId,
      chmodEntry.path,
      octalMode
    );
    if (!res.ok) {
      throw new Error(res.error ?? '修改权限失败');
    }
    await loadDir(cwd);
  };

  const handleUploadPick = async () => {
    if (!cwd) return;
    setError(null);
    const res = await window.xiziterm.sftp.uploadPick(sessionId, cwd);
    if (!res.ok) {
      setError(res.error ?? '上传失败');
      return;
    }
    if (res.data && res.data.uploadedCount > 0) {
      await loadDir(cwd);
    }
  };

  const handleDownload = async (entry: SftpEntry) => {
    if (entry.isDirectory) return;
    setError(null);
    const res = await window.xiziterm.sftp.download(
      sessionId,
      entry.path,
      entry.name
    );
    if (!res.ok) {
      setError(res.error ?? '下载失败');
    }
  };

  const handleOpenTextEditor = async (entry: SftpEntry) => {
    if (entry.isDirectory) return;
    setError(null);
    setOpeningEditorPath(entry.path);
    try {
      const res = await window.xiziterm.sftp.readText(sessionId, entry.path);
      if (!res.ok || !res.data) {
        setError(res.error ?? '无法在线打开该文件');
        return;
      }
      setEditorState({
        open: true,
        path: res.data.path,
        content: res.data.content,
      });
    } finally {
      setOpeningEditorPath(null);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (connectionState === 'connected') {
      setDragOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragOver(false);

    if (connectionState !== 'connected' || !cwd) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const localPaths = files
      .map((f) => window.xiziterm.sftp.getPathForFile(f))
      .filter(Boolean);

    if (localPaths.length === 0) {
      setError('未能获取拖拽文件的本地路径');
      return;
    }

    setError(null);
    const res = await window.xiziterm.sftp.uploadPaths(
      sessionId,
      localPaths,
      cwd
    );
    if (!res.ok) {
      setError(res.error ?? '拖拽上传失败');
      return;
    }
    await loadDir(cwd);
  };

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
      className="relative flex h-full w-full flex-col overflow-hidden border-t border-theme-border bg-theme-sidebar"
    >
      {/* Top Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-theme-border bg-theme-elevated/55 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 rounded bg-theme-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-theme-accent">
            SFTP · {hostName}
          </span>

          <button
            type="button"
            onClick={() => void loadDir(parentPosix(cwd))}
            disabled={connectionState !== 'connected' || !cwd || cwd === '/'}
            title="上级目录"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary disabled:opacity-35"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void loadDir('~')}
            disabled={isLocal || connectionState !== 'connected'}
            title="主目录 (~)"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary disabled:opacity-35"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void loadDir(cwd || undefined)}
            disabled={isLocal || connectionState !== 'connected' || loading}
            title="刷新当前目录"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary disabled:opacity-35"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-theme-accent' : ''}`}
            />
          </button>

          {/* Breadcrumb / Editable Path Bar */}
          {editingPath ? (
            <form onSubmit={handleJumpPath} className="min-w-0 flex-1">
              <input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onBlur={() => setEditingPath(false)}
                placeholder="/etc/nginx"
                autoFocus
                className="h-6 w-full rounded border border-theme-accent bg-theme-input px-2 font-mono text-xs text-theme-primary outline-none"
              />
            </form>
          ) : (
            <div
              onClick={() => {
                if (!isLocal && connectionState === 'connected') {
                  setPathInput(cwd);
                  setEditingPath(true);
                }
              }}
              title="点击可直接输入目标路径跳转"
              className="flex h-6 min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto rounded border border-theme-border bg-theme-input px-2 font-mono text-xs text-theme-primary hover:border-theme-accent/55"
            >
              {cwd ? (
                breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={crumb.path}>
                    {idx > 0 && (
                      <ChevronRight className="h-3 w-3 shrink-0 text-theme-muted" />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadDir(crumb.path);
                      }}
                      className="shrink-0 rounded px-1 py-0.5 hover:bg-theme-hover hover:text-theme-accent"
                    >
                      {crumb.label}
                    </button>
                  </React.Fragment>
                ))
              ) : (
                <span className="text-theme-muted">
                  {isLocal ? '本机终端会话（不使用远程 SFTP）' : '等待连接...'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <div className="relative hidden md:block">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-theme-muted" />
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="过滤文件..."
              className="h-6 w-32 rounded border border-theme-border bg-theme-input pl-6 pr-2 text-xs text-theme-primary placeholder:text-theme-muted/75 focus:border-theme-accent focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? '隐藏点文件 (.*)' : '显示隐藏文件 (.*)'}
            className={`rounded p-1 transition-colors ${
              showHidden
                ? 'text-theme-accent hover:bg-theme-hover'
                : 'text-theme-muted hover:bg-theme-hover hover:text-theme-primary'
            }`}
          >
            {showHidden ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            disabled={connectionState !== 'connected' || !cwd}
            onClick={() => {
              setCreateMode('folder');
              setCreateName('');
            }}
            title="新建文件夹"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent disabled:opacity-35"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={connectionState !== 'connected' || !cwd}
            onClick={() => {
              setCreateMode('file');
              setCreateName('');
            }}
            title="新建空白文件"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent disabled:opacity-35"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
          </button>

          <Button
            size="sm"
            variant="secondary"
            disabled={connectionState !== 'connected' || !cwd}
            onClick={() => void handleUploadPick()}
            className="h-6 px-2 text-[11px]"
          >
            <Upload className="h-3 w-3" />
            上传
          </Button>

          <button
            type="button"
            onClick={onClose}
            title="收起 SFTP 面板"
            className="ml-1 rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Inline Create Bar */}
      {createMode && (
        <form
          onSubmit={(e) => void handleCreateSubmit(e)}
          className="flex shrink-0 items-center gap-2 border-b border-theme-accent/30 bg-theme-accent-soft px-3 py-1.5 text-xs"
        >
          <span className="font-medium text-theme-accent">
            {createMode === 'folder' ? '新建文件夹:' : '新建文件:'}
          </span>
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={
              createMode === 'folder' ? '例如: config' : '例如: app.yaml'
            }
            autoFocus
            className="h-6 w-60 rounded border border-theme-border bg-theme-input px-2 font-mono text-xs text-theme-primary outline-none focus:border-theme-accent"
          />
          <Button type="submit" size="sm" className="h-6 px-2.5 text-[11px]">
            创建
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCreateMode(null)}
            className="h-6 px-2 text-[11px]"
          >
            取消
          </Button>
        </form>
      )}

      {/* Error Bar */}
      {error && (
        <div className="flex shrink-0 items-center justify-between border-b border-theme-error/35 bg-theme-error-soft px-3 py-1.5 text-xs text-theme-error">
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-theme-error hover:opacity-75"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-theme-base">
        {isLocal ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-theme-muted">
            <Folder className="h-6 w-6 opacity-45" />
            <span>当前激活窗格为本机终端，无需远程 SFTP 传输通道</span>
            <span className="text-[11px] opacity-80">
              切换到任意远程 SSH 标签页或分屏后，此处会自动加载对应的远程文件目录
            </span>
          </div>
        ) : connectionState !== 'connected' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-theme-muted">
            <Loader2
              className={`h-5 w-5 ${
                connectionState === 'connecting'
                  ? 'animate-spin text-theme-warn'
                  : 'opacity-50'
              }`}
            />
            <span>
              {connectionState === 'connecting'
                ? '等待 SSH 会话连接就绪后自动复用 SFTP 通道...'
                : '当前 SSH 会话未连接，请先重连后再使用 SFTP'}
            </span>
          </div>
        ) : visibleEntries.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-theme-muted">
            <span>当前目录为空（或无匹配文件）</span>
            <span className="text-[11px] opacity-80">
              支持直接从本地文件夹拖拽文件/文件夹到此处上传
            </span>
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-theme-border bg-theme-sidebar text-[11px] font-medium text-theme-muted">
              <tr>
                <th className="py-1.5 pl-3 pr-2">名称</th>
                <th className="w-24 px-2 py-1.5 text-right">大小</th>
                <th className="w-36 px-2 py-1.5">权限</th>
                <th className="hidden w-36 px-2 py-1.5 sm:table-cell">
                  修改时间
                </th>
                <th className="w-36 py-1.5 pl-2 pr-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {visibleEntries.map((entry) => {
                const isRenaming = renamingEntry?.path === entry.path;
                const canQuickEdit =
                  !entry.isDirectory && isLikelyTextFile(entry.name);

                return (
                  <tr
                    key={entry.path}
                    onDoubleClick={() => {
                      if (entry.isDirectory) {
                        void loadDir(entry.path);
                      } else {
                        void handleOpenTextEditor(entry);
                      }
                    }}
                    className="group cursor-pointer transition-colors hover:bg-theme-hover"
                  >
                    <td className="max-w-[280px] py-1.5 pl-3 pr-2">
                      {isRenaming ? (
                        <form
                          onSubmit={(e) => void handleRenameSubmit(e)}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1"
                        >
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoFocus
                            onBlur={() => setRenamingEntry(null)}
                            className="h-6 w-52 rounded border border-theme-accent bg-theme-input px-1.5 font-mono text-xs text-theme-primary outline-none"
                          />
                        </form>
                      ) : (
                        <div className="flex items-center gap-2">
                          {entry.isDirectory ? (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-theme-accent" />
                          ) : canQuickEdit ? (
                            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-theme-online" />
                          ) : (
                            <File className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
                          )}
                          <span className="truncate font-mono text-theme-primary">
                            {entry.name}
                          </span>
                          {entry.isSymlink && (
                            <span title="符号链接">
                              <Link2 className="h-3 w-3 shrink-0 text-theme-accent-2" />
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    <td className="px-2 py-1.5 text-right font-mono text-[11px] text-theme-muted">
                      {entry.isDirectory ? '-' : formatSize(entry.size)}
                    </td>

                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setChmodEntry(entry);
                        }}
                        title="点击修改权限 (chmod)"
                        className="rounded px-1.5 py-0.5 font-mono text-[11px] text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
                      >
                        {entry.permissions}{' '}
                        <span className="opacity-75">
                          ({entry.octalMode})
                        </span>
                      </button>
                    </td>

                    <td className="hidden px-2 py-1.5 font-mono text-[11px] text-theme-muted sm:table-cell">
                      {formatTime(entry.modifiedAt)}
                    </td>

                    <td className="py-1.5 pl-2 pr-3 text-right">
                      <div className="inline-flex items-center gap-0.5 opacity-75 group-hover:opacity-100">
                        {!entry.isDirectory && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleOpenTextEditor(entry);
                            }}
                            title="在线查看 / 编辑文本"
                            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-online"
                          >
                            {openingEditorPath === entry.path ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-accent" />
                            ) : (
                              <FileCode2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        {!entry.isDirectory && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDownload(entry);
                            }}
                            title="下载到本地"
                            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingEntry(entry);
                            setRenameValue(entry.name);
                          }}
                          title="重命名"
                          className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setChmodEntry(entry);
                          }}
                          title="修改权限 (chmod)"
                          className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-warn"
                        >
                          <Shield className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(entry);
                          }}
                          title="删除"
                          className="rounded p-1 text-theme-muted hover:bg-theme-error-soft hover:text-theme-error"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Transfer Progress Bar Tray */}
      {transfers.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-theme-border bg-theme-elevated/55 px-3 py-1.5 text-[11px]">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
            {transfers.slice(0, 3).map((t) => {
              const pct =
                t.total > 0
                  ? Math.min(100, Math.round((t.transferred / t.total) * 100))
                  : t.status === 'completed'
                    ? 100
                    : 0;
              return (
                <div
                  key={t.transferId}
                  className="flex shrink-0 items-center gap-2 rounded border border-theme-border bg-theme-input px-2 py-0.5"
                >
                  {t.status === 'completed' ? (
                    <CheckCircle2 className="h-3 w-3 text-theme-online" />
                  ) : t.status === 'error' ? (
                    <XCircle className="h-3 w-3 text-theme-error" />
                  ) : (
                    <Loader2 className="h-3 w-3 animate-spin text-theme-accent" />
                  )}
                  <span className="max-w-[140px] truncate font-mono text-theme-primary">
                    {t.direction === 'upload' ? '↑' : '↓'} {t.fileName}
                  </span>
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-theme-border">
                    <div
                      className={`h-full transition-all ${
                        t.status === 'error'
                          ? 'bg-theme-error'
                          : t.status === 'completed'
                            ? 'bg-theme-online'
                            : 'bg-theme-accent'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-theme-muted">
                    {t.status === 'error' ? '失败' : `${pct}%`}
                  </span>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setTransfers([])}
            className="shrink-0 text-[10px] text-theme-muted hover:text-theme-primary"
          >
            清除记录
          </button>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-theme-accent bg-theme-sidebar/90 backdrop-blur-[2px]">
          <Upload className="h-8 w-8 text-theme-accent" />
          <div className="text-sm font-semibold text-theme-primary">
            释放鼠标以上传文件 / 文件夹
          </div>
          <div className="font-mono text-xs text-theme-accent">
            目标路径: {cwd || '~'}
          </div>
        </div>
      )}

      {/* Chmod Dialog */}
      <SftpChmodDialog
        open={chmodEntry !== null}
        entry={chmodEntry}
        onClose={() => setChmodEntry(null)}
        onSubmit={handleChmodSubmit}
      />

      {/* Online Text Editor Dialog */}
      <SftpFileEditorDialog
        open={editorState.open}
        sessionId={sessionId}
        filePath={editorState.path}
        initialContent={editorState.content}
        onClose={() => setEditorState({ open: false, path: null, content: '' })}
        onSaved={() => void loadDir(cwd)}
      />
    </div>
  );
}
