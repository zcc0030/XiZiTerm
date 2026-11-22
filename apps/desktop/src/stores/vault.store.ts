import { create } from 'zustand';
import {
  DEFAULT_PREFERENCES,
  type HostConfig,
  type HostGroup,
  type HostGroupInput,
  type HostInput,
  type Snippet,
  type SnippetInput,
  type SyncRestorePayload,
  type SyncStatusInfo,
  type UserPreferences,
  type VaultData,
  type VaultStatus,
} from '@xiziterm/shared';

interface VaultStoreState {
  loading: boolean;
  status: VaultStatus | null;
  syncStatus: SyncStatusInfo | null;
  groups: HostGroup[];
  hosts: HostConfig[];
  snippets: Snippet[];
  preferences: UserPreferences;
  selectedGroupId: string | 'ALL' | 'UNGROUPED';
  searchQuery: string;

  loadStatus: () => Promise<void>;
  loadSyncStatus: () => Promise<void>;
  setSyncStatus: (info: SyncStatusInfo | null) => void;
  initializeVault: (masterPassword: string) => Promise<{ ok: boolean; error?: string }>;
  unlockVault: (masterPassword: string) => Promise<{ ok: boolean; error?: string }>;
  restoreVaultFromCloud: (
    payload: SyncRestorePayload
  ) => Promise<{ ok: boolean; error?: string }>;
  lockVault: () => Promise<void>;
  refreshData: () => Promise<void>;
  saveGroup: (input: HostGroupInput) => Promise<{ ok: boolean; data?: HostGroup; error?: string }>;
  deleteGroup: (groupId: string) => Promise<{ ok: boolean; error?: string }>;
  saveHost: (input: HostInput) => Promise<{ ok: boolean; data?: HostConfig; error?: string }>;
  deleteHost: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
  saveSnippet: (input: SnippetInput) => Promise<{ ok: boolean; data?: Snippet; error?: string }>;
  deleteSnippet: (snippetId: string) => Promise<{ ok: boolean; error?: string }>;
  updatePreferences: (
    patch: Partial<
      Omit<
        UserPreferences,
        'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'syncVersion'
      >
    >
  ) => Promise<void>;
  setSelectedGroupId: (id: string | 'ALL' | 'UNGROUPED') => void;
  setSearchQuery: (q: string) => void;
}

const fallbackPreferences: UserPreferences = {
  ...DEFAULT_PREFERENCES,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  syncVersion: 0,
};

function applyVaultData(data: VaultData) {
  return {
    groups: data.groups,
    hosts: data.hosts,
    snippets: data.snippets,
    preferences: data.preferences,
  };
}

export const useVaultStore = create<VaultStoreState>((set, get) => ({
  loading: true,
  status: null,
  syncStatus: null,
  groups: [],
  hosts: [],
  snippets: [],
  preferences: fallbackPreferences,
  selectedGroupId: 'ALL',
  searchQuery: '',

  loadStatus: async () => {
    set({ loading: true });
    try {
      const status = await window.xiziterm.vault.getStatus();
      set({ status });
      if (status.unlocked) {
        await get().refreshData();
        await get().loadSyncStatus();
      }
    } finally {
      set({ loading: false });
    }
  },

  loadSyncStatus: async () => {
    const res = await window.xiziterm.sync.getStatus();
    if (res.ok && res.data) {
      set({ syncStatus: res.data });
    }
  },

  setSyncStatus: (syncStatus) => set({ syncStatus }),

  initializeVault: async (masterPassword) => {
    const res = await window.xiziterm.vault.initialize(masterPassword);
    if (res.ok && res.data) {
      const status = await window.xiziterm.vault.getStatus();
      set({ status, ...applyVaultData(res.data) });
      void get().loadSyncStatus();
      return { ok: true };
    }
    return { ok: false, error: res.error ?? '初始化失败' };
  },

  unlockVault: async (masterPassword) => {
    const res = await window.xiziterm.vault.unlock(masterPassword);
    if (res.ok && res.data) {
      const status = await window.xiziterm.vault.getStatus();
      set({ status, ...applyVaultData(res.data) });
      void get().loadSyncStatus();
      return { ok: true };
    }
    return { ok: false, error: res.error ?? '解锁失败' };
  },

  restoreVaultFromCloud: async (payload) => {
    const res = await window.xiziterm.sync.restoreVault(payload);
    if (res.ok && res.data) {
      const status = await window.xiziterm.vault.getStatus();
      set({ status, ...applyVaultData(res.data) });
      void get().loadSyncStatus();
      return { ok: true };
    }
    return { ok: false, error: res.error ?? '从云端恢复失败' };
  },

  lockVault: async () => {
    await window.xiziterm.vault.lock();
    const status = await window.xiziterm.vault.getStatus();
    set({
      status,
      syncStatus: null,
      groups: [],
      hosts: [],
      snippets: [],
      preferences: fallbackPreferences,
      selectedGroupId: 'ALL',
      searchQuery: '',
    });
  },

  refreshData: async () => {
    const res = await window.xiziterm.vault.getData();
    if (res.ok && res.data) {
      set(applyVaultData(res.data));
    }
  },

  saveGroup: async (input) => {
    const res = await window.xiziterm.vault.saveGroup(input);
    if (res.ok) {
      await get().refreshData();
      return { ok: true, data: res.data };
    }
    return { ok: false, error: res.error };
  },

  deleteGroup: async (groupId) => {
    const res = await window.xiziterm.vault.deleteGroup(groupId);
    if (res.ok) {
      if (get().selectedGroupId === groupId) {
        set({ selectedGroupId: 'ALL' });
      }
      await get().refreshData();
      return { ok: true };
    }
    return { ok: false, error: res.error };
  },

  saveHost: async (input) => {
    const res = await window.xiziterm.vault.saveHost(input);
    if (res.ok) {
      await get().refreshData();
      return { ok: true, data: res.data };
    }
    return { ok: false, error: res.error };
  },

  deleteHost: async (hostId) => {
    const res = await window.xiziterm.vault.deleteHost(hostId);
    if (res.ok) {
      await get().refreshData();
      return { ok: true };
    }
    return { ok: false, error: res.error };
  },

  saveSnippet: async (input) => {
    const res = await window.xiziterm.vault.saveSnippet(input);
    if (res.ok) {
      await get().refreshData();
      return { ok: true, data: res.data };
    }
    return { ok: false, error: res.error };
  },

  deleteSnippet: async (snippetId) => {
    const res = await window.xiziterm.vault.deleteSnippet(snippetId);
    if (res.ok) {
      await get().refreshData();
      return { ok: true };
    }
    return { ok: false, error: res.error };
  },

  updatePreferences: async (patch) => {
    const res = await window.xiziterm.vault.updatePreferences(patch);
    if (res.ok && res.data) {
      set({ preferences: res.data });
    }
  },

  setSelectedGroupId: (selectedGroupId) => set({ selectedGroupId }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
