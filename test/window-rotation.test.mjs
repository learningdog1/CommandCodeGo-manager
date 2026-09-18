// 窗口到限轮转与手动切换测试:5 小时/周窗口到顶(429 USAGE_EXCEEDED)时
// 运行时标记 + 自动换账户;窗口重置后自动恢复;手动切换/恢复经管理 API;
// 瞬态 429 不轮转。直通 user_* 入库密钥同样参与。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockUpstream, startProxy } from './helpers.mjs';

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-win-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });
const { SCHEMA } = await import('../src/store/db.mjs');
const windowStateModule = await import('../src/protocol/window-state.mjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KEY_A = 'user_win_a_hitlimit1';
const KEY_B = 'user_win_b_still_ok2';

// 窗口到限的 429 错误体(对齐上游形态:error.code + error.rateLimit.window/reset)
let resetAtSec = 0; // 0 = 不再对 A 回 429(窗口已重置)
let hitsA = 0;
const mock = await startMockUpstream({
  onRequest: (req, res) => {
    if (req.headers['authorization'] === `Bearer ${KEY_A}` && resetAtSec > 0) {
      hitsA++;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'USAGE_EXCEEDED',
          message: 'usage limit for your plan (five-hour window)',
          rateLimit: { window: 'fiveHour', reset: resetAtSec },
        },
      }));
      return false;
    }
    if (req.url.startsWith('/alpha/billing/credits') || req.url.startsWith('/alpha/whoami')
      || req.url.startsWith('/alpha/billing/subscriptions') || req.url.startsWith('/alpha/usage/summary')) {
      // 账号用量四连:按窗口是否受限回放(轮转标记后的延迟刷新会打到这里)
      const blocked = req.headers['authorization'] === `Bearer ${KEY_A}` && resetAtSec > 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(blocked ? {
        credits: { monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: resetAtSec * 1000 }, weekly: { used: 2, cap: 6, exceeded: false, resetAt: 0 } },
      } : {
        credits: { monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 1, cap: 3, exceeded: false, resetAt: 0 }, weekly: { used: 2, cap: 6, exceeded: false, resetAt: 0 } },
      }));
      return false;
    }
    return; // /alpha/generate 走默认正常应答
  },
});

const workdir = mkdtempSync(join(tmpdir(), 'ccp-win-proxy-'));
writeFileSync(join(workdir, 'config.json'), '{}');
const db = new DatabaseSync(join(workdir, 'ccp.db'));
db.exec(SCHEMA);
const token = 'sk-ccp-' + randomBytes(16).toString('hex');
db.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('账户A', KEY_A, 'active', Date.now());
db.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('账户B', KEY_B, 'active', Date.now());
db.prepare('INSERT INTO client_keys (name, key_hash, key_prefix, upstream_key_id, status, created_at) VALUES (?,?,?,?,?,?)')
  .run('zcode', sha256(token), token.slice(0, 16) + '…', 1, 'active', Date.now());
db.close();

const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
after(async () => {
  await proxy.kill();
  await mock.close();
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

const chat = () => proxy.post('/v1/chat/completions',
  { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  { Authorization: `Bearer ${token}` });
const genAuths = () => mock.seen.filter(s => s.url === '/alpha/generate').map(s => s.headers['authorization']);
const statusOf = (name) => {
  // 代理进程并发写(touch/telemetry)会短暂持锁:读侧重试兜底
  for (let i = 0; ; i++) {
    let d;
    try {
      d = new DatabaseSync(join(workdir, 'ccp.db'));
      const r = d.prepare('SELECT status FROM upstream_keys WHERE name = ?').get(name);
      d.close();
      return r.status;
    } catch (e) {
      try { d?.close(); } catch {}
      if (String(e.message).includes('locked') && i < 50) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); continue; }
      throw e;
    }
  }
};

test('window-rotation:客户端密钥 5h 窗口到限(429 USAGE_EXCEEDED)→ 当笔轮转到 B,A 保持 active', async () => {
  resetAtSec = Math.floor(Date.now() / 1000) + 3600; // A 的窗口 1 小时后才重置
  const r = await chat();
  assert.equal(r.status, 200, '轮转后请求成功');
  assert.equal(statusOf('账户A'), 'active', '窗口到限是运行时标记,不改库状态');
  const auths = genAuths();
  assert.equal(auths[0], `Bearer ${KEY_A}`, '先打到绑定的 A(收到 429)');
  assert.equal(auths[1], `Bearer ${KEY_B}`, '轮转重试走 B');
});

test('window-rotation:窗口未重置期间,后续请求直接走 B(不再打 A)', async () => {
  const before = genAuths().filter(a => a === `Bearer ${KEY_A}`).length;
  const r = await chat();
  assert.equal(r.status, 200);
  assert.equal(genAuths().filter(a => a === `Bearer ${KEY_A}`).length, before, 'A 未再被打(解析期即被窗口标记跳过)');
});

test('window-rotation:手动切换 API → 状态可见;恢复后回 A;直通密钥同样轮转', async () => {
  // 窗口已重置:刷新账号用量 → 同步清除 live 标记 → 绑定优先回 A
  resetAtSec = 0;
  const ref = await (await proxy.post('/admin/api/account-usage/refresh', { id: 1 })).json();
  assert.equal(ref.rows[0].windowState.blocked, false, '刷新同步:窗口已释放,live 标记被清除');
  const back = await chat();
  assert.equal(back.status, 200);
  assert.equal(mock.lastGenerate().headers['authorization'], `Bearer ${KEY_A}`, '窗口恢复后绑定优先回到 A');

  // 手动切换:A 切走 → 新请求落 B
  const sw = await (await proxy.post('/admin/api/account-usage/switch', { id: 1, on: true })).json();
  assert.equal(sw.switched, 'away');
  assert.equal(sw.rows[0].windowState.blocked, true);
  assert.equal(sw.rows[0].windowState.source, 'manual');
  const r2 = await chat();
  assert.equal(r2.status, 200);
  assert.equal(mock.lastGenerate().headers['authorization'], `Bearer ${KEY_B}`, '手动切换后新请求走 B');

  // 快照接口能看到窗口状态
  const snap = await (await proxy.get('/admin/api/account-usage')).json();
  assert.equal(snap.rows.find(x => x.id === 1).windowState.source, 'manual');

  // 恢复:回到 A
  const back2 = await (await proxy.post('/admin/api/account-usage/switch', { id: 1, on: false })).json();
  assert.equal(back2.switched, 'back');
  assert.equal(back2.rows[0].windowState.blocked, false);
  const r3 = await chat();
  assert.equal(r3.status, 200);
  assert.equal(mock.lastGenerate().headers['authorization'], `Bearer ${KEY_A}`);

  // 直通 user_*:A 窗口再次到限 → 自动切 B
  resetAtSec = Math.floor(Date.now() / 1000) + 3600;
  const r4 = await proxy.post('/v1/chat/completions',
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { Authorization: `Bearer ${KEY_A}` });
  assert.equal(r4.status, 200, '直通密钥轮转后成功');
  assert.equal(mock.lastGenerate().headers['authorization'], `Bearer ${KEY_B}`, '直通 A 到限 → 切到入库的 B');
  resetAtSec = 0;
});

test('window-rotation:瞬态 429(无 USAGE_EXCEEDED/无 window)不轮转', async () => {
  // 独立 mock + 代理,避免污染共享状态
  const mock2 = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"slow down"}}');
        return false;
      }
    },
  });
  const wd = mkdtempSync(join(tmpdir(), 'ccp-win-transient-'));
  writeFileSync(join(wd, 'config.json'), '{}');
  const d2 = new DatabaseSync(join(wd, 'ccp.db'));
  d2.exec(SCHEMA);
  d2.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('A', 'user_tr_a_000000001', 'active', Date.now());
  d2.prepare('INSERT INTO upstream_keys (name, api_key, status, created_at) VALUES (?,?,?,?)').run('B', 'user_tr_b_000000001', 'active', Date.now());
  d2.close();
  const p2 = await startProxy({ upstreamPort: mock2.port, cwd: wd });
  try {
    const r = await p2.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer user_tr_a_000000001' });
    assert.equal(r.status, 429, '瞬态限速原样透传(映射后 429)');
    assert.equal(mock2.generateCount(), 1, '只打了一次上游:不轮转(换 key=换指纹,不因瞬态限速轻动)');
  } finally {
    await p2.kill();
    await mock2.close();
    rmSync(wd, { recursive: true, force: true });
  }
});

test('窗口标记覆盖语义:live 不缩短更长 resetAt;manual 不被运行时标记覆盖(纯单元)', () => {
  const { markWindowBlocked, isWindowBlocked, getWindowState, resetWindowBlocks } =
    windowStateModule;
  resetWindowBlocks();
  const keyId = 990001;
  const later = Date.now() + 2 * 3600_000;

  // usage 同步写下的 weekly 到 +2h
  markWindowBlocked(keyId, { source: 'usage', window: 'weekly', until: later });
  // live 429 的 10min 探针 TTL 不得把它覆盖掉(否则窗口标记提前放行)
  markWindowBlocked(keyId, { source: 'live', window: 'weekly', until: Date.now() + 10 * 60_000 });
  assert.equal(isWindowBlocked(keyId), true);
  assert.equal(getWindowState(keyId).source, 'usage');
  assert.ok(Math.abs((getWindowState(keyId).until ?? 0) - later) < 1000, 'until 保持更晚者');

  // manual 生效且不被 live/usage 覆盖(只能经 setManualSwitch(false) 解除)
  markWindowBlocked(keyId, { source: 'manual', window: 'manual', until: Date.now() + 3600_000 });
  assert.equal(getWindowState(keyId).source, 'manual');
  markWindowBlocked(keyId, { source: 'live', window: 'fiveHour', until: later });
  assert.equal(getWindowState(keyId).source, 'manual');

  resetWindowBlocks();
});
