// 账号用量面板(卡片式重构):每个账号一张大卡 —— 三条模板条(5 小时滚动 / 周 / 月度)
// 整行铺开(数值与倒计时分行,不再挤一行重叠),信用余额三池与期账累计统计,
// 支持单账号或全部刷新(快照接口纯读服务端缓存),点卡片展开期账全量明细。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, CalendarClock, ChevronDown, Coins, Gauge, RefreshCw, Users, Wallet,
} from 'lucide-react';
import { fetchAccountUsage, refreshAccountUsage, type AccountUsageRow, type WindowLimit } from '../api';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, Loading, StatCard, toast, fmtAgo, fmtInt,
} from '../ui';

// ── 展示工具 ──────────────────────────────────────────────
// 用量数值口径:整数原样,小数最多 2 位(0.3333 → 0.33)
function fmt2(n: number | null | undefined): string {
  const v = n ?? 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── 模板条(整行铺开:标签行 + 满宽条 + 倒计时独立成行,数值不再重叠) ──
function WindowBar({ label, used, cap, exceeded, resetAt, now, unit }: {
  label: string; used: number | null; cap: number | null;
  exceeded?: boolean | null; resetAt?: number | null; now: number; unit: string;
}) {
  const known = used != null && cap != null && cap > 0;
  const pct = known ? Math.min(100, (used! / cap!) * 100) : 0;
  const tone = !known ? 'flat' : exceeded || pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'accent';
  const bar = { accent: 'bg-accent', warn: 'bg-warn', err: 'bg-err', flat: 'bg-line2' }[tone];
  const txt = { accent: 'text-txt2', warn: 'text-warn', err: 'text-err', flat: 'text-txt3' }[tone];
  const countdown = resetAt && resetAt > now
    ? <span className="whitespace-nowrap text-[11px] text-txt3">重置于 {fmtDuration(resetAt - now)} 后</span>
    : <span />;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-xs text-txt2">{label}</span>
        <span className="tnum flex min-w-0 items-baseline justify-end gap-2 text-xs">
          {known ? (<>
            <span className={`truncate font-semibold ${txt}`}>
              {fmt2(used)}<span className="mx-0.5 font-normal text-txt3">/</span>{fmt2(cap)} {unit}
            </span>
            <span className={`shrink-0 text-[11px] ${txt}`}>{Math.round(pct)}%</span>
          </>) : (
            <span className="text-xs text-txt3">—</span>
          )}
          {exceeded && <span className="shrink-0 text-[11px] font-medium text-err">已超限</span>}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2.5">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
          <div className={`h-full rounded-full ${bar} transition-all duration-500`}
            style={{ width: `${known ? Math.max(pct, used! > 0 ? 3 : 0) : 0}%` }} />
        </div>
        <span className="w-24 shrink-0 text-right">{countdown}</span>
      </div>
    </div>
  );
}

// 月度条:cap 未知(新套餐档位)时退化为「剩余 X」文本行
function MonthlyBar({ used, total, remaining, now }: {
  used: number | null; total: number | null; remaining: number; now: number;
}) {
  if (used == null || total == null) {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-txt2">本月额度</span>
        <span className="tnum text-xs text-txt3" title="套餐总额未知,只显示剩余">剩余 {fmt2(remaining)} 信用</span>
      </div>
    );
  }
  return <WindowBar label="本月额度" used={used} cap={total} now={now} unit="信用" />;
}

// 信用余额池的小徽标
function Pool({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span className="tnum inline-flex items-baseline gap-1 rounded-md border border-line bg-panel2 px-2 py-0.5 text-[11px] text-txt3">
      {label}<span className={`font-semibold ${tone ?? 'text-txt2'}`}>{fmt2(value)}</span>
    </span>
  );
}

// 展开明细里的小字段(值区 nowrap + 紧凑格式,完整内容放 title)
function KV({ label, value, tone, title, wide }: { label: string; value: ReactNode; tone?: string; title?: string; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg border border-line bg-panel2 px-3 py-2 ${wide ? 'col-span-2' : ''}`}>
      <div className="truncate text-[10px] uppercase tracking-wide text-txt3" title={label}>{label}</div>
      <div title={title ?? (typeof value === 'string' ? value : undefined)}
        className={`tnum mt-0.5 min-w-0 whitespace-nowrap text-sm font-medium ${tone ?? 'text-txt'}`}>{value}</div>
    </div>
  );
}

// 同年账期省略年份保持单行宽度(卡片内栏放不下完整双日期)
function fmtPeriodRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = start?.slice(0, 10), e = end?.slice(0, 10);
  if (!s || !e) return '—';
  return s.slice(0, 4) === e.slice(0, 4) ? `${s.slice(5)} ~ ${e.slice(5)}` : `${s} ~ ${e}`;
}

export function AccountUsage() {
  const [rows, setRows] = useState<AccountUsageRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [refreshing, setRefreshing] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const autoRefreshed = useRef(false);

  // 30s 心跳:让重置倒计时与「X 分钟前」保持新鲜
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const mergeRows = useCallback((incoming: AccountUsageRow[]) => {
    const byId = new Map(incoming.map(r => [r.id, r]));
    setRows(prev => (prev ?? []).map(r => byId.get(r.id) ?? r));
  }, []);

  const refreshAll = useCallback(async (silent = false) => {
    setBusyAll(true);
    try {
      const r = await refreshAccountUsage();
      mergeRows(r.rows ?? []);
      if (!silent) {
        if ((r.failed ?? 0) > 0) toast('err', `刷新完成:${r.refreshed} 成功,${r.failed} 失败`);
        else toast('ok', `已刷新 ${r.refreshed} 个账号`);
      }
    } catch (e) {
      toast('err', `全部刷新失败:${(e as Error).message}`);
    } finally {
      setBusyAll(false);
    }
  }, [mergeRows]);

  const refreshOne = useCallback(async (id: number) => {
    setRefreshing(prev => new Set(prev).add(id));
    try {
      const r = await refreshAccountUsage(id);
      mergeRows(r.rows ?? []);
      toast('ok', '已刷新该账号');
    } catch (e) {
      toast('err', `刷新失败:${(e as Error).message}`);
    } finally {
      setRefreshing(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [mergeRows]);

  // 初次进入:先读快照;存在启用账号但缓存全空时,自动触发一次全部刷新
  useEffect(() => {
    void (async () => {
      try {
        const d = await fetchAccountUsage();
        setRows(d.rows ?? []);
        setLoadErr(null);
        if (autoRefreshed.current) return;
        const list = d.rows ?? [];
        if (list.some(x => x.status === 'active') && !list.some(x => x.data != null)) {
          autoRefreshed.current = true;
          await refreshAll(true);
        }
      } catch (e) {
        setRows([]);
        setLoadErr((e as Error).message || '加载失败');
        toast('err', `加载账号用量失败:${(e as Error).message}`);
      }
    })();
  }, [refreshAll]);

  // ── 汇总 ──
  const stats = useMemo(() => {
    const list = (rows ?? []).filter(r => r.data);
    const active = (rows ?? []).filter(r => r.status === 'active').length;
    const creditsTotal = list.reduce((n, r) => n + (r.data?.credits?.totalRemaining ?? 0), 0);
    const spentTotal = list.reduce((n, r) => n + (r.data?.period?.totalCost ?? 0), 0);
    const limited = list.filter(r => {
      const w = r.data?.windowLimits;
      const hit = (x: WindowLimit | null | undefined) => !!x && x.cap > 0 && (x.exceeded || x.used >= x.cap);
      return hit(w?.fiveHour) || hit(w?.weekly);
    }).length;
    return { total: rows?.length ?? 0, active, creditsTotal, spentTotal, limited };
  }, [rows]);
  const lastFetch = useMemo(() => Math.max(0, ...(rows ?? []).map(r => r.fetchedAt ?? 0)) || null, [rows]);
  const loading = rows === null;

  return (
    <div className="space-y-5">
      {/* ── 汇总卡 ── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="账号(启用 / 总数)" value={loading ? '…' : `${stats.active} / ${stats.total}`}
          icon={<Users size={18} />} />
        <StatCard label="信用余额合计" value={loading ? '…' : fmt2(stats.creditsTotal)}
          sub="月度 + 购买 + 赠送" icon={<Wallet size={18} />} tone="ok" />
        <StatCard label="本期消费合计" value={loading ? '…' : fmt2(stats.spentTotal)}
          sub="订阅账期口径" icon={<Coins size={18} />} tone="violet" />
        <StatCard label="窗口受限账号" value={loading ? '…' : String(stats.limited)}
          sub="5 小时或周窗口到顶" icon={<Gauge size={18} />} tone="amber"
          status={stats.limited > 0 ? 'warn' : undefined} />
      </div>

      {/* ── 账号卡片列表 ── */}
      <Card>
        <CardHeader
          title="账号用量"
          extra={
            <div className="flex items-center gap-3">
              {lastFetch && <span className="tnum hidden text-xs text-txt3 sm:inline">上次刷新 {fmtAgo(lastFetch)}</span>}
              <Button size="sm" onClick={() => void refreshAll()} loading={busyAll} disabled={loading}>
                <RefreshCw size={13} />全部刷新
              </Button>
            </div>
          } />
        <CardBody className="space-y-4">
          {loading ? (
            <Loading>加载账号列表…</Loading>
          ) : loadErr ? (
            <EmptyState title="账号用量加载失败" hint={`${loadErr},请确认代理服务可达后重试。`} />
          ) : rows.length === 0 ? (
            <EmptyState title="暂无上游账号" hint="先在「密钥管理」导入 Command Code 账号(user_* 密钥),再回到本页刷新用量。" />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {rows.map(r => {
                const d = r.data;
                const c = d?.credits;
                const p = d?.period;
                const open = expanded === r.id;
                const disabled = r.status !== 'active';
                return (
                  <div key={r.id}
                    className={`rounded-xl border bg-panel transition-colors ${disabled ? 'border-line/60 opacity-60' : open ? 'border-accent/40' : 'border-line'}`}>
                    {/* ── 卡头:账号身份 + 套餐 + 刷新 ── */}
                    <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${disabled ? 'bg-txt3' : 'bg-ok'}`} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="max-w-48 truncate text-sm font-semibold text-txt">{r.name}</span>
                            {disabled
                              ? <Badge>已停用</Badge>
                              : !d ? (r.error ? <Badge kind="err">拉取失败</Badge> : <Badge>未刷新</Badge>)
                              : r.error ? <Badge kind="warn">部分失败</Badge> : null}
                            {d?.plan && (
                              <Badge kind={d.plan.status === 'active' ? 'accent' : 'default'}>{d.plan.name ?? d.plan.id ?? '未知套餐'}</Badge>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-txt3">
                            <span className="max-w-56 truncate">{d?.whoami?.userName || d?.whoami?.email || `#${r.id}`}</span>
                            {d?.plan && (
                              <span className="tnum whitespace-nowrap">
                                {d.plan.cancelAtPeriodEnd ? '· 期末取消' : `· 续期 ${d.plan.daysRemaining ?? '—'} 天`}
                              </span>
                            )}
                            {r.fetchedAt && <span className="tnum whitespace-nowrap">· {fmtAgo(r.fetchedAt)}</span>}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => { if (!disabled) void refreshOne(r.id); }}
                        disabled={disabled || refreshing.has(r.id)}
                        title={disabled ? '已停用账号不可刷新' : '刷新此账号'}
                        className="shrink-0 rounded-lg border border-line p-1.5 text-txt3 transition-all duration-150 hover:border-line2 hover:text-accent active:scale-90 disabled:cursor-not-allowed disabled:opacity-40">
                        <RefreshCw size={14} className={refreshing.has(r.id) ? 'animate-spin' : ''} />
                      </button>
                    </div>

                    {r.error && (
                      <div className="mx-4 mt-2.5 rounded-lg border border-warn/25 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
                        上游返回部分失败:{r.error}
                      </div>
                    )}

                    {/* ── 三条模板条 ── */}
                    {disabled ? (
                      <div className="px-4 pb-3.5 pt-3 text-xs text-txt3">账号已停用,重新启用后可刷新用量。</div>
                    ) : d ? (
                      <div className="space-y-3.5 px-4 pb-1 pt-3.5">
                        <WindowBar label="5 小时滚动" unit="条"
                          used={d.windowLimits?.fiveHour?.used ?? null} cap={d.windowLimits?.fiveHour?.cap ?? null}
                          exceeded={d.windowLimits?.fiveHour?.exceeded} resetAt={d.windowLimits?.fiveHour?.resetAt} now={now} />
                        <WindowBar label="本周" unit="条"
                          used={d.windowLimits?.weekly?.used ?? null} cap={d.windowLimits?.weekly?.cap ?? null}
                          exceeded={d.windowLimits?.weekly?.exceeded} resetAt={d.windowLimits?.weekly?.resetAt} now={now} />
                        <MonthlyBar used={c?.monthlyUsed ?? null} total={c?.monthlyTotal ?? null} remaining={c?.monthly ?? 0} now={now} />
                      </div>
                    ) : (
                      <div className="px-4 pb-3.5 pt-3 text-xs text-txt3">
                        暂无数据,点击右上刷新按钮拉取。
                      </div>
                    )}

                    {/* ── 信用余额 + 期账摘要 ── */}
                    {d && (
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line/60 px-4 py-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="text-[11px] text-txt3">信用余额</span>
                          <span className={`tnum text-xl font-bold leading-none ${
                            (c?.totalRemaining ?? 0) <= 0 ? 'text-err' : c?.belowThreshold ? 'text-warn' : 'text-ok'}`}>
                            {fmt2(c?.totalRemaining)}
                          </span>
                          <Pool label="月" value={c?.monthly ?? 0} tone="text-txt" />
                          <Pool label="购" value={c?.purchased ?? 0} />
                          <Pool label="赠" value={c?.free ?? 0} />
                        </div>
                        <div className="flex items-baseline gap-1.5 text-xs text-txt3">
                          <Activity size={12} className="self-center text-violet" />
                          <span className="tnum">
                            本期 <span className="font-semibold text-violet">{fmt2(p?.totalCost)}</span> 信用
                            · {fmtInt(p?.totalCount)} 次 · {fmtTokens(p?.totalTokens ?? 0)} tok
                          </span>
                        </div>
                      </div>
                    )}

                    {/* ── 展开:期账累计全量明细 ── */}
                    {d && (
                      <div className="border-t border-line/60">
                        <button onClick={() => setExpanded(prev => (prev === r.id ? null : r.id))}
                          className="flex w-full items-center justify-center gap-1.5 py-2 text-[11px] text-txt3 transition-colors hover:text-accent">
                          <CalendarClock size={12} />
                          期账累计明细(自 {d.plan?.currentPeriodStart?.slice(0, 10) ?? '期初'} 起)
                          <ChevronDown size={13} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </button>
                        {open && (
                          <div className="px-4 pb-4">
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                              <KV label="总请求" value={fmtInt(p?.totalCount)} />
                              <KV label="完成 / 失败" value={`${fmtInt(p?.completedCount)} / ${fmtInt(p?.failedCount)}`} />
                              <KV label="成功率" value={`${(p?.successRate ?? 0).toFixed(1)}%`}
                                tone={(p?.successRate ?? 100) >= 90 ? 'text-ok' : 'text-warn'} />
                              <KV label="总消费" value={`${fmt2(p?.totalCost)} 信用`} tone="text-violet" />
                              <KV label="平均消费" value={`${fmt2(p?.averageCost)} 信用`} />
                              <KV label="输入 tokens" value={fmtTokens(p?.totalTokensIn ?? 0)} />
                              <KV label="输出 tokens" value={fmtTokens(p?.totalTokensOut ?? 0)} />
                              <KV label="合计 tokens" value={fmtTokens(p?.totalTokens ?? 0)} />
                              <KV label="消费构成(月/购/赠)" title={`${fmt2(p?.totalMonthlyCredits)} / ${fmt2(p?.totalPurchasedCredits)} / ${fmt2(p?.totalFreeCredits)}`}
                                value={`${fmt2(p?.totalMonthlyCredits)}/${fmt2(p?.totalPurchasedCredits)}/${fmt2(p?.totalFreeCredits)}`} />
                              <KV label="信用余额(月/购/赠)" title={c ? `${fmt2(c.monthly)} / ${fmt2(c.purchased)} / ${fmt2(c.free)}` : undefined}
                                value={c ? `${fmt2(c.monthly)}/${fmt2(c.purchased)}/${fmt2(c.free)}` : '—'} />
                              <KV label="订阅周期" wide
                                title={d.plan ? `${d.plan.currentPeriodStart?.slice(0, 10)} ~ ${d.plan.currentPeriodEnd?.slice(0, 10)}` : undefined}
                                value={fmtPeriodRange(d.plan?.currentPeriodStart, d.plan?.currentPeriodEnd)} />
                              <KV label="续期" value={d.plan?.cancelAtPeriodEnd ? '期末取消,到期不续' : `${d.plan?.daysRemaining ?? '—'} 天后`} />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
