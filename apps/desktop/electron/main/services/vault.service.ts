import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import {
  CRYPTO_CONSTANTS,
  DEFAULT_PREFERENCES,
  type CipherPayload,
  type EncryptedEnvelope,
  type HostConfig,
  type HostGroup,
  type HostGroupInput,
  type HostInput,
  type KdfParams,
  type Snippet,
  type SnippetInput,
  type SyncConfigMeta,
  type SyncProviderType,
  type SyncPushAcceptedItem,
  type UserPreferences,
  type VaultData,
  type VaultMeta,
  type VaultStatus,
} from '@xiziterm/shared';
import {
  atomicWriteJson,
  ensureDir,
  fileExists,
  readJsonFile,
} from '../utils/atomic-file';
import {
  createDefaultKdfParams,
  createKeyCheck,
  decryptVaultItem,
  deriveMasterKey,
  encryptVaultItem,
  verifyKeyCheck,
  zeroBuffer,
} from './crypto.service';

interface VaultItemsDisk {
  schemaVersion: number;
  envelopes: Record<string, EncryptedEnvelope>;
}

export class VaultService {
  private masterKey: Buffer | null = null;
  private meta: VaultMeta | null = null;
  private envelopes: Record<string, EncryptedEnvelope> = {};
  private groups = new Map<string, HostGroup>();
  private hosts = new Map<string, HostConfig>();
  private snippets = new Map<string, Snippet>();
  private preferences: UserPreferences | null = null;
  private mutationListeners = new Set<() => void>();

  onLocalMutation(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  private emitLocalMutation(): void {
    for (const listener of this.mutationListeners) {
      listener();
    }
  }

  getVaultDir(): string {
    return this.vaultDir;
  }

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  getMeta(): VaultMeta | null {
    return this.meta;
  }

  private migrationChecked = false;

  private get vaultDir(): string {
    return path.join(app.getPath('userData'), 'vault');
  }

  private get metaPath(): string {
    return path.join(this.vaultDir, 'vault.meta.json');
  }

  private get itemsPath(): string {
    return path.join(this.vaultDir, 'vault.items.enc.json');
  }

  private async ensureLegacyVaultMigrated(): Promise<void> {
    if (this.migrationChecked) return;
    this.migrationChecked = true;

    if (await fileExists(this.metaPath)) {
      return;
    }

    const appDataRoot = app.getPath('appData');
    const legacyCandidates = [
      path.join(appDataRoot, '@nexusterm', 'desktop', 'vault'),
      path.join(appDataRoot, 'nexusterm', 'vault'),
      path.join(appDataRoot, 'NexusTerm', 'vault'),
    ];

    for (const legacyDir of legacyCandidates) {
      const legacyMeta = path.join(legacyDir, 'vault.meta.json');
      if (await fileExists(legacyMeta)) {
        await ensureDir(this.vaultDir);
        for (const filename of [
          'vault.meta.json',
          'vault.items.enc.json',
          'sync.token.bin',
        ]) {
          const src = path.join(legacyDir, filename);
          const dst = path.join(this.vaultDir, filename);
          if (await fileExists(src)) {
            await fs.copyFile(src, dst);
          }
        }
        return;
      }
    }
  }

  async getStatus(): Promise<VaultStatus> {
    await this.ensureLegacyVaultMigrated();
    const initialized = await fileExists(this.metaPath);
    if (initialized && !this.meta) {
      this.meta = await readJsonFile<VaultMeta>(this.metaPath);
    }
    return {
      initialized,
      unlocked: this.masterKey !== null,
      vaultDir: this.vaultDir,
      deviceId: this.meta?.deviceId,
      kdfAlgorithm: this.meta?.kdf.algorithm,
      kdfIterations: this.meta?.kdf.iterations,
    };
  }

  async initialize(masterPassword: string): Promise<VaultData> {
    if (masterPassword.length < 6) {
      throw new Error('主密码长度至少为 6 个字符');
    }
    if (await fileExists(this.metaPath)) {
      throw new Error('保险库已初始化，请使用主密码解锁');
    }

    await ensureDir(this.vaultDir);

    const kdf = createDefaultKdfParams();
    const derivedKey = await deriveMasterKey(masterPassword, kdf);
    const keyCheck = createKeyCheck(derivedKey);
    const now = Date.now();

    const meta: VaultMeta = {
      schemaVersion: CRYPTO_CONSTANTS.SCHEMA_VERSION,
      deviceId: crypto.randomUUID(),
      createdAt: now,
      kdf,
      keyCheck,
      sync: {
        enabled: false,
        serverUrl: '',
        username: '',
        lastServerSeq: 0,
        lastSyncedAt: null,
        autoSyncOnUnlock: true,
        autoPushOnChange: true,
      },
    };

    this.masterKey = derivedKey;
    this.meta = meta;
    this.envelopes = {};
    this.groups.clear();
    this.hosts.clear();
    this.snippets.clear();

    const defaultPrefs: UserPreferences = {
      ...DEFAULT_PREFERENCES,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
    };
    this.preferences = defaultPrefs;
    this.envelopes[defaultPrefs.id] = encryptVaultItem(
      derivedKey,
      'preferences',
      defaultPrefs.id,
      defaultPrefs,
      { isDeleted: false, clientUpdatedAt: now }
    );

    const defaultGroup: HostGroup = {
      id: crypto.randomUUID(),
      name: '默认服务器',
      parentId: null,
      color: '#06b6d4',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
    };
    this.groups.set(defaultGroup.id, defaultGroup);
    this.envelopes[defaultGroup.id] = encryptVaultItem(
      derivedKey,
      'group',
      defaultGroup.id,
      defaultGroup,
      { isDeleted: false, clientUpdatedAt: now }
    );

    await atomicWriteJson(this.metaPath, meta);
    await this.persistEnvelopes();

    return this.getActiveData();
  }

  async unlock(masterPassword: string): Promise<VaultData> {
    const meta = await readJsonFile<VaultMeta>(this.metaPath);
    if (!meta) {
      throw new Error('未找到本地保险库，请先初始化主密码');
    }

    const derivedKey = await deriveMasterKey(masterPassword, meta.kdf);
    const valid = verifyKeyCheck(derivedKey, meta.keyCheck);
    if (!valid) {
      zeroBuffer(derivedKey);
      throw new Error('主密码不正确，请重试');
    }

    const disk = await readJsonFile<VaultItemsDisk>(this.itemsPath);
    const envelopes = disk?.envelopes ?? {};

    this.groups.clear();
    this.hosts.clear();
    this.snippets.clear();
    this.preferences = null;

    for (const envelope of Object.values(envelopes)) {
      if (envelope.itemType === 'group') {
        const group = decryptVaultItem<HostGroup>(derivedKey, envelope);
        this.groups.set(group.id, group);
      } else if (envelope.itemType === 'host') {
        const host = decryptVaultItem<HostConfig>(derivedKey, envelope);
        this.hosts.set(host.id, host);
      } else if (envelope.itemType === 'snippet') {
        const snippet = decryptVaultItem<Snippet>(derivedKey, envelope);
        this.snippets.set(snippet.id, snippet);
      } else if (envelope.itemType === 'preferences') {
        this.preferences = decryptVaultItem<UserPreferences>(derivedKey, envelope);
      }
    }

    this.masterKey = derivedKey;
    this.meta = meta;
    this.envelopes = envelopes;

    if (!this.preferences) {
      const now = Date.now();
      this.preferences = {
        ...DEFAULT_PREFERENCES,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncVersion: 1,
      };
      await this.savePreferencesRecord(this.preferences);
    }

    return this.getActiveData();
  }

  lock(): void {
    zeroBuffer(this.masterKey);
    this.masterKey = null;
    this.groups.clear();
    this.hosts.clear();
    this.snippets.clear();
    this.preferences = null;
    this.envelopes = {};
  }

  private assertUnlocked(): Buffer {
    if (!this.masterKey) {
      throw new Error('保险库处于锁定状态，请先解锁');
    }
    return this.masterKey;
  }

  getActiveData(): VaultData {
    this.assertUnlocked();
    const groups = Array.from(this.groups.values())
      .filter((g) => g.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const hosts = Array.from(this.hosts.values())
      .filter((h) => h.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name));

    const snippets = Array.from(this.snippets.values())
      .filter((s) => s.deletedAt === null)
      .sort((a, b) => a.title.localeCompare(b.title));

    const now = Date.now();
    const preferences: UserPreferences = this.preferences ?? {
      ...DEFAULT_PREFERENCES,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
    };

    return { groups, hosts, snippets, preferences };
  }

  getHostById(hostId: string): HostConfig | null {
    this.assertUnlocked();
    const host = this.hosts.get(hostId);
    if (!host || host.deletedAt !== null) {
      return null;
    }
    return host;
  }

  async saveGroup(input: HostGroupInput): Promise<HostGroup> {
    const key = this.assertUnlocked();
    const now = Date.now();
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error('分组名称不能为空');
    }

    const existing = input.id ? this.groups.get(input.id) : undefined;
    const record: HostGroup = existing
      ? {
          ...existing,
          name: trimmedName,
          parentId: input.parentId ?? null,
          color: input.color || existing.color,
          sortOrder: input.sortOrder ?? existing.sortOrder,
          updatedAt: now,
          deletedAt: null,
          syncVersion: existing.syncVersion + 1,
        }
      : {
          id: input.id || crypto.randomUUID(),
          name: trimmedName,
          parentId: input.parentId ?? null,
          color: input.color || '#06b6d4',
          sortOrder: input.sortOrder ?? this.groups.size,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncVersion: 1,
        };

    this.groups.set(record.id, record);
    this.envelopes[record.id] = encryptVaultItem(key, 'group', record.id, record, {
      isDeleted: false,
      clientUpdatedAt: now,
      serverSeq: this.envelopes[record.id]?.serverSeq,
    });
    await this.persistEnvelopes();
    this.emitLocalMutation();
    return record;
  }

  async deleteGroup(groupId: string): Promise<void> {
    const key = this.assertUnlocked();
    const existing = this.groups.get(groupId);
    if (!existing) return;

    const now = Date.now();
    const tombstone: HostGroup = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: existing.syncVersion + 1,
    };
    this.groups.set(groupId, tombstone);
    this.envelopes[groupId] = encryptVaultItem(key, 'group', groupId, tombstone, {
      isDeleted: true,
      clientUpdatedAt: now,
      serverSeq: this.envelopes[groupId]?.serverSeq,
    });

    // Move hosts in deleted group back to ungrouped (groupId = null)
    for (const host of this.hosts.values()) {
      if (host.deletedAt === null && host.groupId === groupId) {
        const updatedHost: HostConfig = {
          ...host,
          groupId: null,
          updatedAt: now,
          syncVersion: host.syncVersion + 1,
        };
        this.hosts.set(host.id, updatedHost);
        this.envelopes[host.id] = encryptVaultItem(
          key,
          'host',
          host.id,
          updatedHost,
          {
            isDeleted: false,
            clientUpdatedAt: now,
            serverSeq: this.envelopes[host.id]?.serverSeq,
          }
        );
      }
    }

    await this.persistEnvelopes();
    this.emitLocalMutation();
  }

  async saveHost(input: HostInput): Promise<HostConfig> {
    const key = this.assertUnlocked();
    const now = Date.now();

    const name = input.name.trim();
    const hostname = input.hostname.trim();
    const username = input.username.trim();

    if (!name) throw new Error('主机别名不能为空');
    if (!hostname) throw new Error('主机地址 (IP/域名) 不能为空');
    if (!username) throw new Error('用户名不能为空');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error('端口必须是 1-65535 之间的整数');
    }

    const existing = input.id ? this.hosts.get(input.id) : undefined;
    const record: HostConfig = existing
      ? {
          ...existing,
          groupId: input.groupId ?? null,
          name,
          hostname,
          port: input.port,
          username,
          authType: input.authType,
          password: input.authType === 'password' ? input.password ?? '' : undefined,
          privateKey:
            input.authType === 'privateKey' ? input.privateKey ?? '' : undefined,
          passphrase:
            input.authType === 'privateKey' ? input.passphrase ?? '' : undefined,
          tags: Array.from(
            new Set(input.tags.map((t) => t.trim()).filter(Boolean))
          ),
          notes: input.notes ?? '',
          keepAliveInterval: Math.max(0, Number(input.keepAliveInterval) || 0),
          updatedAt: now,
          deletedAt: null,
          syncVersion: existing.syncVersion + 1,
        }
      : {
          id: input.id || crypto.randomUUID(),
          groupId: input.groupId ?? null,
          name,
          hostname,
          port: input.port,
          username,
          authType: input.authType,
          password: input.authType === 'password' ? input.password ?? '' : undefined,
          privateKey:
            input.authType === 'privateKey' ? input.privateKey ?? '' : undefined,
          passphrase:
            input.authType === 'privateKey' ? input.passphrase ?? '' : undefined,
          tags: Array.from(
            new Set(input.tags.map((t) => t.trim()).filter(Boolean))
          ),
          notes: input.notes ?? '',
          keepAliveInterval: Math.max(0, Number(input.keepAliveInterval) || 0),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncVersion: 1,
        };

    this.hosts.set(record.id, record);
    this.envelopes[record.id] = encryptVaultItem(key, 'host', record.id, record, {
      isDeleted: false,
      clientUpdatedAt: now,
      serverSeq: this.envelopes[record.id]?.serverSeq,
    });
    await this.persistEnvelopes();
    this.emitLocalMutation();
    return record;
  }

  async deleteHost(hostId: string): Promise<void> {
    const key = this.assertUnlocked();
    const existing = this.hosts.get(hostId);
    if (!existing) return;

    const now = Date.now();
    const tombstone: HostConfig = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: existing.syncVersion + 1,
    };
    this.hosts.set(hostId, tombstone);
    this.envelopes[hostId] = encryptVaultItem(key, 'host', hostId, tombstone, {
      isDeleted: true,
      clientUpdatedAt: now,
      serverSeq: this.envelopes[hostId]?.serverSeq,
    });
    await this.persistEnvelopes();
    this.emitLocalMutation();
  }

  async saveSnippet(input: SnippetInput): Promise<Snippet> {
    const key = this.assertUnlocked();
    const now = Date.now();

    const title = input.title.trim();
    const command = input.command.replace(/\r\n/g, '\n');
    const category = input.category.trim() || '常用命令';

    if (!title) throw new Error('快捷命令标题不能为空');
    if (!command.trim()) throw new Error('命令内容不能为空');

    const existing = input.id ? this.snippets.get(input.id) : undefined;
    const record: Snippet = existing
      ? {
          ...existing,
          title,
          command,
          category,
          tags: Array.from(
            new Set(input.tags.map((t) => t.trim()).filter(Boolean))
          ),
          description: input.description?.trim() ?? '',
          updatedAt: now,
          deletedAt: null,
          syncVersion: existing.syncVersion + 1,
        }
      : {
          id: input.id || crypto.randomUUID(),
          title,
          command,
          category,
          tags: Array.from(
            new Set(input.tags.map((t) => t.trim()).filter(Boolean))
          ),
          description: input.description?.trim() ?? '',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncVersion: 1,
        };

    this.snippets.set(record.id, record);
    this.envelopes[record.id] = encryptVaultItem(
      key,
      'snippet',
      record.id,
      record,
      {
        isDeleted: false,
        clientUpdatedAt: now,
        serverSeq: this.envelopes[record.id]?.serverSeq,
      }
    );
    await this.persistEnvelopes();
    this.emitLocalMutation();
    return record;
  }

  async deleteSnippet(snippetId: string): Promise<void> {
    const key = this.assertUnlocked();
    const existing = this.snippets.get(snippetId);
    if (!existing) return;

    const now = Date.now();
    const tombstone: Snippet = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: existing.syncVersion + 1,
    };
    this.snippets.set(snippetId, tombstone);
    this.envelopes[snippetId] = encryptVaultItem(
      key,
      'snippet',
      snippetId,
      tombstone,
      {
        isDeleted: true,
        clientUpdatedAt: now,
        serverSeq: this.envelopes[snippetId]?.serverSeq,
      }
    );
    await this.persistEnvelopes();
    this.emitLocalMutation();
  }

  async updatePreferences(
    patch: Partial<
      Omit<
        UserPreferences,
        'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'syncVersion'
      >
    >
  ): Promise<UserPreferences> {
    this.assertUnlocked();
    const now = Date.now();
    const current = this.preferences ?? {
      ...DEFAULT_PREFERENCES,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 0,
    };

    const next: UserPreferences = {
      ...current,
      ...patch,
      id: 'preferences',
      updatedAt: now,
      deletedAt: null,
      syncVersion: current.syncVersion + 1,
    };
    await this.savePreferencesRecord(next);
    this.emitLocalMutation();
    return next;
  }

  // --- Phase 5: E2EE Cloud Sync Helpers (Main-Process Only) ---

  verifyMasterKeyAgainst(remoteKeyCheck: CipherPayload): boolean {
    const key = this.assertUnlocked();
    return verifyKeyCheck(key, remoteKeyCheck);
  }

  getPendingCount(): number {
    if (!this.masterKey) return 0;
    return Object.values(this.envelopes).filter((env) => env.dirty !== false)
      .length;
  }

  getEnvelopesForPush(forceAll = false): EncryptedEnvelope[] {
    this.assertUnlocked();
    const list = Object.values(this.envelopes);
    return forceAll ? list : list.filter((env) => env.dirty !== false);
  }

  async updateSyncMeta(patch: Partial<SyncConfigMeta>): Promise<VaultMeta> {
    if (!this.meta) {
      const diskMeta = await readJsonFile<VaultMeta>(this.metaPath);
      if (!diskMeta) {
        throw new Error('本地保险库尚未初始化');
      }
      this.meta = diskMeta;
    }
    this.meta = {
      ...this.meta,
      sync: {
        ...this.meta.sync,
        ...patch,
      },
    };
    await atomicWriteJson(this.metaPath, this.meta);
    return this.meta;
  }

  async initializeFromRemote(params: {
    masterPassword: string;
    kdf: KdfParams;
    keyCheck: CipherPayload;
    provider?: SyncProviderType;
    serverUrl: string;
    username: string;
    webdavRemoteDir?: string;
  }): Promise<void> {
    if (await fileExists(this.metaPath)) {
      throw new Error('本地保险库已存在，请先解锁后再登录绑定云同步');
    }

    const derivedKey = await deriveMasterKey(params.masterPassword, params.kdf);
    if (!verifyKeyCheck(derivedKey, params.keyCheck)) {
      zeroBuffer(derivedKey);
      throw new Error('主密码与云端保险库不匹配，无法解密数据');
    }

    await ensureDir(this.vaultDir);

    const now = Date.now();
    const meta: VaultMeta = {
      schemaVersion: CRYPTO_CONSTANTS.SCHEMA_VERSION,
      deviceId: crypto.randomUUID(),
      createdAt: now,
      kdf: params.kdf,
      keyCheck: params.keyCheck,
      sync: {
        enabled: true,
        provider: params.provider ?? 'self-hosted',
        serverUrl: params.serverUrl,
        username: params.username,
        webdavRemoteDir: params.webdavRemoteDir,
        webdavLastEtag: null,
        lastServerSeq: 0,
        lastSyncedAt: null,
        autoSyncOnUnlock: true,
        autoPushOnChange: true,
      },
    };

    this.masterKey = derivedKey;
    this.meta = meta;
    this.envelopes = {};
    this.groups.clear();
    this.hosts.clear();
    this.snippets.clear();
    this.preferences = {
      ...DEFAULT_PREFERENCES,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 0,
    };

    await atomicWriteJson(this.metaPath, meta);
    await this.persistEnvelopes();
  }

  /**
   * When binding an already-initialized local vault to an existing remote vault
   * that has a different KDF salt, verify the remote master password and re-encrypt
   * all local items under the remote KDF key so both sides merge seamlessly.
   */
  async adoptRemoteKdf(
    remoteMasterPassword: string,
    remoteKdf: KdfParams,
    remoteKeyCheck: CipherPayload
  ): Promise<void> {
    this.assertUnlocked();
    if (!this.meta) {
      throw new Error('未找到本地保险库元数据');
    }

    const newKey = await deriveMasterKey(remoteMasterPassword, remoteKdf);
    if (!verifyKeyCheck(newKey, remoteKeyCheck)) {
      zeroBuffer(newKey);
      throw new Error('输入的云端主密码不正确，无法解密并合并云端保险库');
    }

    const nextEnvelopes: Record<string, EncryptedEnvelope> = {};

    for (const group of this.groups.values()) {
      // Skip untouched default empty group so it won't duplicate remote's default group
      const isUntouchedDefault =
        group.name === '默认服务器' &&
        group.syncVersion === 1 &&
        group.deletedAt === null &&
        !Array.from(this.hosts.values()).some((h) => h.groupId === group.id);
      if (isUntouchedDefault) {
        this.groups.delete(group.id);
        continue;
      }
      nextEnvelopes[group.id] = encryptVaultItem(
        newKey,
        'group',
        group.id,
        group,
        {
          isDeleted: group.deletedAt !== null,
          clientUpdatedAt: group.updatedAt,
          dirty: true,
        }
      );
    }

    for (const host of this.hosts.values()) {
      nextEnvelopes[host.id] = encryptVaultItem(newKey, 'host', host.id, host, {
        isDeleted: host.deletedAt !== null,
        clientUpdatedAt: host.updatedAt,
        dirty: true,
      });
    }

    for (const snippet of this.snippets.values()) {
      nextEnvelopes[snippet.id] = encryptVaultItem(
        newKey,
        'snippet',
        snippet.id,
        snippet,
        {
          isDeleted: snippet.deletedAt !== null,
          clientUpdatedAt: snippet.updatedAt,
          dirty: true,
        }
      );
    }

    if (this.preferences && this.preferences.syncVersion > 1) {
      nextEnvelopes[this.preferences.id] = encryptVaultItem(
        newKey,
        'preferences',
        this.preferences.id,
        this.preferences,
        {
          isDeleted: false,
          clientUpdatedAt: this.preferences.updatedAt,
          dirty: true,
        }
      );
    }

    zeroBuffer(this.masterKey);
    this.masterKey = newKey;
    this.envelopes = nextEnvelopes;
    this.meta = {
      ...this.meta,
      kdf: remoteKdf,
      keyCheck: remoteKeyCheck,
    };

    await atomicWriteJson(this.metaPath, this.meta);
    await this.persistEnvelopes();
  }

  async mergeSnapshotEnvelopes(
    remoteItems: Record<string, EncryptedEnvelope>
  ): Promise<{
    pulledCount: number;
    conflictCount: number;
    needsPush: boolean;
  }> {
    const key = this.assertUnlocked();
    let pulledCount = 0;
    let conflictCount = 0;
    let changed = false;

    for (const [itemId, remote] of Object.entries(remoteItems)) {
      const decoded = decryptVaultItem<
        HostGroup | HostConfig | Snippet | UserPreferences
      >(key, remote);

      const localEnv = this.envelopes[itemId];
      if (!localEnv) {
        this.storeDecodedItem(remote.itemType, decoded);
        this.envelopes[itemId] = { ...remote, dirty: false };
        pulledCount += 1;
        changed = true;
        continue;
      }

      if (localEnv.ciphertext === remote.ciphertext) {
        if (localEnv.dirty !== false) {
          localEnv.dirty = false;
          changed = true;
        }
        continue;
      }

      if (localEnv.dirty !== true) {
        if (remote.clientUpdatedAt >= localEnv.clientUpdatedAt) {
          this.storeDecodedItem(remote.itemType, decoded);
          this.envelopes[itemId] = { ...remote, dirty: false };
          pulledCount += 1;
          changed = true;
        }
        continue;
      }

      // Both local (dirty) and remote have different ciphertexts
      if (remote.clientUpdatedAt > localEnv.clientUpdatedAt) {
        conflictCount += 1;
        this.saveConflictCopyIfNeeded(key, localEnv);
        this.storeDecodedItem(remote.itemType, decoded);
        this.envelopes[itemId] = { ...remote, dirty: false };
        pulledCount += 1;
        changed = true;
      } else {
        // Local dirty edit is newer -> keep local dirty item so it gets pushed
        conflictCount += 1;
      }
    }

    if (changed) {
      await this.persistEnvelopes();
    }

    const needsPush = Object.entries(this.envelopes).some(([id, env]) => {
      if (env.dirty !== false) return true;
      const remote = remoteItems[id];
      return !remote || remote.ciphertext !== env.ciphertext;
    });

    return { pulledCount, conflictCount, needsPush };
  }

  buildSnapshotMapForUpload(nextRevision: number): {
    items: Record<string, EncryptedEnvelope>;
    pushedCount: number;
  } {
    this.assertUnlocked();
    const items: Record<string, EncryptedEnvelope> = {};
    let pushedCount = 0;

    for (const [id, env] of Object.entries(this.envelopes)) {
      const isDirty = env.dirty !== false;
      if (isDirty) {
        pushedCount += 1;
      }
      items[id] = {
        ...env,
        dirty: false,
        serverSeq: isDirty ? nextRevision : env.serverSeq ?? nextRevision,
      };
    }

    return { items, pushedCount };
  }

  async markSnapshotUploaded(
    revision: number,
    etag: string | null
  ): Promise<void> {
    this.assertUnlocked();
    for (const env of Object.values(this.envelopes)) {
      if (env.dirty !== false) {
        env.dirty = false;
        env.serverSeq = revision;
      }
    }
    await this.persistEnvelopes();
    if (this.meta) {
      await this.updateSyncMeta({
        lastServerSeq: revision,
        webdavLastEtag: etag,
        lastSyncedAt: Date.now(),
      });
    }
  }

  async applyRemoteEnvelopes(
    remoteEnvelopes: EncryptedEnvelope[],
    latestSeq: number
  ): Promise<{ appliedCount: number; conflictCount: number }> {
    const key = this.assertUnlocked();
    let appliedCount = 0;
    let conflictCount = 0;
    let changed = false;

    for (const remote of remoteEnvelopes) {
      // Decrypt and authenticate via AES-256-GCM + AAD
      const decoded = decryptVaultItem<
        HostGroup | HostConfig | Snippet | UserPreferences
      >(key, remote);

      const localEnv = this.envelopes[remote.itemId];
      const localDirty = localEnv?.dirty === true;

      if (localDirty && localEnv) {
        if (localEnv.clientUpdatedAt > remote.clientUpdatedAt) {
          // Local edit is newer -> preserve local dirty item to be pushed, record conflict
          conflictCount += 1;
          continue;
        }
        // Remote edit is newer than local dirty edit -> keep a safe conflict copy for hosts/snippets
        conflictCount += 1;
        this.saveConflictCopyIfNeeded(key, localEnv);
      }

      this.storeDecodedItem(remote.itemType, decoded);
      this.envelopes[remote.itemId] = {
        ...remote,
        dirty: false,
      };
      appliedCount += 1;
      changed = true;
    }

    if (changed) {
      await this.persistEnvelopes();
    }

    if (this.meta) {
      const nextSeq = Math.max(this.meta.sync.lastServerSeq, latestSeq);
      await this.updateSyncMeta({
        lastServerSeq: nextSeq,
        lastSyncedAt: Date.now(),
      });
    }

    return { appliedCount, conflictCount };
  }

  async markEnvelopesAccepted(
    accepted: SyncPushAcceptedItem[],
    acceptedSeq: number
  ): Promise<void> {
    this.assertUnlocked();
    for (const item of accepted) {
      const env = this.envelopes[item.itemId];
      if (env) {
        env.dirty = false;
        env.serverSeq = item.serverSeq;
      }
    }
    await this.persistEnvelopes();
    if (this.meta) {
      await this.updateSyncMeta({
        lastServerSeq: Math.max(this.meta.sync.lastServerSeq, acceptedSeq),
        lastSyncedAt: Date.now(),
      });
    }
  }

  private storeDecodedItem(
    itemType: EncryptedEnvelope['itemType'],
    decoded: HostGroup | HostConfig | Snippet | UserPreferences
  ): void {
    if (itemType === 'group') {
      const g = decoded as HostGroup;
      this.groups.set(g.id, g);
    } else if (itemType === 'host') {
      const h = decoded as HostConfig;
      this.hosts.set(h.id, h);
    } else if (itemType === 'snippet') {
      const s = decoded as Snippet;
      this.snippets.set(s.id, s);
    } else if (itemType === 'preferences') {
      this.preferences = decoded as UserPreferences;
    }
  }

  private saveConflictCopyIfNeeded(
    key: Buffer,
    localEnv: EncryptedEnvelope
  ): void {
    if (localEnv.isDeleted) return;
    const now = Date.now();
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;

    if (localEnv.itemType === 'host') {
      const localHost = this.hosts.get(localEnv.itemId);
      if (!localHost || localHost.deletedAt !== null) return;
      const copy: HostConfig = {
        ...localHost,
        id: crypto.randomUUID(),
        name: `${localHost.name} (冲突副本 ${stamp})`,
        createdAt: now,
        updatedAt: now,
        syncVersion: 1,
      };
      this.hosts.set(copy.id, copy);
      this.envelopes[copy.id] = encryptVaultItem(key, 'host', copy.id, copy, {
        isDeleted: false,
        clientUpdatedAt: now,
        dirty: true,
      });
    } else if (localEnv.itemType === 'snippet') {
      const localSnippet = this.snippets.get(localEnv.itemId);
      if (!localSnippet || localSnippet.deletedAt !== null) return;
      const copy: Snippet = {
        ...localSnippet,
        id: crypto.randomUUID(),
        title: `${localSnippet.title} (冲突副本 ${stamp})`,
        createdAt: now,
        updatedAt: now,
        syncVersion: 1,
      };
      this.snippets.set(copy.id, copy);
      this.envelopes[copy.id] = encryptVaultItem(
        key,
        'snippet',
        copy.id,
        copy,
        {
          isDeleted: false,
          clientUpdatedAt: now,
          dirty: true,
        }
      );
    }
  }

  private async savePreferencesRecord(record: UserPreferences): Promise<void> {
    const key = this.assertUnlocked();
    this.preferences = record;
    this.envelopes[record.id] = encryptVaultItem(
      key,
      'preferences',
      record.id,
      record,
      {
        isDeleted: false,
        clientUpdatedAt: record.updatedAt,
        serverSeq: this.envelopes[record.id]?.serverSeq,
      }
    );
    await this.persistEnvelopes();
  }

  private async persistEnvelopes(): Promise<void> {
    const payload: VaultItemsDisk = {
      schemaVersion: CRYPTO_CONSTANTS.SCHEMA_VERSION,
      envelopes: this.envelopes,
    };
    await atomicWriteJson(this.itemsPath, payload);
  }
}

export const vaultService = new VaultService();
