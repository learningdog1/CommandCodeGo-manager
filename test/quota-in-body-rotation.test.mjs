// 额度耗尽的第三种形态:上游回 **200**,错误在 SSE 体里。
// 以及 429 真身(RATE_LIMITED + 文本 reset)、「非额度类 200 错误不轮转」的边界,
// 和第四种形态:信用耗尽回 **400 + insufficient credits**(issue #15)——
// 状态码/错误码都不带额度味,不认这一形态就永不轮转、400 一路透传。
// 旧实现:只看 402/429 + USAGE_EXCEEDED/rateLimit.window → 200 包裹的错误被当成功,
// RATE_LIMITED 认不出,客户端直接吃「额度已用尽」;本用例锁住这些路径。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockUpstream, startProxy } from './helpers.mjs';

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-quota-'));
process.env.CC_API_BASE = 'http://127.0.0.1:1'; // 单元部分不触达任何真实上游
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });
const { SCHEMA } = await import('../src/store/db.mjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KEY_A = 'user_quo_a_nocredits1';
const KEY_B = 'user_quo_b_still_ok2';

// 上游行为开关(测试内切)
let mode = 'credit200';   // credit200 | weekly429 | badrequest200 | credit400 | plain400 | ok
// 账号用量四连里 A 的剩余信用:必须 >0,否则启动刷新会先把两个账户按信用耗尽封掉,
// 测的就不是「请求侧探测」这条路了
let creditsLeft = 70;
const weeklyResetIso = new Date(Date.now() + 3600_000).toISOString();

const mock = await startMockUpstream({
  onRequest: (req, res) => {
    const auth = req.headers['authorization'];
    const isA = auth === `Bearer ${KEY_A}`;
    // 账号用量四连:让 refresh 能把运行时标记收敛掉
    if (req.url.startsWith('/alpha/billing/credits') || req.url.startsWith('/alpha/whoami')
      || req.url.startsWith('/alpha/billing/subscriptions') || req.url.startsWith('/alpha/usage/summary')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        // 只有 A 会没额度:B 永远健康,否则延迟刷新会把两个账户一起封掉
        credits: { monthlyCredits: isA ? creditsLeft : 70, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: { limited: true, fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 }, weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 } },
      }));
      return false;
    }
    if (!isA || mode === 'ok') return; // 走默认正常应答(B / 恢复后的 A)
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/event-stream' });
      res.end(body);
      return false;
    };
    if (mode === 'credit200') {
      // 实测真身:{"type":"start"} {"type":"start-step"} {"type":"error",…no credits remaining…}
      return send(200, '{"type":"start"}\n{"type":"start-step","request":{}}\n'
        + '{"type":"error","error":{"type":"server_error","message":"You have no credits remaining. Add credits to continue using the API."}}\n');
    }
    if (mode === 'weekly429') {
      return send(429, JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', status: 429,
        message: `You've reached your weekly usage limit for your plan. Your limit resets at ${weeklyResetIso}. Upgrade to continue.` } }));
    }
    if (mode === 'badrequest200') {
      // 请求/模型层面的 400:换账户解决不了,不该轮转
      return send(200, '{"type":"start"}\n{"type":"error","error":{"type":"server_error","message":"Bad Request","statusCode":400,"isRetryable":false}}\n');
    }
    if (mode === 'credit400') {
      // issue #15 实测真身:信用耗尽回 400 + insufficient credits,
      // type=invalid_request_error / code=BAD_REQUEST —— 全都不带额度味,只能认措辞
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.', type: 'invalid_request_error', code: 'BAD_REQUEST' } }));
      return false;
    }
    if (mode === 'plain400') {
      // 普通请求类 400:换账户解决不了,不该轮转(信用措辞才是分界线)
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid request: max_tokens must be a positive integer', type: 'invalid_request_error', code: 'BAD_REQUEST' } }));
      return false;
    }
  },
});

const workdir = mkdtempSync(join(tmpdir(), 'ccp-quo-proxy-'));
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
const hitsA = () => genAuths().filter(a => a === `Bearer ${KEY_A}`).length;
const rowA = async () => (await (await proxy.get('/admin/api/account-usage')).json()).rows.find(r => r.name === '账户A');
const statusOf = (name) => {
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

test('200 体内容量耗尽:当笔轮转到 B,客户端拿到 200', async () => {
  // 账户真的没额度了:轮转标记后代理会延迟 3s 拉一次用量,那次也必须看到 0,
  // 否则 syncFromCredits 会立刻把刚打上的 credit 标记当成「已恢复」清掉
  creditsLeft = 0;
  const r = await chat();
  assert.equal(r.status, 200, '轮转后请求成功(旧实现会把 200 里的错误当成功/或直接透传)');
  const auths = genAuths();
  assert.equal(auths[0], `Bearer ${KEY_A}`, '先打到绑定的 A');
  assert.equal(auths[1], `Bearer ${KEY_B}`, '探测到流内错误后轮转重试走 B');
  assert.equal(statusOf('账户A'), 'active', '信用耗尽走运行时标记,不改库状态(补额度即可恢复)');
  const a = await rowA();
  assert.equal(a.windowState.blocked, true);
  assert.equal(a.windowState.window, 'credit');
});

test('信用标记期间:后续请求直接走 B,不再打 A', async () => {
  const before = hitsA();
  const r = await chat();
  assert.equal(r.status, 200);
  assert.equal(hitsA(), before, 'A 未再被打(解析期即被跳过)');
});

test('429 真身(RATE_LIMITED + 文本 reset)→ 轮转,窗口期取报文里时间', async () => {
  creditsLeft = 70;                                                  // 补上额度
  await proxy.post('/admin/api/account-usage/refresh', { id: 1 });   // → 清 credit 标记
  assert.equal((await rowA()).windowState.blocked, false, '额度恢复后 credit 标记自动解除');
  mode = 'weekly429';
  const r = await chat();
  assert.equal(r.status, 200, '轮转到 B 后成功');
  const a = await rowA();
  assert.equal(a.windowState.window, 'weekly');
  assert.ok(Math.abs((a.windowState.until ?? 0) - Date.parse(weeklyResetIso)) < 2000, '直到报文本里的 reset 时间');
});

test('200 里的非额度错误(Bad Request)不轮转:只打一次上游', async () => {
  await proxy.post('/admin/api/account-usage/refresh', { id: 1 });   // 清 weekly 标记
  assert.equal((await rowA()).windowState.blocked, false);
  mode = 'badrequest200';
  const before = genAuths().length;
  const r = await chat();
  assert.notEqual(r.status, 200, '错误原样透传');
  assert.equal(genAuths().length - before, 1, '不轮转:换账户解决不了请求本身的问题');
  assert.equal((await rowA()).windowState.blocked, false, 'A 没被误封,仍在轮转链首位');
});

test('400 insufficient credits(issue #15):当笔轮转到 B,credit 运行窗口 6 小时', async () => {
  // 账户真的没额度了:轮转标记后延迟 3s 的用量刷新也必须看到 0,
  // 否则 syncFromCredits 会把刚打上的 credit 标记当成「已恢复」清掉
  creditsLeft = 0;
  mode = 'credit400';
  const r = await chat();
  assert.equal(r.status, 200, '轮转后请求成功(旧实现把 400 一路透传,永不轮转)');
  const auths = genAuths();
  assert.equal(auths[auths.length - 2], `Bearer ${KEY_A}`, '先打到绑定的 A(吃 400)');
  assert.equal(auths[auths.length - 1], `Bearer ${KEY_B}`, '认出 400 信用耗尽后轮转重试走 B');
  assert.equal(statusOf('账户A'), 'active', '走运行时标记,不落库(补额度即可恢复)');
  const a = await rowA();
  assert.equal(a.windowState.blocked, true);
  assert.equal(a.windowState.window, 'credit');
  assert.ok((a.windowState.until ?? 0) > Date.now() + 5 * 3600_000, '重探期 6 小时,不是 10 分钟探针(死号不会被反复白撞)');
});

test('400 信用标记期间:后续请求直接走 B,不再打 A', async () => {
  const before = hitsA();
  const r = await chat();
  assert.equal(r.status, 200);
  assert.equal(hitsA(), before, 'A 未再被打(解析期即被跳过)');
});

test('非信用措辞的 400 不轮转:原样透传,只打一次上游', async () => {
  creditsLeft = 70;                                                  // 补上额度
  await proxy.post('/admin/api/account-usage/refresh', { id: 1 });   // → 清 credit 标记
  assert.equal((await rowA()).windowState.blocked, false, '额度恢复后 credit 标记自动解除');
  mode = 'plain400';
  const before = genAuths().length;
  const r = await chat();
  assert.equal(r.status, 400, '错误原样透传(mapCcError:400 → 400)');
  assert.equal(genAuths().length - before, 1, '不轮转:普通 400 是请求本身的问题');
  assert.equal((await rowA()).windowState.blocked, false, 'A 没被误封,仍在轮转链首位');
});

// ── 纯单元:分类表 ─────────────────────────────────────────
test('classifyExhaustion 分类表(429/402/200)', async () => {
  const { classifyExhaustion } = await import('../src/protocol/window-state.mjs');
  const J = JSON.stringify;
  const future = new Date(Date.now() + 3600_000).toISOString();
  const cases = [
    ['429 weekly(RATE_LIMITED)', 429, J({ success: false, error: { code: 'RATE_LIMITED', status: 429, message: `You've reached your weekly usage limit for your plan. Your limit resets at ${future}.` } }), 'weekly'],
    ['429 USAGE_EXCEEDED(旧形态)', 429, J({ error: { code: 'USAGE_EXCEEDED', rateLimit: { window: 'fiveHour', reset: Math.floor((Date.now() + 7200_000) / 1000) } } }), 'fiveHour'],
    ['429 无额度线索', 429, J({ error: { message: 'Bad gateway' } }), null],
    ['429 非 JSON', 429, 'upstream closed', null],
    ['402', 402, '', 'credit'],
    ['200 流内 no credits', 200, '{"type":"start"}\n{"type":"error","error":{"message":"You have no credits remaining. Add credits to continue."}}', 'credit'],
    ['200 流内 weekly', 200, `{"type":"start"}\n{"type":"error","error":{"message":"weekly usage limit reached, resets at ${future}"}}`, 'weekly'],
    ['200 Bad Request', 200, '{"type":"error","error":{"message":"Bad Request","statusCode":400,"isRetryable":false}}', null],
    ['200 模型不可用', 200, '{"type":"error","error":{"message":"This model is temporarily unavailable. Please try again shortly."}}', null],
    ['200 地区限制', 200, '{"type":"error","error":{"message":"This model is not available in your region.","statusCode":403}}', null],
    ['200 校验错误', 200, '{"type":"error","error":{"message":"Invalid request error. HINT: Validation error: price"}}', null],
    ['200 正常正文里出现 quota', 200, '{"id":"x","choices":[{"message":{"content":"your quota usage limit was fine"}}]}', null],
    ['400 insufficient credits(issue #15)', 400, J({ error: { message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.', type: 'invalid_request_error', code: 'BAD_REQUEST' } }), 'credit'],
    ['400 一般 Bad Request', 400, J({ error: { message: 'Invalid request: max_tokens must be a positive integer', type: 'invalid_request_error', code: 'BAD_REQUEST' } }), null],
    ['400 无额度线索', 400, J({ error: { message: 'model not found' } }), null],
    ['400 空 body', 400, '', null],
  ];
  for (const [name, status, body, want] of cases) {
    const got = classifyExhaustion(status, body);
    assert.equal(got ? got.kind : null, want, name);
  }
  // 402 是账户层面的持久标记,其余是运行时窗口
  assert.equal(classifyExhaustion(402, '').persist, true);
  assert.equal(classifyExhaustion(429, cases[0][2]).persist, false);
  // 400 信用耗尽:不落库(充值后 syncFromCredits 自动恢复),重探期 6 小时
  const c400 = classifyExhaustion(400, cases.find(c => c[0].startsWith('400 insufficient'))[2]);
  assert.equal(c400.persist, false);
  assert.ok(c400.until > Date.now() + 5 * 3600_000, '无 reset 报文按 6 小时重探');
});

test('peekEarlyError:命中即报错,正常流立刻放行,且不改动原响应体', async () => {
  const { peekEarlyError } = await import('../src/protocol/early-error.mjs');
  const sse = (chunks) => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
    }), { status: 200 });
  };
  const credit = sse(['{"type":"start"}\n', '{"type":"start-step"}\n',
    '{"type":"error","error":{"message":"You have no credits remaining."}}']);
  assert.match(await peekEarlyError(credit), /no credits remaining/);

  const normal = sse(['{"type":"start"}\n', '{"type":"text-start"}\n', '{"type":"text-delta","text":"hi"}\n']);
  assert.equal(await peekEarlyError(normal), null, '见到正文事件立刻放行,不吞内容');
  assert.match(await normal.text(), /text-delta/, '原响应体未被消费');

  // thinking 模型:reasoning 事件同样是「正文已开始」,不能扣满 3s 预算才放行
  // (回归:CONTENT_STARTED 曾漏了本协议的 reasoning-start/reasoning-delta,
  //  推理先行的流首字节被扣满 3s)
  const think = sse(['{"type":"start"}\n', '{"type":"start-step"}\n', '{"type":"reasoning-start"}\n']);
  const t0 = Date.now();
  assert.equal(await peekEarlyError(think), null, 'reasoning-start 立刻放行');
  assert.ok(Date.now() - t0 < 500, '几乎立即返回,不吃满预算');
  assert.match(await think.text(), /reasoning-start/, '原响应体未被消费');

  const plain = new Response('{"id":"a","choices":[{"message":{"content":"quota"}}]}', { status: 200 });
  assert.equal(await peekEarlyError(plain), null);
});
