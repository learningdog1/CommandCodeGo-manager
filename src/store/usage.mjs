// 用量聚合:天 × key × model 粒度 upsert,供 /admin/api/usage 与图表查询。
import { getDb } from './db.mjs';

// 「天」用本地时区口径(与 overview 的今日统计一致);toISOString 是 UTC,
// 非 UTC 时区会在深夜把请求归到前一天。
const dayStr = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function recordUsage({ ts, keyId, model, inputTokens = 0, outputTokens = 0, cachedTokens = 0 }) {
  const db = getDb();
  if (!db) return;
  // key_id 用 0 表示直通/无客户端 key:SQLite 主键里 NULL 互不相等,
  // 用 NULL 会让 (day, NULL, model) 的 upsert 永不命中、每次都插新行。
  db.prepare(`
    INSERT INTO usage_daily (day, key_id, model, input_tokens, output_tokens, cached_tokens, requests)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (day, key_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      requests = requests + 1`)
    .run(dayStr(ts ?? Date.now()), keyId ?? 0, model ?? 'unknown',
      inputTokens, outputTokens, cachedTokens);
}

/**
 * 聚合查询。opts: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', groupBy: 'day'|'model'|'key' }
 * groupBy=key 时附 client_keys 名称(直接落库的 usage 无 key 名,由 admin 层解析)。
 */
export async function usageSummary({ from, to, groupBy = 'day' } = {}) {
  const db = getDb();
  if (!db) return [];
  const where = [];
  const args = [];
  if (from) { where.push('day >= ?'); args.push(from); }
  if (to) { where.push('day <= ?'); args.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const dim = { day: 'day', model: 'model', key: 'key_id' }[groupBy] ?? 'day';
  const sql = `
    SELECT ${dim === 'key_id' ? `u.key_id AS key_id, CASE WHEN u.key_id = 0 THEN '(direct)' WHEN c.id IS NOT NULL THEN COALESCE(c.name, c.key_prefix) ELSE '(已删除 key #' || u.key_id || ')' END AS key_name` : `u.${dim} AS ${dim}`},
      SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
      SUM(u.cached_tokens) AS cached_tokens, SUM(u.requests) AS requests
    FROM usage_daily u
    ${dim === 'key_id' ? 'LEFT JOIN client_keys c ON c.id = u.key_id' : ''}
    ${whereSql}
    GROUP BY ${dim === 'key_id' ? 'u.key_id' : `u.${dim}`}
    ORDER BY ${dim === 'key_id' ? 'u.key_id' : `u.${dim}`}`;
  return db.prepare(sql).all(...args);
}
