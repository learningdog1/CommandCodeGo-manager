// 上游账户「窗口受限」运行时状态:自动轮转与手动切换账户的共同依据。
// 上游的 5 小时滚动 / 周窗口到限时并不改变密钥的持久状态(账还在、信用可能还有),
// 只是该账户暂时不可用 —— 所以这里只做**进程内**的临时标记,到期自动解除:
//   live   —— 请求打到上游收到 429 USAGE_EXCEEDED(或 error.rateLimit.window)时标记,
//             有效期到 resetAt(未知则探针 TTL,到期自动放行重试);
//   usage  —— account-usage 刷新发现 fiveHour/weekly 到顶时标记/已释放时清除;
//   manual —— 管理界面「切换账户」按钮写入(1 小时 TTL),再次点击立即恢复。
// 与 402 信用耗尽的持久标记(status='exhausted',落库)互补:那是额度没了,这是窗口到了。
import { log } from '../log.mjs';

// upstreamKeyId → { until: ms(0=永久,manual 不用), source, window, at }
const blocks = new Map();

function prune(id) {
  const b = blocks.get(id);
  if (b && b.until && b.until <= Date.now()) { blocks.delete(id); return null; }
  return b ?? null;
}

/** 该上游密钥当前是否窗口受限(过期自动清除)。 */
export function isWindowBlocked(keyId) {
  if (keyId == null) return false;
  return prune(keyId) !== null;
}

/** 打标记(live/usage 同窗口互相覆盖取更晚者;manual 独立叠加,清除只由 manual 路径做)。 */
export function markWindowBlocked(keyId, { source, window, until }) {
  if (keyId == null) return;
  blocks.set(keyId, { source, window, until: until || 0, at: Date.now() });
}

/** 面板用的状态摘要(blocked/source/window/until;manual 与 live 并存时以 manual 为准展示)。 */
export function getWindowState(keyId) {
  if (keyId == null) return { blocked: false, source: null, window: null, until: null };
  const list = [...blocks.entries()]
    .filter(([id, b]) => id === keyId && (!b.until || b.until > Date.now()))
    .map(([, b]) => b);
  if (list.length === 0) return { blocked: false, source: null, window: null, until: null };
  const manual = list.find(b => b.source === 'manual');
  const pick = manual ?? list.reduce((a, b) => ((b.until || Infinity) > (a.until || Infinity) ? b : a));
  return { blocked: true, source: pick.source, window: pick.window, until: pick.until || null };
}

/**
 * 从 account-usage 刷新结果同步:窗口到顶 → 标记(source=usage,到 resetAt);
 * 窗口已释放 → 清除该窗口的 live/usage 标记(manual 不动,由用户手动恢复)。
 * windowLimits 形状:{ limited, fiveHour:{used,cap,exceeded,resetAt(ms)}, weekly:{...} }。
 */
export function syncFromWindowLimits(keyId, windowLimits) {
  if (keyId == null) return;
  const hit = (w) => !!w && w.cap > 0 && (w.exceeded === true || w.used >= w.cap);
  for (const name of ['fiveHour', 'weekly']) {
    const w = windowLimits?.[name];
    if (hit(w)) {
      const until = w.resetAt > Date.now() ? w.resetAt : Date.now() + 10 * 60_000; // resetAt 缺失时给探针 TTL
      const cur = blocks.get(keyId);
      if (!cur || cur.source !== 'manual' || (cur.until || 0) < until) {
        markWindowBlocked(keyId, { source: 'usage', window: name, until });
      }
    } else if (w && blocks.get(keyId)?.source !== 'manual') {
      // 窗口有数据且未到顶:清除 live/usage 标记(该窗口已恢复)
      const b = blocks.get(keyId);
      if (b && b.window === name) blocks.delete(keyId);
    }
  }
  // 套餐无窗口限制(limited=false/无 windowLimits):清除全部非 manual 标记
  if (windowLimits && windowLimits.limited === false) {
    const b = blocks.get(keyId);
    if (b && b.source !== 'manual') blocks.delete(keyId);
  }
}

/** 手动切换(管理界面):on=true 屏蔽 1 小时(或已知窗口重置时刻,取更晚),on=false 立即恢复。 */
export function setManualSwitch(keyId, on, maxUntil = 0) {
  if (keyId == null) return;
  if (!on) {
    const b = blocks.get(keyId);
    if (b?.source === 'manual') blocks.delete(keyId);
    return;
  }
  const until = Math.max(Date.now() + 60 * 60_000, maxUntil || 0);
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
