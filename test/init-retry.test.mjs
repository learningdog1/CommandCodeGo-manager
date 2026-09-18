// 回归:指纹/lifecycle 上报未全成功时,nextInitAt 只推 1~5min(而非 8~10h),
// 否则一次网络抖动会让该 key 的指纹上报"消失"大半天(见 init.mjs 的重试注释)。
// 经子进程代理 + /admin/api/fingerprints 外部观测:keystate 在代理进程内存里,
// 且 init.mjs 的依赖链(upstream/session)带未 unref 的定时器,不能进程内直测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const AUTH = { Authorization: 'Bearer user_init_retry_1' };

test('指纹上报失败 → nextInitAt 推 1~5min(短重试),失败状态对管理界面可见', async () => {
  const s = await setup({
    onRequest: (req, res) => {
      if (req.url === '/alpha/fingerprint/record') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
        return false; // 已接管该响应
      }
      // 其余(lifecycle / generate)走默认 200 应答
    },
  });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 200);

    const info = await (await s.proxy.get('/admin/api/fingerprints')).json();
    assert.equal(info.keys.length, 1);
    const k = info.keys[0];
    assert.equal(k.fingerprintReport.ok, false);
    assert.equal(k.fingerprintReport.status, 500);
    const waitMs = k.nextInitAt - Date.now();
    assert.ok(waitMs > 0 && waitMs <= 6 * 60 * 1000,
      `失败后应在 1~5min 内重试,实际 ${Math.round(waitMs / 60000)}min`);
  } finally { await s.close(); }
});

test('上报全成功 → nextInitAt 推 8h+2h 抖动', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 200);

    const info = await (await s.proxy.get('/admin/api/fingerprints')).json();
    assert.equal(info.keys.length, 1);
    const k = info.keys[0];
    assert.equal(k.fingerprintReport.ok, true);
    assert.equal(k.lifecycleReport.ok, true);
    const waitMs = k.nextInitAt - Date.now();
    assert.ok(waitMs >= 8 * 60 * 60 * 1000 - 10_000 && waitMs <= 10 * 60 * 60 * 1000 + 60_000,
      `成功后应推 8h+2h 抖动,实际 ${(waitMs / 3600000).toFixed(2)}h`);
  } finally { await s.close(); }
});
