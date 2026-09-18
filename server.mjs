#!/usr/bin/env node
/**
 * CommandCodeGo-manager 服务入口。
 * 职责:Node 版本门禁 → 静默 node:sqlite 的 ExperimentalWarning(22.x,无害,
 * 见 README)→ 加载配置引导(src/config.mjs 首启落 data/config.json)与
 * HTTP 服务(src/routes/server.mjs)。
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`[commandcodego-manager] 需要 Node >= 22.5(当前 ${process.versions.node})。`);
  process.exit(1);
}
// node:sqlite 在 22.x 每次触发 ExperimentalWarning;只静默这一种,
// 其余警告(MaxListenersExceeded、未来的弃用警告等)照常打到 stderr,不被误吞
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning' && /sqlite/i.test(String(w?.message))) return;
  console.error(`(node:${process.pid}) ${w?.stack ?? String(w)}`);
});

await import('./src/routes/server.mjs');
