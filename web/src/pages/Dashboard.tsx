// 总览仪表盘(Phase 3.2):统计卡 + 24h 请求/tokens 双轴图 + 最近请求 + 服务状态。
import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Coins, KeyRound, Radio, Timer } from 'lucide-react';
import { fetchLogs, fetchOverview, type Overview, type RequestRow } from '../api';
import {
  Badge, Card, CardBody, CardHeader, EChart, echartsBase, EmptyState, Loading, Pagination, vgrad,
  Skeleton, StatCard, Table, Td, Th, toast, themeColor, useTheme, fmtInt, fmtK, fmtMs, fmtTime,
} from '../ui';

// 运行时长人性化(与 AppShell 口径一致)
function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

function StatusBadge({ code }: { code: number | null }) {
  if (code == null) return <Badge>—</Badge>;
  const kind = code >= 500 ? 'err' : code >= 400 ? 'warn' : 'ok';
  return <Badge kind={kind}>{code}</Badge>;
}

// 按小时分桶聚合(请求数 + tokens 总量)
function bucketByHour(rows: RequestRow[]) {
  const buckets = Array.from({ length: 24 }, () => ({ req: 0, tokens: 0 }));
  for (const r of rows) {
    const h = new Date(r.ts).getHours();
    buckets[h].req += 1;
    buckets[h].tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cached_tokens ?? 0);
  }
  return buckets;
}

// 服务状态卡的单行
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/50 py-2.5 text-sm last:border-b-0">
      <span className="shrink-0 text-txt2">{label}</span>
      <span className="min-w-0 truncate text-right text-txt">{children}</span>
    </div>
  );
}

export function Dashboard() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [rows, setRows] = useState<RequestRow[] | null>(null); // null = 加载中
  const [logsTotal, setLogsTotal] = useState(0); // 服务端 total(行数据被 limit 截断,计数不能取 rows.length)
  const [logsFailed, setLogsFailed] = useState(false);
  const [recentPage, setRecentPage] = useState(1); // 最近请求分页(今日数据前端切片)

  // overview 每 10s 轮询(失败静默,下轮重试)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const d = await fetchOverview(); if (alive) setOv(d); } catch { /* 静默 */ }
    };
    void tick();
    const timer = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // 今日日志(图表 + 最近请求),挂载时加载一次
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const d = await fetchLogs(`?from=${start.getTime()}&limit=500`);
        if (alive) { setRows(d.rows); setLogsTotal(d.total); setLogsFailed(false); }
      } catch (e) {
        if (alive) {
          setRows([]); setLogsFailed(true);
          toast('err', `加载今日日志失败:${(e as Error).message}`);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  // 24h 双轴图:左轴请求数(柱,accent),右轴 tokens(线,txt2);配色随主题
  const [theme] = useTheme();
  const chartOption = useMemo(() => {
    if (!rows) return null;
    const C = {
      accent: themeColor('--color-accent'), brand2: themeColor('--color-brand2'),
      violet: themeColor('--color-violet'),
      txt2: themeColor('--color-txt2'), txt3: themeColor('--color-txt3'),
      line: themeColor('--color-line'), line2: themeColor('--color-line2'),
    };
    const base = echartsBase();
    const buckets = bucketByHour(rows);
    return {
      ...base,
      grid: { ...base.grid, top: 56, right: 56 },
      tooltip: { ...base.tooltip, axisPointer: { type: 'cross', label: { backgroundColor: C.line2 } } },
      legend: { data: ['请求数', 'tokens'], top: 4, right: 8, itemWidth: 14, textStyle: { color: C.txt2, fontSize: 12 } },
      xAxis: {
        type: 'category',
        data: buckets.map((_, h) => `${String(h).padStart(2, '0')}:00`),
        axisLine: { lineStyle: { color: C.line2 } },
        axisTick: { show: false },
        axisLabel: { color: C.txt2, fontSize: 11 },
      },
      yAxis: [
        {
          type: 'value',
          axisLabel: { color: C.txt2, fontSize: 11 },
          splitLine: { lineStyle: { color: C.line } },
        },
        {
          type: 'value',
          axisLabel: { color: C.txt2, fontSize: 11 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '请求数', type: 'bar', yAxisIndex: 0,
          data: buckets.map(b => b.req),
          itemStyle: { color: vgrad(C.accent, C.accent + '22'), borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
        {
          name: 'tokens', type: 'line', yAxisIndex: 1,
          data: buckets.map(b => b.tokens),
          smooth: true, showSymbol: false,
          lineStyle: { color: C.violet, width: 2.5 },
          areaStyle: { color: vgrad(C.violet + '18', C.violet + '02') },
          itemStyle: { color: C.violet },
        },
      ],
    };
  }, [rows, theme]);

  const today = ov?.today;
  const todayTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0) + (today?.cachedTokens ?? 0);
  const errRate = today && today.requests > 0 ? (today.errors / today.requests) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* ── 统计卡网格 ── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6">
        {ov ? (
          <>
            <StatCard label="今日请求" value={fmtInt(today?.requests)} tone="brand" icon={<Activity size={19} />} />
            <StatCard label="今日 Tokens" value={fmtK(todayTokens)} tone="sky" icon={<Coins size={19} />} />
            <StatCard label="错误率" value={today && today.requests > 0 ? `${errRate.toFixed(1)}%` : '0%'}
              tone="rose" status={errRate > 5 ? 'err' : errRate > 0 ? 'warn' : 'ok'} icon={<AlertTriangle size={19} />} />
            <StatCard label="客户端密钥" value={fmtInt(ov.keys.client.active)} unit={`共 ${ov.keys.client.total} 个`}
              tone="violet" icon={<KeyRound size={19} />} />
            <StatCard label="在途请求" value={fmtInt(ov.inflight)} tone="amber" icon={<Radio size={19} />} />
            <StatCard label="运行时长" value={fmtUptime(ov.uptimeSec)} tone="ok" icon={<Timer size={19} />} />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => (
            <Card key={i} className="flex items-center gap-3.5 px-4 py-3.5">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="min-w-0 flex-1">
                <Skeleton className="mb-2 h-3 w-16" />
                <Skeleton className="h-5 w-20" />
              </div>
            </Card>
          ))
        )}
      </div>

      {/* ── 24 小时请求与 Tokens ── */}
      <Card>
        <CardHeader title="24 小时请求与 Tokens" />
        <CardBody className="p-4">
          {logsFailed ? (
            <EmptyState title="图表数据加载失败" hint="请确认代理服务可达后刷新页面重试。" />
          ) : !rows ? (
            <Loading>加载今日数据…</Loading>
          ) : rows.length === 0 ? (
            <EmptyState title="今日暂无请求" hint="发起新的代理请求后,这里会按小时展示请求量与 token 消耗。" />
          ) : (
            chartOption && <EChart option={chartOption} className="h-72" />
          )}
        </CardBody>
      </Card>

      {/* ── 最近请求 + 服务状态 ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="最近请求" extra={<span className="tnum text-xs text-txt3">
            今日共 {fmtInt(logsTotal)} 条{logsTotal > (rows?.length ?? 0) ? `(展示最近 ${fmtInt(rows?.length ?? 0)})` : ''}
          </span>} />
          {logsFailed ? (
            <EmptyState title="请求列表加载失败" hint="请确认代理服务可达后刷新页面重试。" />
          ) : !rows ? (
            <Loading />
          ) : rows.length === 0 ? (
            <EmptyState title="暂无请求" hint="今日还没有任何代理请求记录。" />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>时间</Th><Th>端点</Th><Th>模型</Th><Th>状态</Th><Th>耗时</Th><Th className="text-right">tokens</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice((recentPage - 1) * 10, recentPage * 10).map(r => (
                    <tr key={r.id} className="transition-colors hover:bg-panel2/60">
                      <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtTime(r.ts)}</Td>
                      <Td className="font-mono text-xs">{r.endpoint || '—'}</Td>
                      <Td className="max-w-36 truncate text-xs">{r.model ?? '—'}</Td>
                      <Td className="whitespace-nowrap"><StatusBadge code={r.status_code} /></Td>
                      <Td className="tnum text-xs">{fmtMs(r.duration_ms)}</Td>
                      <Td className="tnum text-right text-xs">{fmtK((r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cached_tokens ?? 0))}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={recentPage} total={rows.length} pageSize={10} onChange={setRecentPage} />
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="服务状态" extra={<span className="tnum text-xs text-txt3">v{ov?.version ?? '…'}</span>} />
          <CardBody className="p-4">
            {!ov ? (
              <Loading />
            ) : (
              <div className="flex flex-col">
                <Row label="服务状态">
                  {ov.degraded ? <Badge kind="warn">降级</Badge> : <Badge kind="ok">运行中</Badge>}
                </Row>
                <Row label="API 地址"><span className="tnum text-xs">{ov.apiBase}</span></Row>
                <Row label="存储状态">
                  {ov.degraded ? <Badge kind="warn">降级(内存)</Badge> : <Badge kind="ok">正常</Badge>}
                </Row>
                <Row label="ZDR">
                  {ov.zdr ? <Badge kind="ok">开启</Badge> : <Badge>关闭</Badge>}
                </Row>
                <Row label="模型数"><span className="tnum">{fmtInt(ov.modelCount)}</span></Row>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
