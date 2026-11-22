import type {
  CipherPayload,
  EncryptedEnvelope,
  KdfParams,
  SyncProviderType,
} from '../crypto/constants.js';

export interface SyncRegisterRequest {
  username: string;
  password: string; // VPS auth password (NEVER the master password)
  deviceId: string;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  inviteCode?: string;
}

export interface SyncLoginRequest {
  username: string;
  password: string;
  deviceId: string;
}

export interface SyncAuthResponse {
  token: string;
  userId: string;
  username: string;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  latestSeq: number;
}

export interface SyncMeResponse {
  userId: string;
  username: string;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  latestSeq: number;
}

export interface SyncPullResponse {
  latestSeq: number;
  items: EncryptedEnvelope[];
}

export interface SyncPushRequest {
  baseSeq: number;
  items: EncryptedEnvelope[];
}

export interface SyncPushAcceptedItem {
  itemId: string;
  serverSeq: number;
}

export interface SyncPushResponse {
  acceptedSeq: number;
  accepted: SyncPushAcceptedItem[];
  conflicts: EncryptedEnvelope[];
}

export type SyncRuntimeState = 'idle' | 'syncing' | 'synced' | 'error';

export interface SyncStatusInfo {
  enabled: boolean;
  provider: SyncProviderType;
  serverUrl: string;
  username: string;
  webdavRemoteDir?: string;
  lastServerSeq: number;
  lastSyncedAt: number | null;
  autoSyncOnUnlock: boolean;
  autoPushOnChange: boolean;
  pendingCount: number;
  state: SyncRuntimeState;
  lastError: string | null;
  hasToken: boolean;
}

export interface SyncRunResult {
  pulledCount: number;
  pushedCount: number;
  conflictCount: number;
  latestSeq: number;
  syncedAt: number;
}

export interface SyncBindCredentials {
  serverUrl: string;
  username: string;
  password: string;
  inviteCode?: string;
  masterPassword?: string;
}

export interface SyncBindTokenPayload {
  serverUrl: string;
  token: string;
  masterPassword?: string;
}

export interface SyncWebDavTestPayload {
  serverUrl: string;
  username: string;
  password: string;
  remoteDir: string;
}

export interface SyncWebDavTestResult {
  folderExists: boolean;
  hasVaultFile: boolean;
  writable: boolean;
  availableShares?: string[];
  message: string;
}

export interface SyncWebDavBindPayload {
  serverUrl: string;
  username: string;
  password: string;
  remoteDir: string;
  masterPassword?: string;
}

export interface WebDavVaultBundle {
  format: 'xiziterm-e2ee-webdav-v1' | 'nexusterm-e2ee-webdav-v1';
  schemaVersion: number;
  updatedAt: number;
  updatedByDeviceId: string;
  revision: number;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  items: Record<string, EncryptedEnvelope>;
}

export interface SyncRestorePayload {
  provider?: SyncProviderType;
  serverUrl: string;
  mode: 'password' | 'token';
  username?: string;
  password?: string;
  token?: string;
  webdavRemoteDir?: string;
  masterPassword: string;
}

export interface SyncDeployTemplates {
  dockerfile: string;
  dockerCompose: string;
  envExample: string;
}

export interface SyncOneClickDeployPayload {
  host: string;
  sshPort: number;
  username: string;
  password: string;
  syncPort: number;
  remoteDir: string;
  inviteCode?: string;
}

export interface SyncDeployLogEvent {
  deployId: string;
  level: 'info' | 'step' | 'warn' | 'error' | 'success';
  message: string;
  timestamp: number;
}

export interface SyncOneClickDeployResult {
  serverUrl: string;
  remoteHealthOk: boolean;
  clientReachable: boolean;
  version?: string;
  warning?: string;
}
