// 上游账户「窗口受限」运行时状态:自动轮转的依据。
// 上游的 5 小时滚动 / 周窗口到限时并不改变密钥的持久状态(账还在、信用可能还有),
// 只是该账户暂时不可用 —— 所以这里只做**进程内**的临时标记,到期自动解除:
//   live   —— 请求打到上游收到 429 USAGE_EXCEEDED(或 error.rateLimit.window)时标记,
//             有效期到 resetAt(未知则探针 TTL,到期自动放行重试);
//   usage  —— account-usage 刷新发现 fiveHour/weekly/月度信用到顶时标记/已释放时清除。
// 与 402 信用耗尽的持久标记(status='exhausted',落库)互补:那是额度没了,这是窗口到了。
// 「额度没了」有两种到法:402/429 走状态码,上游也可能回 **200 但流里带 error 事件**
// (no credits remaining)—— 后者由 rotation.mjs 的 peekEarlyError 探到,同样落 credit 窗口。
const blocks = new Map();

// keyId → Map(window → block)。各额度窗口独立保存,
// 一个窗口恢复也不能覆盖另一个。
function activeBlocks(keyId) {
  const entries = blocks.get(keyId);
  if (!entries) return [];
  for (const [window, b] of entries) {
    if (b.until && b.until <= Date.now()) entries.delete(window);
  }
  if (!entries.size) blocks.delete(keyId);
  return [...entries.values()];
}

export function isWindowBlocked(keyId) {
  return keyId != null && activeBlocks(keyId).length > 0;
}

export function markWindowBlocked(keyId, { source, window, until }) {
  if (keyId == null) return;
  activeBlocks(keyId);
  const entries = blocks.get(keyId) ?? new Map();
  const cur = entries.get(window);
  const next = { source, window, until: until || 0, at: Date.now() };
  if (cur && (cur.until || Infinity) >= (next.until || Infinity)) return;
  entries.set(window, next);
  blocks.set(keyId, entries);
}

export function getWindowState(keyId) {
  const list = activeBlocks(keyId);
  if (!list.length) return { blocked: false, source: null, window: null, until: null };
  const pick = list.reduce((a, b) => ((b.until || Infinity) > (a.until || Infinity) ? b : a));
  return { blocked: true, source: pick.source, window: pick.window, until: pick.until || null };
}

/** 用量刷新只更新有数据的窗口;失败/缺失数据不解除 live 标记。 */
export function syncFromWindowLimits(keyId, windowLimits) {
  if (keyId == null || !windowLimits) return;
  const hit = w => !!w && (w.exceeded === true || (w.cap > 0 && w.used >= w.cap));
  for (const name of ['fiveHour', 'weekly']) {
    const w = windowLimits[name];
    if (hit(w)) {
      const until = w.resetAt > Date.now() ? w.resetAt : Date.now() + 10 * 60_000;
      markWindowBlocked(keyId, { source: 'usage', window: name, until });
    } else if (w) {
      blocks.get(keyId)?.delete(name);
    }
  }
  // 释放只清「用量窗口」这一族:credit 是信用额度的独立维度,credit 与 live 探针标记
  // 各有自己的数据源,不能被两条模板条的放开顺带擦掉(旧实现是整个 key 一起 blocks.delete)。
  const entries = blocks.get(keyId);
  if (!entries) return;
  if (windowLimits.limited === false) {
    entries.delete('fiveHour');
    entries.delete('weekly');
  } else if (windowLimits.fiveHour && windowLimits.weekly && !windowLimits.exceeded
    && !hit(windowLimits.fiveHour) && !hit(windowLimits.weekly)) {
    entries.delete('usage');
  }
  if (!entries.size) blocks.delete(keyId);
}

/**
 * 信用额度同步(与窗口分开):credits.totalRemaining 归零 = 账户真的没额度了,
 * 标记 credit 到当期结束(拿不到就 6 小时后重探);补上额度后自动解除。
 * 单看 windowLimits 看不出来这件事 —— 那两条模板条只覆盖 5 小时/周,月度额度耗尽时
 * 两条都可能还空着,于是账户永远是 active、每笔请求都打到上游再拿一个 200 包裹的错误。
 */
export function syncFromCredits(keyId, data) {
  if (keyId == null || !data?.credits || typeof data.credits.totalRemaining !== 'number') return;
  if (data.credits.totalRemaining > 0) {
    const entries = blocks.get(keyId);
    if (!entries) return;
    entries.delete('credit');
    if (!entries.size) blocks.delete(keyId);
    return;
  }
  // belowThreshold 只是提示线,不作为判定:剩余 > 0 仍可能够用,归零才是真耗尽
  const end = Date.parse(data.plan?.currentPeriodEnd ?? '');
  const until = Number.isFinite(end) && end > Date.now() ? end : Date.now() + 6 * 3600_000;
  markWindowBlocked(keyId, { source: 'usage', window: 'credit', until });
}

// 上游错误体/错误事件里「这是额度问题」的措辞面(实测过的三种形态都落在这里):
//   429 {"error":{"code":"RATE_LIMITED","message":"You've reached your weekly usage limit
//        for your plan. Your limit resets at <ISO>."}}        ← 真身,旧实现认不出
//   429 {"error":{"code":"USAGE_EXCEEDED","rateLimit":{"window":"fiveHour","reset":<sec>}}}
//   200 {"type":"start"} … {"type":"error","error":{"message":"You have no credits remaining…"}}
const QUOTA_HINT = /(usage limit|no credits|credits remaining|credit balance|insufficient|quota|payment required|billing|limit resets|reached your [a-z ]*limit)/i;
// 信用(钱/额度池)而不是时间窗口 —— 决定持久语义与展示文案
const CREDIT_HINT = /(no credits|credits remaining|credit balance|payment required|insufficient.?quota|top ?up|add credits)/i;
// SSE/JSON 里的错误事件标记:200 响应只有命中它才继续分类(否则正常正文里恰好出现
// "quota"/"usage limit" 就会被误判成耗尽,把好账户封掉)。
export const ERROR_MARKER = /"type"\s*:\s*"error"|"isRetryable"|"success"\s*:\s*false|"error"\s*:\s*\{/;

/** 从报文里抠一个 ISO reset 时间(429 真身只给文本,不给 rateLimit.reset)。 */
function resetFromText(text) {
  const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(String(text ?? ''));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * 分类上游错误是否属于「额度/窗口耗尽」(可轮转):
 *   402 → 信用耗尽(持久,落库 exhausted);
 *   429 → 命中额度码/额度措辞才是耗尽(其余 429 是瞬态限速,不轮转);
 *   200 → 仅用于 peekEarlyError 探到的流内错误事件(信用/额度到顶却回了 200)。
 * 返回 { kind: 'credit' | 'fiveHour' | 'weekly' | 'usage', until, persist? } 或 null。
 *   persist=true 表示「账户层面没了」→ 调用方落库;否则只做运行时窗口标记。
 */
export function classifyExhaustion(status, bodyText) {
  if (status === 402) return { kind: 'credit', until: 0, persist: true };
  if (status !== 429 && status !== 200) return null;
  const text = String(bodyText ?? '');
  if (!text) return null;
  // 200 必须是错误事件;正常响应体里出现 quota 字样不算
  if (status === 200 && !ERROR_MARKER.test(text)) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON(含 SSE 多行)按文本兜底 */ }
  const err = parsed?.error ?? parsed ?? {};
  const code = String(err.code ?? parsed?.code ?? '');
  const message = String(err.message ?? parsed?.message ?? (parsed ? '' : text.slice(0, 2048)));
  const hay = `${code} ${message}${parsed ? '' : ' ' + text.slice(0, 2048)}`.slice(0, 4096);
  const rl = err.rateLimit ?? parsed?.rateLimit ?? err.details?.rateLimit ?? null;
  const win = rl && (rl.window === 'fiveHour' || rl.window === 'weekly') ? rl.window : null;
  const quotaish = [
    'USAGE_EXCEEDED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'insufficient_quota',
  ].includes(code) || QUOTA_HINT.test(hay);
  // 非额度类错误(Bad Request / 模型不可用 / 地区限制 / 校验失败)一律不轮转:
  // 换账户解决不了,还会把一套还好的密钥全封掉。
  if (!quotaish) return null;
  // reset 口径对齐 CLI extractResetAtMs:秒级(小值)×1000,ms 级原样;没有就按文本里的 ISO
  const resetRaw = typeof rl?.reset === 'number' ? (rl.reset > 1e12 ? rl.reset : rl.reset * 1000) : null;
  const reset = resetRaw ?? resetFromText(hay);
  const until = reset && reset > Date.now() ? reset : Date.now() + 10 * 60_000;
  const winFromText = /five.?hour|5-hour|5 hour/i.test(hay) ? 'fiveHour'
    : /weekly|this week/i.test(hay) ? 'weekly' : null;
  const kind = CREDIT_HINT.test(hay) ? 'credit' : (win ?? winFromText ?? 'usage');
  return { kind, until, persist: false };
}

// 测试辅助:清空运行时标记
export function resetWindowBlocks() { blocks.clear(); }
