export const CRYPTO_CONSTANTS = {
  SCHEMA_VERSION: 1,
  KDF_ALGORITHM: 'pbkdf2-sha512' as const,
  KDF_ITERATIONS: 600_000,
  KDF_KEY_LENGTH: 32, // 256-bit AES key
  SALT_BYTES: 32,
  AES_ALGORITHM: 'aes-256-gcm' as const,
  IV_BYTES: 12, // 96-bit GCM nonce
  AUTH_TAG_BYTES: 16,
  KEY_CHECK_PLAINTEXT: 'XIZITERM_KEY_CHECK_V1',
  LEGACY_KEY_CHECK_PLAINTEXT: 'NEXUSTERM_KEY_CHECK_V1',
  KEY_CHECK_ITEM_ID: '__key_check__',
} as const;

export type KdfAlgorithm = typeof CRYPTO_CONSTANTS.KDF_ALGORITHM;

export interface KdfParams {
  algorithm: KdfAlgorithm;
  iterations: number;
  keyLength: number;
  salt: string; // Base64
}

export interface CipherPayload {
  iv: string; // Base64 (12 bytes)
  authTag: string; // Base64 (16 bytes)
  ciphertext: string; // Base64
}

export type VaultItemType = 'group' | 'host' | 'snippet' | 'preferences';

export interface EncryptedEnvelope extends CipherPayload {
  itemId: string;
  itemType: VaultItemType;
  schemaVersion: number;
  isDeleted: boolean;
  clientUpdatedAt: number;
  serverSeq?: number;
  dirty?: boolean;
}

export type SyncProviderType = 'self-hosted' | 'webdav';

export interface SyncConfigMeta {
  enabled: boolean;
  provider?: SyncProviderType;
  serverUrl: string;
  username: string;
  webdavRemoteDir?: string;
  webdavLastEtag?: string | null;
  lastServerSeq: number;
  lastSyncedAt: number | null;
  autoSyncOnUnlock?: boolean;
  autoPushOnChange?: boolean;
}

export interface VaultMeta {
  schemaVersion: number;
  deviceId: string;
  createdAt: number;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  sync: SyncConfigMeta;
}

export function buildEnvelopeAad(
  itemType: VaultItemType | 'key_check',
  itemId: string,
  schemaVersion: number = CRYPTO_CONSTANTS.SCHEMA_VERSION
): string {
  return `xiziterm:v${schemaVersion}:${itemType}:${itemId}`;
}

export function buildLegacyEnvelopeAad(
  itemType: VaultItemType | 'key_check',
  itemId: string,
  schemaVersion: number = CRYPTO_CONSTANTS.SCHEMA_VERSION
): string {
  return `nexusterm:v${schemaVersion}:${itemType}:${itemId}`;
}
