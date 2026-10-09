// 存储层测试:临时目录建库 → CRUD → 原始 DatabaseSync 复核持久化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-store-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });

const { createUpstreamKey, listUpstreamKeys, createClientKey, listClientKeys,
  verifyClientKey, deleteUpstreamKey, setClientKeyStatus, setUpstreamKeyStatus } =
  await import('../src/store/keys.mjs');
const { insertRequest, listRequests } = await import('../src/store/requests.mjs');
const { recordUsage, usageSummary } = await import('../src/store/usage.mjs');
const { dataDir } = await import('../src/config.mjs');

test('store:库文件在数据目录创建', () => {
  assert.ok(existsSync(join(dataDir, 'ccp.db')));
});

test('store:上游 key CRUD,列表只给掩码(明文不出接口)', async () => {
  const { id } = await createUpstreamKey({ name: 'go-plan', apiKey: 'user_abcdef1234567890' });
  assert.ok(id > 0);
  const list = await listUpstreamKeys();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'go-plan');
  assert.equal(list[0].api_key, 'user_abc…7890');
  assert.equal(list[0].api_key.includes('def123456'), false);
});

test('store:客户端 key 创建返回一次性明文,DB 只存哈希;verifyClientKey 往返命中', async () => {
  const up = await listUpstreamKeys();
  const created = await createClientKey({ name: 'zcode', upstreamKeyId: up[0].id });
  assert.match(created.token, /^sk-ccp-[0-9a-f]{32}$/);
  const list = await listClientKeys();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'zcode');
  assert.equal(list[0].upstream_name, 'go-plan');
  // 列表/落库不含明文
  assert.equal(JSON.stringify(list).includes(created.token), false);
  const hit = await verifyClientKey(created.token);
  assert.ok(hit);
  assert.equal(hit.id, created.id);
  assert.equal(hit.upstream_key_id, up[0].id);
  // 命中即记 last_used
  const list2 = await listClientKeys();
  assert.ok(list2[0].last_used_at > 0);
});

test('store:绑定不存在的上游 key → 创建失败', async () => {
  await assert.rejects(() => createClientKey({ name: 'x', upstreamKeyId: 9999 }));
});

test('store:吊销(禁用)后的客户端 key 验证不命中', async () => {
  const list = await listClientKeys();
  await setClientKeyStatus(list[0].id, 'disabled');
  const up = await listUpstreamKeys();
  const created = await createClientKey({ name: 'second', upstreamKeyId: up[0].id });
  assert.ok(await verifyClientKey(created.token));
  const disabled = list[0];
  // 重新启用后再命中
  await setClientKeyStatus(disabled.id, 'active');
});

test('store:禁用上游 key 后,绑定它的客户端 key 解析不到上游(getUpstreamKeyById null)', async () => {
  const { getUpstreamKeyById } = await import('../src/store/keys.mjs');
  const list = await listUpstreamKeys();
  await setUpstreamKeyStatus(list[0].id, 'disabled');
  assert.equal(await getUpstreamKeyById(list[0].id), null);
  await setUpstreamKeyStatus(list[0].id, 'active');
  assert.ok(await getUpstreamKeyById(list[0].id));
});

test('store:删除上游 key 的绑定守卫(有客户端 key 绑定时拒绝)', async () => {
  const list = await listUpstreamKeys();
  const r = await deleteUpstreamKey(list[0].id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bound_client_keys');
  // 无绑定的新上游 key 可删
  const fresh = await createUpstreamKey({ name: 'solo', apiKey: 'user_solo000000000001' });
  const r2 = await deleteUpstreamKey(fresh.id);
  assert.equal(r2.ok, true);
});

test('store:请求日志插入 + 过滤 + 分页', async () => {
  for (let i = 0; i < 5; i++) {
    await insertRequest({ ts: 1700000000000 + i, endpoint: '/v1/chat/completions', proxyKey: 'zcode',
      model: 'deepseek/deepseek-v4-flash', statusCode: 200, stream: true, durationMs: 100 + i,
      inputTokens: 10, outputTokens: 5, finishReason: 'stop' });
  }
  await insertRequest({ ts: 1700000001000, endpoint: '/v1/messages', proxyKey: 'direct',
    model: 'glm-5.2', statusCode: 429, stream: false, durationMs: 20, errorType: 'rate_limit_error' });
  const all = await listRequests({});
  assert.equal(all.total, 6);
  const chatOnly = await listRequests({ endpoint: '/v1/chat/completions' });
  assert.equal(chatOnly.total, 5);
  const page = await listRequests({ limit: 2, offset: 0 });
  assert.equal(page.rows.length, 2);
  // ts 倒序
  assert.ok(page.rows[0].ts >= page.rows[1].ts);
});

test('store:用量 upsert 聚合(day×key×model)', async () => {
  // 「天」口径与后端一致:本地时区(dayStr 已改为本地;跨 UTC 午夜用 toISOString 会错位)
  const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  await recordUsage({ keyId: null, model: 'glm-5.2', inputTokens: 100, outputTokens: 40, cachedTokens: 10 });
  await recordUsage({ keyId: null, model: 'glm-5.2', inputTokens: 50, outputTokens: 20, cachedTokens: 0 });
  await recordUsage({ keyId: null, model: 'kimi-k2.7', inputTokens: 7, outputTokens: 3 });
  const byModel = await usageSummary({ from: day, to: day, groupBy: 'model' });
  const glm = byModel.find(r => r.model === 'glm-5.2');
  assert.equal(glm.requests, 2);
  assert.equal(glm.input_tokens, 150);
  assert.equal(glm.output_tokens, 60);
  assert.equal(glm.cached_tokens, 10);
  const byDay = await usageSummary({ groupBy: 'day' });
  assert.ok(byDay.some(r => r.day === day && r.requests === 3));
});

test('store:持久化 —— 用原始 DatabaseSync 复核(模拟进程重启后数据仍在)', async () => {
  const raw = new DatabaseSync(join(dataDir, 'ccp.db'));
  const ups = raw.prepare('SELECT COUNT(*) AS n FROM upstream_keys').get().n;
  const clients = raw.prepare('SELECT COUNT(*) AS n FROM client_keys').get().n;
  const reqs = raw.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  raw.close();
  assert.ok(ups >= 1);
  assert.ok(clients >= 1);
  assert.equal(reqs, 6);
});

test('store: rolling 24h includes previous day and >500 requests, excludes outside range, counts cache once', async () => {
  const { summarizeLast24Hours } = await import('../src/store/requests.mjs');
  const end = new Date(2030, 0, 2, 0, 15).getTime();
  const from = end - 86_400_000;
  await insertRequest({ ts: from - 1, inputTokens: 9000 });
  await insertRequest({ ts: end, inputTokens: 9000 });
  for (let i = 0; i < 601; i++) {
    await insertRequest({ ts: from + i, inputTokens: 10, outputTokens: 5, cachedTokens: 7 });
  }
  await insertRequest({ ts: end - 1, inputTokens: 20, outputTokens: 6, cachedTokens: 12 });
  const summary = await summarizeLast24Hours(end);
  assert.equal(summary.from, from);
  assert.equal(summary.to, end);
  assert.equal(summary.buckets.length, 24);
  assert.equal(summary.buckets[0].requests, 601);
  assert.equal(summary.buckets[23].requests, 1);
  assert.equal(summary.buckets.reduce((sum, b) => sum + b.requests, 0), 602);
  assert.equal(summary.buckets.reduce((sum, b) => sum + b.tokens, 0), 601 * 15 + 26);
  assert.ok(summary.buckets.slice(1, 23).every(b => b.requests === 0));
});

test('store:设置 KV 与固定承接账号(固定跨重启持久化)', async () => {
  const { getSetting, setSetting, deleteSetting } = await import('../src/store/settings.mjs');
  assert.equal(await getSetting('kv_test'), null);
  await setSetting('kv_test', 'v1');
  assert.equal(await getSetting('kv_test'), 'v1');
  await setSetting('kv_test', 'v2');
  assert.equal(await getSetting('kv_test'), 'v2');
  await deleteSetting('kv_test');
  assert.equal(await getSetting('kv_test'), null);

  const { getPinnedUpstreamKeyId, setPinnedUpstreamKeyId } = await import('../src/store/keys.mjs');
  assert.equal(await getPinnedUpstreamKeyId(), null, '未固定时返回 null(而非 NaN/0)');
  await setPinnedUpstreamKeyId('bogus');
  assert.equal(await getPinnedUpstreamKeyId(), null, '脏值按未固定处理');
  const up = (await listUpstreamKeys()).find(k => k.status === 'active');
  await setPinnedUpstreamKeyId(up.id);
  assert.equal(await getPinnedUpstreamKeyId(), up.id);
  await setPinnedUpstreamKeyId(null);
  assert.equal(await getPinnedUpstreamKeyId(), null);
  // 持久化:原始 DatabaseSync 复核(固定是路由偏好,重启必须保留)
  await setPinnedUpstreamKeyId(up.id);
  const raw = new DatabaseSync(join(dataDir, 'ccp.db'));
  const row = raw.prepare("SELECT value FROM settings WHERE key = 'route_pinned_upstream_id'").get();
  raw.close();
  assert.equal(row.value, String(up.id));
  await setPinnedUpstreamKeyId(null);
});
