// 账号用量面板数据源:对齐 command-code CLI 的 fetchUsageData 四连请求
// (dist 反查 @1.56.0):/alpha/whoami → /alpha/billing/credits + /alpha/billing/subscriptions
// → /alpha/usage/summary?since=订阅当期开始。产出三个维度的数据:
//   · 模板条(5 小时滚动 / 周):credits 响应的 windowLimits,used/cap 均为「条」数;
//   · 模板条(月度):credits 只给剩余 monthlyCredits,需按套餐总额表换算已用;
//   · 信用余额与期账累计:credits 三池余额 + usage/summary 的当期统计。
// 纪律:GET 快照纯读缓存、绝触达上游;只有显式「刷新」才发上游请求;
// 单端点失败不拦整账号(与 CLI 的 errors 数组同款,部分数据照常展示)。
import { CFG } from '../config.mjs';
import { log } from '../log.mjs';
import { CC_VERSION } from './upstream.mjs';
import { slugifyProjectPath, DEVICE_PROFILE } from './fingerprint.mjs';
import { listUpstreamKeys, getUpstreamKeyById } from '../store/keys.mjs';

// 套餐 → 月度信用总额(CLI 的 Xn 表):月度模板条的上限从这里来。
// credits 接口只报剩余;未知套餐(上游新档位)时 total=null,前端退化为只显示剩余。
const PLAN_TOTAL_CREDITS = {
  'individual-go': 10, 'individual-goat': 70, 'individual-pro': 30, 'individual-pro-v1': 80,
  'individual-provider': 15, 'individual-max': 150, 'individual-ultra': 300, 'teams-pro': 40,
};
// CLI 的 er 表:套餐 id → 展示名。
const PLAN_DISPLAY = {
  'individual-go': 'Go', 'individual-goat': 'GOAT', 'individual-pro': 'Pro', 'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider', 'individual-max': 'Max', 'individual-ultra': 'Ultra', 'teams-pro': 'Teams Pro',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// 与 generate 转发同一套 CLI 身份头(User-Agent/x-cli-environment/版本/项目 slug),
// 避免管理面板的计费查询在指纹维度上脱离「这是同一个 CLI」的自洽性。
async function usageGet(path, params, apiKey) {
  const qs = params
    ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString()
    : '';
  const res = await fetch(`${CFG.apiBase}${path}${qs}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'cli',
      'x-cli-environment': 'production',
      'x-command-code-version': CC_VERSION,
      'x-project-slug': slugifyProjectPath(DEVICE_PROFILE.projectDir),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 拉取单账号全量用量。返回 { data, errors }:端点级失败进 errors(不抛),硬异常向上抛。 */
async function fetchAccountUsage(apiKey) {
  const errors = [];

  // 先 whoami 拿 orgId —— 团队账号后续三个接口都要带;个人账号为 null
  let whoami = null;
  try { whoami = await usageGet('/alpha/whoami', { limits: '1' }, apiKey); }
  catch (e) { errors.push(`whoami: ${e.message}`); }
  const orgId = whoami?.org?.id ?? null;

  const [creditsBody, subsBody] = await Promise.all([
    usageGet('/alpha/billing/credits', { orgId }, apiKey).catch(e => { errors.push(`credits: ${e.message}`); return null; }),
    usageGet('/alpha/billing/subscriptions', { orgId }, apiKey).catch(e => { errors.push(`subscriptions: ${e.message}`); return null; }),
  ]);

  // 期账累计:since = 订阅当期开始(订阅接口失败时缺 since,上游回落自身默认口径)
  const since = subsBody?.data?.currentPeriodStart ?? null;
  let summary = null;
  try { summary = await usageGet('/alpha/usage/summary', { orgId, since }, apiKey); }
  catch (e) { errors.push(`summary: ${e.message}`); }

  const sub = subsBody?.data ?? null;
  // 四个端点全失败 = 会话失效/网络不通,整行按失败处理(带空 data 的「成功」会误导刷新计数)
  if (!whoami && !creditsBody && !subsBody && !summary) throw new Error(errors.join('; '));
  const planId = typeof sub?.planId === 'string' ? sub.planId : null;  const monthlyTotal = sub?.status === 'active' ? (PLAN_TOTAL_CREDITS[planId] ?? null) : null;
  const monthlyRemaining = num(creditsBody?.credits?.monthlyCredits);
  const periodEnd = sub?.currentPeriodEnd ?? null;

  return {
    data: {
      whoami: {
        userName: whoami?.user?.userName ?? whoami?.user?.name ?? null,
        email: whoami?.user?.email ?? null,
        orgId,
      },
      plan: sub ? {
        id: planId,
        name: PLAN_DISPLAY[planId] ?? planId,
        status: typeof sub.status === 'string' ? sub.status : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
        currentPeriodStart: sub.currentPeriodStart ?? null,
        currentPeriodEnd: periodEnd,
        daysRemaining: periodEnd
          ? Math.max(0, Math.ceil((Date.parse(periodEnd) - Date.now()) / 86_400_000))
          : null,
        monthlyTotal,
      } : null,
      credits: creditsBody?.credits ? {
        monthly: monthlyRemaining,
        purchased: num(creditsBody.credits.purchasedCredits),
        free: num(creditsBody.credits.freeCredits),
        totalRemaining: monthlyRemaining + num(creditsBody.credits.purchasedCredits) + num(creditsBody.credits.freeCredits),
        belowThreshold: creditsBody.credits.belowThreshold === true,
        // 月度模板条的派生值:总额来自套餐表,已用 = 总额 - 剩余(CLI getCreditDepletionPct 同款)
        monthlyTotal,
        monthlyUsed: monthlyTotal != null ? Math.max(0, Math.min(monthlyTotal, monthlyTotal - monthlyRemaining)) : null,
      } : null,
      // 原样透传:{ limited, exceeded, fiveHour/weekly: { used, cap, exceeded, resetAt(ms) } }
      windowLimits: creditsBody?.windowLimits ?? null,
      period: summary ? {
        totalCount: num(summary.totalCount),
        completedCount: num(summary.completedCount),
        failedCount: num(summary.failedCount),
        successRate: num(summary.successRate),
        totalCost: num(summary.totalCost),
        averageCost: num(summary.averageCost),
        totalTokensIn: num(summary.totalTokensIn),
        totalTokensOut: num(summary.totalTokensOut),
        totalTokens: num(summary.totalTokens),
        totalCredits: num(summary.totalCredits),
        totalMonthlyCredits: num(summary.totalMonthlyCredits),
        totalPurchasedCredits: num(summary.totalPurchasedCredits),
        totalFreeCredits: num(summary.totalFreeCredits),
        periodBasis: typeof summary.periodBasis === 'string' ? summary.periodBasis : null,
      } : null,
    },
    errors: errors.length ? errors : null,
  };
}

// ── 缓存与刷新编排 ─────────────────────────────────────────
// id → { data, error, fetchedAt }。进程内缓存,重启即空,靠手动刷新回填。
const cache = new Map();
// 进行中的刷新去重:同一账号并发点刷新只发一串上游请求
const inflight = new Map();

function rowOf(key, entry) {
  return {
    id: key.id, name: key.name, status: key.status,
    fetchedAt: entry?.fetchedAt ?? null,
    error: entry?.error ?? null,
    data: entry?.data ?? null,
  };
}

async function refreshKey(key) {
  const running = inflight.get(key.id);
  if (running) return running;
  const p = (async () => {
    let entry;
    try {
      const { data, errors } = await fetchAccountUsage(key.api_key);
      // 部分端点失败:数据保留展示,error 带明细(前端黄条提示)
      entry = { data, error: errors ? errors.join('; ') : null, fetchedAt: Date.now() };
    } catch (e) {
      entry = { data: null, error: e.message, fetchedAt: Date.now() };
      log('warn', 'Account usage refresh failed', { keyId: key.id, error: e.message });
    }
    cache.set(key.id, entry);
    return entry;
  })();
  inflight.set(key.id, p);
  try { return await p; } finally { inflight.delete(key.id); }
}

/** 快照(纯读缓存,不发上游请求):所有上游 key + 各自缓存数据。 */
export async function accountUsageSnapshot() {
  const keys = await listUpstreamKeys();
  return { rows: keys.map(k => rowOf(k, cache.get(k.id))) };
}

/**
 * 刷新:id 指定单账号,否则全部启用账号(并发 3,账号多时不突发)。
 * 返回 { rows, refreshed, failed } 或 { notFound: true }(单账号不存在/已停用)。
 */
export async function refreshAccountUsage(id) {
  if (id != null) {
    const key = await getUpstreamKeyById(id);
    if (!key) return { notFound: true };
    const entry = await refreshKey(key);
    return {
      rows: [rowOf(key, entry)],
      refreshed: entry.data ? 1 : 0,
      failed: entry.data ? 0 : 1,
    };
  }
  const actives = (await listUpstreamKeys()).filter(k => k.status === 'active');
  const rows = [];
  let refreshed = 0, failed = 0;
  const CONCURRENCY = 3;
  for (let i = 0; i < actives.length; i += CONCURRENCY) {
    const batch = actives.slice(i, i + CONCURRENCY);
    const entries = await Promise.all(batch.map(async k => {
      const full = await getUpstreamKeyById(k.id);
      return full ? refreshKey(full) : null;
    }));
    batch.forEach((k, j) => {
      const e = entries[j];
      if (!e) return;
      rows.push(rowOf(k, e));
      if (e.data) refreshed++; else failed++;
    });
  }
  return { rows, refreshed, failed };
}

// ── 自动定时刷新 ───────────────────────────────────────────
// 服务启动即刷一次(node:sqlite 同步初始化,此刻密钥已可读,面板开机即有数据),
// 之后按 CFG.accountUsageRefreshMs 间隔轮询全部启用账号。0/非法值 = 关闭;
// 运行时经设置页改配置即时生效(每 15s 检查一次到期,无需重启)。
// unref:定时器不阻止进程退出(测试/CLI 场景随退随停)。
let lastAutoRefreshAt = 0;
function autoRefreshTick() {
  const ms = Number(CFG.accountUsageRefreshMs);
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (Date.now() - lastAutoRefreshAt < ms) return;
  lastAutoRefreshAt = Date.now();
  refreshAccountUsage(null).catch(() => {});
}
autoRefreshTick();
const autoRefreshTimer = setInterval(autoRefreshTick, 15_000);
autoRefreshTimer.unref?.();
