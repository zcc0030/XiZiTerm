import type { FastifyInstance } from 'fastify';
import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  VaultItemType,
} from '@xiziterm/shared';
import type { SyncDatabase } from '../db/database.js';
import { authenticateRequest } from './auth.routes.js';

const VALID_ITEM_TYPES = new Set<VaultItemType>([
  'group',
  'host',
  'snippet',
  'preferences',
]);

export function registerSyncRoutes(
  app: FastifyInstance,
  db: SyncDatabase
): void {
  app.get<{ Querystring: { sinceSeq?: string } }>(
    '/api/sync/pull',
    async (req, reply) => {
      const auth = authenticateRequest(req, db);
      if (!auth) {
        return reply.code(401).send({ error: '未授权或 Token 已失效' });
      }

      const parsed = Number(req.query?.sinceSeq ?? 0);
      const sinceSeq = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;

      const result: SyncPullResponse = db.pullItems(auth.user.id, sinceSeq);
      return reply.send(result);
    }
  );

  app.post<{ Body: SyncPushRequest }>('/api/sync/push', async (req, reply) => {
    const auth = authenticateRequest(req, db);
    if (!auth) {
      return reply.code(401).send({ error: '未授权或 Token 已失效' });
    }

    const baseSeq = Number(req.body?.baseSeq ?? 0);
    const items = req.body?.items;

    if (!Array.isArray(items)) {
      return reply.code(400).send({ error: 'items 必须为密文信封数组' });
    }

    for (const item of items) {
      if (
        !item ||
        typeof item.itemId !== 'string' ||
        !VALID_ITEM_TYPES.has(item.itemType) ||
        typeof item.iv !== 'string' ||
        typeof item.authTag !== 'string' ||
        typeof item.ciphertext !== 'string' ||
        typeof item.clientUpdatedAt !== 'number'
      ) {
        return reply.code(400).send({ error: '包含格式非法的加密信封' });
      }
    }

    const result: SyncPushResponse = db.pushItems(
      auth.user.id,
      Number.isFinite(baseSeq) && baseSeq >= 0 ? Math.floor(baseSeq) : 0,
      items
    );
    return reply.send(result);
  });
}
