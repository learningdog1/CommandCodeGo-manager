// 密钥管理:上游 Command Code key(user_*,明文存,上游调用必需——见 README 安全说明)
// 与客户端 key(sk-ccp-*,只存 sha256 哈希,显式绑定一枚上游 key)。
// 按 ultrabrain U2 决议:显式绑定、不做自动轮换;schema 即「绑定表+key 状态表」,
// 日后若加故障转移免迁移。DB 降级时走内存(不持久化)。
import { createHash, randomBytes } from 'node:crypto';
import { getDb, memoryFallback } from './db.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

/** 掩码:保留前 8 与后 4 位。user_abcd1234…wxyz */
export function maskKey(key) {
  if (!key) return '';
  return key.length <= 14 ? key.slice(0, 4) + '…' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

// ── 上游 key ────────────────────────────────────────────────
export async function createUpstreamKey({ name, apiKey }) {
  const db = getDb();
  if (!db) {
    const id = memoryFallback.nextId++;
    memoryFallback.upstreamKeys.set(id, { id, name, api_key: apiKey, status: 'active', created_at: now(), last_used_at: null });
    return { id, name };
  }
  const r = db.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?, ?, ?, ?)')
    .run(name, apiKey, 'active', now());
  return { id: Number(r.lastInsertRowid), name };
}

export async function listUpstreamKeys() {
  const db = getDb();
  if (!db) return [...memoryFallback.upstreamKeys.values()].map(k => ({ ...k, api_key: maskKey(k.api_key) }));
  return db.prepare('SELECT * FROM upstream_keys ORDER BY id').all()
    .map(k => ({ ...k, api_key: maskKey(k.api_key) }));
}

/** 内部使用(鉴权/探活):按 id 取明文 key。不存在或已停用返回 null。 */
export async function getUpstreamKeyById(id) {
  const db = getDb();
  if (!db) {
    const k = memoryFallback.upstreamKeys.get(id);
    return k && k.status === 'active' ? k : null;
  }
  const k = db.prepare('SELECT * FROM upstream_keys WHERE id = ?').get(id);
  return k && k.status === 'active' ? k : null;
}

/** 按 API key 明文查重(CLI 凭证导入时避免重复建同名记录)。返回行或 null。 */
export async function findUpstreamKeyByApiKey(apiKey) {
  const db = getDb();
  if (!db) {
    for (const k of memoryFallback.upstreamKeys.values()) if (k.api_key === apiKey) return k;
    return null;
  }
  return db.prepare('SELECT * FROM upstream_keys WHERE api_key = ?').get(apiKey) ?? null;
}

export async function setUpstreamKeyStatus(id, status) {
  const db = getDb();
  if (!db) { const k = memoryFallback.upstreamKeys.get(id); if (k) k.status = status; return; }
  db.prepare('UPDATE upstream_keys SET status = ? WHERE id = ?').run(status, id);
}

/** 重命名上游 key(账户名自动迁移用:导入时未取到账户名的,拿到 whoami 后补齐)。 */
export async function renameUpstreamKey(id, name) {
  const db = getDb();
  if (!db) { const k = memoryFallback.upstreamKeys.get(id); if (k) k.name = name; return; }
  db.prepare('UPDATE upstream_keys SET name = ? WHERE id = ?').run(name, id);
}

/** 删除上游 key:有客户端 key 绑定时拒绝(显式绑定语义,静默级联会让客户端 key 失效)。 */
export async function deleteUpstreamKey(id) {
  const db = getDb();
  if (!db) { memoryFallback.upstreamKeys.delete(id); return { ok: true }; }
  const bound = db.prepare('SELECT COUNT(*) AS n FROM client_keys WHERE upstream_key_id = ?').get(id).n;
  if (bound > 0) return { ok: false, reason: 'bound_client_keys', bound };
  db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(id);
  return { ok: true };
}

export async function touchUpstreamKey(id) {
  const db = getDb();
  if (!db) { const k = memoryFallback.upstreamKeys.get(id); if (k) k.last_used_at = now(); return; }
  db.prepare('UPDATE upstream_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
}

// ── 客户端 key ──────────────────────────────────────────────
/**
 * 创建客户端 key:token = sk-ccp-<32hex>,明文只在本函数返回值里出现一次,
 * DB 只存 sha256 哈希 + 展示前缀。
 */
export async function createClientKey({ name, upstreamKeyId }) {
  const upstream = await getUpstreamKeyById(upstreamKeyId);
  if (!upstream) throw new Error('upstream key not found or disabled');
  const token = 'sk-ccp-' + randomBytes(16).toString('hex');
  const prefix = token.slice(0, 16) + '…';
  const db = getDb();
  if (!db) {
    const id = memoryFallback.nextId++;
    memoryFallback.clientKeys.set(sha256(token), { id, name, key_hash: sha256(token), key_prefix: prefix, upstream_key_id: upstreamKeyId, status: 'active', created_at: now(), last_used_at: null });
    return { id, name, token, upstreamKeyId };
  }
  const r = db.prepare('INSERT INTO client_keys (name, key_hash, key_prefix, upstream_key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, sha256(token), prefix, upstreamKeyId, 'active', now());
  return { id: Number(r.lastInsertRowid), name, token, upstreamKeyId };
}

export async function listClientKeys() {
  const db = getDb();
  const mapRow = (k, upstreamName) => ({ ...k, upstream_name: upstreamName });
  if (!db) {
    return [...memoryFallback.clientKeys.values()].map(k => mapRow(k, memoryFallback.upstreamKeys.get(k.upstream_key_id)?.name ?? null));
  }
  return db.prepare(`
    SELECT c.*, u.name AS upstream_name
    FROM client_keys c LEFT JOIN upstream_keys u ON u.id = c.upstream_key_id
    ORDER BY c.id`).all();
}

/** 鉴权用:token → 客户端 key 记录(active 才命中),顺带记 last_used。 */
export async function verifyClientKey(token) {
  const hash = sha256(token);
  const db = getDb();
  let row;
  if (!db) row = memoryFallback.clientKeys.get(hash);
  else row = db.prepare('SELECT * FROM client_keys WHERE key_hash = ?').get(hash);
  if (!row || row.status !== 'active') return null;
  if (!db) row.last_used_at = now();
  else db.prepare('UPDATE client_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export async function setClientKeyStatus(id, status) {
  const db = getDb();
  if (!db) { for (const k of memoryFallback.clientKeys.values()) if (k.id === id) k.status = status; return; }
  db.prepare('UPDATE client_keys SET status = ? WHERE id = ?').run(status, id);
}

export async function deleteClientKey(id) {
  const db = getDb();
  if (!db) { for (const [h, k] of memoryFallback.clientKeys) if (k.id === id) memoryFallback.clientKeys.delete(h); return; }
  db.prepare('DELETE FROM client_keys WHERE id = ?').run(id);
}
