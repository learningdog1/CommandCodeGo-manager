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

test('manual switch: all three API routes and credential modes use B; restore uses A', async () => {
  const s = await managed();
  try {
    const result = await (await s.proxy.post('/admin/api/account-usage/switch', { id: 1, on: true })).json();
    assert.deepEqual(result.nextAccount, { id: 2, name: 'Account 2' });
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
    await s.proxy.post('/admin/api/account-usage/switch', { id: 1, on: false });
    for (const headers of s.credentials) {
      const r = await s.proxy.post(...endpoints[0], headers);
      await r.text();
      assert.equal(r.status, 200);
      assert.equal(s.mock.lastGenerate().headers.authorization, `Bearer ${keys[0]}`);
    }
  } finally { await s.close(); }
});

test('manual switch: reject without alternative; never return to a switched-away account when backup disappears', async () => {
  const s = await managed();
  try {
    await setStatus(s, 2, 'disabled');
    await setStatus(s, 3, 'disabled');
    const rejected = await s.proxy.post('/admin/api/account-usage/switch', { id: 1, on: true });
    assert.equal(rejected.status, 409);
    const snap = await (await s.proxy.get('/admin/api/account-usage')).json();
    assert.equal(snap.rows[0].windowState.blocked, false);
    await setStatus(s, 2, 'active');
    assert.equal((await s.proxy.post('/admin/api/account-usage/switch', { id: 1, on: true })).status, 200);
    await setStatus(s, 2, 'disabled');
    for (const [path, body] of endpoints) {
      for (const headers of s.credentials) {
        const r = await s.proxy.post(path, body, headers);
        assert.equal(r.status, 429);
        assert.equal((await r.json()).error.type, 'rate_limit_error');
      }
    }
    assert.equal(s.mock.generateCount(), 0, 'manual block must never silently fall back');
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
