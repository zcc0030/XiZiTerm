import path from 'path';
import { promises as fs } from 'fs';
import { safeStorage } from 'electron';
import {
  CRYPTO_CONSTANTS,
  type SyncAuthResponse,
  type SyncBindCredentials,
  type SyncBindTokenPayload,
  type SyncMeResponse,
  type SyncProviderType,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncRestorePayload,
  type SyncRunResult,
  type SyncRuntimeState,
  type SyncStatusInfo,
  type SyncWebDavBindPayload,
  type SyncWebDavTestPayload,
  type SyncWebDavTestResult,
  type VaultData,
  type WebDavVaultBundle,
} from '@xiziterm/shared';
import { vaultService } from './vault.service';
import {
  getWebDavVaultBundle,
  normalizeWebDavTarget,
  putWebDavVaultBundle,
  testWebDavConnection,
  WebDavConflictError,
  type WebDavConnectionConfig,
} from './webdav.client';

type SyncStateListener = (payload: {
  status: SyncStatusInfo;
  vaultUpdated: boolean;
}) => void;

type StoredSyncSecret =
  | { provider: 'self-hosted'; token: string }
  | { provider: 'webdav'; password: string };

export const REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX =
  'NEED_REMOTE_MASTER_PASSWORD:';

function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error('服务器地址必须以 http:// 或 https:// 开头');
  }
  return trimmed;
}

async function httpJson<T>(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    token?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000
  );

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const errMsg =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `服务器返回错误 HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    return parsed as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('连接云同步服务器超时，请检查地址与网络');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class SyncService {
  private runtimeState: SyncRuntimeState = 'idle';
  private lastError: string | null = null;
  private cachedSecret: StoredSyncSecret | null = null;
  private syncingPromise: Promise<SyncRunResult> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stateListener: SyncStateListener | null = null;

  constructor() {
    vaultService.onLocalMutation(() => {
      this.scheduleAutoPush();
    });
  }

  setStateListener(listener: SyncStateListener): void {
    this.stateListener = listener;
  }

  private get secretPath(): string {
    return path.join(vaultService.getVaultDir(), 'sync.token.bin');
  }

  private async saveSecret(secret: StoredSyncSecret): Promise<void> {
    this.cachedSecret = secret;
    const serialized = JSON.stringify(secret);
    await fs.mkdir(vaultService.getVaultDir(), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(serialized);
      await fs.writeFile(this.secretPath, encrypted, { mode: 0o600 });
    } else {
      await fs.writeFile(this.secretPath, Buffer.from(serialized, 'utf8'), {
        mode: 0o600,
      });
    }
  }

  private async loadSecret(): Promise<StoredSyncSecret | null> {
    if (this.cachedSecret) return this.cachedSecret;
    try {
      const rawBuf = await fs.readFile(this.secretPath);
      const text = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(rawBuf)
        : rawBuf.toString('utf8').trim();

      if (!text) return null;

      if (text.startsWith('{')) {
        const parsed = JSON.parse(text) as StoredSyncSecret;
        this.cachedSecret = parsed;
        return parsed;
      }

      // Backward compatibility with plain self-hosted Bearer token
      this.cachedSecret = { provider: 'self-hosted', token: text.trim() };
      return this.cachedSecret;
    } catch {
      return null;
    }
  }

  private async clearSecret(): Promise<void> {
    this.cachedSecret = null;
    try {
      await fs.unlink(this.secretPath);
    } catch {
      // ignore if missing
    }
  }

  async getToken(): Promise<string | null> {
    const secret = await this.loadSecret();
    if (secret?.provider === 'self-hosted') {
      return secret.token;
    }
    return null;
  }

  async getStatus(): Promise<SyncStatusInfo> {
    const meta = vaultService.getMeta();
    const sync = meta?.sync;
    const secret = await this.loadSecret();
    const provider: SyncProviderType = sync?.provider ?? 'self-hosted';

    return {
      enabled: Boolean(sync?.enabled),
      provider,
      serverUrl: sync?.serverUrl ?? '',
      username: sync?.username ?? '',
      webdavRemoteDir: sync?.webdavRemoteDir ?? '/XiZiTerm',
      lastServerSeq: sync?.lastServerSeq ?? 0,
      lastSyncedAt: sync?.lastSyncedAt ?? null,
      autoSyncOnUnlock: sync?.autoSyncOnUnlock ?? true,
      autoPushOnChange: sync?.autoPushOnChange ?? true,
      pendingCount: vaultService.getPendingCount(),
      state: this.runtimeState,
      lastError: this.lastError,
      hasToken:
        provider === 'self-hosted'
          ? Boolean(secret?.provider === 'self-hosted' && secret.token)
          : Boolean(secret?.provider === 'webdav' && secret.password),
    };
  }

  private async emitState(vaultUpdated = false): Promise<void> {
    if (!this.stateListener) return;
    const status = await this.getStatus();
    this.stateListener({ status, vaultUpdated });
  }

  // --- Self-Hosted VPS Methods ---

  async testServer(
    serverUrl: string
  ): Promise<{ version: string; timestamp: number }> {
    const base = normalizeServerUrl(serverUrl);
    const res = await httpJson<{
      status: string;
      version: string;
      timestamp: number;
    }>(`${base}/api/health`, { timeoutMs: 8000 });
    if (res?.status !== 'ok') {
      throw new Error('目标地址不是有效的 XiZiTerm 云同步服务端');
    }
    return { version: res.version || '0.1.0', timestamp: res.timestamp };
  }

  async registerAndBind(payload: SyncBindCredentials): Promise<SyncStatusInfo> {
    if (!vaultService.isUnlocked()) {
      throw new Error('请先解锁本地保险库');
    }
    const meta = vaultService.getMeta();
    if (!meta) throw new Error('未找到本地保险库元数据');

    const base = normalizeServerUrl(payload.serverUrl);
    const auth = await httpJson<SyncAuthResponse>(`${base}/api/auth/register`, {
      method: 'POST',
      body: {
        username: payload.username.trim(),
        password: payload.password,
        deviceId: meta.deviceId,
        kdf: meta.kdf,
        keyCheck: meta.keyCheck,
        inviteCode: payload.inviteCode?.trim() || undefined,
      },
    });

    await this.saveSecret({ provider: 'self-hosted', token: auth.token });
    await vaultService.updateSyncMeta({
      enabled: true,
      provider: 'self-hosted',
      serverUrl: base,
      username: auth.username,
      webdavLastEtag: null,
      lastServerSeq: 0,
      autoSyncOnUnlock: true,
      autoPushOnChange: true,
    });

    await this.syncNow({ forceFull: true });
    return this.getStatus();
  }

  async loginAndBind(payload: SyncBindCredentials): Promise<SyncStatusInfo> {
    if (!vaultService.isUnlocked()) {
      throw new Error('请先解锁本地保险库');
    }
    const meta = vaultService.getMeta();
    if (!meta) throw new Error('未找到本地保险库元数据');

    const base = normalizeServerUrl(payload.serverUrl);
    const auth = await httpJson<SyncAuthResponse>(`${base}/api/auth/login`, {
      method: 'POST',
      body: {
        username: payload.username.trim(),
        password: payload.password,
        deviceId: meta.deviceId,
      },
    });

    if (
      auth.kdf.salt !== meta.kdf.salt ||
      !vaultService.verifyMasterKeyAgainst(auth.keyCheck)
    ) {
      if (payload.masterPassword) {
        await vaultService.adoptRemoteKdf(
          payload.masterPassword,
          auth.kdf,
          auth.keyCheck
        );
      } else {
        throw new Error(
          `${REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该云端账号已有加密保险库（加密盐值与本机不同），请在下方输入云端保险库的主密码以验证并自动合并数据`
        );
      }
    }

    await this.saveSecret({ provider: 'self-hosted', token: auth.token });
    await vaultService.updateSyncMeta({
      enabled: true,
      provider: 'self-hosted',
      serverUrl: base,
      username: auth.username,
      webdavLastEtag: null,
      lastServerSeq: 0,
      autoSyncOnUnlock: true,
      autoPushOnChange: true,
    });

    await this.syncNow({ forceFull: true });
    return this.getStatus();
  }

  async bindWithToken(payload: SyncBindTokenPayload): Promise<SyncStatusInfo> {
    if (!vaultService.isUnlocked()) {
      throw new Error('请先解锁本地保险库');
    }
    const meta = vaultService.getMeta();
    if (!meta) throw new Error('未找到本地保险库元数据');

    const base = normalizeServerUrl(payload.serverUrl);
    const token = payload.token.trim();
    if (!token) throw new Error('请输入有效的认证 Token');

    const me = await httpJson<SyncMeResponse>(`${base}/api/auth/me`, {
      method: 'GET',
      token,
    });

    if (
      me.kdf.salt !== meta.kdf.salt ||
      !vaultService.verifyMasterKeyAgainst(me.keyCheck)
    ) {
      if (payload.masterPassword) {
        await vaultService.adoptRemoteKdf(
          payload.masterPassword,
          me.kdf,
          me.keyCheck
        );
      } else {
        throw new Error(
          `${REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该 Token 对应的云端已有加密保险库（盐值与本机不同），请在下方输入云端保险库的主密码以验证并合并`
        );
      }
    }

    await this.saveSecret({ provider: 'self-hosted', token });
    await vaultService.updateSyncMeta({
      enabled: true,
      provider: 'self-hosted',
      serverUrl: base,
      username: me.username,
      webdavLastEtag: null,
      lastServerSeq: 0,
      autoSyncOnUnlock: true,
      autoPushOnChange: true,
    });

    await this.syncNow({ forceFull: true });
    return this.getStatus();
  }

  // --- WebDAV Methods ---

  async testWebdav(
    payload: SyncWebDavTestPayload
  ): Promise<SyncWebDavTestResult> {
    return testWebDavConnection({
      serverUrl: payload.serverUrl,
      username: payload.username,
      password: payload.password,
      remoteDir: payload.remoteDir,
    });
  }

  async bindWebdav(payload: SyncWebDavBindPayload): Promise<SyncStatusInfo> {
    if (!vaultService.isUnlocked()) {
      throw new Error('请先解锁本地保险库');
    }
    const meta = vaultService.getMeta();
    if (!meta) throw new Error('未找到本地保险库元数据');

    const config: WebDavConnectionConfig = {
      serverUrl: payload.serverUrl.trim(),
      username: payload.username.trim(),
      password: payload.password,
      remoteDir: payload.remoteDir.trim() || '/XiZiTerm',
    };

    const target = normalizeWebDavTarget(config.serverUrl, config.remoteDir);

    // Step 1: Verify WebDAV reachability, credentials & directory write capability
    const check = await testWebDavConnection(config);
    if (!check.writable) {
      const shareHint =
        check.availableShares && check.availableShares.length > 0
          ? `（检测到可用共享目录：${check.availableShares
              .slice(0, 6)
              .map((s) => `/${s}/XiZiTerm`)
              .join('、')}）`
          : '';
      throw new Error(`${check.message}${shareHint}`);
    }

    // Step 2: Check if an existing encrypted vault bundle already lives on WebDAV
    const existing = await getWebDavVaultBundle(config);
    if (existing.status === 'ok') {
      const { kdf, keyCheck } = existing.bundle;
      if (
        kdf.salt !== meta.kdf.salt ||
        !vaultService.verifyMasterKeyAgainst(keyCheck)
      ) {
        if (payload.masterPassword) {
          await vaultService.adoptRemoteKdf(
            payload.masterPassword,
            kdf,
            keyCheck
          );
        } else {
          throw new Error(
            `${REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该 WebDAV 目录中已存在加密保险库，请在下方输入该云端保险库的主密码以验证并自动合并本地与云端数据`
          );
        }
      }
    }

    await this.saveSecret({ provider: 'webdav', password: config.password });
    await vaultService.updateSyncMeta({
      enabled: true,
      provider: 'webdav',
      serverUrl: config.serverUrl,
      username: config.username,
      webdavRemoteDir: target.normalizedDir,
      webdavLastEtag: null,
      lastServerSeq: 0,
      autoSyncOnUnlock: true,
      autoPushOnChange: true,
    });

    await this.syncNow({ forceFull: true });
    return this.getStatus();
  }

  // --- New Device Cloud Restore (Self-Hosted OR WebDAV) ---

  async restoreVaultFromCloud(payload: SyncRestorePayload): Promise<VaultData> {
    const provider: SyncProviderType = payload.provider ?? 'self-hosted';

    if (provider === 'webdav') {
      const config: WebDavConnectionConfig = {
        serverUrl: payload.serverUrl.trim(),
        username: (payload.username ?? '').trim(),
        password: payload.password ?? '',
        remoteDir: payload.webdavRemoteDir?.trim() || '/XiZiTerm',
      };
      if (!config.username || !config.password) {
        throw new Error('请输入 WebDAV 账号和应用密码');
      }

      const target = normalizeWebDavTarget(config.serverUrl, config.remoteDir);
      const remoteRes = await getWebDavVaultBundle(config);
      if (remoteRes.status !== 'ok') {
        throw new Error(
          `在 WebDAV 目录 ${target.normalizedDir} 中未找到加密保险库文件 (xiziterm-vault.enc.json)`
        );
      }

      const { bundle, etag } = remoteRes;
      await vaultService.initializeFromRemote({
        masterPassword: payload.masterPassword,
        kdf: bundle.kdf,
        keyCheck: bundle.keyCheck,
        provider: 'webdav',
        serverUrl: config.serverUrl,
        username: config.username,
        webdavRemoteDir: target.normalizedDir,
      });

      await this.saveSecret({ provider: 'webdav', password: config.password });
      await vaultService.mergeSnapshotEnvelopes(bundle.items);
      await vaultService.markSnapshotUploaded(bundle.revision, etag);
      this.runtimeState = 'synced';
      this.lastError = null;
      await this.emitState(true);
      return vaultService.getActiveData();
    }

    // Self-Hosted VPS restore
    const base = normalizeServerUrl(payload.serverUrl);
    let token = '';
    let username = '';
    let kdf: SyncMeResponse['kdf'];
    let keyCheck: SyncMeResponse['keyCheck'];

    if (payload.mode === 'token') {
      token = (payload.token ?? '').trim();
      if (!token) throw new Error('请输入认证 Token');
      const me = await httpJson<SyncMeResponse>(`${base}/api/auth/me`, {
        method: 'GET',
        token,
      });
      username = me.username;
      kdf = me.kdf;
      keyCheck = me.keyCheck;
    } else {
      const auth = await httpJson<SyncAuthResponse>(`${base}/api/auth/login`, {
        method: 'POST',
        body: {
          username: (payload.username ?? '').trim(),
          password: payload.password ?? '',
          deviceId: 'restore-device',
        },
      });
      token = auth.token;
      username = auth.username;
      kdf = auth.kdf;
      keyCheck = auth.keyCheck;
    }

    await vaultService.initializeFromRemote({
      masterPassword: payload.masterPassword,
      kdf,
      keyCheck,
      provider: 'self-hosted',
      serverUrl: base,
      username,
    });

    await this.saveSecret({ provider: 'self-hosted', token });
    await this.syncNow({ forceFull: true });
    return vaultService.getActiveData();
  }

  async updateOptions(patch: {
    autoSyncOnUnlock?: boolean;
    autoPushOnChange?: boolean;
  }): Promise<SyncStatusInfo> {
    await vaultService.updateSyncMeta(patch);
    await this.emitState(false);
    return this.getStatus();
  }

  async disconnect(): Promise<SyncStatusInfo> {
    this.cancelPendingAutoPush();
    const meta = vaultService.getMeta();
    const secret = await this.loadSecret();
    const provider: SyncProviderType = meta?.sync.provider ?? 'self-hosted';

    if (
      provider === 'self-hosted' &&
      meta?.sync.serverUrl &&
      secret?.provider === 'self-hosted' &&
      secret.token
    ) {
      try {
        await httpJson(`${meta.sync.serverUrl}/api/auth/logout`, {
          method: 'POST',
          token: secret.token,
          timeoutMs: 4000,
        });
      } catch {
        // ignore network errors during disconnect
      }
    }

    await this.clearSecret();
    await vaultService.updateSyncMeta({
      enabled: false,
      webdavLastEtag: null,
      lastServerSeq: 0,
    });
    this.runtimeState = 'idle';
    this.lastError = null;
    await this.emitState(false);
    return this.getStatus();
  }

  onVaultUnlocked(): void {
    const meta = vaultService.getMeta();
    if (meta?.sync.enabled && (meta.sync.autoSyncOnUnlock ?? true)) {
      void this.syncNow().catch(() => {
        // Error already recorded in runtimeState & emitted
      });
    } else {
      void this.emitState(false);
    }
  }

  onVaultLocked(): void {
    this.cancelPendingAutoPush();
    this.runtimeState = 'idle';
    this.lastError = null;
  }

  private cancelPendingAutoPush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleAutoPush(): void {
    const meta = vaultService.getMeta();
    if (
      !vaultService.isUnlocked() ||
      !meta?.sync.enabled ||
      !(meta.sync.autoPushOnChange ?? true)
    ) {
      return;
    }

    this.cancelPendingAutoPush();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow().catch(() => {
        // Error captured in status
      });
    }, 1500);
  }

  async syncNow(
    options: { forceFull?: boolean } = {}
  ): Promise<SyncRunResult> {
    if (this.syncingPromise) {
      return this.syncingPromise;
    }

    const run = this.executeSync(options);
    this.syncingPromise = run;
    try {
      return await run;
    } finally {
      this.syncingPromise = null;
    }
  }

  private async executeSync(options: {
    forceFull?: boolean;
  }): Promise<SyncRunResult> {
    if (!vaultService.isUnlocked()) {
      throw new Error('保险库处于锁定状态，无法执行同步');
    }
    const meta = vaultService.getMeta();
    if (!meta?.sync.enabled || !meta.sync.serverUrl) {
      throw new Error('尚未配置云同步服务');
    }

    const provider: SyncProviderType = meta.sync.provider ?? 'self-hosted';

    this.runtimeState = 'syncing';
    this.lastError = null;
    await this.emitState(false);

    try {
      const result =
        provider === 'webdav'
          ? await this.executeWebDavSync(options)
          : await this.executeSelfHostedSync(options);

      this.runtimeState = 'synced';
      this.lastError = null;
      await this.emitState(result.pulledCount > 0 || result.conflictCount > 0);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runtimeState = 'error';
      this.lastError = msg;
      await this.emitState(false);
      throw err;
    }
  }

  private async executeSelfHostedSync(options: {
    forceFull?: boolean;
  }): Promise<SyncRunResult> {
    const meta = vaultService.getMeta()!;
    const secret = await this.loadSecret();
    if (!secret || secret.provider !== 'self-hosted' || !secret.token) {
      throw new Error('缺少认证 Token，请重新登录云同步账号');
    }

    const token = secret.token;
    const base = meta.sync.serverUrl;
    const sinceSeq = options.forceFull ? 0 : meta.sync.lastServerSeq;

    const pullRes = await httpJson<SyncPullResponse>(
      `${base}/api/sync/pull?sinceSeq=${sinceSeq}`,
      { method: 'GET', token }
    );

    let pulledCount = 0;
    let conflictCount = 0;

    if (
      pullRes.items.length > 0 ||
      pullRes.latestSeq > meta.sync.lastServerSeq
    ) {
      const applied = await vaultService.applyRemoteEnvelopes(
        pullRes.items,
        pullRes.latestSeq
      );
      pulledCount += applied.appliedCount;
      conflictCount += applied.conflictCount;
    }

    const latestBaseSeq =
      vaultService.getMeta()?.sync.lastServerSeq ?? pullRes.latestSeq;
    const toPush = vaultService.getEnvelopesForPush(Boolean(options.forceFull));
    let pushedCount = 0;
    let finalSeq = latestBaseSeq;

    if (toPush.length > 0) {
      const pushRes = await httpJson<SyncPushResponse>(
        `${base}/api/sync/push`,
        {
          method: 'POST',
          token,
          body: {
            baseSeq: latestBaseSeq,
            items: toPush,
          },
        }
      );

      pushedCount = pushRes.accepted.length;
      finalSeq = Math.max(finalSeq, pushRes.acceptedSeq);

      if (pushRes.accepted.length > 0) {
        await vaultService.markEnvelopesAccepted(
          pushRes.accepted,
          pushRes.acceptedSeq
        );
      }

      if (pushRes.conflicts.length > 0) {
        const reconciled = await vaultService.applyRemoteEnvelopes(
          pushRes.conflicts,
          finalSeq
        );
        pulledCount += reconciled.appliedCount;
        conflictCount += reconciled.conflictCount;
      }
    } else {
      await vaultService.updateSyncMeta({ lastSyncedAt: Date.now() });
    }

    return {
      pulledCount,
      pushedCount,
      conflictCount,
      latestSeq: finalSeq,
      syncedAt: Date.now(),
    };
  }

  private async executeWebDavSync(options: {
    forceFull?: boolean;
  }): Promise<SyncRunResult> {
    const secret = await this.loadSecret();
    if (!secret || secret.provider !== 'webdav' || !secret.password) {
      throw new Error('缺少 WebDAV 密码凭据，请重新绑定 WebDAV 同步');
    }

    let totalPulled = 0;
    let totalConflict = 0;

    // Retry up to 2 times if another device updated WebDAV concurrently (HTTP 412)
    for (let attempt = 0; attempt < 2; attempt++) {
      const currentMeta = vaultService.getMeta()!;
      const config: WebDavConnectionConfig = {
        serverUrl: currentMeta.sync.serverUrl,
        username: currentMeta.sync.username,
        password: secret.password,
        remoteDir: currentMeta.sync.webdavRemoteDir || '/XiZiTerm',
      };

      const hasLocalPending = vaultService.getPendingCount() > 0;
      const canUseEtagCache =
        !options.forceFull &&
        !hasLocalPending &&
        attempt === 0 &&
        Boolean(currentMeta.sync.webdavLastEtag);

      const getRes = await getWebDavVaultBundle(
        config,
        canUseEtagCache ? currentMeta.sync.webdavLastEtag : null
      );

      if (getRes.status === 'not_modified') {
        const syncedAt = Date.now();
        await vaultService.updateSyncMeta({ lastSyncedAt: syncedAt });
        return {
          pulledCount: totalPulled,
          pushedCount: 0,
          conflictCount: totalConflict,
          latestSeq: currentMeta.sync.lastServerSeq,
          syncedAt,
        };
      }

      if (getRes.status === 'not_found') {
        // First upload to this WebDAV directory
        const nextRev = 1;
        const snapshot = vaultService.buildSnapshotMapForUpload(nextRev);
        const bundle: WebDavVaultBundle = {
          format: 'xiziterm-e2ee-webdav-v1',
          schemaVersion: CRYPTO_CONSTANTS.SCHEMA_VERSION,
          updatedAt: Date.now(),
          updatedByDeviceId: currentMeta.deviceId,
          revision: nextRev,
          kdf: currentMeta.kdf,
          keyCheck: currentMeta.keyCheck,
          items: snapshot.items,
        };

        const putRes = await putWebDavVaultBundle(config, bundle);
        await vaultService.markSnapshotUploaded(nextRev, putRes.etag);

        return {
          pulledCount: totalPulled,
          pushedCount: Object.keys(snapshot.items).length,
          conflictCount: totalConflict,
          latestSeq: nextRev,
          syncedAt: Date.now(),
        };
      }

      // Existing remote bundle found -> verify KDF + keyCheck before merging
      const { bundle: remoteBundle, etag } = getRes;
      if (
        remoteBundle.kdf.salt !== currentMeta.kdf.salt ||
        !vaultService.verifyMasterKeyAgainst(remoteBundle.keyCheck)
      ) {
        throw new Error(
          'WebDAV 远端保险库的加密盐值或主密码与本机不一致，已中止同步以保护数据安全'
        );
      }

      const merged = await vaultService.mergeSnapshotEnvelopes(
        remoteBundle.items
      );
      totalPulled += merged.pulledCount;
      totalConflict += merged.conflictCount;

      if (!options.forceFull && !merged.needsPush) {
        const syncedAt = Date.now();
        await vaultService.updateSyncMeta({
          lastServerSeq: remoteBundle.revision,
          webdavLastEtag: etag,
          lastSyncedAt: syncedAt,
        });
        return {
          pulledCount: totalPulled,
          pushedCount: 0,
          conflictCount: totalConflict,
          latestSeq: remoteBundle.revision,
          syncedAt,
        };
      }

      const nextRev = (remoteBundle.revision || 0) + 1;
      const snapshot = vaultService.buildSnapshotMapForUpload(nextRev);
      const updatedBundle: WebDavVaultBundle = {
        format: 'xiziterm-e2ee-webdav-v1',
        schemaVersion: CRYPTO_CONSTANTS.SCHEMA_VERSION,
        updatedAt: Date.now(),
        updatedByDeviceId: currentMeta.deviceId,
        revision: nextRev,
        kdf: currentMeta.kdf,
        keyCheck: currentMeta.keyCheck,
        items: snapshot.items,
      };

      try {
        const putRes = await putWebDavVaultBundle(config, updatedBundle, {
          expectedEtag: etag,
          expectedRevision: remoteBundle.revision,
        });
        await vaultService.markSnapshotUploaded(nextRev, putRes.etag);
        return {
          pulledCount: totalPulled,
          pushedCount:
            snapshot.pushedCount > 0
              ? snapshot.pushedCount
              : options.forceFull
                ? Object.keys(snapshot.items).length
                : 0,
          conflictCount: totalConflict,
          latestSeq: nextRev,
          syncedAt: Date.now(),
        };
      } catch (err) {
        if (err instanceof WebDavConflictError && attempt === 0) {
          // Concurrent update detected via ETag -> loop once to re-pull & merge
          continue;
        }
        throw err;
      }
    }

    throw new Error('WebDAV 并发写入冲突重试失败，请稍后再试');
  }
}

export const syncService = new SyncService();
