// 账号用量面板:交互矩阵展示每个上游账号的模板条(5 小时滚动 / 周 / 月度)、
// 信用余额与期账累计统计;支持单账号或全部刷新(快照接口纯读服务端缓存)。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, CalendarClock, ChevronDown, Coins, Gauge, LayoutGrid, RefreshCw, Users, Wallet } from 'lucide-react';
import { fetchAccountUsage, refreshAccountUsage, type AccountUsageRow, type WindowLimit } from '../api';
import {
  Badge, Button, Card, CardHeader, EmptyState, Loading, StatCard, Table, Td, Th, fmtAgo, fmtInt, toast,
} from '../ui';

// ── 展示工具 ──────────────────────────────────────────────
// 信用数值:整数直接显示,小数保留两位(CLI formatCredits2 同款)
function fmtCredits(n: number | null | undefined): string {
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

// ── 模板条 ────────────────────────────────────────────────
// used/cap 均为「条」数;≥90% 或已超限转红,≥70% 转黄;cap 未知时退化为剩余量文本。
function LimitBar({ used, cap, exceeded, resetAt, now, unitLabel = '条' }: {
  used: number | null; cap: number | null; exceeded?: boolean | null; resetAt?: number | null;
  now: number; unitLabel?: string;
}) {
  if (used == null || cap == null || cap <= 0) return <span className="text-xs text-txt3">—</span>;
  const pct = Math.min(100, (used / cap) * 100);
  const tone = exceeded || pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'accent';
  const barCls = { accent: 'bg-accent', warn: 'bg-warn', err: 'bg-err' }[tone];
  const txtCls = { accent: 'text-txt2', warn: 'text-warn', err: 'text-err' }[tone];
  const countdown = resetAt && resetAt > now ? ` · 重置 ${fmtDuration(resetAt - now)}` : '';
  return (
    <div className="w-36 max-w-full" title={`已用 ${used} / 上限 ${cap} ${unitLabel}${countdown}(占比 ${Math.round(pct)}%)`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full ${barCls} transition-all duration-500`} style={{ width: `${Math.max(pct, used > 0 ? 4 : 0)}%` }} />
      </div>
      <div className={`tnum mt-1 whitespace-nowrap text-[11px] ${txtCls}`}>
        {used} / {cap}
        {exceeded && <span className="ml-1 font-medium">已超限</span>}
        {countdown && <span className="text-txt3">{countdown}</span>}
      </div>
    </div>
  );
}

// 窗口单元格:windowLimits 缺失(拉取失败或套餐无窗口限制)时的降级
function WindowCell({ w, now }: { w: WindowLimit | null | undefined; now: number }) {
  if (!w) return <span className="text-xs text-txt3">—</span>;
  return <LimitBar used={w.used} cap={w.cap} exceeded={w.exceeded} resetAt={w.resetAt} now={now} />;
}

// 展开明细里的小字段(min-w-0 + break-all:长用户名/日期段不撑破网格)
function KV({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel2 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-txt3">{label}</div>
      <div className={`tnum mt-0.5 min-w-0 break-all text-sm font-medium ${tone ?? 'text-txt'}`}>{value}</div>
    </div>
  );
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

  const load = useCallback(async () => {
    try {
      const d = await fetchAccountUsage();
      setRows(d.rows ?? []);
      setLoadErr(null);
      return d.rows ?? [];
    } catch (e) {
      setRows([]);
      setLoadErr((e as Error).message || '加载失败');
      toast('err', `加载账号用量失败:${(e as Error).message}`);
      return null;
    }
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
      toast('ok', `已刷新账号 #${id}`);
    } catch (e) {
      toast('err', `刷新失败:${(e as Error).message}`);
    } finally {
      setRefreshing(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [mergeRows]);

  // 初次进入:先读快照;存在启用账号但缓存全空时,自动触发一次全部刷新
  useEffect(() => {
    void (async () => {
      const r = await load();
      if (autoRefreshed.current || !r) return;
      const hasActive = r.some(x => x.status === 'active');
      const hasData = r.some(x => x.data != null);
      if (hasActive && !hasData) {
        autoRefreshed.current = true;
        await refreshAll(true);
      }
    })();
  }, [load, refreshAll]);

  // ── 汇总 ──
  const stats = useMemo(() => {
    const list = (rows ?? []).filter(r => r.data);
    const active = (rows ?? []).filter(r => r.status === 'active').length;
    const creditsTotal = list.reduce((n, r) => n + (r.data?.credits?.totalRemaining ?? 0), 0);
    const spentTotal = list.reduce((n, r) => n + (r.data?.period?.totalCost ?? 0), 0);
    const limited = list.filter(r => {
      const w = r.data?.windowLimits;
      return w?.fiveHour?.exceeded || (w?.fiveHour && w.fiveHour.cap > 0 && w.fiveHour.used >= w.fiveHour.cap)
        || w?.weekly?.exceeded || (w?.weekly && w.weekly.cap > 0 && w.weekly.used >= w.weekly.cap);
    }).length;
    return { total: rows?.length ?? 0, active, creditsTotal, spentTotal, limited };
  }, [rows]);
  const lastFetch = useMemo(() => Math.max(0, ...(rows ?? []).map(r => r.fetchedAt ?? 0)) || null, [rows]);
  const loading = rows === null;

  const toggleExpand = (id: number) => setExpanded(prev => (prev === id ? null : id));

  const rowState = (r: AccountUsageRow) => {
    if (r.status !== 'active') return <Badge>已停用</Badge>;
    if (!r.data) return r.error ? <Badge kind="err">拉取失败</Badge> : <Badge>未刷新</Badge>;
    if (r.error) return <Badge kind="warn">部分失败</Badge>;
    return null;
  };

  return (
    <div className="space-y-5">
      {/* ── 汇总卡 ── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="账号(启用 / 总数)" value={loading ? '…' : `${stats.active} / ${stats.total}`} icon={<Users size={18} />} />
        <StatCard label="信用余额合计" value={loading ? '…' : fmtCredits(stats.creditsTotal)} icon={<Wallet size={18} />} tone="ok" />
        <StatCard label="本期消费合计" value={loading ? '…' : fmtCredits(stats.spentTotal)} icon={<Coins size={18} />} tone="violet" />
        <StatCard label="窗口受限账号" value={loading ? '…' : String(stats.limited)} icon={<Gauge size={18} />} tone="amber" status={stats.limited > 0 ? 'warn' : undefined} />
      </div>

      {/* ── 交互矩阵 ── */}
      <Card>
        <CardHeader
          icon={<LayoutGrid size={15} />}
          title="账号用量矩阵"
          extra={
            <div className="flex items-center gap-3">
              {lastFetch && <span className="tnum hidden text-xs text-txt3 sm:inline">上次刷新 {fmtAgo(lastFetch)}</span>}
              <Button size="sm" onClick={() => void refreshAll()} loading={busyAll} disabled={loading}>
                <RefreshCw size={13} />全部刷新
              </Button>
            </div>
          } />
        {loading ? (
          <Loading>加载账号列表…</Loading>
        ) : loadErr ? (
          <EmptyState title="账号用量加载失败" hint={`${loadErr},请确认代理服务可达后重试。`} />
        ) : rows.length === 0 ? (
          <EmptyState title="暂无上游账号" hint="先在「密钥管理」导入 Command Code 账号(user_* 密钥),再回到本页刷新用量。" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>账号</Th>
                <Th>套餐</Th>
                <Th>5 小时滚动</Th>
                <Th>本周</Th>
                <Th>本月</Th>
                <Th className="text-right">信用余额</Th>
                <Th className="text-right">期账累计</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const d = r.data;
                const c = d?.credits;
                const p = d?.period;
                const open = expanded === r.id;
                return [
                  <tr key={r.id}
                    onClick={() => toggleExpand(r.id)}
                    className={`cursor-pointer transition-colors hover:bg-panel2/60 ${open ? 'bg-panel2/40' : ''}`}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${r.status === 'active' ? 'bg-ok' : 'bg-txt3'}`} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="max-w-40 truncate text-[13px] font-medium text-txt">{r.name}</span>
                            {rowState(r)}
                          </div>
                          <div className="max-w-44 truncate text-[11px] text-txt3">
                            {d?.whoami?.userName || d?.whoami?.email || `#${r.id}`}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {d?.plan ? (
                        <div className="flex flex-col gap-0.5">
                          <Badge kind={d.plan.status === 'active' ? 'accent' : 'default'}>{d.plan.name ?? d.plan.id ?? '未知'}</Badge>
                          <span className="tnum whitespace-nowrap text-[11px] text-txt3">
                            {d.plan.cancelAtPeriodEnd ? '期末取消' : `续期 ${d.plan.daysRemaining ?? '—'} 天`}
                          </span>
                        </div>
                      ) : <span className="text-xs text-txt3">—</span>}
                    </Td>
                    <Td><WindowCell w={d?.windowLimits?.fiveHour} now={now} /></Td>
                    <Td><WindowCell w={d?.windowLimits?.weekly} now={now} /></Td>
                    <Td>
                      {c ? (
                        c.monthlyTotal != null
                          ? <LimitBar used={c.monthlyUsed} cap={c.monthlyTotal} now={now} unitLabel="信用" />
                          : <span className="tnum text-[11px] text-txt3" title="套餐总额未知,只显示剩余">余 {fmtCredits(c.monthly)}</span>
                      ) : <span className="text-xs text-txt3">—</span>}
                    </Td>
                    <Td className="text-right">
                      {c ? (
                        <div className="tnum">
                          <div className={`text-[13px] font-semibold ${c.totalRemaining <= 0 ? 'text-err' : c.belowThreshold ? 'text-warn' : 'text-txt'}`}>
                            {fmtCredits(c.totalRemaining)}
                          </div>
                          <div className="text-[10px] text-txt3">月 {fmtCredits(c.monthly)} · 购 {fmtCredits(c.purchased)} · 赠 {fmtCredits(c.free)}</div>
                        </div>
                      ) : <span className="text-xs text-txt3">—</span>}
                    </Td>
                    <Td className="text-right">
                      {p ? (
                        <div className="tnum">
                          <div className="text-[13px] font-semibold text-txt">
                            {fmtCredits(p.totalCost)} <span className="text-[10px] font-normal text-txt3">信用</span>
                          </div>
                          <div className="text-[10px] text-txt3">{fmtInt(p.totalCount)} 次 · {fmtTokens(p.totalTokens)} tok</div>
                        </div>
                      ) : <span className="text-xs text-txt3">—</span>}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={e => { e.stopPropagation(); if (r.status === 'active') void refreshOne(r.id); }}
                          disabled={r.status !== 'active' || refreshing.has(r.id)}
                          title={r.status === 'active' ? '刷新此账号' : '已停用账号不可刷新'}
                          className="rounded p-1.5 text-txt3 transition-all duration-150 hover:bg-panel2 hover:text-accent active:scale-90 disabled:cursor-not-allowed disabled:opacity-40">
                          <RefreshCw size={13} className={refreshing.has(r.id) ? 'animate-spin' : ''} />
                        </button>
                        <ChevronDown size={14} className={`text-txt3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                      </div>
                    </Td>
                  </tr>,
                  open && (
                    <tr key={`${r.id}-detail`} className="bg-panel2/30">
                      <td colSpan={8} className="border-b border-line/50 px-4 py-4">
                        <div className="flex flex-col gap-3">
                          {r.error && (
                            <div className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn">
                              上游返回部分失败:{r.error}
                            </div>
                          )}
                          {d ? (
                            <>
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-txt3">期账累计(自 {d.plan?.currentPeriodStart?.slice(0, 10) ?? '期初'} 起 · {p?.periodBasis === 'billing-period' ? '订阅账期口径' : p?.periodBasis ?? '未知口径'})</div>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                                <KV label="总请求" value={fmtInt(p?.totalCount)} />
                                <KV label="完成 / 失败" value={`${fmtInt(p?.completedCount)} / ${fmtInt(p?.failedCount)}`} />
                                <KV label="成功率" value={`${(p?.successRate ?? 0).toFixed(1)}%`} tone={(p?.successRate ?? 100) >= 90 ? 'text-ok' : 'text-warn'} />
                                <KV label="总消费" value={`${fmtCredits(p?.totalCost)} 信用`} tone="text-violet" />
                                <KV label="平均消费" value={`${fmtCredits(p?.averageCost)} 信用`} />
                                <KV label="输入 tokens" value={fmtTokens(p?.totalTokensIn ?? 0)} />
                                <KV label="输出 tokens" value={fmtTokens(p?.totalTokensOut ?? 0)} />
                                <KV label="消费构成(月/购/赠)" value={`${fmtCredits(p?.totalMonthlyCredits)} / ${fmtCredits(p?.totalPurchasedCredits)} / ${fmtCredits(p?.totalFreeCredits)}`} />
                                <KV label="合计 tokens" value={fmtTokens(p?.totalTokens ?? 0)} />
                                <KV label="信用余额(月/购/赠)" value={c ? `${fmtCredits(c.monthly)} / ${fmtCredits(c.purchased)} / ${fmtCredits(c.free)}` : '—'} />
                                <KV label="订阅周期" value={d.plan ? `${d.plan.currentPeriodStart?.slice(0, 10) ?? '—'} ~ ${d.plan.currentPeriodEnd?.slice(0, 10) ?? '—'}` : '—'} />
                                <KV label="续期" value={d.plan?.cancelAtPeriodEnd ? '期末取消,到期不续' : `${d.plan?.daysRemaining ?? '—'} 天后`} />
                                <KV label="数据时间" value={r.fetchedAt ? fmtAgo(r.fetchedAt) : '—'} />
                                <KV label="账号标识" value={d.whoami.userName ?? '—'} />
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px] text-txt3">
                                <Activity size={12} className="text-accent" />
                                点击行可收起;「模板条」= 5 小时滚动 / 周窗口的生成条数上限,月度按套餐信用总额折算
                                <CalendarClock size={12} className="ml-2" />
                                窗口到期后自动重置
                              </div>
                            </>
                          ) : (
                            <div className="text-xs text-txt3">
                              暂无数据{r.error ? `(${r.error})` : ''},点击行尾刷新按钮重新拉取。
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
