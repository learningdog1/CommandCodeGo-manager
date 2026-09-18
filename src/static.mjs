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
  // ReadStream 的 error 必须有人接:否则 stat 与 open 之间文件被删、或目录回落出
  // 竞态时,ENOENT 的 error 事件无人监听会把整个进程带崩(实测 GET /assets/ 即崩)。
  const stream = createReadStream(filePath);
  stream.on('error', (err) => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Read error');
    } else {
      try { res.end(); } catch {} // 头已发出,只能掐断连接
    }
  });
  // 客户端中途断开时销毁读流:pipe 不会替我们停掉 source,否则文件会被完整读进无人的 socket
  res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  stream.pipe(res);
}

/** 返回 true 表示已处理(命中静态文件或 SPA fallback)。 */
export async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // 畸形百分号编码('/%'、'/a%zz')会让 decodeURIComponent 抛 URIError;
  // 按静态未命中处理走上层 404,而不是 500
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { return false; }
  // 防目录穿越:规范化后必须仍在 public/ 内
  const rel = decoded.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return false;

  // 直达文件存在则用它;目录回落 index.html 后必须**再验一次存在性**:
  // public/assets/ 这类目录没有 index.html,不验就交给 createReadStream 会在
  // 异步 open 时炸出无人处理的 ENOENT —— 单个 GET 就能打崩整个进程。
  const resolveFile = () => {
    let filePath = target;
    let st = null;
    try { st = statSync(filePath); } catch {}
    if (st?.isDirectory()) filePath = join(filePath, 'index.html');
    try { statSync(filePath); return filePath; } catch { return null; }
  };
  let filePath = resolveFile();
  if (!filePath) {
    // 不存在的文件(含无 index.html 的目录):SPA fallback 到 index.html(前端路由),
    // 但资源型后缀不回退
    if (/\.[a-z0-9]+$/i.test(rel)) return false;
    filePath = join(PUBLIC_DIR, 'index.html');
    try { statSync(filePath); } catch { return false; } // UI 未构建
  }

  if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' }); res.end(); return true; }
  sendFile(res, filePath);
  return true;
}
