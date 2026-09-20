// 模型页(花销版重构):当前生效模型目录 × 官方公开价目 × 本地 30 天用量,
// 每个模型展示单价($/1M 输入/输出/缓存读)、实际用量与参考成本,方便按价格选型。
// 厂商分组默认折叠(点厂商名展开,头部直接给该组参考成本),搜索/筛选时自动展开。
// 成本为估算值(官方价目 × 本地 token 计量),实际扣费以账号信用为准。
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronDown, Coins, Download, RefreshCw, Search, Sigma, UnfoldVertical, Zap } from 'lucide-react';
import { fetchUsage, refreshModels, type ModelItem, type UsageRow } from '../api';
import { CATALOG_BY_ID } from '../model-catalog';
import {
  Badge, Button, Card, EmptyState, Input, Loading, StatCard, Tabs,
  copyText, fmtInt, fmtK, toast,
} from '../ui';

const PLAN_LABEL: Record<string, string> = { go: 'Go', pro: 'Pro', goat: 'GOAT', max: 'Max', team: 'Teams' };
const USAGE_DAYS = 30;

// 厂商名:取 id 第一段('deepseek/xxx' → 'DeepSeek');无斜杠取品牌词首段
function vendorOf(id: string): string {
  const head = id.includes('/') ? id.slice(0, id.indexOf('/')) : (id.split('-')[0] || id);
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : '其他';
}

// 美元展示:小额多留小数位,避免 $0.0004 被抹成 0
function fmtUsd(v: number): string {
  if (v === 0) return '—';
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(3);
  return '$' + v.toFixed(4);
}

// 参考成本:非缓存输入 × 输入价 + 缓存读 × 缓存读价 + 输出 × 输出价(均 $/1M)。
// 本地 input_tokens 为含缓存命中的总口径,非缓存输入 = input - cached(与代理转发口径一致)。
function estCost(cat: { priceIn: number; priceOut: number; cacheRead: number }, u: { input: number; cached: number; output: number }): number {
  const nonCacheIn = Math.max(0, u.input - u.cached);
  return nonCacheIn / 1e6 * cat.priceIn + u.cached / 1e6 * cat.cacheRead + u.output / 1e6 * cat.priceOut;
}

// 点击复制模型 id:copyText 自带非安全上下文(HTTP 访问)降级;
// 连 execCommand 都被禁时兜底提示走导出清单
async function copyId(id: string) {
  const ok = await copyText(id);
  if (ok) toast('ok', '已复制');
  else toast('err', '复制失败:剪贴板不可用,可点「导出清单」获取模型 id');
}

// 导出全部模型 id 为 txt(一行一个):不依赖剪贴板,任何部署环境可用
function exportIds(models: ModelItem[]) {
  const blob = new Blob([models.map(m => m.id).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'models.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// 单个模型行:名称/plan + 单价 + 30 天用量 + 参考成本。
// memo:展开/收起任一厂商时 expanded 集合变化会重渲整页,行内容与 expanded
// 无关,70 行全部跳过,弱机器上点手风琴的开销从整表降到单卡
const ModelRow = memo(function ModelRow({ m, u }: {
  m: ModelItem;
  u?: { input: number; cached: number; output: number; requests: number };
}) {
  const cat = CATALOG_BY_ID.get(m.id);
  const cost = cat && u ? estCost(cat, u) : null;
  const used = !!u && u.requests > 0;
  return (
    <button onClick={() => copyId(m.id)} title="点击复制模型 id"
      className={`group flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-left transition-all duration-150 hover:border-accent/50 active:scale-[0.99] ${
        used ? 'border-line bg-panel2/50' : 'border-line/70 bg-transparent hover:bg-panel2/40'}`}>
      {/* 名称 + id + 套餐 */}
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex items-center gap-1.5">
          <span className={`truncate font-mono text-xs ${used ? 'text-txt' : 'text-txt2'}`}>{m.id}</span>
          {m.plan && (
            <span className={`shrink-0 rounded px-1 py-px text-[9px] ${m.plan === 'go' ? 'bg-accent-dim text-accent' : 'bg-line text-txt3'}`}>
              {PLAN_LABEL[m.plan] ?? m.plan}
            </span>
          )}
        </div>
        {cat?.bestFor && <div className="mt-0.5 truncate text-[10px] text-txt3">{cat.bestFor}</div>}
      </div>
      {/* 单价($/1M in/out · cache read;上下文进 title,保证单价单行不断裂) */}
      <div className="tnum basis-44 whitespace-nowrap text-[11px] text-txt3"
        title={cat ? `官方公开单价:$ / 1M tokens(输入 / 输出 / 缓存读)${cat.context ? ` · 上下文 ${cat.context}` : ''}${cat.cacheWrite ? ` · 缓存写 $${cat.cacheWrite}` : ''}` : undefined}>
        {cat ? (cat.priceIn === 0 && cat.priceOut === 0
          ? <span className="text-ok">免费</span>
          : <>${cat.priceIn} / ${cat.priceOut}{cat.cacheRead ? ` · 缓存 $${cat.cacheRead}` : ''}</>)
        : '价格未知'}
      </div>
      {/* 30 天本地用量 */}
      <div className="tnum basis-40 whitespace-nowrap text-[11px] text-txt3" title="最近 30 天经本代理的用量">
        {used
          ? <>{fmtInt(u!.requests)} 次 · {fmtK(u!.input + u!.output)} tok</>
          : <span className="text-txt3/70">近 {USAGE_DAYS} 天未使用</span>}
      </div>
      {/* 参考成本 */}
      <div className="tnum w-16 shrink-0 text-right text-sm font-semibold" title="参考成本 = 官方单价 × 本地 token 用量(估算,非账单)">
        {cost != null && cost > 0
          ? <span className={cost >= 1 ? 'text-rose' : 'text-violet'}>{fmtUsd(cost)}</span>
          : <span className="text-txt3">—</span>}
      </div>
    </button>
  );
});

export function Models() {
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [usage, setUsage] = useState<Map<string, { input: number; cached: number; output: number; requests: number }> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('all'); // all = 全部模型,used = 仅看已使用
  // 展开的厂商(默认全折叠;搜索/仅看已使用时自动全展开 —— 结果已被过滤,折叠碍事)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - USAGE_DAYS);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const [res, u] = await Promise.all([
        fetch('/v1/models'),
        fetchUsage(`?from=${fmt(from)}&to=${fmt(to)}&groupBy=model`),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: ModelItem[] };
      const list = Array.isArray(json?.data) ? json.data.filter(m => m && typeof m.id === 'string') : [];
      setModels(list);
      const map = new Map();
      for (const r of (u.rows ?? []) as UsageRow[]) {
        if (!r.model) continue;
        const prev = map.get(r.model) ?? { input: 0, cached: 0, output: 0, requests: 0 };
        prev.input += r.input_tokens ?? 0;
        prev.cached += r.cached_tokens ?? 0;
        prev.output += r.output_tokens ?? 0;
        prev.requests += r.requests ?? 0;
        map.set(r.model, prev);
      }
      setUsage(map);
      setFailed(null);
    } catch (e) {
      setModels([]);
      setUsage(new Map());
      setFailed((e as Error).message || '加载失败');
      toast('err', `加载模型列表失败:${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await refreshModels();
      if (r.source === 'upstream') toast('ok', `已从上游刷新模型列表(${r.count} 个)`);
      else toast('info', r.reason ?? `已展示内置清单(${r.count} 个)`);
      await load();
    } catch (e) {
      toast('err', `刷新失败:${(e as Error).message}`);
    } finally {
      // 失败也必须复位:否则按钮永久转圈禁用,只能离开页面重进
      setBusy(false);
    }
  }, [load]);

  // ── 汇总:30 天估算总成本 / 请求数 / tokens ──
  const totals = useMemo(() => {
    let cost = 0, requests = 0, tokens = 0;
    if (usage) for (const [id, u] of usage) {
      requests += u.requests;
      tokens += u.input + u.cached + u.output;
      const cat = CATALOG_BY_ID.get(id);
      if (cat) cost += estCost(cat, u);
    }
    return { cost, requests, tokens, usedModels: usage ? [...usage.values()].filter(u => u.requests > 0).length : 0 };
  }, [usage]);

  // 搜索 + 视图过滤 + 厂商分组(组内按参考成本降序,未用过的按 id;组头汇总该组成本)
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (models ?? []).filter(m => {
      if (q && !m.id.toLowerCase().includes(q)) return false;
      if (view === 'used') {
        const u = usage?.get(m.id);
        if (!u || u.requests === 0) return false;
      }
      return true;
    });
    const costOf = (id: string) => {
      const u = usage?.get(id);
      const cat = CATALOG_BY_ID.get(id);
      return cat && u && u.requests > 0 ? estCost(cat, u) : -1;
    };
    const map = new Map<string, ModelItem[]>();
    for (const m of rows) {
      const v = vendorOf(m.id);
      const arr = map.get(v);
      if (arr) arr.push(m); else map.set(v, [m]);
    }
    return [...map.entries()]
      .map(([vendor, items]) => ({
        vendor,
        // 组内:有参考成本的在前(降序),其余按 id
        items: items.sort((a, b) => costOf(b.id) - costOf(a.id) || a.id.localeCompare(b.id)),
        cost: items.reduce((n, m) => n + Math.max(0, costOf(m.id)), 0),
      }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor));
  }, [models, usage, query, view]);
  const matched = groups.reduce((n, g) => n + g.items.length, 0);

  // 进入过滤态(搜索/仅看已使用)自动展开全部组
  useEffect(() => {
    if (query.trim() || view === 'used') setExpanded(new Set(groups.map(g => g.vendor)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在过滤条件变化时联动,groups 变化不重置用户手动展开
  }, [query, view]);

  const toggleGroup = (vendor: string) =>
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(vendor)) s.delete(vendor); else s.add(vendor);
      return s;
    });
  const allOpen = groups.length > 0 && groups.every(g => expanded.has(g.vendor));
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(groups.map(g => g.vendor)));

  return (
    <div className="space-y-5">
      {/* ── 30 天花销汇总 ── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={`近 ${USAGE_DAYS} 天参考成本`} value={fmtUsd(totals.cost)} unit="估算"
          sub="官方单价 × 本地用量" icon={<Coins size={18} />} tone="violet" />
        <StatCard label={`近 ${USAGE_DAYS} 天请求`} value={fmtInt(totals.requests)}
          icon={<Zap size={18} />} />
        <StatCard label={`近 ${USAGE_DAYS} 天 tokens`} value={fmtK(totals.tokens)}
          sub={`已用模型 ${totals.usedModels} 个`} icon={<Sigma size={18} />} tone="sky" />
        <StatCard label="可用模型" value={models ? fmtInt(models.length) : '…'}
          unit={models && usage ? `已用 ${totals.usedModels}` : undefined}
          icon={<Boxes size={18} />} tone="ok" />
      </div>

      {/* ── 顶部:搜索 / 视图 / 刷新 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-txt3" />
          <Input className="pl-8" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索模型 id…" />
        </div>
        <Tabs items={[{ id: 'all', label: '全部模型' }, { id: 'used', label: '仅看已使用' }]} value={view} onChange={setView} />
        {matched > 0 && (
          <Button size="sm" variant="ghost" onClick={toggleAll} title={allOpen ? '收起全部厂商' : '展开全部厂商'}>
            <UnfoldVertical size={13} className={`transition-transform duration-300 ${allOpen ? 'rotate-180' : ''}`} />
            {allOpen ? '收起全部' : '展开全部'}
          </Button>
        )}
        <Button onClick={() => void refresh()} loading={busy}><RefreshCw size={14} />一键刷新</Button>
        {models && models.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => exportIds(models)} title="下载全部模型 id 清单(txt,一行一个)——剪贴板不可用时的替代">
            <Download size={13} />导出清单
          </Button>
        )}
        {models && (
          <span className="tnum ml-auto text-xs text-txt3">
            {query.trim() || view === 'used' ? `匹配 ${matched} / ${models.length} 个模型` : `共 ${fmtInt(models.length)} 个模型 · ${groups.length} 个厂商`}
          </span>
        )}
      </div>

      {/* ── 厂商分组列表 ── */}
      {models === null || usage === null ? (
        <Card><Loading>加载模型列表与用量…</Loading></Card>
      ) : failed ? (
        <Card><EmptyState title="模型列表加载失败" hint={`${failed},请点击「一键刷新」重试。`} /></Card>
      ) : models.length === 0 ? (
        <Card><EmptyState title="暂无模型" hint="上游未返回任何模型,请确认服务配置后刷新。" /></Card>
      ) : matched === 0 ? (
        <Card><EmptyState title="无匹配模型" hint={view === 'used' && !query.trim() ? `最近 ${USAGE_DAYS} 天没有经代理的模型调用。` : `没有 id 包含「${query.trim()}」的模型。`} /></Card>
      ) : (
        // items-start:卡片各自按内容高度排布。缺省的 stretch 会让同一行的两张卡
        // 等高 —— 展开左卡时,右卡(折叠态)被拉到同高,看起来像"旁边的厂商也跟着展开"
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {groups.map(g => {
            const open = expanded.has(g.vendor);
            return (
              <Card key={g.vendor} className={`overflow-hidden transition-all duration-200 ${open ? 'border-accent/30' : ''}`}>
                {/* 厂商头:整条可点,展开/收起有旋转箭头与底色反馈;折叠时组头直接给该组参考成本 */}
                <button onClick={() => toggleGroup(g.vendor)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-all duration-150 active:scale-[0.995] ${
                    open ? 'border-b border-line bg-panel2/40' : 'hover:bg-panel2/60'}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-txt">{g.vendor}</span>
                    <Badge kind="accent">{g.items.length} 个模型</Badge>
                    {g.cost > 0 && (
                      <span className="tnum shrink-0 rounded border border-violet/25 bg-violet/10 px-1.5 py-0.5 text-[11px] font-semibold text-violet"
                        title="该组近 30 天参考成本合计">
                        {fmtUsd(g.cost)}
                      </span>
                    )}
                  </span>
                  <ChevronDown size={15} className={`shrink-0 text-txt3 transition-transform duration-300 ${open ? 'rotate-180 text-accent' : ''}`} />
                </button>
                {/* 高度动画折叠(grid-template-rows 0fr→1fr),内层 min-h-0 + overflow-hidden 才能真正收干 */}
                <div className={`grid transition-all duration-300 ease-in-out ${open ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'}`}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-1.5 p-4">
                      {g.items.map(m => <ModelRow key={m.id} m={m} u={usage.get(m.id)} />)}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="px-1 text-[11px] text-txt3">
        参考成本 = 官方公开单价($/1M tokens:非缓存输入 / 缓存读 / 输出)× 本代理计量的 token 用量,仅供选型比较;
        订阅套餐内实际按信用扣减,与该估算值不一致属正常。价目源:command-code 官方 models.md(随版本可能调整)。
      </p>
    </div>
  );
}
