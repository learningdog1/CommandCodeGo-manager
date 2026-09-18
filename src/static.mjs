// 静态托管:服务 public/(Vite 构建产物),带 MIME 与缓存策略。
// SPA fallback:非 /v1、非 /admin/api 的未知路径回落到 index.html(前端路由)。
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize, sep, basename } from 'node:path';
import { appDir } from './paths.mjs';

// 静态资源目录 = <运行基目录>/public(与 data 同级;见 src/paths.mjs 说明)。
// 前缀必须用平台分隔符拼接:join() 在 Windows 产出反斜杠,若硬编码拼 '/',
// 下方 startsWith 防穿越判断会因分隔符混用恒为 false,静态托管整体 404(issue #1)。
const PUBLIC_DIR = join(appDir, 'public') + sep;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res, filePath, status = 200) {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  // 带 hash 的静态资源(如 /assets/index-BwXk3.js)缓存 1 年;index.html 不缓存(SPA 要拿新版本)
  // basename 也按平台分隔符取段:Windows 上路径含反斜杠,split('/') 取不到文件名
  const immutable = status === 200 && /\.[0-9a-f]{8,}\.(js|css|woff2?|ttf|svg|png)$/i.test(basename(filePath) ?? '');
  res.writeHead(status, {
    'Content-Type': mime,
    'Cache-Control': filePath.endsWith('index.html') || status !== 200
      ? 'no-cache'
      : immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

/** 返回 true 表示已处理(命中静态文件或 SPA fallback)。 */
export async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // 防目录穿越:规范化后必须仍在 public/ 内
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return false;

  let filePath = target;
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // 不存在的文件:SPA fallback 到 index.html(前端路由),但资源型后缀不回退
    if (/\.[a-z0-9]+$/i.test(rel)) return false;
    filePath = join(PUBLIC_DIR, 'index.html');
    try { statSync(filePath); } catch { return false; } // UI 未构建
  }

  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' }); res.end(); return true; }
  sendFile(res, filePath);
  return true;
}
