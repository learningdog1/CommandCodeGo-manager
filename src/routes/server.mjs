// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
import http from "http";
import { CFG } from "../config.mjs";
import { sendJSON } from "../http/respond.mjs";
import { MAX_BODY_SIZE, STREAM_IDLE_TIMEOUT_MS, NONSTREAM_IDLE_TIMEOUT_MS, MAX_INFLIGHT, CLIENT_DRAIN_TIMEOUT_MS } from "../limits.mjs";
import { log } from "../log.mjs";
import { MODELS } from "../protocol/models.mjs";
import { handleChatCompletions } from "./chat.mjs";
import { handleMessages } from "./messages.mjs";
import { handleResponses } from "./responses.mjs";
import { handleModels } from "./models-route.mjs";
import { createAdminApi } from "../admin/api.mjs";
import { serveStatic } from "../static.mjs";

let inflightCount = 0;   // 当前在途请求数（不含 /health）
const handleAdmin = createAdminApi({ getInflight: () => inflightCount });
function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS:/v1 与静态资源保持参考实现的宽松 CORS(任意客户端可用);
  // /admin/* 同源管理界面,不放宽
  const reqPath = (req.url || '/').split('?')[0];
  const isAdminPath = reqPath.startsWith('/admin');
  if (!isAdminPath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  // 在途上限准入。/health、/ 与 /admin 例外：探活、管理界面与编排器不该因业务繁忙而收 503。
  const isLiveness = url.pathname === '/health' || url.pathname === '/' || url.pathname.startsWith('/admin');
  if (!isLiveness && MAX_INFLIGHT > 0) {
    if (inflightCount >= MAX_INFLIGHT) {
      log('warn', 'In-flight limit reached, rejecting request', {
        maxInflight: MAX_INFLIGHT, inflight: inflightCount, path: url.pathname,
      });
      sendJSON(res, 503, {
        error: { message: `Too many concurrent requests (limit ${MAX_INFLIGHT}), retry shortly`, type: 'server_busy' },
        retry_after: 5,
      });
      return;
    }
    inflightCount++;
    // 释放时机：响应写完（finish）或连接终止（close）—— 取先到者，且幂等，
    // 保证任何退出路径（成功/出错/客户端断连/超时）都不会泄漏槽位。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (inflightCount > 0) inflightCount--;
    };
    res.once('finish', release);
    res.once('close', release);
  }

  try {
    if (url.pathname.startsWith('/admin/api/')) {
      await handleAdmin(req, res, url);
    } else if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/health') {
      handleHealth(req, res);
    } else {
      // Web UI(SPA):public/ 静态资源 + index.html 回落;未命中再 404
      const handled = await serveStatic(req, res, url);
      if (!handled) sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    // 未预期异常必须留痕(此前静默返回 500,线上排障看不到任何线索)
    log('error', 'Unhandled request error', { path: url.pathname, message: e.message, stack: e.stack?.split('\n')[1] });
    if (!res.headersSent) {
      sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
    } else {
      try { res.end(); } catch {} // 头已发出(如流式中途抛错),只能掐断连接
    }
  }
});

// 全局兜底：abort 触发的异步 rejection 不会让进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // 客户端断连触发的 abort — 预期行为，静默处理
    log('info', 'Aborted request cleaned up');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

// ── keep-alive 时序（放在反向代理后面时是必调项） ──────────────
// 反代（nginx/OpenResty）的 upstream keepalive_timeout 必须**小于**这里的值，
// 否则反代会复用一条后端已经关掉的连接：它把请求体写过去，后端早已 FIN，
// 写这一侧就是 EPIPE —— nginx 侧表现为
//   sendfile() failed (32: Broken pipe) while sending request to upstream
// 而这条请求是 POST（非幂等），nginx 默认不会重试 → 客户端直接吃 502。
//
// Node 默认 keepAliveTimeout=5s。反代若用常见的 4s，余量只有 1 秒；一旦反代的
// 空闲判定基准与后端差一点（大响应体读完的时刻 vs 后端写完的时刻），就会踩上。
// 这里显式抬到 65s，让「谁先关」不再取决于一两秒的抖动 —— 与 Node 官方在
// 反向代理后部署的建议一致（keepAliveTimeout > 前端 idle timeout）。
// 反代侧仍建议设 keepalive_timeout 60s 以内。
const KEEPALIVE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_KEEPALIVE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 65000;
})();
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = KEEPALIVE_TIMEOUT_MS + 1000;   // Node 要求 headersTimeout > keepAliveTimeout

server.listen(CFG.port, CFG.host, () => {
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    session: '12h + 1h jitter, per API key',
    zdr: CFG.zdr ? 'enabled (x-cmd-zdr: 1 on generation/init requests)' : 'off (CMD_ZDR=1 or per-request x-cmd-zdr: 1 to enable)',
    emptySystemPlaceholder: CFG.emptySystemPlaceholder ? 'on (space placeholder for requests without system prompt, issue #17)' : 'off',
    logFile: CFG.logFile || '(console only)',
    clientDrainTimeout: CLIENT_DRAIN_TIMEOUT_MS > 0 ? `${CLIENT_DRAIN_TIMEOUT_MS}ms` : 'disabled',
    keepAliveTimeout: `${KEEPALIVE_TIMEOUT_MS}ms (反代侧 keepalive_timeout 必须小于它)`,
    idleTimeouts: `stream ${STREAM_IDLE_TIMEOUT_MS}ms / nonstream ${NONSTREAM_IDLE_TIMEOUT_MS}ms`,
    maxInflight: MAX_INFLIGHT > 0 ? `${MAX_INFLIGHT} (global, /health exempt)` : 'unlimited (CC_MAX_INFLIGHT=0)',
  });
  if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
    log('info', 'Client drain timeout enabled', { timeoutMs: CLIENT_DRAIN_TIMEOUT_MS });
  }
  // 内存提示：body 上限隐含的最坏内存 = 上限 × 实测放大系数（见 MAX_BODY_SIZE 注释 / issue #20）
  const bodyCapMB = Math.round(MAX_BODY_SIZE / 1048576);
  const worstCaseMB = Math.round(bodyCapMB * 5.5);
  if (worstCaseMB >= 500) {
    log('warn', 'Request body limit implies high per-request worst-case memory', {
      maxBodyMB: bodyCapMB,
      worstCaseRSSPerRequestMB: worstCaseMB,
      hint: 'lower CC_MAX_BODY_MB and/or cap in-flight requests at the reverse proxy (see README)',
    });
  }
  if (!CFG.apiKey) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }
});
