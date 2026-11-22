import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { SyncDatabase } from './db/database.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerSyncRoutes } from './routes/sync.routes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new SyncDatabase(config.dbPath);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    bodyLimit: 16 * 1024 * 1024, // 16 MB for vaults with many SSH keys
  });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(rateLimit, {
    max: 180,
    timeWindow: '1 minute',
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'xiziterm-sync-server',
    version: '0.1.0',
    timestamp: Date.now(),
  }));

  registerAuthRoutes(app, db, config);
  registerSyncRoutes(app, db);

  const shutdown = async () => {
    app.log.info('Shutting down XiZiTerm Sync Server...');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `XiZiTerm Sync Server listening on http://${config.host}:${config.port} (SQLite: ${config.dbPath})`
  );
}

main().catch((err) => {
  console.error('Failed to start XiZiTerm Sync Server:', err);
  process.exit(1);
});
