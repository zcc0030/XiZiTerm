import type {
  HostConfig,
  HostGroup,
  HostGroupInput,
  HostInput,
  Snippet,
  SnippetInput,
  UserPreferences,
  VaultData,
  VaultStatus,
} from '../types/vault.js';
import type {
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshResizePayload,
  SshStateEvent,
} from '../types/ssh.js';
import type {
  SftpListResult,
  SftpReadTextResult,
  SftpTransferProgressEvent,
} from '../types/sftp.js';
import type {
  HostMetricsSnapshot,
  MonitorErrorEvent,
} from '../types/monitor.js';
import type {
  SyncBindCredentials,
  SyncBindTokenPayload,
  SyncDeployLogEvent,
  SyncDeployTemplates,
  SyncOneClickDeployPayload,
  SyncOneClickDeployResult,
  SyncRestorePayload,
  SyncRunResult,
  SyncStatusInfo,
  SyncWebDavBindPayload,
  SyncWebDavTestPayload,
  SyncWebDavTestResult,
} from '../types/sync.js';

export const IPC_CHANNELS = {
  VAULT_STATUS: 'vault:status',
  VAULT_INIT: 'vault:init',
  VAULT_UNLOCK: 'vault:unlock',
  VAULT_LOCK: 'vault:lock',
  VAULT_GET_DATA: 'vault:get-data',
  VAULT_SAVE_GROUP: 'vault:save-group',
  VAULT_DELETE_GROUP: 'vault:delete-group',
  VAULT_SAVE_HOST: 'vault:save-host',
  VAULT_DELETE_HOST: 'vault:delete-host',
  VAULT_SAVE_SNIPPET: 'vault:save-snippet',
  VAULT_DELETE_SNIPPET: 'vault:delete-snippet',
  VAULT_UPDATE_PREFERENCES: 'vault:update-preferences',
  DIALOG_OPEN_KEY_FILE: 'dialog:open-key-file',
  SSH_CONNECT: 'ssh:connect',
  SSH_WRITE: 'ssh:write',
  SSH_RESIZE: 'ssh:resize',
  SSH_DISCONNECT: 'ssh:disconnect',
  SSH_DATA: 'ssh:data',
  SSH_STATE: 'ssh:state',
  SFTP_LIST: 'sftp:list',
  SFTP_MKDIR: 'sftp:mkdir',
  SFTP_CREATE_FILE: 'sftp:create-file',
  SFTP_RENAME: 'sftp:rename',
  SFTP_DELETE: 'sftp:delete',
  SFTP_CHMOD: 'sftp:chmod',
  SFTP_UPLOAD_PICK: 'sftp:upload-pick',
  SFTP_UPLOAD_PATHS: 'sftp:upload-paths',
  SFTP_DOWNLOAD: 'sftp:download',
  SFTP_READ_TEXT: 'sftp:read-text',
  SFTP_WRITE_TEXT: 'sftp:write-text',
  SFTP_TRANSFER_PROGRESS: 'sftp:transfer-progress',
  MONITOR_START: 'monitor:start',
  MONITOR_STOP: 'monitor:stop',
  MONITOR_SAMPLE: 'monitor:sample',
  MONITOR_ERROR: 'monitor:error',
  SYNC_STATUS: 'sync:status',
  SYNC_TEST_SERVER: 'sync:test-server',
  SYNC_REGISTER: 'sync:register',
  SYNC_LOGIN: 'sync:login',
  SYNC_BIND_TOKEN: 'sync:bind-token',
  SYNC_TEST_WEBDAV: 'sync:test-webdav',
  SYNC_BIND_WEBDAV: 'sync:bind-webdav',
  SYNC_NOW: 'sync:now',
  SYNC_UPDATE_OPTIONS: 'sync:update-options',
  SYNC_GET_TOKEN: 'sync:get-token',
  SYNC_DISCONNECT: 'sync:disconnect',
  SYNC_RESTORE_VAULT: 'sync:restore-vault',
  SYNC_STATE_EVENT: 'sync:state-event',
  SYNC_GET_DEPLOY_TEMPLATES: 'sync:get-deploy-templates',
  SYNC_EXPORT_DEPLOY_BUNDLE: 'sync:export-deploy-bundle',
  SYNC_ONE_CLICK_DEPLOY: 'sync:one-click-deploy',
  SYNC_DEPLOY_LOG: 'sync:deploy-log',
} as const;

export interface ActionResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface XiZiTermApi {
  vault: {
    getStatus: () => Promise<VaultStatus>;
    initialize: (masterPassword: string) => Promise<ActionResult<VaultData>>;
    unlock: (masterPassword: string) => Promise<ActionResult<VaultData>>;
    lock: () => Promise<ActionResult>;
    getData: () => Promise<ActionResult<VaultData>>;
    saveGroup: (input: HostGroupInput) => Promise<ActionResult<HostGroup>>;
    deleteGroup: (groupId: string) => Promise<ActionResult>;
    saveHost: (input: HostInput) => Promise<ActionResult<HostConfig>>;
    deleteHost: (hostId: string) => Promise<ActionResult>;
    saveSnippet: (input: SnippetInput) => Promise<ActionResult<Snippet>>;
    deleteSnippet: (snippetId: string) => Promise<ActionResult>;
    updatePreferences: (
      patch: Partial<
        Omit<
          UserPreferences,
          'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'syncVersion'
        >
      >
    ) => Promise<ActionResult<UserPreferences>>;
  };
  dialog: {
    openPrivateKeyFile: () => Promise<
      ActionResult<{ filePath: string; content: string } | null>
    >;
  };
  ssh: {
    connect: (req: SshConnectRequest) => Promise<SshConnectResult>;
    write: (sessionId: string, data: string) => void;
    resize: (payload: SshResizePayload) => void;
    disconnect: (sessionId: string) => Promise<void>;
    onData: (listener: (event: SshDataEvent) => void) => () => void;
    onState: (listener: (event: SshStateEvent) => void) => () => void;
  };
  sftp: {
    list: (
      sessionId: string,
      remotePath?: string
    ) => Promise<ActionResult<SftpListResult>>;
    mkdir: (sessionId: string, remotePath: string) => Promise<ActionResult>;
    createFile: (
      sessionId: string,
      remotePath: string
    ) => Promise<ActionResult>;
    rename: (
      sessionId: string,
      oldPath: string,
      newPath: string
    ) => Promise<ActionResult>;
    deleteEntry: (
      sessionId: string,
      remotePath: string,
      isDirectory: boolean
    ) => Promise<ActionResult>;
    chmod: (
      sessionId: string,
      remotePath: string,
      octalMode: string
    ) => Promise<ActionResult>;
    uploadPick: (
      sessionId: string,
      remoteDir: string
    ) => Promise<ActionResult<{ uploadedCount: number }>>;
    uploadPaths: (
      sessionId: string,
      localPaths: string[],
      remoteDir: string
    ) => Promise<ActionResult<{ uploadedCount: number }>>;
    download: (
      sessionId: string,
      remotePath: string,
      suggestedName: string
    ) => Promise<ActionResult<{ localPath: string } | null>>;
    readText: (
      sessionId: string,
      remotePath: string
    ) => Promise<ActionResult<SftpReadTextResult>>;
    writeText: (
      sessionId: string,
      remotePath: string,
      content: string
    ) => Promise<ActionResult>;
    getPathForFile: (file: File) => string;
    onTransferProgress: (
      listener: (event: SftpTransferProgressEvent) => void
    ) => () => void;
  };
  monitor: {
    start: (sessionId: string, intervalMs?: number) => Promise<ActionResult>;
    stop: (sessionId: string) => Promise<ActionResult>;
    onSample: (listener: (snapshot: HostMetricsSnapshot) => void) => () => void;
    onError: (listener: (event: MonitorErrorEvent) => void) => () => void;
  };
  sync: {
    getStatus: () => Promise<ActionResult<SyncStatusInfo>>;
    testServer: (
      serverUrl: string
    ) => Promise<ActionResult<{ version: string; timestamp: number }>>;
    register: (
      payload: SyncBindCredentials
    ) => Promise<ActionResult<SyncStatusInfo>>;
    login: (
      payload: SyncBindCredentials
    ) => Promise<ActionResult<SyncStatusInfo>>;
    bindToken: (
      payload: SyncBindTokenPayload
    ) => Promise<ActionResult<SyncStatusInfo>>;
    testWebdav: (
      payload: SyncWebDavTestPayload
    ) => Promise<ActionResult<SyncWebDavTestResult>>;
    bindWebdav: (
      payload: SyncWebDavBindPayload
    ) => Promise<ActionResult<SyncStatusInfo>>;
    syncNow: (options?: {
      forceFull?: boolean;
    }) => Promise<ActionResult<SyncRunResult>>;
    updateOptions: (patch: {
      autoSyncOnUnlock?: boolean;
      autoPushOnChange?: boolean;
    }) => Promise<ActionResult<SyncStatusInfo>>;
    getToken: () => Promise<ActionResult<string | null>>;
    disconnect: () => Promise<ActionResult<SyncStatusInfo>>;
    restoreVault: (
      payload: SyncRestorePayload
    ) => Promise<ActionResult<VaultData>>;
    onStateChanged: (
      listener: (event: {
        status: SyncStatusInfo;
        vaultUpdated: boolean;
      }) => void
    ) => () => void;
    getDeployTemplates: () => Promise<ActionResult<SyncDeployTemplates>>;
    exportDeployBundle: () => Promise<
      ActionResult<{ targetDir: string; fileCount: number } | null>
    >;
    oneClickDeploy: (
      payload: SyncOneClickDeployPayload
    ) => Promise<ActionResult<SyncOneClickDeployResult>>;
    onDeployLog: (listener: (event: SyncDeployLogEvent) => void) => () => void;
  };
}
