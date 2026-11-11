// 从 command-code npm 包的 models.md 生成 src/protocol/models.mjs 里的内置权威清单。
// 用法:node scripts/gen-models.mjs [version]   # 缺省 latest
// 输出 MODELS 数组的 JS 字面量(含共 N 个注释),人工比对后贴入 models.mjs。
// 包按不可信数据处理:只在内存里解析 tar 中的 models.md,不落盘、不执行包内代码。
import { spawnSync } from 'node:child_process';

const version = process.argv[2] ?? 'latest';
const meta = JSON.parse(spawnSync('npm', ['view', `command-code@${version}`, 'dist.tarball', '--json'],
  { encoding: 'utf8' }).stdout.toString());
const tarball = Array.isArray(meta) ? meta.at(-1) : meta;
if (typeof tarball !== 'string' || !tarball.startsWith('https://')) {
  console.error('无法解析 tarball 地址:', meta); process.exit(1);
}
console.error(`command-code@${version} → ${tarball}`);

const res = await fetch(tarball);
if (!res.ok) { console.error('下载失败:', res.status); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
// gunzip 后按 tar 条目扫出目标文件(gzip -dc | 手工解 tar,免依赖)
const { gunzipSync } = await import('node:zlib');
const tar = gunzipSync(buf);
const target = 'package/dist/bundled/command-code-knowledge/reference/models.md';
let md = null;
for (let off = 0; off + 512 <= tar.length;) {
  const name = tar.subarray(off, off + 100).toString().utf8Slice?.() ?? tar.toString('utf8', off, off + 100);
  const clean = name.replace(/\0.*$/s, '');
  const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
  if (clean === target) { md = tar.subarray(off + 512, off + 512 + size).toString('utf8'); break; }
  off += 512 + Math.ceil(size / 512) * 512;
}
if (!md) { console.error('包内未找到', target); process.exit(1); }

// Min plan 列 → 内部规范化(与 models.mjs 现有取值一致)
const planOf = (s) => /^go\b/i.test(s) ? 'go' : /^goat\b/i.test(s) ? 'goat' : /^pro\b/i.test(s) ? 'pro' : 'max';
const rows = [];
for (const line of md.split('\n')) {
  const m = /^\| `([^`]+)` \| (.+?) \|/.exec(line);
  if (!m) continue;
  const minPlan = line.split('|')[6]?.trim() ?? '';
  if (!/^(Go|GOAT|Pro|Max)\b/.test(minPlan)) continue;   // 表头/分隔行
  rows.push({ id: m[1], name: m[2].replace(/\s*\([^)]*\)\s*$/, '').trim(), plan: planOf(minPlan) });
}
const lines = rows.map(r => `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, plan: ${JSON.stringify(r.plan)} },`);
console.log(lines.join('\n'));
console.log(`// 共 ${rows.length} 个模型`);
