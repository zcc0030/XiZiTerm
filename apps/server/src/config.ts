import fs from 'fs';
import path from 'path';

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  allowRegistration: boolean;
  inviteCode: string;
  corsOrigin: string;
  tokenTtlDays: number;
}

function resolveDefaultDbPath(): string {
  if (process.env.DB_PATH) {
    const configured = path.resolve(process.env.DB_PATH);
    if (!fs.existsSync(configured)) {
      const legacy = path.join(path.dirname(configured), 'nexusterm.db');
      if (fs.existsSync(legacy)) {
        return legacy;
      }
    }
    return configured;
  }

  const preferred = path.resolve('./data/xiziterm.db');
  const legacy = path.resolve('./data/nexusterm.db');
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 8787),
    dbPath: resolveDefaultDbPath(),
    allowRegistration:
      (process.env.ALLOW_REGISTRATION ?? 'true').toLowerCase() !== 'false',
    inviteCode: process.env.INVITE_CODE?.trim() ?? '',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    tokenTtlDays: Math.max(1, Number(process.env.TOKEN_TTL_DAYS || 365)),
  };
}
