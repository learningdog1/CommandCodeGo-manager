// 静态托管测试(issue #1 回归):workdir 里放一个 public/index.html,
// 验证 GET / 与 SPA fallback 路径能命中静态文件(Windows 分隔符混用会让
// 防穿越前缀判断恒 false → 全部 404;修复后统一用 path.sep)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, startProxy } from './helpers.mjs';

test('static:GET / 返回 index.html;未知路径 SPA fallback;资源型 404 不回退', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-static-'));
  writeFileSync(join(workdir, 'config.json'), '{}');
  mkdirSync(join(workdir, 'public', 'assets'), { recursive: true });
  writeFileSync(join(workdir, 'public', 'index.html'), '<!doctype html><title>ccp-ui</title>');
  writeFileSync(join(workdir, 'public', 'assets', 'app-12345678.js'), '// bundle');

  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    const root = await proxy.get('/');
    assert.equal(root.status, 200);
    assert.match(await root.text(), /ccp-ui/);

    // SPA fallback:非 API 未知路径回落 index.html(前端路由)
    const spa = await proxy.get('/accounts');
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /ccp-ui/);

    // 静态资产命中 + 不存在的资源型路径不回退(404 走 API 兜底 JSON)
    const asset = await proxy.get('/assets/app-12345678.js');
    assert.equal(asset.status, 200);
    assert.equal((await proxy.get('/assets/nope-99999999.js')).status, 404);

    // 目录穿越被拒
    const evil = await proxy.get('/..%2f..%2fconfig.json');
    assert.notEqual(evil.status, 200);

    // 回归:目录存在但目录下没有 index.html 时,不得把不存在的路径交给
    // createReadStream —— ReadStream 的 ENOENT error 无人处理,曾把整个进程
    // 打崩(GET /assets/ 即可反复杀死服务);现在按 SPA fallback 回 index.html
    const dir = await proxy.get('/assets/');
    assert.equal(dir.status, 200);
    assert.match(await dir.text(), /ccp-ui/);
    // 上述请求后进程必须仍活着(崩溃路径的直接断言)
    assert.equal((await proxy.get('/health')).status, 200);

    // 回归:畸形百分号编码('/%'、'/a%zz')不得让 decodeURIComponent 抛
    // URIError 变成 500;按静态未命中走 404
    assert.notEqual((await proxy.get('/%')).status, 500);
    assert.notEqual((await proxy.get('/a%zz')).status, 500);
  } finally {
    await proxy.kill();
    await mock.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
