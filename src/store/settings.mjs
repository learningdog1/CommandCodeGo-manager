// 设置 KV:少量运行时可变的持久配置(当前用于「固定承接账号」,见 keys.mjs)。
// 与 config.json 的分工:config 是启动期部署配置,这里是管理界面运行时写入、
// 需要跨重启保留的状态。DB 降级时走内存(不持久化),与 keys.mjs 同款。
import { getDb, memoryFallback } from './db.mjs';

export async function getSetting(key) {
  const db = getDb();
  if (!db) return memoryFallback.settings.get(key) ?? null;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  const db = getDb();
  if (!db) { memoryFallback.settings.set(key, value); return; }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export async function deleteSetting(key) {
  const db = getDb();
  if (!db) { memoryFallback.settings.delete(key); return; }
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
