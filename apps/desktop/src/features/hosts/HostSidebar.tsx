import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  Columns2,
  Folder,
  FolderPlus,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { HostConfig, HostGroup } from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useVaultStore } from '@/stores/vault.store';
import { useTerminalStore } from '@/stores/terminal.store';

interface HostSidebarProps {
  collapsed: boolean;
  width: number;
  onToggleCollapse: () => void;
  onAddHost: (defaultGroupId?: string | null) => void;
  onEditHost: (host: HostConfig) => void;
  onOpenSettings: () => void;
  onOpenSyncSettings: () => void;
}

const GROUP_COLORS = [
  '#06b6d4',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#3b82f6',
];

export function HostSidebar({
  collapsed,
  width,
  onToggleCollapse,
  onAddHost,
  onEditHost,
  onOpenSettings,
  onOpenSyncSettings,
}: HostSidebarProps) {
  const groups = useVaultStore((s) => s.groups);
  const hosts = useVaultStore((s) => s.hosts);
  const syncStatus = useVaultStore((s) => s.syncStatus);
  const loadSyncStatus = useVaultStore((s) => s.loadSyncStatus);
  const refreshData = useVaultStore((s) => s.refreshData);
  const selectedGroupId = useVaultStore((s) => s.selectedGroupId);
  const searchQuery = useVaultStore((s) => s.searchQuery);
  const setSelectedGroupId = useVaultStore((s) => s.setSelectedGroupId);
  const setSearchQuery = useVaultStore((s) => s.setSearchQuery);
  const saveGroup = useVaultStore((s) => s.saveGroup);
  const deleteGroup = useVaultStore((s) => s.deleteGroup);
  const deleteHost = useVaultStore((s) => s.deleteHost);
  const lockVault = useVaultStore((s) => s.lockVault);

  const openHostTab = useTerminalStore((s) => s.openHostTab);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const tabs = useTerminalStore((s) => s.tabs);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const resetAllTabs = useTerminalStore((s) => s.resetAll);

  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState('');
  const [renamingGroup, setRenamingGroup] = React.useState<HostGroup | null>(null);
  const [renameText, setRenameText] = React.useState('');

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  const filteredHosts = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return hosts.filter((h) => {
      if (selectedGroupId === 'UNGROUPED' && h.groupId !== null) return false;
      if (
        selectedGroupId !== 'ALL' &&
        selectedGroupId !== 'UNGROUPED' &&
        h.groupId !== selectedGroupId
      ) {
        return false;
      }
      if (!q) return true;
      return (
        h.name.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q) ||
        h.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [hosts, selectedGroupId, searchQuery]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
    const res = await saveGroup({
      name: trimmed,
      parentId: null,
      color,
    });
    if (res.ok && res.data) {
      setSelectedGroupId(res.data.id);
      setNewGroupName('');
      setCreatingGroup(false);
    }
  };

  const handleRenameGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingGroup || !renameText.trim()) return;
    const res = await saveGroup({
      id: renamingGroup.id,
      name: renameText.trim(),
      parentId: renamingGroup.parentId,
      color: renamingGroup.color,
      sortOrder: renamingGroup.sortOrder,
    });
    if (res.ok) {
      setRenamingGroup(null);
      setRenameText('');
    }
  };

  const handleDeleteGroup = async (group: HostGroup) => {
    if (!window.confirm(`确定删除分组「${group.name}」？该分组下的主机将移至未分组。`)) {
      return;
    }
    await deleteGroup(group.id);
  };

  const handleDeleteHost = async (host: HostConfig) => {
    if (!window.confirm(`确定删除主机「${host.name}」(${host.hostname})？`)) {
      return;
    }
    await deleteHost(host.id);
  };

  const handleLock = async () => {
    resetAllTabs();
    await lockVault();
  };

  const handleQuickSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!syncStatus?.enabled) {
      onOpenSyncSettings();
      return;
    }
    await window.xiziterm.sync.syncNow();
    await loadSyncStatus();
    await refreshData();
  };

  const isSyncing = syncStatus?.state === 'syncing';
  const isSyncError = syncStatus?.state === 'error';
  const isSyncEnabled = Boolean(syncStatus?.enabled);

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 flex-col items-center justify-between border-r border-theme-border bg-theme-sidebar py-3">
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            title="展开侧边栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-theme-accent-soft text-theme-accent hover:opacity-90"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onAddHost(null)}
            title="新建 SSH 主机"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onOpenSyncSettings}
            title="自托管云同步设置"
            className={`flex h-8 w-8 items-center justify-center rounded-lg hover:bg-theme-hover ${
              isSyncError
                ? 'text-theme-error'
                : isSyncEnabled
                  ? 'text-theme-online'
                  : 'text-theme-muted hover:text-theme-primary'
            }`}
          >
            {isSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin text-theme-accent" />
            ) : isSyncError ? (
              <CloudOff className="h-4 w-4" />
            ) : (
              <Cloud className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="终端设置"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleLock}
            title="锁定保险库"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-theme-muted hover:bg-theme-error-soft hover:text-theme-error"
          >
            <Lock className="h-4 w-4" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      style={{ width: `${width}px` }}
      className="flex h-full shrink-0 flex-col border-r border-theme-border bg-theme-sidebar"
    >
      {/* Brand Header */}
      <div className="flex items-center justify-between border-b border-theme-border px-3.5 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-accent/35 bg-theme-accent-soft text-theme-accent">
            <Terminal className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-theme-primary">
              XiZiTerm
            </div>
            <div className="text-[10px] text-theme-online">
              E2EE Vault Unlocked
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="收起侧边栏"
          className="rounded-md p-1.5 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Search & New Host */}
      <div className="space-y-2 border-b border-theme-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-muted" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索主机、IP、标签..."
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className="flex-1"
            onClick={() =>
              onAddHost(
                selectedGroupId !== 'ALL' && selectedGroupId !== 'UNGROUPED'
                  ? selectedGroupId
                  : null
              )
            }
          >
            <Plus className="h-3.5 w-3.5" />
            新建主机
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCreatingGroup((v) => !v)}
            title="新建分组"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {creatingGroup && (
          <form onSubmit={handleCreateGroup} className="flex gap-1.5 pt-1">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="输入新分组名称"
              className="h-7 text-xs"
              autoFocus
            />
            <Button type="submit" size="sm">
              确定
            </Button>
          </form>
        )}
      </div>

      {/* Groups Filter */}
      <div className="border-b border-theme-border px-2.5 py-2">
        <div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-theme-muted">
          分组 ({groups.length})
        </div>
        <div className="max-h-36 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            onClick={() => setSelectedGroupId('ALL')}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
              selectedGroupId === 'ALL'
                ? 'bg-theme-accent-soft font-medium text-theme-accent'
                : 'text-theme-primary hover:bg-theme-hover'
            }`}
          >
            <span className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5" />
              全部主机
            </span>
            <span className="text-[11px] text-theme-muted">{hosts.length}</span>
          </button>

          {groups.map((group) => {
            const count = hosts.filter((h) => h.groupId === group.id).length;
            const isRenaming = renamingGroup?.id === group.id;

            if (isRenaming) {
              return (
                <form
                  key={group.id}
                  onSubmit={handleRenameGroup}
                  className="flex items-center gap-1 px-1 py-0.5"
                >
                  <Input
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    className="h-6 text-xs"
                    autoFocus
                    onBlur={() => setRenamingGroup(null)}
                  />
                </form>
              );
            }

            return (
              <div
                key={group.id}
                className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
                  selectedGroupId === group.id
                    ? 'bg-theme-accent-soft font-medium text-theme-accent'
                    : 'text-theme-primary hover:bg-theme-hover'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedGroupId(group.id)}
                  className="flex flex-1 items-center gap-2 truncate text-left"
                >
                  <Folder
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: group.color }}
                  />
                  <span className="truncate">{group.name}</span>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingGroup(group);
                      setRenameText(group.name);
                    }}
                    title="重命名分组"
                    className="hidden rounded p-0.5 text-theme-muted hover:text-theme-primary group-hover:inline-flex"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteGroup(group)}
                    title="删除分组"
                    className="hidden rounded p-0.5 text-theme-muted hover:text-theme-error group-hover:inline-flex"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <span className="min-w-[16px] text-right text-[11px] text-theme-muted">
                    {count}
                  </span>
                </div>
              </div>
            );
          })}

          {hosts.some((h) => h.groupId === null) && (
            <button
              type="button"
              onClick={() => setSelectedGroupId('UNGROUPED')}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
                selectedGroupId === 'UNGROUPED'
                  ? 'bg-theme-accent-soft font-medium text-theme-accent'
                  : 'text-theme-muted hover:bg-theme-hover'
              }`}
            >
              <span className="flex items-center gap-2">
                <Folder className="h-3.5 w-3.5 text-theme-muted" />
                未分组
              </span>
              <span className="text-[11px] text-theme-muted">
                {hosts.filter((h) => h.groupId === null).length}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Host List */}
      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-theme-muted">
          主机列表 ({filteredHosts.length})
        </div>

        {filteredHosts.length === 0 ? (
          <div className="mt-6 flex flex-col items-center px-4 text-center text-xs text-theme-muted">
            <Server className="mb-2 h-8 w-8 opacity-45" />
            <p>暂无匹配的 SSH 主机</p>
            <p className="mt-1 text-[11px] opacity-80">
              点击上方「新建主机」添加服务器配置
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredHosts.map((host) => (
              <div
                key={host.id}
                onDoubleClick={() => openHostTab(host)}
                className="group cursor-pointer rounded-lg border border-theme-border bg-theme-elevated/65 p-2.5 transition-all hover:border-theme-accent/55 hover:bg-theme-elevated"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-theme-primary">
                        {host.name}
                      </span>
                      {host.authType === 'privateKey' && (
                        <span title="SSH 私钥认证">
                          <KeyRound className="h-3 w-3 shrink-0 text-theme-warn" />
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-theme-muted">
                      {host.username}@{host.hostname}:{host.port}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-80 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openHostTab(host);
                      }}
                      title="在新标签页连接"
                      className="rounded p-1 text-theme-accent hover:bg-theme-accent-soft"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </button>
                    {activeTab && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          splitPane(
                            activeTab.tabId,
                            activeTab.activePaneId,
                            'horizontal',
                            host
                          );
                        }}
                        title="在当前标签页右侧分屏连接"
                        className="hidden rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent group-hover:inline-flex"
                      >
                        <Columns2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditHost(host);
                      }}
                      title="编辑主机"
                      className="hidden rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary group-hover:inline-flex"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteHost(host);
                      }}
                      title="删除主机"
                      className="hidden rounded p-1 text-theme-muted hover:bg-theme-error-soft hover:text-theme-error group-hover:inline-flex"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {host.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {host.tags.slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="cyan">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cloud Sync Status Pill */}
      <div className="border-t border-theme-border px-2.5 pt-2">
        <div
          onClick={onOpenSyncSettings}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpenSyncSettings();
          }}
          className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            isSyncError
              ? 'border-theme-error/45 bg-theme-error-soft text-theme-error'
              : isSyncEnabled
                ? 'border-theme-online/40 bg-theme-online-soft text-theme-online hover:border-theme-online/65'
                : 'border-theme-border bg-theme-elevated/60 text-theme-muted hover:border-theme-accent/50 hover:text-theme-primary'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {isSyncing ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-theme-accent" />
            ) : isSyncError ? (
              <CloudOff className="h-3.5 w-3.5 shrink-0 text-theme-error" />
            ) : (
              <Cloud
                className={`h-3.5 w-3.5 shrink-0 ${
                  isSyncEnabled ? 'text-theme-online' : 'text-theme-muted'
                }`}
              />
            )}
            <div className="min-w-0 truncate">
              <div className="truncate text-[11px] font-medium">
                {isSyncing
                  ? 'E2EE 同步中...'
                  : isSyncError
                    ? '云同步异常'
                    : isSyncEnabled
                      ? `${
                          syncStatus?.provider === 'webdav'
                            ? 'WebDAV 已连接'
                            : 'VPS 云同步'
                        } (${syncStatus?.username})`
                      : '配置云同步 (WebDAV / VPS)'}
              </div>
            </div>
          </div>

          {isSyncEnabled && (
            <button
              type="button"
              onClick={(e) => void handleQuickSync(e)}
              disabled={isSyncing}
              title="立即同步"
              className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent disabled:opacity-40"
            >
              <RefreshCw
                className={`h-3 w-3 ${isSyncing ? 'animate-spin' : ''}`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Footer Controls */}
      <div className="flex items-center justify-between px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSettings}
          className="text-theme-muted"
        >
          <Settings className="h-3.5 w-3.5" />
          终端设置
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLock}
          className="text-theme-muted hover:text-theme-error"
          title="清除内存中的主密钥并锁定"
        >
          <Lock className="h-3.5 w-3.5" />
          锁定
        </Button>
      </div>
    </aside>
  );
}
