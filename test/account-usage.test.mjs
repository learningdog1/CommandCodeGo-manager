// 账号用量面板测试:mock 上游回放 /alpha/whoami、/alpha/billing/*、/alpha/usage/summary,
// 验证快照纯读缓存、单/全刷新、月度模板条换算、上游鉴权头,以及服务启动即自动刷新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup, startMockUpstream, startProxy } from './helpers.mjs';

const FUTURE = Date.now() + 90 * 60 * 1000; // 5h 窗口重置时刻(ms epoch)

function usageUpstream() {
  return {
    onRequest: (req, res, seen) => {
      const url = new URL(req.url, 'http://x');
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === '/alpha/whoami') {
        assert.equal(url.searchParams.get('limits'), '1');
        return json({ success: true, user: { id: 'u1', name: 'Test User', email: 't@example.com', userName: 'testuser' }, org: null }), false;
      }
      if (url.pathname === '/alpha/billing/credits') {
        return json({
          credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 8, purchasedCredits: 2, freeCredits: 1 },
          windowLimits: {
            limited: true, exceeded: null,
            fiveHour: { used: 1, cap: 3, exceeded: false, resetAt: FUTURE },
            weekly: { used: 2, cap: 6, exceeded: false, resetAt: 0 },
          },
        }), false;
      }
      if (url.pathname === '/alpha/billing/subscriptions') {
        return json({
          success: true,
          data: {
            status: 'active', planId: 'individual-go', cancelAtPeriodEnd: false,
            currentPeriodStart: '2026-09-01T00:00:00.000Z', currentPeriodEnd: '2026-10-01T00:00:00.000Z',
          },
        }), false;
      }
      if (url.pathname === '/alpha/usage/summary') {
        assert.equal(url.searchParams.get('since'), '2026-09-01T00:00:00.000Z');
        return json({
          totalCount: 12, totalCost: 4, averageCost: 0.3333, successRate: 91.7,
          completedCount: 11, failedCount: 1,
          totalTokensIn: 1000, totalTokensOut: 2000, totalTokens: 3000,
          totalCredits: 4, totalFreeCredits: 0, totalMonthlyCredits: 4, totalPurchasedCredits: 0,
          periodBasis: 'billing-period',
        }), false;
      }
      // 其余路径走默认应答(不影响本用例)
      return;
    },
  };
}

test('account-usage:快照纯读缓存;单/全刷新回填;模板条与月度换算;鉴权头', async () => {
  const opts = usageUpstream();
  const s = await setup(opts);
  try {
    // 建两把启用的上游 key + 一把停用的
    const k1 = await (await s.proxy.post('/admin/api/upstream-keys', { name: 'acc1', apiKey: 'user_usage_key_1111' })).json();
    const k2 = await (await s.proxy.post('/admin/api/upstream-keys', { name: 'acc2', apiKey: 'user_usage_key_2222' })).json();
    const k3 = await (await s.proxy.post('/admin/api/upstream-keys', { name: 'acc3', apiKey: 'user_usage_key_3333' })).json();
    await fetch(`${s.proxy.base}/admin/api/upstream-keys/${k3.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }),
    });

    // 1) 快照:不发上游请求,只给 key 元数据 + 空缓存
    const before = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.equal(before.rows.length, 3);
    assert.ok(before.rows.every(r => r.data === null && r.fetchedAt === null));
    const alphaCalls = () => s.mock.seen.filter(x => x.url.startsWith('/alpha/')).length;
    assert.equal(alphaCalls(), 0);

    // 2) 单账号刷新:回填该行,其余不动
    const one = await (await s.proxy.post('/admin/api/account-usage/refresh', { id: k1.id })).json();
    assert.equal(one.refreshed, 1);
    assert.equal(one.rows.length, 1);
    assert.equal(one.rows[0].id, k1.id);
    assert.equal(one.rows[0].error, null);
    const snap1 = await (await s.proxy.get('/admin/api/account-usage')).json();
    const row1 = snap1.rows.find(r => r.id === k1.id);
    const row2 = snap1.rows.find(r => r.id === k2.id);
    assert.ok(row1.fetchedAt > 0);
    assert.equal(row2.data, null);

    // 数据契约:模板条 / 信用 / 期账
    const d = row1.data;
    assert.equal(d.whoami.userName, 'testuser');
    assert.equal(d.windowLimits.fiveHour.cap, 3);
    assert.equal(d.windowLimits.weekly.used, 2);
    assert.equal(d.credits.monthly, 8);
    assert.equal(d.credits.purchased, 2);
    assert.equal(d.credits.free, 1);
    assert.equal(d.credits.totalRemaining, 11);
    // Go 套餐总额 10,剩余 8 → 月度模板条已用 2 / 上限 10
    assert.equal(d.credits.monthlyTotal, 10);
    assert.equal(d.credits.monthlyUsed, 2);
    assert.equal(d.plan.name, 'Go');
    assert.equal(d.plan.status, 'active');
    assert.ok(d.plan.daysRemaining >= 0);
    assert.equal(d.period.totalCount, 12);
    assert.equal(d.period.totalCost, 4);
    assert.equal(d.period.periodBasis, 'billing-period');

    // 上游侧:刷新带了 CLI 身份头与 Bearer
    const who = s.mock.seen.find(x => x.url.startsWith('/alpha/whoami'));
    assert.equal(who.headers.authorization, 'Bearer user_usage_key_1111');
    assert.equal(who.headers['x-cli-environment'], 'production');
    assert.ok(who.headers['x-command-code-version']);
    assert.equal(who.headers['user-agent'], 'cli');

    // 3) 全部刷新:只覆盖启用账号(停用的 k3 不触达)
    const all = await (await s.proxy.post('/admin/api/account-usage/refresh', {})).json();
    assert.equal(all.refreshed, 2);
    const snap2 = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.ok(snap2.rows.find(r => r.id === k2.id).data !== null);
    assert.equal(snap2.rows.find(r => r.id === k3.id).data, null);

    // 4) 不存在/停用账号 → 404
    assert.equal((await s.proxy.post('/admin/api/account-usage/refresh', { id: k3.id })).status, 404);
    assert.equal((await s.proxy.post('/admin/api/account-usage/refresh', { id: 99999 })).status, 404);

    // 5) 空 body 视为全部刷新(浏览器 fetch 空 POST 的兜底路径)
    const emptyBody = await s.proxy.post('/admin/api/account-usage/refresh', '');
    assert.equal(emptyBody.status, 200);
    assert.equal((await emptyBody.json()).refreshed, 2);
  } finally { await s.close(); }
});

test('account-usage:服务启动即自动刷新(开机即有数据,无需打开面板)', async () => {
  const mock = await startMockUpstream(usageUpstream());
  // 手管 workdir:重启代理后 DB 里的 key 要还在(startProxy 传 cwd 时不负责清理)
  const dir = mkdtempSync(join(tmpdir(), 'ccp-autorefresh-'));
  let proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    await proxy.post('/admin/api/upstream-keys', { name: 'auto', apiKey: 'user_auto_refresh_001' });
    await proxy.kill();
    proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });

    // 启动 tick 是 fire-and-forget,本地 mock 亚秒级,给它一点时间
    await sleep(1500);
    const urls = mock.seen.map(x => x.url.split('?')[0]);
    assert.ok(urls.includes('/alpha/whoami'), '启动即拉 whoami');
    assert.ok(urls.includes('/alpha/billing/credits'));
    assert.ok(urls.includes('/alpha/billing/subscriptions'));
    assert.ok(urls.includes('/alpha/usage/summary'));
    const who = mock.seen.find(x => x.url.startsWith('/alpha/whoami'));
    assert.equal(who.headers['authorization'], 'Bearer user_auto_refresh_001');

    // 快照纯读缓存,但缓存已被启动 tick 填充 —— 面板开机即有数据
    const snap = await (await proxy.get('/admin/api/account-usage')).json();
    assert.equal(snap.rows.length, 1);
    assert.ok(snap.rows[0].data !== null);
    assert.equal(snap.rows[0].data.plan.name, 'Go');
  } finally {
    await proxy.kill();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('account-usage:存量默认名自动迁移为 commandcode 账户名,自定义名不动', async () => {
  const s = await setup(usageUpstream());
  try {
    // 两条 key:一条旧默认名,一条用户自定义名
    const legacy = await (await s.proxy.post('/admin/api/upstream-keys', { name: 'CommandCode CLI 登录', apiKey: 'user_legacy_name_001' })).json();
    const custom = await (await s.proxy.post('/admin/api/upstream-keys', { name: '我的小号', apiKey: 'user_custom_name_002' })).json();
    await s.proxy.post('/admin/api/account-usage/refresh', {});

    const list = await (await s.proxy.get('/admin/api/upstream-keys')).json();
    assert.equal(list.rows.find(r => r.id === legacy.id).name, 'testuser', '旧默认名在刷新拿到 whoami 后迁移为账户名');
    assert.equal(list.rows.find(r => r.id === custom.id).name, '我的小号', '用户自定义名不被覆盖');
  } finally { await s.close(); }
});

test('account-usage:上游全挂时行级 error,不影响其他账号', async () => {
  // onRequest 对计费端点一律 401
  const s = await setup({
    onRequest: (req, res) => {
      if (req.url.startsWith('/alpha/')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'session expired' } }));
        return false;
      }
      return;
    },
  });
  try {
    const k = await (await s.proxy.post('/admin/api/upstream-keys', { name: 'dead', apiKey: 'user_dead_key_0001' })).json();
    const r = await (await s.proxy.post('/admin/api/account-usage/refresh', { id: k.id })).json();
    assert.equal(r.failed, 1);
    assert.equal(r.rows[0].data, null);
    assert.match(r.rows[0].error, /whoami: HTTP 401/);
    assert.ok(r.rows[0].fetchedAt > 0);
    // 快照保留错误现场
    const snap = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.match(snap.rows[0].error, /credits: HTTP 401/);
  } finally { await s.close(); }
});
