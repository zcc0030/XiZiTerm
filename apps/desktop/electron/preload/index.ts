import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC_CHANNELS,
  type HostMetricsSnapshot,
  type MonitorErrorEvent,
  type XiZiTermApi,
  type SftpTransferProgressEvent,
  type SshDataEvent,
  type SshStateEvent,
  type SyncDeployLogEvent,
  type SyncStatusInfo,
} from '@xiziterm/shared';

const api: XiZiTermApi = {
  vault: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.VAULT_STATUS),
    initialize: (masterPassword) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_INIT, masterPassword),
    unlock: (masterPassword) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_UNLOCK, masterPassword),
    lock: () => ipcRenderer.invoke(IPC_CHANNELS.VAULT_LOCK),
    getData: () => ipcRenderer.invoke(IPC_CHANNELS.VAULT_GET_DATA),
    saveGroup: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_SAVE_GROUP, input),
    deleteGroup: (groupId) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_DELETE_GROUP, groupId),
    saveHost: (input) => ipcRenderer.invoke(IPC_CHANNELS.VAULT_SAVE_HOST, input),
    deleteHost: (hostId) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_DELETE_HOST, hostId),
    saveSnippet: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_SAVE_SNIPPET, input),
    deleteSnippet: (snippetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_DELETE_SNIPPET, snippetId),
    updatePreferences: (patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.VAULT_UPDATE_PREFERENCES, patch),
  },
  dialog: {
    openPrivateKeyFile: () =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_KEY_FILE),
  },
  ssh: {
    connect: (req) => ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECT, req),
    write: (sessionId, data) =>
      ipcRenderer.send(IPC_CHANNELS.SSH_WRITE, { sessionId, data }),
    resize: (payload) => ipcRenderer.send(IPC_CHANNELS.SSH_RESIZE, payload),
    disconnect: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.SSH_DISCONNECT, sessionId),
    onData: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, data: SshDataEvent) => {
        listener(data);
      };
      ipcRenderer.on(IPC_CHANNELS.SSH_DATA, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SSH_DATA, handler);
      };
    },
    onState: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: SshStateEvent
      ) => {
        listener(state);
      };
      ipcRenderer.on(IPC_CHANNELS.SSH_STATE, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SSH_STATE, handler);
      };
    },
  },
  sftp: {
    list: (sessionId, remotePath) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_LIST, sessionId, remotePath),
    mkdir: (sessionId, remotePath) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_MKDIR, sessionId, remotePath),
    createFile: (sessionId, remotePath) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_CREATE_FILE, sessionId, remotePath),
    rename: (sessionId, oldPath, newPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_RENAME, sessionId, oldPath, newPath),
    deleteEntry: (sessionId, remotePath, isDirectory) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.SFTP_DELETE,
        sessionId,
        remotePath,
        isDirectory
      ),
    chmod: (sessionId, remotePath, octalMode) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.SFTP_CHMOD,
        sessionId,
        remotePath,
        octalMode
      ),
    uploadPick: (sessionId, remoteDir) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_UPLOAD_PICK, sessionId, remoteDir),
    uploadPaths: (sessionId, localPaths, remoteDir) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.SFTP_UPLOAD_PATHS,
        sessionId,
        localPaths,
        remoteDir
      ),
    download: (sessionId, remotePath, suggestedName) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.SFTP_DOWNLOAD,
        sessionId,
        remotePath,
        suggestedName
      ),
    readText: (sessionId, remotePath) =>
      ipcRenderer.invoke(IPC_CHANNELS.SFTP_READ_TEXT, sessionId, remotePath),
    writeText: (sessionId, remotePath, content) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.SFTP_WRITE_TEXT,
        sessionId,
        remotePath,
        content
      ),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    onTransferProgress: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: SftpTransferProgressEvent
      ) => {
        listener(event);
      };
      ipcRenderer.on(IPC_CHANNELS.SFTP_TRANSFER_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.SFTP_TRANSFER_PROGRESS,
          handler
        );
      };
    },
  },
  monitor: {
    start: (sessionId, intervalMs) =>
      ipcRenderer.invoke(IPC_CHANNELS.MONITOR_START, sessionId, intervalMs),
    stop: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.MONITOR_STOP, sessionId),
    onSample: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: HostMetricsSnapshot
      ) => {
        listener(snapshot);
      };
      ipcRenderer.on(IPC_CHANNELS.MONITOR_SAMPLE, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.MONITOR_SAMPLE, handler);
      };
    },
    onError: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: MonitorErrorEvent
      ) => {
        listener(event);
      };
      ipcRenderer.on(IPC_CHANNELS.MONITOR_ERROR, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.MONITOR_ERROR, handler);
      };
    },
  },
  sync: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_STATUS),
    testServer: (serverUrl) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_TEST_SERVER, serverUrl),
    register: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_REGISTER, payload),
    login: (payload) => ipcRenderer.invoke(IPC_CHANNELS.SYNC_LOGIN, payload),
    bindToken: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_BIND_TOKEN, payload),
    testWebdav: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_TEST_WEBDAV, payload),
    bindWebdav: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_BIND_WEBDAV, payload),
    syncNow: (options) => ipcRenderer.invoke(IPC_CHANNELS.SYNC_NOW, options),
    updateOptions: (patch) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_UPDATE_OPTIONS, patch),
    getToken: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_GET_TOKEN),
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.SYNC_DISCONNECT),
    restoreVault: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_RESTORE_VAULT, payload),
    onStateChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { status: SyncStatusInfo; vaultUpdated: boolean }
      ) => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.SYNC_STATE_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SYNC_STATE_EVENT, handler);
      };
    },
    getDeployTemplates: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_GET_DEPLOY_TEMPLATES),
    exportDeployBundle: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_EXPORT_DEPLOY_BUNDLE),
    oneClickDeploy: (payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.SYNC_ONE_CLICK_DEPLOY, payload),
    onDeployLog: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: SyncDeployLogEvent
      ) => {
        listener(event);
      };
      ipcRenderer.on(IPC_CHANNELS.SYNC_DEPLOY_LOG, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SYNC_DEPLOY_LOG, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('xiziterm', api);
