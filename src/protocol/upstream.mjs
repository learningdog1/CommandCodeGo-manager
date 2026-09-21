// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
// 唯一适配:原模块级 let consecutiveTimeouts 被三个路由模块读写,改为导出可变对象 timeoutStats(语义不变)。
import crypto from 'crypto';
import { CFG } from '../config.mjs';
import { slugifyProjectPath, DEVICE_PROFILE } from './fingerprint.mjs';
import { getSessionId } from './session.mjs';
import { log, summarizeUpstreamError } from '../log.mjs';
// 本代理**实际实现**的 wire 协议版本（对齐 command-code@1.53.1 源码）。
// 真机发的永远是「形状 + 版本号」自洽的组合；如果版本号跟着 npm 走而形状没变，
// 就变成「自称最新版、却说旧方言」—— 这比版本号过期更容易被行为分析挑出来。
// 因此这里报的是协议版本，npm 上更新了只告警、不自动改。
const CC_PROTOCOL_VERSION = '1.53.1';
let CC_VERSION = CC_PROTOCOL_VERSION;
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — 检查一次是否发生漂移

// ── 协议漂移检测（只告警，不改版本号） ─────────────
// 上游 CLI 更新可能带来协议变化。这里只负责提醒「该重新读包对齐了」，
// 绝不会把 x-command-code-version 改成一个我们并未实现的版本。
// 漂移状态(供 Web 界面展示):只记录最近一次检查结果,不改变检测行为。
export const driftStatus = { lastCheckedAt: null, latestVersion: null, protocolVersion: CC_PROTOCOL_VERSION, changed: false, lastError: null };

async function checkProtocolDrift() {
  driftStatus.lastCheckedAt = Date.now();
  driftStatus.lastError = null;
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    const latest = typeof pkg?.version === 'string' ? pkg.version : null;
    if (latest) {
      driftStatus.latestVersion = latest;
      driftStatus.changed = latest !== CC_PROTOCOL_VERSION;
    }
    if (latest && latest !== CC_PROTOCOL_VERSION) {
      log('warn', 'CC CLI version drift: protocol may have changed, re-align from the npm package', {
        implemented: CC_PROTOCOL_VERSION, latest,
      });
    } else if (latest) {
      log('info', 'CC CLI version in sync', { version: latest });
    }
  } catch (e) {
    driftStatus.lastError = e.message;
    log('warn', 'CC version check failed', { error: e.message });
  }
}
checkProtocolDrift(); // 启动时立即检查
setInterval(checkProtocolDrift, CC_VERSION_REFRESH_MS);

// 连续超时计数：连续 3 次超时才提醒压缩上下文，任意成功请求后重置
const timeoutStats = { consecutive: 0 };
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;
function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}
// normalize CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

// CC 的 inputTokens 是「总数」（含缓存命中部分），而 Anthropic 的 input_tokens 只计
// 非缓存部分 —— 官方 SDK 注释：Total input tokens in a request is the summation of
// `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`。
// 直接把 CC 的 inputTokens 当 input_tokens 转发，会让下游把两者当成互不重叠的两部分，
// 相加后约为真实输入的两倍（issue #25）。
//
// CC 实际已经算好：inputTokenDetails.noCacheTokens（实测 noCacheTokens + cacheReadTokens
// === inputTokens）。优先采用该字段；缺失时回退到减法，保证老版本上游也能得到正确值。
function anthropicInputTokens(usage, noCacheOverride) {
  const u = usage || {};
  if (typeof noCacheOverride === 'number' && noCacheOverride >= 0) return noCacheOverride;
  const noCache = u.inputTokenDetails && u.inputTokenDetails.noCacheTokens;
  if (typeof noCache === 'number' && noCache >= 0) return noCache;
  const cacheRead = u.cachedInputTokens || (u.inputTokenDetails && u.inputTokenDetails.cacheReadTokens) || 0;
  const cacheWrite = (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0;
  return Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
}

// 从 finish / finish-step 事件里取「有效的完成原因」，对齐 CLI 的读法：
//   s = rawFinishReason ?? finishReason          （command-code@1.53.1 起即如此，1.58.1 未变）
// 两条补充规则（同样来自 CLI 的 runAiSdkStream）：
//   · finishReason === 'other' 且没有 rawFinishReason → 视为「没有有效完成信号」（CLI 报 502 截断）
//   · 网络失败族(network/connection/upstream error)只会出现在 rawFinishReason 里 ——
//     只读 finishReason 会把它漏成「正常结束」，正是 issue #5「只有思考、无正文无工具调用」的根因。
// 真机抓包佐证：正常结束的 finish 事件总是同时显式携带两者
// （如 {"finishReason":"stop","rawFinishReason":"stop"} 或 tool-calls / tool_calls），
// 因此「两个字段都为空」在上游 wire 上不是合法的正常结束，按不完整处理是安全的。
function eventFinishReason(event, ctx) {
  const raw = event?.rawFinishReason;
  const fin = event?.finishReason;
  const rawEmpty = raw === undefined || raw === null || String(raw).trim() === '';
  if (rawEmpty && fin === 'other') return '';
  const v = rawEmpty ? fin : raw;
  if (v === undefined || v === null || String(v).trim() === '') {
    // issue #5 建议的原始日志：finish 宣告了完成却没说为什么，必须留痕才能与上游对账。
    // 只记标量字段 —— finish 事件可能带巨大的 providerMetadata/gateway 路由块。
    log('warn', 'Finish event without a finish reason', {
      path: ctx?.path, eventType: event?.type,
      finishReason: fin ?? null, rawFinishReason: raw ?? null,
      hasTotalUsage: !!(event?.totalUsage || event?.usage),
    });
    return '';
  }
  return String(v);
}

// 上游 finishReason → 本代理内部规范化取值。
// 对齐 CLI 的 normalizeStopReason2 / isNetworkFailureFinish（command-code@1.54.0）：
//   tool_use | tool-calls | tool_calls                    → tool_calls
//   length | max_tokens | max_output_tokens
//          | model_context_window_exceeded                → length
//   /^(network|connection|upstream)[-_\s]?error$/i        → upstream_error
//   pause_turn                                            → pause_turn（原样保留）
// 关键点：'length' 家族**不止 'length' 一个值**。max_output_tokens 与
// model_context_window_exceeded 都是「输出被截断」，折成 stop/end_turn 等于
// 把半截回答谎报成完整回答。未知值一律原样返回，宁可让它露出来也不要静默折成 stop。
// 空值（上游宣告 finish 却没给原因）返回 null —— 折成 'stop' 正是 issue #5 反对的
// 「谎报完成」；null 会被 incompleteUpstreamDetail 判为可重试的 502，下游有机会重试。
// 入参应传 eventFinishReason(event) 的结果，而不是裸的 event.finishReason。
function mapFinishReason(reason) {
  const r = String(reason ?? '').trim().toLowerCase();
  if (!r) return null;
  if (r === 'tool-calls' || r === 'tool_calls' || r === 'tool_use') return 'tool_calls';
  if (r === 'length' || r === 'max_tokens'
      || r === 'max_output_tokens' || r === 'model_context_window_exceeded') return 'length';
  if (/^(?:network|connection|upstream)[-_\s]?error$/.test(r)) return 'upstream_error';
  return r;
}

// 上游「没有正常走完」的两种情形，CLI 都当成可重试的 502：
//   · 流里根本没有 finish 事件 —— "Stream ended unexpectedly before completion
//     (no finish event) — response was truncated"
//   · provider 报 network/connection/upstream-error —— isNetworkFailureFinish
// 返回 null 表示这次流是正常结束的。
//
// sawFinish 的口径是「上游给过任何完成信号」：终态 finish，以及本代理一直在处理的
// finish-step。（'finish-step' 在 CLI 的事件集里不存在 —— 见 proxy.mjs 各处注释 ——
// 但既然代理认它，就不能让它变成「没完成」，否则会把原本正常的响应误判成 502。
// 真正要拦的是「一个完成信号都没有就断了」。）
function incompleteUpstreamDetail(sawFinish, finishReason) {
  if (!sawFinish) return 'no finish event';
  if (finishReason === 'upstream_error') return 'provider reported an upstream connection failure';
  // finish 事件存在但没说为什么结束（两字段皆空 / 'other' 且无 raw，见 eventFinishReason）：
  // CLI 把它当成 "no finish event" 同族的截断处理；谎报 stop 会让下游拿到
  // 「只有思考、无正文无工具调用」的空回复还以为这轮正常完成（issue #5）。
  if (!finishReason) return 'finish event without a finish reason';
  return null;
}

function incompleteUpstreamError(detail) {
  return {
    status: 502,
    // retry_after 同时放在 body 里与顶层：sendJSON 只发 body，
    // 而 sendAnthropicError / sendResponsesError 需要单独的形参。
    body: {
      error: {
        message: `Upstream stream ended without a completion finish (${detail}) — response was truncated`,
        type: 'upstream_error',
      },
      retry_after: 10,
    },
    retry_after: 10,
  };
}
// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;
  let code = null;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
      // 上游错误体：{"success":false,"error":{"code":"BAD_REQUEST"|"USAGE_EXCEEDED",...}}
      // code 是上游的机器可读错误分类（BAD_REQUEST / USAGE_EXCEEDED 等），透出来便于下游 SDK 与运维判定
      code = parsed.error?.code || parsed.code || null;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      code,
      body: {
        error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) },
        retry_after: 30,
      },
    };
  }

  // 402（配额/计费窗口耗尽）保持 429 的退避语义，但必须在 message 里说清这不是
  // 瞬时限流 —— 只按状态码退避的下游会无限空转（issue #5 的独立观察）。
  if (ccStatus === 402) {
    return {
      status: 429,
      code,
      body: {
        error: {
          message: `${message}${code ? ` (code: ${code})` : ''} — quota or billing window exhausted (payment required upstream), not a transient rate limit; retrying the same key will not help until the window resets`,
          type: 'rate_limit_error',
          ...(code ? { code } : {}),
        },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, code, body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

function mapCcEventError(event) {
  const message = event.error?.message || event.message || 'Unknown CC error';
  const code = event.error?.code || event.code || null;
  // 上游 error 事件除了 message 还可能自带 statusCode / isRetryable ——
  // CLI 的 readStreamErrorEvent 读的正是这两个字段，取值链是
  //   parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null
  // 原实现只看 message 里的 "<NNN>" 前缀，statusCode 一律被丢掉，
  // 于是 429 / 503 这类「该退避重试」的信号在代理这一层被抹平成 502「服务端错误」：
  // 客户端不再按限流退避，监控也会把它错误归类成后端故障。
  const statusMatch = message.match(/^<(\d{3})>/);
  const reportedStatus = statusMatch
    ? Number(statusMatch[1])
    : (Number.isInteger(event.error?.statusCode) ? event.error.statusCode : null);
  const ccStatus = reportedStatus ?? 502;
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };

  // 与 mapCcError 保持一致：终态为 429 时带上 retry_after，
  // 否则客户端 SDK 拿不到退避提示（402 也映射成 429，一视同仁）
  if (mapped.status === 429) {
    return {
      status: 429,
      code,
      reportedStatus,
      body: { error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) }, retry_after: 30 },
    };
  }

  return { status: mapped.status, code, reportedStatus,
    body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}
// ── 流式转发 ────────────────────────────────────────

async function forwardToCC(body, apiKey, incomingHeaders = {}, signal, promptCacheKey) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = getSessionId(incomingHeaders, apiKey, promptCacheKey);
  // CLI 的 toWireThreadId：只有合法 UUID 才放进信封，否则整个键省略。
  // 同时按 CLI 的键顺序重排：config, memory, taste, skills, permissionMode, threadId, mode, params
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId))) {
    const ordered = {};
    for (const k of ['config', 'memory', 'taste', 'skills', 'permissionMode']) ordered[k] = body[k];
    ordered.threadId = sessionId;
    for (const k of ['mode', 'promptCache', 'params']) if (k in body) ordered[k] = body[k];
    body = ordered;
  }

  // 与 CLI 的 buildCommandAuthHeaders 对齐：没有 x-co-flag；User-Agent 固定 "cli"
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': CC_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': slugifyProjectPath(DEVICE_PROFILE.projectDir),
    'x-taste-learning': 'false',
    'x-session-id': sessionId,
    'Authorization': `Bearer ${apiKey}`,
    'traceparent': traceparent,
  };

  if (CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1') {
    headers['x-cmd-zdr'] = '1';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  return response;
}

// OpenAI 的 finish_reason 只有 stop | length | tool_calls | content_filter | function_call。
// pause_turn 没有对应值：折成 'stop' 是谎报完成（正是要修的问题），
// 折成 'length' 至少如实表达了「输出不完整」，下游的截断处理会做对的事。
// (拆分说明:原在 Anthropic 转换段,但 chat/responses 路由也调用,移入本模块避免循环依赖。)
function toOpenAIFinishReason(finishReason) {
  return finishReason === 'pause_turn' ? 'length' : finishReason;
}

export {
  CC_PROTOCOL_VERSION, CC_VERSION, CC_VERSION_REFRESH_MS, checkProtocolDrift,
  timeoutStats, TIMEOUT_REDUCE_CONTEXT_THRESHOLD,
  generateTraceparent,
  normalizeUsage, anthropicInputTokens, eventFinishReason, mapFinishReason, toOpenAIFinishReason,
  incompleteUpstreamDetail, incompleteUpstreamError,
  CC_STATUS_MAP, mapCcError, mapCcEventError,
  forwardToCC,
};
