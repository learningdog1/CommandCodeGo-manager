import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const keys = ['user_routing_account_a', 'user_routing_account_b', 'user_routing_account_c'];
const endpoints = [
  ['/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }],
  ['/v1/responses', { model: 'm', input: 'hi' }],
];

async function managed(opts = {}) {
  const s = await setup(opts);
  for (const [i, apiKey] of keys.entries()) {
    const r = await s.proxy.post('/admin/api/upstream-keys', { name: `Account ${i + 1}`, apiKey });
    assert.equal(r.status, 201);
  }
  const { token } = await (await s.proxy.post('/admin/api/client-keys', { name: 'client', upstreamKeyId: 1 })).json();
  await fetch(s.proxy.base + '/admin/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: keys[0], accountUsageRefreshMs: 0 }),
  });
  s.credentials = [{ Authorization: `Bearer ${token}` }, { 'x-api-key': keys[0] }, {}];
  return s;
}
const setStatus = (s, id, status) => fetch(s.proxy.base + `/admin/api/upstream-keys/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
});
const auths = s => s.mock.seen.filter(r => r.url === '/alpha/generate').map(r => r.headers.authorization);

test('pin: all three API routes and credential modes use B; unpin restores binding A', async () => {
  const s = await managed();
  try {
    const result = await (await s.proxy.post('/admin/api/account-usage/pin', { id: 2 })).json();
    assert.deepEqual(result.pinned, { id: 2, name: 'Account 2' });
    assert.equal(result.rows.find(r => r.id === 2).pinned, true);
    for (const [path, body] of endpoints) {
      for (const headers of s.credentials) {
        const r = await s.proxy.post(path, body, headers);
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(s.mock.lastGenerate().headers.authorization, `Bearer ${keys[1]}`, `${path}: ${JSON.stringify(headers)}`);
      }
    }
    const logs = await (await s.proxy.get('/admin/api/logs')).json();
    assert.equal(logs.total, 9);
    assert.ok(logs.rows.every(r => r.upstream_key_id === 2 && r.upstream_name === 'Account 2'));
    const unpinned = await (await s.proxy.post('/admin/api/account-usage/pin', { id: null })).json();
    assert.equal(unpinned.pinned, null);
    assert.ok(unpinned.rows.every(r => r.pinned === false));
    for (const headers of s.credentials) {
      const r = await s.proxy.post(...endpoints[0], headers);
      await r.text();
      assert.equal(r.status, 200);
      assert.equal(s.mock.lastGenerate().headers.authorization, `Bearer ${keys[0]}`);
    }
  } finally { await s.close(); }
});

test('pin: preference not outage — pinned account disabled falls back to binding; only account can be pinned; unknown id 404', async () => {
  const s = await managed();
  try {
    assert.equal((await s.proxy.post('/admin/api/account-usage/pin', { id: 999 })).status, 404);
    assert.equal((await s.proxy.post('/admin/api/account-usage/pin', { id: 2 })).status, 200);
    await setStatus(s, 2, 'disabled');
    for (const headers of s.credentials) {
      const r = await s.proxy.post(...endpoints[0], headers);
      await r.text();
      assert.equal(r.status, 200);
      assert.equal(s.mock.lastGenerate().headers.authorization, `Bearer ${keys[0]}`, '固定账号不可用时按绑定兜底,不产生硬性中断');
    }
    // 唯一启用账号也能固定(固定是偏好,不需要「有替代账号」前提)
    await setStatus(s, 3, 'disabled');
    assert.equal((await s.proxy.post('/admin/api/account-usage/pin', { id: 1 })).status, 200);
    const snap = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.equal(snap.rows[0].pinned, true);
    assert.equal(snap.rows[0].windowState.blocked, false);
  } finally { await s.close(); }
});

for (const [index, [path, body]] of endpoints.entries()) {
  for (const stream of [false, true]) {
    test(`rotation: ${path}, stream=${stream}, A credit exhausted → B window exhausted → C succeeds`, async () => {
      const s = await managed({ onRequest(req, res) {
        if (req.url !== '/alpha/generate') return;
        const key = req.headers.authorization;
        if (key === `Bearer ${keys[2]}`) return;
        res.writeHead(key === `Bearer ${keys[0]}` ? 402 : 429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'USAGE_EXCEEDED', rateLimit: { window: 'weekly', reset: Math.floor(Date.now() / 1000) + 3600 } } }));
        return false;
      } });
      try {
        const r = await s.proxy.post(path, { ...body, stream }, s.credentials[index]);
        assert.equal(r.status, 200);
        assert.match(await r.text(), /hello/);
        assert.deepEqual(auths(s), keys.map(k => `Bearer ${k}`));
        const logs = await (await s.proxy.get('/admin/api/logs')).json();
        assert.equal(logs.rows[0].upstream_key_id, 3);
        assert.equal(logs.rows[0].output_tokens, 3);
        const next = await s.proxy.post(path, { ...body, stream }, s.credentials[index]);
        await next.text();
        assert.equal(next.status, 200);
        assert.deepEqual(auths(s), [...keys, keys[2]].map(k => `Bearer ${k}`), 'later request skips A and B');
      } finally { await s.close(); }
    });
  }
}

test('rotation: all windows exhausted are tried once; subsequent requests do not hit upstream', async () => {
  const s = await managed({ onRequest(req, res) {
    if (req.url !== '/alpha/generate') return;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('{"error":{"code":"USAGE_EXCEEDED"}}');
    return false;
  } });
  try {
    const r = await s.proxy.post(...endpoints[0], s.credentials[0]);
    assert.equal(r.status, 429);
    await r.text();
    assert.deepEqual(auths(s), keys.map(k => `Bearer ${k}`));
    for (const headers of s.credentials) {
      assert.equal((await s.proxy.post(...endpoints[0], headers)).status, 429);
    }
    assert.equal(s.mock.generateCount(), 3);
  } finally { await s.close(); }
});
