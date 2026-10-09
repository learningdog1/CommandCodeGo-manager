// SQLite 存储层(node:sqlite,Node ≥22.5 内置,零外部依赖)。
// 库文件:{dataDir}/ccp.db。失败降级:DB 不可用时 keys 走内存(不持久化)、
// requests/usage 丢弃,代理的 user_* 直通模式不受影响。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir, CFG } from '../config.mjs';
import { log } from '../log.mjs';

let db = null;
let degraded = false;
// 内存降级容器(keys.mjs / settings.mjs 在 getDb() 为 null 时使用)
export const memoryFallback = { upstreamKeys: new Map(), clientKeys: new Map(), settings: new Map(), nextId: 1 };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS upstream_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS client_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  upstream_key_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  proxy_key TEXT,
  upstream_key_id INTEGER,
  model TEXT,
  status_code INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  error_type TEXT,
  client_disconnected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint);
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  key_id INTEGER,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key_id, model)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function init() {
  try {
    db = new DatabaseSync(join(dataDir, 'ccp.db'));
    db.exec(SCHEMA);
  } catch (e) {
    degraded = true;
    db = null;
    log('error', 'SQLite init failed, degrading to memory (keys not persisted)', { error: e.message });
  }
}
init();

/** 定时清理过期请求日志(保留 CFG.logRetentionDays 天)。unref:不阻止进程退出。 */
function cleanupOldRequests() {
  if (!db) return;
  try {
    const cutoff = Date.now() - Math.max(1, Number(CFG.logRetentionDays) || 30) * 86400000;
    const r = db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff);
    if (r.changes > 0) log('info', 'Request log cleanup', { deleted: r.changes });
  } catch (e) {
    log('warn', 'Request log cleanup failed', { error: e.message });
  }
}
cleanupOldRequests();
const cleanupTimer = setInterval(cleanupOldRequests, 24 * 60 * 60 * 1000);
cleanupTimer.unref?.();

export function getDb() { return db; }
export function isDegraded() { return degraded; }
export function closeDb() { try { db?.close(); } catch {} db = null; }
