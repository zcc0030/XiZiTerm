import * as React from 'react';
import {
  Activity,
  Code2,
  Columns2,
  FolderOpen,
  Minus,
  Plus,
  Rows2,
  Server,
  Terminal,
  X,
} from 'lucide-react';
import type { SplitDirection } from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { useVaultStore } from '@/stores/vault.store';
import { findPaneById, useTerminalStore } from '@/stores/terminal.store';
import { SplitPaneRenderer } from './SplitPaneRenderer';
import { SftpPanel } from '@/features/sftp/SftpPanel';
import { CockpitPanel } from '@/features/monitor/CockpitPanel';
import { SnippetsPanel } from '@/features/snippets/SnippetsPanel';
import { ThemeDropdown } from '@/features/theme/ThemeSwitcher';

const SFTP_HEIGHT_KEY = 'xiziterm.sftpHeight';
const LEGACY_SFTP_HEIGHT_KEY = 'nexusterm.sftpHeight';
const DEFAULT_SFTP_HEIGHT = 300;
const MIN_SFTP_HEIGHT = 160;
const MAX_SFTP_HEIGHT = 800;

const RIGHT_PANEL_WIDTH_KEY = 'xiziterm.rightPanelWidth';
const LEGACY_RIGHT_PANEL_WIDTH_KEY = 'nexusterm.rightPanelWidth';
const DEFAULT_RIGHT_PANEL_WIDTH = 310;
const MIN_RIGHT_PANEL_WIDTH = 240;
const MAX_RIGHT_PANEL_WIDTH = 600;

function loadSavedNumber(
  key: string,
  legacyKey: string,
  fallback: number,
  min: number,
  max: number
): number {
  try {
    const raw =
      window.localStorage.getItem(key) ??
      window.localStorage.getItem(legacyKey);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(min, parsed));
    }
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function persistNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // ignore storage errors
  }
}

interface TerminalWorkspaceProps {
  onAddHost: () => void;
}

export function TerminalWorkspace({ onAddHost }: TerminalWorkspaceProps) {
  const hosts = useVaultStore((s) => s.hosts);
  const preferences = useVaultStore((s) => s.preferences);
  const updatePreferences = useVaultStore((s) => s.updatePreferences);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessionStatuses = useTerminalStore((s) => s.sessionStatuses);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const openHostTab = useTerminalStore((s) => s.openHostTab);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const updateSplitRatio = useTerminalStore((s) => s.updateSplitRatio);
  const closePane = useTerminalStore((s) => s.closePane);
  const closeTab = useTerminalStore((s) => s.closeTab);

  const [sftpOpen, setSftpOpen] = React.useState(false);
  const [sftpHeight, setSftpHeight] = React.useState<number>(() =>
    loadSavedNumber(
      SFTP_HEIGHT_KEY,
      LEGACY_SFTP_HEIGHT_KEY,
      DEFAULT_SFTP_HEIGHT,
      MIN_SFTP_HEIGHT,
      MAX_SFTP_HEIGHT
    )
  );
  const [rightPanel, setRightPanel] = React.useState<
    'none' | 'cockpit' | 'snippets'
  >('none');
  const [rightPanelWidth, setRightPanelWidth] = React.useState<number>(() =>
    loadSavedNumber(
      RIGHT_PANEL_WIDTH_KEY,
      LEGACY_RIGHT_PANEL_WIDTH_KEY,
      DEFAULT_RIGHT_PANEL_WIDTH,
      MIN_RIGHT_PANEL_WIDTH,
      MAX_RIGHT_PANEL_WIDTH
    )
  );
  const workspaceContainerRef = React.useRef<HTMLDivElement | null>(null);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;
  const activePane = activeTab
    ? findPaneById(activeTab.root, activeTab.activePaneId)
    : null;
  const activeSessionState = activePane
    ? sessionStatuses[activePane.sessionId]?.state ?? 'connecting'
    : 'disconnected';

  const handleSftpResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = sftpHeight;
    let latestHeight = startHeight;
    const maxHeight = workspaceContainerRef.current
      ? Math.min(
          MAX_SFTP_HEIGHT,
          Math.floor(workspaceContainerRef.current.clientHeight * 0.78)
        )
      : 560;

    const onMove = (moveEv: MouseEvent) => {
      const delta = startY - moveEv.clientY;
      const next = Math.min(
        maxHeight,
        Math.max(MIN_SFTP_HEIGHT, startHeight + delta)
      );
      latestHeight = next;
      setSftpHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      persistNumber(SFTP_HEIGHT_KEY, latestHeight);
    };

    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleRightPanelResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPanelWidth;
    let latestWidth = startWidth;

    const onMove = (moveEv: MouseEvent) => {
      const delta = startX - moveEv.clientX;
      const next = Math.min(
        MAX_RIGHT_PANEL_WIDTH,
        Math.max(MIN_RIGHT_PANEL_WIDTH, startWidth + delta)
      );
      latestWidth = next;
      setRightPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      persistNumber(RIGHT_PANEL_WIDTH_KEY, latestWidth);
    };

    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleSplit = (
    tabId: string,
    paneId: string,
    hostId: string,
    direction: SplitDirection
  ) => {
    const host = hosts.find((h) => h.id === hostId);
    if (!host) return;
    splitPane(tabId, paneId, direction, host);
  };

  const handleToolbarSplit = (direction: SplitDirection) => {
    if (!activeTab) return;
    const pane = findPaneById(activeTab.root, activeTab.activePaneId);
    if (!pane) return;
    handleSplit(activeTab.tabId, pane.paneId, pane.hostId, direction);
  };

  const adjustFontSize = (delta: number) => {
    const next = Math.min(28, Math.max(10, preferences.fontSize + delta));
    if (next !== preferences.fontSize) {
      void updatePreferences({ fontSize: next });
    }
  };

  if (tabs.length === 0) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center bg-theme-base p-8 text-center">
        <div className="absolute right-4 top-3">
          <ThemeDropdown />
        </div>
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-theme-accent/35 bg-theme-accent-soft text-theme-accent">
          <Terminal className="h-8 w-8" />
        </div>
        <h2 className="text-lg font-semibold text-theme-primary">
          欢迎使用 XiZiTerm
        </h2>
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-theme-muted">
          双击左侧任意 SSH 主机即可建立加密终端会话。支持多标签页、左右/上下分屏、终端内搜索与断线重连。
        </p>

        {hosts.length > 0 ? (
          <div className="mt-6 w-full max-w-lg">
            <div className="mb-2 text-left text-[11px] font-medium uppercase tracking-wider text-theme-muted">
              快速连接
            </div>
            <div className="grid grid-cols-2 gap-2">
              {hosts.slice(0, 6).map((host) => (
                <button
                  key={host.id}
                  type="button"
                  onClick={() => openHostTab(host)}
                  className="flex items-center gap-2.5 rounded-lg border border-theme-border bg-theme-elevated/70 p-3 text-left transition-colors hover:border-theme-accent/60 hover:bg-theme-elevated"
                >
                  <Server className="h-4 w-4 shrink-0 text-theme-accent" />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-theme-primary">
                      {host.name}
                    </div>
                    <div className="truncate font-mono text-[10px] text-theme-muted">
                      {host.username}@{host.hostname}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Button onClick={onAddHost} className="mt-6">
            <Plus className="h-4 w-4" />
            添加第一台 SSH 主机
          </Button>
        )}

        <div className="mt-8 flex flex-wrap justify-center gap-4 text-[11px] text-theme-muted">
          <span>
            <kbd className="rounded border border-theme-border bg-theme-elevated px-1.5 py-0.5 font-mono text-theme-primary">
              Ctrl+Shift+C
            </kbd>{' '}
            复制
          </span>
          <span>
            <kbd className="rounded border border-theme-border bg-theme-elevated px-1.5 py-0.5 font-mono text-theme-primary">
              Ctrl+Shift+V
            </kbd>{' '}
            粘贴
          </span>
          <span>
            <kbd className="rounded border border-theme-border bg-theme-elevated px-1.5 py-0.5 font-mono text-theme-primary">
              Ctrl+Shift+F
            </kbd>{' '}
            终端搜索
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-theme-base">
      {/* Tab Bar + Quick Actions */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-theme-border bg-theme-sidebar px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-2">
          {tabs.map((tab) => {
            const isActive = tab.tabId === activeTabId;
            const activePane = findPaneById(tab.root, tab.activePaneId);
            const status = activePane
              ? sessionStatuses[activePane.sessionId]?.state
              : undefined;
            const dotClass =
              status === 'connected'
                ? 'bg-theme-online'
                : status === 'connecting'
                  ? 'bg-theme-warn animate-pulse'
                  : 'bg-theme-error';

            return (
              <div
                key={tab.tabId}
                onClick={() => setActiveTab(tab.tabId)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(tab.tabId);
                  }
                }}
                className={`group relative flex h-8 max-w-[200px] shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md border px-2.5 text-xs transition-colors ${
                  isActive
                    ? 'nt-tab-active border-theme-accent/45 bg-theme-elevated text-theme-primary'
                    : 'border-transparent bg-transparent text-theme-muted hover:bg-theme-hover hover:text-theme-primary'
                }`}
              >
                {isActive && (
                  <span
                    className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
                    style={{ background: 'var(--tab-active-bar)' }}
                  />
                )}
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
                <span className="truncate font-medium">{tab.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.tabId);
                  }}
                  className="ml-1 rounded p-0.5 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
                  title="关闭标签页"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Workspace Toolbar */}
        <div className="flex shrink-0 items-center gap-1 border-l border-theme-border pl-2">
          <button
            type="button"
            onClick={() => handleToolbarSplit('horizontal')}
            title="当前窗格左右分屏"
            className="flex h-7 items-center gap-1 rounded px-2 text-xs text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
          >
            <Columns2 className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">左右分屏</span>
          </button>
          <button
            type="button"
            onClick={() => handleToolbarSplit('vertical')}
            title="当前窗格上下分屏"
            className="flex h-7 items-center gap-1 rounded px-2 text-xs text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
          >
            <Rows2 className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">上下分屏</span>
          </button>

          <div className="mx-1 h-4 w-px bg-theme-border" />

          <button
            type="button"
            onClick={() => adjustFontSize(-1)}
            title="减小字体"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-8 text-center font-mono text-[11px] text-theme-muted">
            {preferences.fontSize}px
          </span>
          <button
            type="button"
            onClick={() => adjustFontSize(1)}
            title="增大字体"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-4 w-px bg-theme-border" />

          {/* Active SFTP Drawer Toggle */}
          <button
            type="button"
            onClick={() => setSftpOpen((v) => !v)}
            title={sftpOpen ? '收起内置 SFTP 面板' : '展开内置 SFTP 文件管理器'}
            className={`flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors ${
              sftpOpen
                ? 'border-theme-accent bg-theme-accent-soft text-theme-accent'
                : 'border-theme-border bg-theme-elevated/70 text-theme-primary hover:border-theme-accent/60 hover:text-theme-accent'
            }`}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>SFTP</span>
          </button>

          {/* Active Cockpit Monitor Sidebar Toggle */}
          <button
            type="button"
            onClick={() =>
              setRightPanel((cur) => (cur === 'cockpit' ? 'none' : 'cockpit'))
            }
            title={
              rightPanel === 'cockpit'
                ? '收起主机座舱监控'
                : '展开无 Agent 主机座舱实时监控'
            }
            className={`flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors ${
              rightPanel === 'cockpit'
                ? 'border-theme-online bg-theme-online-soft text-theme-online'
                : 'border-theme-border bg-theme-elevated/70 text-theme-primary hover:border-theme-online/60 hover:text-theme-online'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            <span>座舱</span>
          </button>

          {/* Active Snippets Sidebar Toggle */}
          <button
            type="button"
            onClick={() =>
              setRightPanel((cur) => (cur === 'snippets' ? 'none' : 'snippets'))
            }
            title={
              rightPanel === 'snippets'
                ? '收起快捷命令面板'
                : '展开快捷命令 (Snippets) 侧边栏'
            }
            className={`flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors ${
              rightPanel === 'snippets'
                ? 'border-theme-accent bg-theme-accent-soft text-theme-accent'
                : 'border-theme-border bg-theme-elevated/70 text-theme-primary hover:border-theme-accent/60 hover:text-theme-accent'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Snippets</span>
          </button>

          <div className="mx-1 h-4 w-px bg-theme-border" />

          {/* Theme Switcher Menu */}
          <ThemeDropdown compact />
        </div>
      </div>

      {/* Main Content Area: (Terminal + SFTP Drawer) + Optional Right Cockpit Sidebar */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={workspaceContainerRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* Keep all tab terminal trees mounted so switching tabs preserves scrollback & SSH state */}
          <div className="nt-terminal-shell relative min-h-0 flex-1 overflow-hidden">
            {tabs.map((tab) => {
              const isActive = tab.tabId === activeTabId;
              return (
                <div
                  key={tab.tabId}
                  className={
                    isActive
                      ? 'flex h-full w-full min-h-0 min-w-0'
                      : 'hidden h-full w-full'
                  }
                >
                  <SplitPaneRenderer
                    tabId={tab.tabId}
                    node={tab.root}
                    isActiveTab={isActive}
                    activePaneId={tab.activePaneId}
                    isRootSinglePane={tab.root.type === 'pane'}
                    onFocusPane={(paneId) => setActivePane(tab.tabId, paneId)}
                    onSplitPane={(paneId, hostId, dir) =>
                      handleSplit(tab.tabId, paneId, hostId, dir)
                    }
                    onClosePane={(paneId) => closePane(tab.tabId, paneId)}
                    onResizeSplit={(splitId, ratio) =>
                      updateSplitRatio(tab.tabId, splitId, ratio)
                    }
                  />
                </div>
              );
            })}
          </div>

          {/* SFTP Drawer */}
          {sftpOpen && activePane && (
            <>
              <div
                onMouseDown={handleSftpResizeStart}
                onDoubleClick={() => {
                  setSftpHeight(DEFAULT_SFTP_HEIGHT);
                  persistNumber(SFTP_HEIGHT_KEY, DEFAULT_SFTP_HEIGHT);
                }}
                title="拖拽调整 SFTP 面板高度（双击恢复默认）"
                className="h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-theme-accent"
              />
              <div
                style={{ height: `${sftpHeight}px` }}
                className="shrink-0 overflow-hidden"
              >
                <SftpPanel
                  sessionId={activePane.sessionId}
                  hostName={activePane.hostName}
                  connectionState={activeSessionState}
                  onClose={() => setSftpOpen(false)}
                />
              </div>
            </>
          )}
        </div>

        {/* Right Resizable Panel: Cockpit Monitor OR Snippets */}
        {rightPanel !== 'none' && activePane && (
          <>
            <div
              onMouseDown={handleRightPanelResizeStart}
              onDoubleClick={() => {
                setRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH);
                persistNumber(RIGHT_PANEL_WIDTH_KEY, DEFAULT_RIGHT_PANEL_WIDTH);
              }}
              title="拖拽调整右侧面板宽度（双击恢复默认）"
              className={`w-1 shrink-0 cursor-col-resize bg-transparent transition-colors ${
                rightPanel === 'cockpit'
                  ? 'hover:bg-theme-online'
                  : 'hover:bg-theme-accent'
              }`}
            />
            <div
              style={{ width: `${rightPanelWidth}px` }}
              className="shrink-0 overflow-hidden"
            >
              {rightPanel === 'cockpit' ? (
                <CockpitPanel
                  sessionId={activePane.sessionId}
                  hostName={activePane.hostName}
                  connectionState={activeSessionState}
                  onClose={() => setRightPanel('none')}
                />
              ) : (
                <SnippetsPanel
                  sessionId={activePane.sessionId}
                  hostName={activePane.hostName}
                  connectionState={activeSessionState}
                  onClose={() => setRightPanel('none')}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
