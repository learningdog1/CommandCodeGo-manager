// 上游 401(key 失效/被吊销)的处理,issue #14:
//   旧实现:401 不标记、不轮转,一路透传 —— 死 key 永远钉在轮转链首位,
//   每笔请求都白撞一次 401;探活按钮走 /provider/v1/models(不校验鉴权),
//   死 key 还显示「探活成功」,用户无从排查。
// 本用例锁住:轮转 + invalid 运行标记(不落库)、后续请求跳过、探活走真鉴权端点、
// 凭据恢复后自动回链、未入库直通 key 维持透传语义、请求日志带上游报错原文。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, startProxy } from './helpers.mjs';

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-rot401-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });
const { SCHEMA } = await import('../src/store/db.mjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KEY_A = 'user_rot401_a_revoked1';
const KEY_B = 'user_rot401_b_still_ok2';
const KEY_DIRECT = 'user_rot401_direct_dead3';

// A 的凭据是否处于失效状态(401);恢复 = false 后上游对 A 正常应答
let aInvalid = true;

const UNAUTHORIZED = JSON.stringify({
  success: false,
  error: { code: 'UNAUTHORIZED', status: 401, message: "Invalid 'Authorization' header or token." },
});

const mock = await startMockUpstream({
  onRequest: (req, res) => {
    const auth = req.headers['authorization'];
    const isA = auth === `Bearer ${KEY_A}`;
    // 用量四连 + 探活(/alpha/whoami):A 失效期间同样 401(鉴权真实生效);
    // 注意先于 generate 分支判断 —— generate 不能被这里吞掉
    const isQuad = req.url.startsWith('/alpha/whoami') || req.url.startsWith('/alpha/billing/')
      || req.url.startsWith('/alpha/usage/');
    if (isQuad) {
      if (isA && aInvalid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(UNAUTHORIZED);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          user: { userName: 'rot401-a', email: 'a@example.com' },
          credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: { limited: false, fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 }, weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 } },
          data: { currentPeriodEnd: new Date(Date.now() + 15 * 86400_000).toISOString() },
        }));
      }
      return false;
    }
    // generate:A 失效期间回 401 真身;其余(恢复后的 A、B)走默认 SSE 应答
    if (isA && aInvalid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(UNAUTHORIZED);
      return false;
    }
    // 未入库直通 key:上游一律 401(它就是失效的),验证直通透传语义
    if (auth === `Bearer ${KEY_DIRECT}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(UNAUTHORIZED);
      return false;
    }
  },
});

const workdir = mkdtempSync(join(tmpdir(), 'ccp-rot401-proxy-'));
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

const chat = (auth = token) => proxy.post('/v1/chat/completions',
  { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  { Authorization: `Bearer ${auth}` });
const genAuths = () => mock.seen.filter(s => s.url === '/alpha/generate').map(s => s.headers['authorization']);
const hitsA = () => genAuths().filter(a => a === `Bearer ${KEY_A}`).length;
const rowA = async () => (await (await proxy.get('/admin/api/account-usage')).json()).rows.find(r => r.name === '账户A');
const statusOf = (name) => {
  // 与 quota-in-body-rotation 同款:代理进程并发写库时 open/prepare 可能撞锁,重试
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
const recentLogs = async () => (await (await proxy.get('/admin/api/logs?limit=20')).json()).rows;

test('上游 401(key 失效)→ 当笔轮转到 B,A 落 invalid 运行标记不落库', async () => {
  const r = await chat();
  assert.equal(r.status, 200, '死 key 被跳过、轮转到 B 成功(旧实现 401 一路透传,永不轮转)');
  const auths = genAuths();
  assert.equal(auths[0], `Bearer ${KEY_A}`, '先打到绑定的 A(吃 401)');
  assert.equal(auths[1], `Bearer ${KEY_B}`, '认出 401 后轮转重试走 B');
  assert.equal(statusOf('账户A'), 'active', '不落库:换 key 走删除重导,误判可自愈');
  const a = await rowA();
  assert.equal(a.windowState.blocked, true);
  assert.equal(a.windowState.window, 'invalid');
  assert.ok((a.windowState.until ?? 0) > Date.now() + 55 * 60_000, '1 小时后放行重探');
});

test('invalid 标记期间:后续请求直接走 B,不再白撞 A', async () => {
  const before = hitsA();
  const r = await chat();
  assert.equal(r.status, 200);
  assert.equal(hitsA(), before, 'A 未再被打(选择期即被跳过)');
});

test('探活走 /alpha/whoami:死 key 如实报 401,不再「探活成功」', async () => {
  const r = await proxy.post('/admin/api/upstream-keys/1/test', {});
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, false, '旧探活打 /provider/v1/models(不校验鉴权),死 key 也回 200');
  assert.equal(body.status, 401);
});

test('直通(未入库)key 的 401:原样透传不轮转,日志带上游报错原文', async () => {
  const before = genAuths().length;
  const r = await chat(KEY_DIRECT);
  assert.equal(r.status, 401, '未入库凭据保持直通语义:不轮转,错误原样透传');
  assert.equal(genAuths().length - before, 1, '只打一次上游');
  const body = await r.json();
  assert.match(body.error.message, /Invalid 'Authorization' header or token\./);
  // 请求日志:错误列不再只有干巴巴的 http_401,带上上游报文(issue #14 排障的关键)
  const row = (await recentLogs()).find(l => l.proxy_key === '(direct)' && l.status_code === 401);
  assert.ok(row, 'direct 401 已入请求日志');
  assert.match(row.error_type, /^http_401 · Invalid 'Authorization' header or token\.$/);
});

test('凭据恢复:探活成功即解除 invalid,A 自动回到链首位', async () => {
  aInvalid = false;                                              // 上游侧 A 的 key 修好了
  const r = await proxy.post('/admin/api/upstream-keys/1/test', {});
  const body = await r.json();
  assert.equal(body.ok, true, 'whoami 200:探活通过');
  assert.equal(body.userName, 'rot401-a');
  const a = await rowA();
  assert.equal(a.windowState.blocked, false, '探活成功解除 invalid 标记,不必等 1 小时重探');
  const chatR = await chat();
  assert.equal(chatR.status, 200);
  assert.equal(mock.lastGenerate()?.headers['authorization'], `Bearer ${KEY_A}`, '绑定优先:恢复后的 A 回到链首位');
});

// ── 纯单元:clearWindowBlock ───────────────────────────────
test('clearWindowBlock:只清指定窗口,不动其它窗口标记', async () => {
  const { markWindowBlocked, clearWindowBlock, resetWindowBlocks, getWindowState } =
    await import('../src/protocol/window-state.mjs');
  resetWindowBlocks();
  const until = Date.now() + 3600_000;
  markWindowBlocked(999, { source: 'live', window: 'invalid', until });
  markWindowBlocked(999, { source: 'live', window: 'fiveHour', until });
  clearWindowBlock(999, 'invalid');
  const s = getWindowState(999);
  assert.equal(s.blocked, true);
  assert.equal(s.window, 'fiveHour', 'invalid 已清,fiveHour 不受影响');
  clearWindowBlock(999, 'fiveHour');
  assert.equal(getWindowState(999).blocked, false);
  resetWindowBlocks();
});
