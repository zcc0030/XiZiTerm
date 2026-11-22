import * as React from 'react';
import { Loader2 } from 'lucide-react';
import type { HostConfig, SyncProviderType } from '@xiziterm/shared';
import { useVaultStore } from '@/stores/vault.store';
import { VaultLockScreen } from '@/features/lock/VaultLockScreen';
import { HostSidebar } from '@/features/hosts/HostSidebar';
import { HostFormDialog } from '@/features/hosts/HostFormDialog';
import { TerminalWorkspace } from '@/features/terminal/TerminalWorkspace';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { SyncSettingsDialog } from '@/features/sync/SyncSettingsDialog';
import {
  LEGACY_SKIP_SYNC_GUIDE_KEY,
  SKIP_SYNC_GUIDE_KEY,
  SyncOnboardingDialog,
} from '@/features/sync/SyncOnboardingDialog';

const SIDEBAR_WIDTH_KEY = 'xiziterm.sidebarWidth';
const LEGACY_SIDEBAR_WIDTH_KEY = 'nexusterm.sidebarWidth';
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 288;

function loadSavedSidebarWidth(): number {
  try {
    const raw =
      window.localStorage.getItem(SIDEBAR_WIDTH_KEY) ??
      window.localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed));
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function App() {
  const loading = useVaultStore((s) => s.loading);
  const status = useVaultStore((s) => s.status);
  const syncStatus = useVaultStore((s) => s.syncStatus);
  const loadStatus = useVaultStore((s) => s.loadStatus);
  const setSyncStatus = useVaultStore((s) => s.setSyncStatus);
  const refreshData = useVaultStore((s) => s.refreshData);

  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [sidebarWidth, setSidebarWidth] = React.useState<number>(
    loadSavedSidebarWidth
  );
  const [hostModalOpen, setHostModalOpen] = React.useState(false);
  const [editingHost, setEditingHost] = React.useState<HostConfig | null>(null);
  const [defaultGroupId, setDefaultGroupId] = React.useState<string | null>(
    null
  );
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [syncSettingsOpen, setSyncSettingsOpen] = React.useState(false);
  const [syncGuideOpen, setSyncGuideOpen] = React.useState(false);
  const [prefillSyncUrl, setPrefillSyncUrl] = React.useState<
    string | undefined
  >(undefined);
  const [prefillSyncProvider, setPrefillSyncProvider] = React.useState<
    SyncProviderType | undefined
  >(undefined);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  React.useEffect(() => {
    const off = window.xiziterm.sync.onStateChanged((payload) => {
      setSyncStatus(payload.status);
      if (payload.vaultUpdated) {
        void refreshData();
      }
    });
    return off;
  }, [setSyncStatus, refreshData]);

  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;

    const onMove = (moveEv: MouseEvent) => {
      const next = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + (moveEv.clientX - startX))
      );
      latestWidth = next;
      setSidebarWidth(next);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latestWidth));
      } catch {
        // ignore
      }
    };

    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-theme-base text-theme-accent">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!status?.unlocked) {
    return <VaultLockScreen />;
  }

  const handleOpenAddHost = (groupId?: string | null) => {
    setEditingHost(null);
    setDefaultGroupId(groupId ?? null);
    setHostModalOpen(true);
  };

  const handleOpenEditHost = (host: HostConfig) => {
    setEditingHost(host);
    setDefaultGroupId(host.groupId);
    setHostModalOpen(true);
  };

  const handleOpenSyncEntry = () => {
    let skipGuide = false;
    try {
      skipGuide =
        window.localStorage.getItem(SKIP_SYNC_GUIDE_KEY) === '1' ||
        window.localStorage.getItem(LEGACY_SKIP_SYNC_GUIDE_KEY) === '1';
    } catch {
      skipGuide = false;
    }

    if (!syncStatus?.enabled && !skipGuide) {
      setSyncGuideOpen(true);
    } else {
      setPrefillSyncUrl(undefined);
      setPrefillSyncProvider(undefined);
      setSyncSettingsOpen(true);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-theme-base text-theme-primary">
      <HostSidebar
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        onAddHost={handleOpenAddHost}
        onEditHost={handleOpenEditHost}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSyncSettings={handleOpenSyncEntry}
      />

      {!sidebarCollapsed && (
        <div
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            try {
              window.localStorage.setItem(
                SIDEBAR_WIDTH_KEY,
                String(DEFAULT_SIDEBAR_WIDTH)
              );
            } catch {
              // ignore
            }
          }}
          title="拖拽调整左侧边栏宽度（双击恢复默认）"
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-theme-accent"
        />
      )}

      <TerminalWorkspace onAddHost={() => handleOpenAddHost(null)} />

      <HostFormDialog
        open={hostModalOpen}
        editingHost={editingHost}
        defaultGroupId={defaultGroupId}
        onClose={() => setHostModalOpen(false)}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <SyncSettingsDialog
        open={syncSettingsOpen}
        prefillServerUrl={prefillSyncUrl}
        prefillProvider={prefillSyncProvider}
        onClose={() => setSyncSettingsOpen(false)}
        onOpenGuide={() => {
          setSyncSettingsOpen(false);
          setSyncGuideOpen(true);
        }}
      />

      <SyncOnboardingDialog
        open={syncGuideOpen}
        onClose={() => setSyncGuideOpen(false)}
        onProceedToSyncConfig={(opts) => {
          setSyncGuideOpen(false);
          setPrefillSyncUrl(opts?.prefillUrl);
          setPrefillSyncProvider(opts?.provider);
          setSyncSettingsOpen(true);
        }}
      />
    </div>
  );
}

export default App;
