export interface SyncableRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
}

export interface HostGroup extends SyncableRecord {
  name: string;
  parentId: string | null;
  color: string;
  sortOrder: number;
}

export type HostAuthType = 'password' | 'privateKey';

export interface HostConfig extends SyncableRecord {
  groupId: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: HostAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  tags: string[];
  notes: string;
  keepAliveInterval: number; // seconds, 0 disables keepalive
}

export interface HostInput {
  id?: string;
  groupId: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: HostAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  tags: string[];
  notes: string;
  keepAliveInterval: number;
}

export interface HostGroupInput {
  id?: string;
  name: string;
  parentId: string | null;
  color: string;
  sortOrder?: number;
}

export interface Snippet extends SyncableRecord {
  title: string;
  command: string;
  category: string;
  tags: string[];
  description: string;
}

export interface SnippetInput {
  id?: string;
  title: string;
  command: string;
  category: string;
  tags: string[];
  description: string;
}

export type TerminalCursorStyle = 'block' | 'bar' | 'underline';

export interface UserPreferences extends SyncableRecord {
  id: 'preferences';
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  autoReconnectPrompt: boolean;
  scrollback: number;
}

export const DEFAULT_PREFERENCES: Omit<
  UserPreferences,
  'createdAt' | 'updatedAt' | 'deletedAt' | 'syncVersion'
> = {
  id: 'preferences',
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.25,
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: true,
  autoReconnectPrompt: true,
  scrollback: 5000,
};

export interface VaultData {
  groups: HostGroup[];
  hosts: HostConfig[];
  snippets: Snippet[];
  preferences: UserPreferences;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  vaultDir: string;
  deviceId?: string;
  kdfAlgorithm?: string;
  kdfIterations?: number;
}
