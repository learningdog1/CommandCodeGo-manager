// 桌面版更新器纯函数单测(issue #11):版本比较 / 资产挑选 / digest 解析。
// updater.cjs 顶层不依赖 electron,直接以 CJS 加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { compareVersions, parseVersion, pickAsset, digestToHex, createUpdater } = require_('../desktop/updater.cjs');

test('parseVersion:接受/拒绝的标签形态', () => {
  assert.deepEqual(parseVersion('v0.2.14'), { major: 0, minor: 2, patch: 14, pre: '' });
  assert.deepEqual(parseVersion('0.3.0-beta.1'), { major: 0, minor: 3, patch: 0, pre: 'beta.1' });
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('v0.2'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
});

test('compareVersions:主版本/预发布语义', () => {
  assert.equal(compareVersions('v0.2.15', '0.2.14'), 1);
  assert.equal(compareVersions('0.2.14', 'v0.2.14'), 0);
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  // 预发布 < 正式版;预发布段数字比较按数值
  assert.equal(compareVersions('0.3.0', '0.3.0-rc.1'), 1);
  assert.equal(compareVersions('0.3.0-rc.2', '0.3.0-rc.10'), -1);
  // 解析失败(上游换了命名)按「有新版」处理,宁可提示不可漏报
  assert.equal(compareVersions('weird-tag', '0.2.14'), 1);
});

const RELEASE = {
  tag_name: 'v0.2.15',
  html_url: 'https://github.com/learningdog1/CommandCodeGo-manager/releases/tag/v0.2.15',
  body: '修复若干问题',
  assets: [
    { name: 'CommandCodeGo.Manager-Portable-0.2.15-x64.exe', size: 94_000_000, digest: 'sha256:' + 'a'.repeat(64) },
    { name: 'CommandCodeGo.Manager-Setup-0.2.15-x64.exe', size: 90_000_000, digest: 'sha256:' + 'b'.repeat(64) },
    { name: 'CommandCodeGo.Manager-Setup-0.2.15-arm64.exe', size: 88_000_000, digest: '' },
    { name: 'CommandCodeGo.Manager-Update-0.2.15-x64.zip', size: 92_000_000, digest: 'sha256:' + 'c'.repeat(64) },
    { name: 'CommandCodeGo.Manager-0.2.15-arm64-mac.zip', size: 100_000_000, digest: 'sha256:' + 'd'.repeat(64) },
    { name: 'CommandCodeGo.Manager-0.2.15-x64-mac.zip', size: 101_000_000, digest: 'sha256:' + 'e'.repeat(64) },
  ],
};
const assetNamed = (r, name) => r.assets.find(a => a.name === name);

test('pickAsset:windows 按安装形态选包(便携=Update zip / NSIS=Setup exe)', () => {
  // 便携形态(默认):只认 Update zip —— Setup exe 会写注册表/快捷方式,破坏免安装属性
  const portable = pickAsset(RELEASE, 'win32', 'x64', 'CommandCodeGo Manager', 'portable');
  assert.equal(portable.kind, 'update-zip');
  assert.equal(portable.name, 'CommandCodeGo.Manager-Update-0.2.15-x64.zip');
  assert.equal(portable.digest, 'c'.repeat(64));
  // NSIS 形态:首选 Setup exe
  const nsis = pickAsset(RELEASE, 'win32', 'x64', 'CommandCodeGo Manager', 'nsis');
  assert.equal(nsis.kind, 'nsis-setup');
  assert.equal(nsis.name, 'CommandCodeGo.Manager-Setup-0.2.15-x64.exe');
  assert.equal(nsis.digest, 'b'.repeat(64));
});

test('pickAsset:windows arm64 不串到 x64 资产', () => {
  const portable = pickAsset(RELEASE, 'win32', 'arm64', 'CommandCodeGo Manager', 'portable');
  assert.equal(portable, null); // 该 release 没打 arm64 的 Update zip
  const nsis = pickAsset(RELEASE, 'win32', 'arm64', 'CommandCodeGo Manager', 'nsis');
  assert.equal(nsis.name, 'CommandCodeGo.Manager-Setup-0.2.15-arm64.exe');
  assert.equal(nsis.digest, ''); // 无 digest → 下载时跳过校验并提示
});

test('pickAsset:mac 按架构选 -mac.zip', () => {
  assert.equal(pickAsset(RELEASE, 'darwin', 'arm64', 'CommandCodeGo Manager').name, 'CommandCodeGo.Manager-0.2.15-arm64-mac.zip');
  assert.equal(pickAsset(RELEASE, 'darwin', 'x64', 'CommandCodeGo Manager').name, 'CommandCodeGo.Manager-0.2.15-x64-mac.zip');
});

test('pickAsset:缺资产/空 release/其它平台返回 null', () => {
  assert.equal(pickAsset({ assets: [] }, 'win32', 'x64', 'CommandCodeGo Manager'), null);
  assert.equal(pickAsset(null, 'win32', 'x64', 'CommandCodeGo Manager'), null);
  assert.equal(pickAsset(RELEASE, 'linux', 'x64', 'CommandCodeGo Manager'), null);
  // 早期 release(如 v0.2.14)只有 Portable/Setup exe,没有 Update zip:
  // 便携形态选不出包(界面引导去发布页);NSIS 形态仍可用 Setup
  const oldStyle = { assets: [assetNamed(RELEASE, 'CommandCodeGo.Manager-Portable-0.2.15-x64.exe')] };
  assert.equal(pickAsset(oldStyle, 'win32', 'x64', 'CommandCodeGo Manager', 'portable'), null);
  const oldNsis = pickAsset(oldStyle, 'win32', 'x64', 'CommandCodeGo Manager', 'nsis');
  assert.equal(oldNsis, null); // 只有 Portable exe,Setup 缺席且无 zip 兜底
});

test('digestToHex:sha256 前缀剥离与非法输入', () => {
  assert.equal(digestToHex('sha256:' + 'a'.repeat(64)), 'a'.repeat(64));
  assert.equal(digestToHex('A'.repeat(64)), 'a'.repeat(64));
  assert.equal(digestToHex('sha256:short'), '');
  assert.equal(digestToHex(''), '');
  assert.equal(digestToHex(undefined), '');
});

// ── 状态机集成(createUpdater + 桩 fetch/app)─────────────────
// 覆盖两类真实回归:① ready 状态被周期轮询推翻导致整包重下;
// ② 下载失败后状态机卡死/错误不回显。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const PN = 'CommandCodeGo Manager';
const pnDot = PN.replace(/ /g, '.');

function makeReleaseAssets(version) {
  // 覆盖测试机平台:win(win32)与 mac(darwin)按 process.arch 生成
  const arch = process.arch;
  const list = [
    { name: `${pnDot}-Setup-${version}-${arch}.exe` },
    { name: `${pnDot}-Update-${version}-${arch}.zip` },
    { name: `${pnDot}-${version}-${arch}-mac.zip` },
  ];
  return list;
}

function stubUpdater({ version = '0.2.14', latest = '0.2.15', fetchImpl, onUpdateAvailable } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'ccp-upd-test-'));
  const realFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const states = [];
  const upd = createUpdater({
    app: { getVersion: () => version, isPackaged: true, getPath: () => tmp },
    notify: s => states.push(s.status),
    onUpdateAvailable,
    spawnDetached: () => {},
    quitApp: () => {},
  });
  return {
    upd, states, tmp,
    restore() { if (fetchImpl) globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); },
  };
}

const releaseJson = latest => ({
  tag_name: `v${latest}`,
  html_url: 'https://github.com/learningdog1/CommandCodeGo-manager/releases/tag/v' + latest,
  body: '修复若干问题',
  assets: makeReleaseAssets(latest).map(a => ({ ...a, size: 4096, browser_download_url: 'https://example.com/' + a.name, digest: 'sha256:' + 'f'.repeat(64) })),
});

test('状态机:自动检查失败 → 静默保持原状态,不写 error(验收:断网/限流静默跳过)', async () => {
  let calls = 0;
  const h = stubUpdater({ fetchImpl: async () => { calls++; throw new Error('rate limited'); } });
  try {
    const s1 = await h.upd.check(false);
    assert.equal(calls, 1);
    assert.equal(s1.status, 'idle');
    assert.equal(s1.error, null);
  } finally { h.restore(); }
});

test('状态机:手动检查失败 → error 回显给界面(不弹系统对话框)', async () => {
  const h = stubUpdater({ fetchImpl: async () => { throw new Error('boom'); } });
  try {
    const s1 = await h.upd.check(true);
    assert.equal(s1.status, 'idle');
    assert.match(s1.error, /检查更新失败/);
  } finally { h.restore(); }
});

test('状态机:发现新版 → available 且选中本机资产;回调用于托盘气泡', { skip: process.platform === 'linux' }, async () => {
  let seen = null;
  const rel = releaseJson('0.2.15');
  const h = stubUpdater({ fetchImpl: async url => new Response(JSON.stringify(rel), { headers: { 'content-type': 'application/json' } }), onUpdateAvailable: v => { seen = v; } });
  try {
    const s1 = await h.upd.check(false);
    assert.equal(s1.status, 'available');
    assert.equal(s1.latestVersion, '0.2.15');
    assert.ok(s1.asset && s1.asset.name.includes('0.2.15'));
    assert.equal(seen, '0.2.15');
  } finally { h.restore(); }
});

test('状态机:下载 → sha256 校验通过 → ready;同版本重复检查不推翻 ready', { skip: process.platform === 'linux' }, async () => {
  const rel = releaseJson('0.2.15');
  const payload = new Uint8Array(2048); // sha256 与资产 digest 对不上 → 先生成对的
  const hex = createHash('sha256').update(payload).digest('hex');
  for (const a of rel.assets) a.digest = `sha256:${hex}`;
  const apiBody = JSON.stringify(rel);
  const dlBody = new Response(payload, { headers: { 'content-length': String(payload.length) } });
  let dlUsed = false;
  const h = stubUpdater({
    fetchImpl: async url => {
      if (String(url).includes('api.github.com')) return new Response(apiBody, { headers: { 'content-type': 'application/json' } });
      dlUsed = true; return dlBody;
    },
  });
  try {
    await h.upd.check(true);
    const s2 = await h.upd.download();
    assert.equal(s2.status, 'ready');
    assert.equal(s2.progress, 1);
    assert.ok(dlUsed);
    // 周期轮询命中同一 release:ready 不得被推翻(否则用户要重下整个包)
    const s3 = await h.upd.check(false);
    assert.equal(s3.status, 'ready');
  } finally { h.restore(); }
});

test('状态机:下载网络失败 → 回到 available 并回显错误,不卡在 downloading', { skip: process.platform === 'linux' }, async () => {
  const rel = releaseJson('0.2.15');
  const h = stubUpdater({
    fetchImpl: async url => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(rel), { headers: { 'content-type': 'application/json' } });
      throw new Error('ETIMEDOUT');
    },
  });
  try {
    await h.upd.check(true);
    const s2 = await h.upd.download();
    assert.equal(s2.status, 'available');
    assert.match(s2.error, /下载失败/);
  } finally { h.restore(); }
});

test('状态机:下载内容与 digest 不符 → 拒绝 ready', { skip: process.platform === 'linux' }, async () => {
  const rel = releaseJson('0.2.15');
  const payload = new Uint8Array(1024);
  const hex = createHash('sha256').update(payload).digest('hex');
  for (const a of rel.assets) a.digest = `sha256:${'0'.repeat(64)}`; // 恒错
  void hex;
  const h = stubUpdater({
    fetchImpl: async url => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify(rel), { headers: { 'content-type': 'application/json' } });
      return new Response(payload, { headers: { 'content-length': String(payload.length) } });
    },
  });
  try {
    await h.upd.check(true);
    const s2 = await h.upd.download();
    assert.equal(s2.status, 'available');
    assert.match(s2.error, /sha256 校验失败/);
  } finally { h.restore(); }
});
