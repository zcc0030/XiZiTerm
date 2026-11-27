import { create } from 'zustand';
import {
  LOCAL_HOST_ID,
  type HostConfig,
  type LocalShellProfile,
  type SplitDirection,
  type SshConnectionState,
  type TerminalSplitNode,
  type TerminalTab,
} from '@xiziterm/shared';

const PREFERRED_LOCAL_SHELL_KEY = 'xiziterm.preferredLocalShell';

function loadPreferredShellId(): string | null {
  try {
    return window.localStorage.getItem(PREFERRED_LOCAL_SHELL_KEY);
  } catch {
    return null;
  }
}

function persistPreferredShellId(shellId: string): void {
  try {
    window.localStorage.setItem(PREFERRED_LOCAL_SHELL_KEY, shellId);
  } catch {
    // ignore storage errors
  }
}

function resolveDefaultShell(
  shells: LocalShellProfile[],
  preferredId: string | null
): LocalShellProfile | undefined {
  if (preferredId) {
    const found = shells.find((s) => s.id === preferredId);
    if (found) return found;
  }
  return shells[0];
}

export interface SessionStatusInfo {
  state: SshConnectionState;
  message?: string;
}

interface TerminalStoreState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  sessionStatuses: Record<string, SessionStatusInfo>;
  localShells: LocalShellProfile[];
  preferredShellId: string | null;

  loadLocalShells: (refresh?: boolean) => Promise<LocalShellProfile[]>;
  setPreferredShellId: (shellId: string) => void;
  openHostTab: (host: HostConfig) => void;
  openLocalTab: (shell?: LocalShellProfile) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  splitPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    host: HostConfig
  ) => void;
  splitLocalPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    shell?: LocalShellProfile
  ) => void;
  updateSplitRatio: (tabId: string, splitId: string, ratio: number) => void;
  closePane: (tabId: string, paneId: string) => void;
  closeTab: (tabId: string) => void;
  setSessionStatus: (
    sessionId: string,
    state: SshConnectionState,
    message?: string
  ) => void;
  resetAll: () => void;
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function collectSessionIds(node: TerminalSplitNode): string[] {
  if (node.type === 'pane') {
    return [node.sessionId];
  }
  return [...collectSessionIds(node.first), ...collectSessionIds(node.second)];
}

function findFirstPaneId(node: TerminalSplitNode): string {
  if (node.type === 'pane') return node.paneId;
  return findFirstPaneId(node.first);
}

export function findPaneById(
  node: TerminalSplitNode,
  paneId: string
): Extract<TerminalSplitNode, { type: 'pane' }> | null {
  if (node.type === 'pane') {
    return node.paneId === paneId ? node : null;
  }
  return findPaneById(node.first, paneId) ?? findPaneById(node.second, paneId);
}

function replacePaneWithSplit(
  node: TerminalSplitNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPane: Extract<TerminalSplitNode, { type: 'pane' }>
): TerminalSplitNode {
  if (node.type === 'pane') {
    if (node.paneId === targetPaneId) {
      return {
        type: 'split',
        id: makeId('split'),
        direction,
        ratio: 0.5,
        first: node,
        second: newPane,
      };
    }
    return node;
  }
  return {
    ...node,
    first: replacePaneWithSplit(node.first, targetPaneId, direction, newPane),
    second: replacePaneWithSplit(node.second, targetPaneId, direction, newPane),
  };
}

function updateRatioInTree(
  node: TerminalSplitNode,
  splitId: string,
  ratio: number
): TerminalSplitNode {
  if (node.type === 'pane') return node;
  if (node.id === splitId) {
    return {
      ...node,
      ratio: Math.min(0.85, Math.max(0.15, ratio)),
    };
  }
  return {
    ...node,
    first: updateRatioInTree(node.first, splitId, ratio),
    second: updateRatioInTree(node.second, splitId, ratio),
  };
}

function removePaneFromTree(
  node: TerminalSplitNode,
  targetPaneId: string
): { next: TerminalSplitNode | null; removedSessionId: string | null } {
  if (node.type === 'pane') {
    if (node.paneId === targetPaneId) {
      return { next: null, removedSessionId: node.sessionId };
    }
    return { next: node, removedSessionId: null };
  }

  const left = removePaneFromTree(node.first, targetPaneId);
  if (left.removedSessionId) {
    if (!left.next) {
      return { next: node.second, removedSessionId: left.removedSessionId };
    }
    return {
      next: { ...node, first: left.next },
      removedSessionId: left.removedSessionId,
    };
  }

  const right = removePaneFromTree(node.second, targetPaneId);
  if (right.removedSessionId) {
    if (!right.next) {
      return { next: node.first, removedSessionId: right.removedSessionId };
    }
    return {
      next: { ...node, second: right.next },
      removedSessionId: right.removedSessionId,
    };
  }

  return { next: node, removedSessionId: null };
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessionStatuses: {},
  localShells: [],
  preferredShellId: loadPreferredShellId(),

  loadLocalShells: async (refresh = false) => {
    try {
      const list = await window.xiziterm.ssh.listLocalShells(refresh);
      set({ localShells: list });
      return list;
    } catch {
      return get().localShells;
    }
  },

  setPreferredShellId: (shellId) => {
    persistPreferredShellId(shellId);
    set({ preferredShellId: shellId });
  },

  openHostTab: (host) => {
    const tabId = makeId('tab');
    const paneId = makeId('pane');
    const sessionId = makeId('ssh');

    const newTab: TerminalTab = {
      tabId,
      title: host.name,
      hostId: host.id,
      activePaneId: paneId,
      root: {
        type: 'pane',
        paneId,
        sessionId,
        hostId: host.id,
        hostName: host.name,
        hostAddress: `${host.username}@${host.hostname}:${host.port}`,
      },
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: { state: 'connecting', message: '正在建立 SSH 连接...' },
      },
    }));
  },

  openLocalTab: (shell) => {
    const chosen =
      shell ?? resolveDefaultShell(get().localShells, get().preferredShellId);
    const tabId = makeId('tab');
    const paneId = makeId('pane');
    const sessionId = makeId('local');
    const title = chosen ? `本机 · ${chosen.label}` : '本机终端';
    const hostAddress = chosen?.command ?? 'Local PTY';

    const newTab: TerminalTab = {
      tabId,
      title,
      hostId: LOCAL_HOST_ID,
      activePaneId: paneId,
      root: {
        type: 'pane',
        paneId,
        sessionId,
        hostId: LOCAL_HOST_ID,
        hostName: title,
        hostAddress,
        shellId: chosen?.id,
      },
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: { state: 'connecting', message: '正在启动本机终端...' },
      },
    }));
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setActivePane: (tabId, paneId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.tabId === tabId ? { ...tab, activePaneId: paneId } : tab
      ),
    })),

  splitPane: (tabId, targetPaneId, direction, host) => {
    const newPaneId = makeId('pane');
    const newSessionId = makeId('ssh');
    const newPane: Extract<TerminalSplitNode, { type: 'pane' }> = {
      type: 'pane',
      paneId: newPaneId,
      sessionId: newSessionId,
      hostId: host.id,
      hostName: host.name,
      hostAddress: `${host.username}@${host.hostname}:${host.port}`,
    };

    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.tabId !== tabId) return tab;
        return {
          ...tab,
          root: replacePaneWithSplit(tab.root, targetPaneId, direction, newPane),
          activePaneId: newPaneId,
        };
      }),
      sessionStatuses: {
        ...state.sessionStatuses,
        [newSessionId]: { state: 'connecting', message: '正在建立 SSH 连接...' },
      },
    }));
  },

  splitLocalPane: (tabId, targetPaneId, direction, shell) => {
    const chosen =
      shell ?? resolveDefaultShell(get().localShells, get().preferredShellId);
    const newPaneId = makeId('pane');
    const newSessionId = makeId('local');
    const title = chosen ? `本机 · ${chosen.label}` : '本机终端';
    const hostAddress = chosen?.command ?? 'Local PTY';

    const newPane: Extract<TerminalSplitNode, { type: 'pane' }> = {
      type: 'pane',
      paneId: newPaneId,
      sessionId: newSessionId,
      hostId: LOCAL_HOST_ID,
      hostName: title,
      hostAddress,
      shellId: chosen?.id,
    };

    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.tabId !== tabId) return tab;
        return {
          ...tab,
          root: replacePaneWithSplit(tab.root, targetPaneId, direction, newPane),
          activePaneId: newPaneId,
        };
      }),
      sessionStatuses: {
        ...state.sessionStatuses,
        [newSessionId]: { state: 'connecting', message: '正在启动本机终端...' },
      },
    }));
  },

  updateSplitRatio: (tabId, splitId, ratio) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.tabId === tabId
          ? { ...tab, root: updateRatioInTree(tab.root, splitId, ratio) }
          : tab
      ),
    })),

  closePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    const { next, removedSessionId } = removePaneFromTree(tab.root, paneId);
    if (removedSessionId) {
      void window.xiziterm.ssh.disconnect(removedSessionId);
    }

    if (!next) {
      get().closeTab(tabId);
      return;
    }

    set((state) => {
      const nextStatuses = { ...state.sessionStatuses };
      if (removedSessionId) {
        delete nextStatuses[removedSessionId];
      }
      return {
        tabs: state.tabs.map((t) => {
          if (t.tabId !== tabId) return t;
          const nextActivePane =
            t.activePaneId === paneId ? findFirstPaneId(next) : t.activePaneId;
          return { ...t, root: next, activePaneId: nextActivePane };
        }),
        sessionStatuses: nextStatuses,
      };
    });
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.tabId === tabId);
    if (!tab) return;

    const sessionIds = collectSessionIds(tab.root);
    for (const sid of sessionIds) {
      void window.xiziterm.ssh.disconnect(sid);
    }

    set((state) => {
      const idx = state.tabs.findIndex((t) => t.tabId === tabId);
      const remaining = state.tabs.filter((t) => t.tabId !== tabId);
      let nextActiveTabId = state.activeTabId;
      if (state.activeTabId === tabId) {
        if (remaining.length === 0) {
          nextActiveTabId = null;
        } else {
          const fallbackIdx = Math.min(idx, remaining.length - 1);
          nextActiveTabId = remaining[fallbackIdx].tabId;
        }
      }
      const nextStatuses = { ...state.sessionStatuses };
      for (const sid of sessionIds) {
        delete nextStatuses[sid];
      }
      return {
        tabs: remaining,
        activeTabId: nextActiveTabId,
        sessionStatuses: nextStatuses,
      };
    });
  },

  setSessionStatus: (sessionId, stateVal, message) =>
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: { state: stateVal, message },
      },
    })),

  resetAll: () => set({ tabs: [], activeTabId: null, sessionStatuses: {} }),
}));
