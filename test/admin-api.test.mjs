// Admin API 测试(H1 后:管理界面已取消 token;跨站 Origin 修改类请求 403)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

test('admin:免 token 访问;跨站 Origin 的修改类请求 403', async () => {
  const s = await setup();
  try {
    assert.equal((await s.proxy.get('/admin/api/overview')).status, 200);
    const evil = await fetch(s.proxy.base + '/admin/api/upstream-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
      body: JSON.stringify({ name: 'x', apiKey: 'user_evil_0001' }),
    });
    assert.equal(evil.status, 403);
    // 跨站 GET 放行(只读)
    const evilGet = await fetch(s.proxy.base + '/admin/api/logs?limit=1', { headers: { Origin: 'http://evil.example.com' } });
    assert.equal(evilGet.status, 200);
  } finally { await s.close(); }
});

test('admin:overview 返回运行状态/今日统计/密钥计数', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer user_test' });
    await sleep(300);
    const r = await s.proxy.get('/admin/api/overview');
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.ok(json.version);
    assert.equal(json.today.requests, 1);
    assert.equal(json.today.outputTokens, 3);
    assert.equal(json.keys.upstream.total, 0);
    assert.equal(json.degraded, false);
  } finally { await s.close(); }
});

test('admin:上游 key CRUD + 掩码;绑定守卫;客户端 key 创建并可用', async () => {
  const s = await setup();
  try {
    const created = await (await s.proxy.post('/admin/api/upstream-keys',
      { name: 'go-plan', apiKey: 'user_live_key_value' })).json();
    assert.ok(created.id > 0);
    const list = await (await s.proxy.get('/admin/api/upstream-keys')).json();
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0].api_key, 'user_liv…alue');
    assert.equal((await s.proxy.post('/admin/api/upstream-keys',
      { name: 'x', apiKey: 'not-a-key' })).status, 400);

    const ck = await (await s.proxy.post('/admin/api/client-keys',
      { name: 'zcode', upstreamKeyId: created.id })).json();
    assert.match(ck.token, /^sk-ccp-[0-9a-f]{32}$/);
    const chat = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${ck.token}` });
    assert.equal(chat.status, 200);
    assert.equal(s.mock.lastGenerate().headers['authorization'], 'Bearer user_live_key_value');

    const delR = await fetch(s.proxy.base + `/admin/api/upstream-keys/${created.id}`, { method: 'DELETE' });
    assert.equal(delR.status, 409);
    const dis = await fetch(s.proxy.base + `/admin/api/client-keys/${ck.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(dis.status, 200);
    const chat2 = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${ck.token}` });
    assert.equal(chat2.status, 401);
  } finally { await s.close(); }
});

test('admin:logs 分页过滤;SSE 直连实时流(免 ticket)', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer user_test' });
    await sleep(300);
    const logs = await (await s.proxy.get('/admin/api/logs?endpoint=/v1/chat/completions')).json();
    assert.ok(logs.total >= 1);

    // SSE 直连(管理界面无 token 后不再需要 ticket)
    const sse = await fetch(s.proxy.base + '/admin/api/logs/stream');
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const p = s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'again' }] },
      { Authorization: 'Bearer user_test' });
    const deadline = Date.now() + 8000;
    let sawData = false;
    while (Date.now() < deadline && !sawData) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise(r => setTimeout(() => r({ done: true }), 1000)),
      ]);
      if (chunk.value) {
        buf += decoder.decode(chunk.value, { stream: true });
        for (const l of buf.split('\n').filter(x => x.startsWith('data: '))) {
          try {
            const ev = JSON.parse(l.slice(6));
            if (ev.endpoint === '/v1/chat/completions' && ev.model === 'm') sawData = true;
          } catch {}
        }
      }
      if (chunk.done) break;
    }
    await reader.cancel();
    await p;
    assert.ok(sawData, 'SSE 流收到实时请求事件');
  } finally { await s.close(); }
});

test('admin:settings 读取(默认值兜底)与写回(白名单过滤)', async () => {
  const s = await setup();
  try {
    const get = await (await s.proxy.get('/admin/api/settings')).json();
    assert.equal(get.host, '127.0.0.1');
    assert.equal(get.port, 3050);
    const putR = await fetch(s.proxy.base + '/admin/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logLevel: 'debug', bogusKey: 'x' }),
    });
    assert.equal(putR.status, 200);
    const cfg = JSON.parse(readFileSync(join(s.proxy.dir, 'config.json'), 'utf-8'));
    assert.equal(cfg.logLevel, 'debug');
    assert.equal('bogusKey' in cfg, false, '未知键被白名单过滤');
  } finally { await s.close(); }
});

test('admin:上游 key 探活(test=1)打上游 /provider/v1/models', async () => {
  const s = await setup();
  try {
    const created = await (await s.proxy.post('/admin/api/upstream-keys',
      { name: 'probe', apiKey: 'user_probe_0001' })).json();
    const r = await fetch(s.proxy.base + `/admin/api/upstream-keys/${created.id}/test`, { method: 'POST' });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.ok, true);
    const seen = s.mock.seen.find(x => x.url === '/provider/v1/models');
    assert.ok(seen, '探活请求到达 mock 上游');
    assert.equal(seen.headers['authorization'], 'Bearer user_probe_0001');
  } finally { await s.close(); }
});

test('admin:models/refresh —— 无上游密钥时回落内置清单并说明原因', async () => {
  const s = await setup();
  try {
    const r = await fetch(s.proxy.base + '/admin/api/models/refresh', { method: 'POST' });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.source, 'builtin');
    assert.ok(json.count >= 70, `内置权威清单(${json.count} 个)`);
    assert.match(json.reason, /没有已启用的上游密钥/);
    // /v1/models 返回 plan 标注
    const models = await (await s.proxy.get('/v1/models')).json();
    const withPlan = models.data.filter(m => m.plan === 'go');
    assert.ok(withPlan.length >= 35, `Go 可用模型带标注(${withPlan.length} 个)`);
  } finally { await s.close(); }
});

test('admin:cc-cli —— 检测 CLI 登录凭证并一键导入(掩码/查重/导入)', async () => {
  const fakeAuth = join('/tmp', `ccp-fake-auth-${process.pid}.json`);
  writeFileSync(fakeAuth, JSON.stringify({
    oauth: { access_token: 'irrelevant' },
    keys: { api: 'user_cli_login_abcd1234efgh5678' },
  }));
  const s = await setup({ env: { CCP_CLI_AUTH_FILE: fakeAuth } });
  try {
    const det = await (await s.proxy.get('/admin/api/cc-cli')).json();
    assert.equal(det.installed, true);
    assert.equal(det.keyMask, 'user_cli…5678');
    assert.equal(JSON.stringify(det).includes('user_cli_login_abcd1234efgh5678'), false, '检测响应不回传明文');

    const imp = await fetch(s.proxy.base + '/admin/api/cc-cli/import', { method: 'POST' });
    assert.equal(imp.status, 201);
    const created = await imp.json();
    const list = await (await s.proxy.get('/admin/api/upstream-keys')).json();
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0].name, 'CommandCode CLI 登录');

    const imp2 = await fetch(s.proxy.base + '/admin/api/cc-cli/import', { method: 'POST' });
    assert.equal((await imp2.json()).existing, true);
    const list2 = await (await s.proxy.get('/admin/api/upstream-keys')).json();
    assert.equal(list2.rows.length, 1, '重复导入不新增记录');

    const ck = await (await s.proxy.post('/admin/api/client-keys',
      { name: 'go', upstreamKeyId: created.id })).json();
    const chat = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${ck.token}` });
    assert.equal(chat.status, 200);
    assert.equal(s.mock.lastGenerate().headers['authorization'], 'Bearer user_cli_login_abcd1234efgh5678');
  } finally {
    try { rmSync(fakeAuth, { force: true }); } catch {}
    await s.close();
  }
});

test('admin:cc-cli —— 未安装 CLI 时 installed=false,导入 404', async () => {
  const s = await setup({ env: { CCP_CLI_AUTH_FILE: '/nonexistent/auth.json' } });
  try {
    const det = await (await s.proxy.get('/admin/api/cc-cli')).json();
    assert.equal(det.installed, false);
    const imp = await fetch(s.proxy.base + '/admin/api/cc-cli/import', { method: 'POST' });
    assert.equal(imp.status, 404);
  } finally { await s.close(); }
});

test('admin:日志状态分组过滤(2xx/4xx/5xx)+ 分页 offset', async () => {
  // 前两笔 200,第三笔 500:分组过滤的行集与 total 必须一致(分页前提)
  let genCount = 0;
  const s = await setup({
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        const n = ++genCount;
        res.writeHead(n <= 2 ? 200 : 500, { 'Content-Type': 'text/event-stream' });
        res.end('{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1,"outputTokens":1}}\n');
        return false;
      }
      return;
    },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await s.proxy.post('/v1/chat/completions',
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer user_group_filter' });
    }
    const all = await (await s.proxy.get('/admin/api/logs?limit=10')).json();
    assert.equal(all.total, 3);
    const okOnly = await (await s.proxy.get('/admin/api/logs?status=2xx&limit=10')).json();
    assert.equal(okOnly.total, 2, '2xx 分组 total');
    assert.ok(okOnly.rows.every(r => r.status_code >= 200 && r.status_code < 300));
    const errOnly = await (await s.proxy.get('/admin/api/logs?status=5xx&limit=10')).json();
    assert.equal(errOnly.total, 1);
    assert.equal(errOnly.rows[0].status_code, 502, '上游 500 经代理映射为 502,仍在 5xx 分组');
    const exact = await (await s.proxy.get('/admin/api/logs?status=200&limit=10')).json();
    assert.equal(exact.total, 2, '精确值过滤不受分组支持影响');
    const page2 = await (await s.proxy.get('/admin/api/logs?limit=2&offset=2')).json();
    assert.equal(page2.total, 3);
    assert.equal(page2.rows.length, 1, 'offset 分页');
  } finally { await s.close(); }
});
