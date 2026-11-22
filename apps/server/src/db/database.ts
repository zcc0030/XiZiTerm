import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  CipherPayload,
  EncryptedEnvelope,
  KdfParams,
  SyncPushAcceptedItem,
  VaultItemType,
} from '@xiziterm/shared';

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  kdf: KdfParams;
  keyCheck: CipherPayload;
  nextSeq: number;
  createdAt: number;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  kdf_json: string;
  key_check_json: string;
  next_seq: number;
  created_at: number;
}

interface RawVaultItemRow {
  item_id: string;
  item_type: VaultItemType;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  schema_version: number;
  is_deleted: number;
  client_updated_at: number;
  server_seq: number;
}

function mapUserRow(row: RawUserRow): UserRow {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    kdf: JSON.parse(row.kdf_json) as KdfParams,
    keyCheck: JSON.parse(row.key_check_json) as CipherPayload,
    nextSeq: Number(row.next_seq),
    createdAt: Number(row.created_at),
  };
}

function mapVaultItemRow(row: RawVaultItemRow): EncryptedEnvelope {
  return {
    itemId: row.item_id,
    itemType: row.item_type,
    schemaVersion: Number(row.schema_version),
    iv: row.iv,
    authTag: row.auth_tag,
    ciphertext: row.ciphertext,
    isDeleted: Number(row.is_deleted) === 1,
    clientUpdatedAt: Number(row.client_updated_at),
    serverSeq: Number(row.server_seq),
    dirty: false,
  };
}

export class SyncDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        kdf_json TEXT NOT NULL,
        key_check_json TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

      CREATE TABLE IF NOT EXISTS vault_items (
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        client_updated_at INTEGER NOT NULL,
        server_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, item_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_vault_items_user_seq
        ON vault_items(user_id, server_seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  findUserByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as RawUserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  findUserById(userId: string): UserRow | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(userId) as RawUserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  createUser(params: {
    username: string;
    passwordHash: string;
    kdf: KdfParams;
    keyCheck: CipherPayload;
  }): UserRow {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, kdf_json, key_check_json, next_seq, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        id,
        params.username,
        params.passwordHash,
        JSON.stringify(params.kdf),
        JSON.stringify(params.keyCheck),
        now
      );

    return {
      id,
      username: params.username,
      passwordHash: params.passwordHash,
      kdf: params.kdf,
      keyCheck: params.keyCheck,
      nextSeq: 0,
      createdAt: now,
    };
  }

  createSession(params: {
    userId: string;
    tokenHash: string;
    deviceId: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        params.userId,
        params.tokenHash,
        params.deviceId,
        params.expiresAt,
        Date.now()
      );
  }

  findUserByTokenHash(tokenHash: string): UserRow | null {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT u.*
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(tokenHash, now) as RawUserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  revokeSession(tokenHash: string): void {
    this.db
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(tokenHash);
  }

  pullItems(
    userId: string,
    sinceSeq: number
  ): { latestSeq: number; items: EncryptedEnvelope[] } {
    const user = this.findUserById(userId);
    const latestSeq = user?.nextSeq ?? 0;

    const rows = this.db
      .prepare(
        `SELECT item_id, item_type, ciphertext, iv, auth_tag, schema_version,
                is_deleted, client_updated_at, server_seq
         FROM vault_items
         WHERE user_id = ? AND server_seq > ?
         ORDER BY server_seq ASC`
      )
      .all(userId, sinceSeq) as unknown as RawVaultItemRow[];

    return {
      latestSeq,
      items: rows.map(mapVaultItemRow),
    };
  }

  pushItems(
    userId: string,
    baseSeq: number,
    envelopes: EncryptedEnvelope[]
  ): {
    acceptedSeq: number;
    accepted: SyncPushAcceptedItem[];
    conflicts: EncryptedEnvelope[];
  } {
    const accepted: SyncPushAcceptedItem[] = [];
    const conflicts: EncryptedEnvelope[] = [];
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const userRow = this.db
        .prepare('SELECT next_seq FROM users WHERE id = ?')
        .get(userId) as { next_seq: number } | undefined;

      if (!userRow) {
        throw new Error('User not found');
      }

      let currentSeq = Number(userRow.next_seq);

      const selectExisting = this.db.prepare(
        `SELECT item_id, item_type, ciphertext, iv, auth_tag, schema_version,
                is_deleted, client_updated_at, server_seq
         FROM vault_items
         WHERE user_id = ? AND item_id = ?`
      );

      const upsertItem = this.db.prepare(
        `INSERT INTO vault_items (
           user_id, item_id, item_type, ciphertext, iv, auth_tag,
           schema_version, is_deleted, client_updated_at, server_seq, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET
           item_type = excluded.item_type,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           schema_version = excluded.schema_version,
           is_deleted = excluded.is_deleted,
           client_updated_at = excluded.client_updated_at,
           server_seq = excluded.server_seq,
           updated_at = excluded.updated_at`
      );

      for (const item of envelopes) {
        const existing = selectExisting.get(userId, item.itemId) as
          | RawVaultItemRow
          | undefined;

        if (
          existing &&
          Number(existing.server_seq) > baseSeq &&
          Number(existing.client_updated_at) > item.clientUpdatedAt
        ) {
          // Server holds a newer timestamp than client -> conflict returned for client LWW reconciliation
          conflicts.push(mapVaultItemRow(existing));
          continue;
        }

        currentSeq += 1;
        upsertItem.run(
          userId,
          item.itemId,
          item.itemType,
          item.ciphertext,
          item.iv,
          item.authTag,
          item.schemaVersion,
          item.isDeleted ? 1 : 0,
          item.clientUpdatedAt,
          currentSeq,
          now
        );
        accepted.push({ itemId: item.itemId, serverSeq: currentSeq });
      }

      if (accepted.length > 0) {
        this.db
          .prepare('UPDATE users SET next_seq = ? WHERE id = ?')
          .run(currentSeq, userId);
      }

      this.db.exec('COMMIT');
      return { acceptedSeq: currentSeq, accepted, conflicts };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
