import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  SyncAuthResponse,
  SyncLoginRequest,
  SyncMeResponse,
  SyncRegisterRequest,
} from '@xiziterm/shared';
import type { ServerConfig } from '../config.js';
import type { SyncDatabase, UserRow } from '../db/database.js';
import {
  generateBearerToken,
  hashServerPassword,
  sha256Hex,
  verifyServerPassword,
} from '../utils/password.js';

export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function authenticateRequest(
  req: FastifyRequest,
  db: SyncDatabase
): { user: UserRow; tokenHash: string } | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const user = db.findUserByTokenHash(tokenHash);
  if (!user) return null;
  return { user, tokenHash };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: SyncDatabase,
  config: ServerConfig
): void {
  app.post<{ Body: SyncRegisterRequest }>(
    '/api/auth/register',
    async (req, reply) => {
      if (!config.allowRegistration) {
        return reply
          .code(403)
          .send({ error: '服务端已关闭新用户注册 (ALLOW_REGISTRATION=false)' });
      }

      const body = req.body;
      if (config.inviteCode && body?.inviteCode !== config.inviteCode) {
        return reply.code(403).send({ error: '邀请码不正确' });
      }

      const username = body?.username?.trim();
      const password = body?.password ?? '';
      const deviceId = body?.deviceId?.trim() || 'unknown-device';

      if (!username || username.length < 2 || username.length > 64) {
        return reply.code(400).send({ error: '用户名长度需在 2-64 字符之间' });
      }
      if (password.length < 6) {
        return reply
          .code(400)
          .send({ error: 'VPS 登录密码长度至少为 6 位' });
      }
      if (!body?.kdf?.salt || !body?.keyCheck?.ciphertext) {
        return reply
          .code(400)
          .send({ error: '缺少客户端 E2EE 密钥元数据 (kdf / keyCheck)' });
      }

      if (db.findUserByUsername(username)) {
        return reply.code(409).send({ error: '该用户名已存在，请直接登录' });
      }

      const passwordHash = await hashServerPassword(password);
      const user = db.createUser({
        username,
        passwordHash,
        kdf: body.kdf,
        keyCheck: body.keyCheck,
      });

      const token = generateBearerToken();
      const expiresAt =
        Date.now() + config.tokenTtlDays * 24 * 60 * 60 * 1000;
      db.createSession({
        userId: user.id,
        tokenHash: sha256Hex(token),
        deviceId,
        expiresAt,
      });

      const res: SyncAuthResponse = {
        token,
        userId: user.id,
        username: user.username,
        kdf: user.kdf,
        keyCheck: user.keyCheck,
        latestSeq: user.nextSeq,
      };
      return reply.code(201).send(res);
    }
  );

  app.post<{ Body: SyncLoginRequest }>('/api/auth/login', async (req, reply) => {
    const body = req.body;
    const username = body?.username?.trim();
    const password = body?.password ?? '';
    const deviceId = body?.deviceId?.trim() || 'unknown-device';

    if (!username || !password) {
      return reply.code(400).send({ error: '请输入用户名和 VPS 登录密码' });
    }

    const user = db.findUserByUsername(username);
    if (!user) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    const valid = await verifyServerPassword(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    const token = generateBearerToken();
    const expiresAt = Date.now() + config.tokenTtlDays * 24 * 60 * 60 * 1000;
    db.createSession({
      userId: user.id,
      tokenHash: sha256Hex(token),
      deviceId,
      expiresAt,
    });

    const res: SyncAuthResponse = {
      token,
      userId: user.id,
      username: user.username,
      kdf: user.kdf,
      keyCheck: user.keyCheck,
      latestSeq: user.nextSeq,
    };
    return reply.send(res);
  });

  app.get('/api/auth/me', async (req, reply) => {
    const auth = authenticateRequest(req, db);
    if (!auth) {
      return reply.code(401).send({ error: '认证 Token 无效或已过期' });
    }

    const res: SyncMeResponse = {
      userId: auth.user.id,
      username: auth.user.username,
      kdf: auth.user.kdf,
      keyCheck: auth.user.keyCheck,
      latestSeq: auth.user.nextSeq,
    };
    return reply.send(res);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const auth = authenticateRequest(req, db);
    if (auth) {
      db.revokeSession(auth.tokenHash);
    }
    return reply.send({ ok: true });
  });
}
