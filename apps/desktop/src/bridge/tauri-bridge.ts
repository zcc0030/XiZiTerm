import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  IPC_CHANNELS,
  type HostMetricsSnapshot,
  type MonitorErrorEvent,
  type SftpTransferProgressEvent,
  type SshDataEvent,
  type SshStateEvent,
  type SyncDeployLogEvent,
  type SyncStatusInfo,
  type XiZiTermApi,
} from '@xiziterm/shared';

function subscribeEvent<T>(
  eventName: string,
  listener: (payload: T) => void
): () => void {
  let disposed = false;
  let unlistenFn: (() => void) | null = null;

  void listen<T>(eventName, (event) => {
    if (!disposed) {
      listener(event.payload);
    }
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
    } else {
      unlistenFn = unlisten;
    }
  });

  return () => {
    disposed = true;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

const tauriApi: XiZiTermApi = {
  vault: {
    getStatus: () => invoke('vault_status'),
    initialize: (masterPassword) =>
      invoke('vault_init', { masterPassword }),
    unlock: (masterPassword) =>
      invoke('vault_unlock', { masterPassword }),
    lock: () => invoke('vault_lock'),
    getData: () => invoke('vault_get_data'),
    saveGroup: (input) => invoke('vault_save_group', { input }),
    deleteGroup: (groupId) => invoke('vault_delete_group', { groupId }),
    saveHost: (input) => invoke('vault_save_host', { input }),
    deleteHost: (hostId) => invoke('vault_delete_host', { hostId }),
    saveSnippet: (input) => invoke('vault_save_snippet', { input }),
    deleteSnippet: (snippetId) =>
      invoke('vault_delete_snippet', { snippetId }),
    updatePreferences: (patch) =>
      invoke('vault_update_preferences', { patch }),
  },
  dialog: {
    openPrivateKeyFile: () => invoke('dialog_open_key_file'),
  },
  ssh: {
    connect: (req) => invoke('ssh_connect', { req }),
    testConnection: (req) => invoke('ssh_test_connection', { req }),
    listLocalShells: (refresh) =>
      invoke('local_list_shells', { refresh: refresh ?? false }),
    write: (sessionId, data) => {
      void invoke('ssh_write', { sessionId, data });
    },
    resize: (payload) => {
      void invoke('ssh_resize', { payload });
    },
    disconnect: (sessionId) => invoke('ssh_disconnect', { sessionId }),
    onData: (listener) =>
      subscribeEvent<SshDataEvent>(IPC_CHANNELS.SSH_DATA, listener),
    onState: (listener) =>
      subscribeEvent<SshStateEvent>(IPC_CHANNELS.SSH_STATE, listener),
  },
  sftp: {
    list: (sessionId, remotePath) =>
      invoke('sftp_list', { sessionId, remotePath: remotePath ?? null }),
    mkdir: (sessionId, remotePath) =>
      invoke('sftp_mkdir', { sessionId, remotePath }),
    createFile: (sessionId, remotePath) =>
      invoke('sftp_create_file', { sessionId, remotePath }),
    rename: (sessionId, oldPath, newPath) =>
      invoke('sftp_rename', { sessionId, oldPath, newPath }),
    deleteEntry: (sessionId, remotePath, isDirectory) =>
      invoke('sftp_delete', { sessionId, remotePath, isDirectory }),
    chmod: (sessionId, remotePath, octalMode) =>
      invoke('sftp_chmod', { sessionId, remotePath, octalMode }),
    uploadPick: (sessionId, remoteDir) =>
      invoke('sftp_upload_pick', { sessionId, remoteDir }),
    uploadPaths: (sessionId, localPaths, remoteDir) =>
      invoke('sftp_upload_paths', { sessionId, localPaths, remoteDir }),
    download: (sessionId, remotePath, suggestedName) =>
      invoke('sftp_download', { sessionId, remotePath, suggestedName }),
    readText: (sessionId, remotePath) =>
      invoke('sftp_read_text', { sessionId, remotePath }),
    writeText: (sessionId, remotePath, content) =>
      invoke('sftp_write_text', { sessionId, remotePath, content }),
    getPathForFile: (file) => {
      const maybePath = (file as File & { path?: string }).path;
      return typeof maybePath === 'string' ? maybePath : '';
    },
    onNativeFileDrop: (listener) => {
      let disposed = false;
      let unlistenFn: (() => void) | null = null;

      try {
        void getCurrentWebview()
          .onDragDropEvent((ev) => {
            if (disposed) return;
            const p = ev.payload;
            if (p.type === 'enter') {
              listener({ type: 'enter', paths: p.paths });
            } else if (p.type === 'over') {
              listener({ type: 'over' });
            } else if (p.type === 'leave') {
              listener({ type: 'leave' });
            } else if (p.type === 'drop') {
              listener({ type: 'drop', paths: p.paths });
            }
          })
          .then((unlisten) => {
            if (disposed) {
              unlisten();
            } else {
              unlistenFn = unlisten;
            }
          });
      } catch {
        // ignore outside Tauri webview
      }

      return () => {
        disposed = true;
        if (unlistenFn) {
          unlistenFn();
          unlistenFn = null;
        }
      };
    },
    onTransferProgress: (listener) =>
      subscribeEvent<SftpTransferProgressEvent>(
        IPC_CHANNELS.SFTP_TRANSFER_PROGRESS,
        listener
      ),
  },
  monitor: {
    start: (sessionId, intervalMs) =>
      invoke('monitor_start', { sessionId, intervalMs: intervalMs ?? 2500 }),
    stop: (sessionId) => invoke('monitor_stop', { sessionId }),
    onSample: (listener) =>
      subscribeEvent<HostMetricsSnapshot>(IPC_CHANNELS.MONITOR_SAMPLE, listener),
    onError: (listener) =>
      subscribeEvent<MonitorErrorEvent>(IPC_CHANNELS.MONITOR_ERROR, listener),
  },
  sync: {
    getStatus: () => invoke('sync_status'),
    testServer: (serverUrl) => invoke('sync_test_server', { serverUrl }),
    register: (payload) => invoke('sync_register', { payload }),
    login: (payload) => invoke('sync_login', { payload }),
    bindToken: (payload) => invoke('sync_bind_token', { payload }),
    testWebdav: (payload) => invoke('sync_test_webdav', { payload }),
    bindWebdav: (payload) => invoke('sync_bind_webdav', { payload }),
    syncNow: (options) => invoke('sync_now', { options: options ?? null }),
    updateOptions: (patch) => invoke('sync_update_options', { patch }),
    getToken: () => invoke('sync_get_token'),
    disconnect: () => invoke('sync_disconnect'),
    restoreVault: (payload) => invoke('sync_restore_vault', { payload }),
    onStateChanged: (listener) =>
      subscribeEvent<{ status: SyncStatusInfo; vaultUpdated: boolean }>(
        IPC_CHANNELS.SYNC_STATE_EVENT,
        listener
      ),
    getDeployTemplates: () => invoke('sync_get_deploy_templates'),
    exportDeployBundle: () => invoke('sync_export_deploy_bundle'),
    oneClickDeploy: (payload) => invoke('sync_one_click_deploy', { payload }),
    onDeployLog: (listener) =>
      subscribeEvent<SyncDeployLogEvent>(
        IPC_CHANNELS.SYNC_DEPLOY_LOG,
        listener
      ),
  },
};

if (typeof window !== 'undefined' && !window.xiziterm) {
  window.xiziterm = tauriApi;
}

export { tauriApi };
