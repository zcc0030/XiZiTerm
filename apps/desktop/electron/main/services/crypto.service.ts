import crypto from 'crypto';
import {
  buildEnvelopeAad,
  buildLegacyEnvelopeAad,
  CRYPTO_CONSTANTS,
  type CipherPayload,
  type EncryptedEnvelope,
  type KdfParams,
  type VaultItemType,
} from '@xiziterm/shared';

export function generateSalt(): string {
  return crypto.randomBytes(CRYPTO_CONSTANTS.SALT_BYTES).toString('base64');
}

export function createDefaultKdfParams(): KdfParams {
  return {
    algorithm: CRYPTO_CONSTANTS.KDF_ALGORITHM,
    iterations: CRYPTO_CONSTANTS.KDF_ITERATIONS,
    keyLength: CRYPTO_CONSTANTS.KDF_KEY_LENGTH,
    salt: generateSalt(),
  };
}

export function deriveMasterKey(password: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const saltBuf = Buffer.from(kdf.salt, 'base64');
    crypto.pbkdf2(
      password,
      saltBuf,
      kdf.iterations,
      kdf.keyLength,
      'sha512',
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      }
    );
  });
}

export function encryptPayload(
  key: Buffer,
  plaintext: string,
  aad: string
): CipherPayload {
  const iv = crypto.randomBytes(CRYPTO_CONSTANTS.IV_BYTES);
  const cipher = crypto.createCipheriv(CRYPTO_CONSTANTS.AES_ALGORITHM, key, iv, {
    authTagLength: CRYPTO_CONSTANTS.AUTH_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptPayload(
  key: Buffer,
  payload: CipherPayload,
  aad: string
): string {
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv(
    CRYPTO_CONSTANTS.AES_ALGORITHM,
    key,
    iv,
    { authTagLength: CRYPTO_CONSTANTS.AUTH_TAG_BYTES }
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function createKeyCheck(key: Buffer): CipherPayload {
  const aad = buildEnvelopeAad('key_check', CRYPTO_CONSTANTS.KEY_CHECK_ITEM_ID);
  return encryptPayload(key, CRYPTO_CONSTANTS.KEY_CHECK_PLAINTEXT, aad);
}

export function verifyKeyCheck(key: Buffer, keyCheck: CipherPayload): boolean {
  try {
    const aad = buildEnvelopeAad('key_check', CRYPTO_CONSTANTS.KEY_CHECK_ITEM_ID);
    const plaintext = decryptPayload(key, keyCheck, aad);
    if (plaintext === CRYPTO_CONSTANTS.KEY_CHECK_PLAINTEXT) {
      return true;
    }
  } catch {
    // Fallback to legacy v1 domain tag if vault was created prior to XiZiTerm rename
  }

  try {
    const legacyAad = buildLegacyEnvelopeAad(
      'key_check',
      CRYPTO_CONSTANTS.KEY_CHECK_ITEM_ID
    );
    const plaintext = decryptPayload(key, keyCheck, legacyAad);
    return plaintext === CRYPTO_CONSTANTS.LEGACY_KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export function encryptVaultItem<T>(
  key: Buffer,
  itemType: VaultItemType,
  itemId: string,
  record: T,
  meta: { isDeleted: boolean; clientUpdatedAt: number; dirty?: boolean; serverSeq?: number }
): EncryptedEnvelope {
  const schemaVersion = CRYPTO_CONSTANTS.SCHEMA_VERSION;
  const aad = buildEnvelopeAad(itemType, itemId, schemaVersion);
  const cipher = encryptPayload(key, JSON.stringify(record), aad);

  return {
    itemId,
    itemType,
    schemaVersion,
    ...cipher,
    isDeleted: meta.isDeleted,
    clientUpdatedAt: meta.clientUpdatedAt,
    dirty: meta.dirty ?? true,
    serverSeq: meta.serverSeq,
  };
}

export function decryptVaultItem<T>(
  key: Buffer,
  envelope: EncryptedEnvelope
): T {
  const aad = buildEnvelopeAad(
    envelope.itemType,
    envelope.itemId,
    envelope.schemaVersion
  );
  try {
    const plaintext = decryptPayload(key, envelope, aad);
    return JSON.parse(plaintext) as T;
  } catch {
    const legacyAad = buildLegacyEnvelopeAad(
      envelope.itemType,
      envelope.itemId,
      envelope.schemaVersion
    );
    const plaintext = decryptPayload(key, envelope, legacyAad);
    return JSON.parse(plaintext) as T;
  }
}

export function zeroBuffer(buf: Buffer | null): void {
  if (buf) {
    buf.fill(0);
  }
}
