// 上游账户「窗口受限」运行时状态:自动轮转与手动切换账户的共同依据。
// 上游的 5 小时滚动 / 周窗口到限时并不改变密钥的持久状态(账还在、信用可能还有),
// 只是该账户暂时不可用 —— 所以这里只做**进程内**的临时标记,到期自动解除:
//   live   —— 请求打到上游收到 429 USAGE_EXCEEDED(或 error.rateLimit.window)时标记,
//             有效期到 resetAt(未知则探针 TTL,到期自动放行重试);
//   usage  —— account-usage 刷新发现 fiveHour/weekly 到顶时标记/已释放时清除;
//   manual —— 管理界面「切换账户」按钮写入(1 小时 TTL),再次点击立即恢复。
// 与 402 信用耗尽的持久标记(status='exhausted',落库)互补:那是额度没了,这是窗口到了。
import { log } from '../log.mjs';

// keyId → Map(window → block)。手动切走和各额度窗口独立保存,
// 取消手动切走不能顺带清除真实的额度限制,一个窗口恢复也不能覆盖另一个窗口。
const blocks = new Map();

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
  const slot = source === 'manual' ? 'manual' : window;
  const cur = entries.get(slot);
  const next = { source, window: slot, until: until || 0, at: Date.now() };
  if (cur && (cur.until || Infinity) >= (next.until || Infinity)) return;
  entries.set(slot, next);
  blocks.set(keyId, entries);
}

export function getWindowState(keyId) {
  const list = activeBlocks(keyId);
  if (!list.length) return { blocked: false, source: null, window: null, until: null };
  const pick = list.find(b => b.source === 'manual')
    ?? list.reduce((a, b) => ((b.until || Infinity) > (a.until || Infinity) ? b : a));
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
  if (windowLimits.limited === false) {
    const entries = blocks.get(keyId);
    if (entries) for (const name of entries.keys()) if (name !== 'manual') entries.delete(name);
  } else if (windowLimits.fiveHour && windowLimits.weekly && !windowLimits.exceeded
    && !hit(windowLimits.fiveHour) && !hit(windowLimits.weekly)) {
    blocks.get(keyId)?.delete('usage');
  }
}

/** 手动切走至少 1 小时,已知受限窗口更长时延长;取消只删除手动状态。 */
export function setManualSwitch(keyId, on, maxUntil = 0) {
  if (keyId == null) return;
  if (!on) { blocks.get(keyId)?.delete('manual'); return; }
  const until = Math.max(Date.now() + 60 * 60_000, maxUntil || 0,
    ...activeBlocks(keyId).map(b => b.until || 0));
  markWindowBlocked(keyId, { source: 'manual', window: 'manual', until });
  log('info', 'Account manually switched away (window block)', { upstreamKeyId: keyId, until: new Date(until).toISOString() });
}

/**
 * 分类上游错误是否属于「额度/窗口耗尽」(可轮转):
 *   402 → 信用耗尽(持久,落库 exhausted);
 *   429 → 仅当 body 带 USAGE_EXCEEDED 或 rateLimit.window(5 小时/周窗口)才是窗口到限,
 *         其余 429 是瞬态限速,不轮转(换 key=换设备指纹,只在确属耗尽时才值得)。
 * 返回 { kind: 'credit' | 'fiveHour' | 'weekly' | 'usage', until } 或 null。
 */
export function classifyExhaustion(status, bodyText) {
  if (status === 402) return { kind: 'credit', until: 0 };
  if (status !== 429) return null;
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  const err = parsed?.error ?? parsed ?? {};
  const code = err.code ?? parsed?.code ?? null;
  const rl = err.rateLimit ?? parsed?.rateLimit ?? err.details?.rateLimit ?? null;
  const win = rl && (rl.window === 'fiveHour' || rl.window === 'weekly') ? rl.window : null;
  if (code !== 'USAGE_EXCEEDED' && !win) return null;
  // reset 口径对齐 CLI extractResetAtMs:秒级(小值)×1000,ms 级原样
  const reset = typeof rl?.reset === 'number' ? (rl.reset > 1e12 ? rl.reset : rl.reset * 1000) : null;
  const until = reset && reset > Date.now() ? reset : Date.now() + 10 * 60_000;
  return { kind: win ?? 'usage', until };
}

// 测试辅助:清空运行时标记
export function resetWindowBlocks() { blocks.clear(); }
