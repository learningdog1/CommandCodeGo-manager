// 实时请求日志(Phase 3.2):历史查询 + SSE 实时追加(ticket 一次性票据,断线 1.5s 自动重连)。
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchClientKeys, fetchLogs, tokenQuery, type ClientKey, type RequestRow } from '../api';
import {
  Badge, Button, Card, CardHeader, EmptyState, Loading, Pagination, Select,
  Table, Td, Th, toast, fmtInt, fmtK, fmtMs, fmtTime,
} from '../ui';

const ENDPOINTS = ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models'];
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: '2xx', label: '2xx 成功' },
  { value: '4xx', label: '4xx 客户端错误' },
  { value: '5xx', label: '5xx 服务端错误' },
  { value: '200', label: '200' },
  { value: '401', label: '401' },
  { value: '429', label: '429' },
  { value: '502', label: '502' },
];
const MAX_ROWS = 500;      // SSE 实时尾随的状态上限(渲染只出当前页)
const PAGE_SIZE = 50;      // 分页每页条数(DOM 上限,侧栏切换卡顿的主因就是无分页时整表渲染)

function statusKind(code: number | null): 'ok' | 'warn' | 'err' | 'default' {
  if (code == null) return 'default';
  if (code >= 500) return 'err';
  if (code >= 400) return 'warn';
  return 'ok';
}

// SSE 行无 id(后端 publish 的是 camelCase 记录),补一个会话内负数自增 id 兜底
let sseSeq = 0;

/** 归一化:SSE 事件(camelCase)与历史行(snake_case)统一成 RequestRow。 */
function normalize(raw: Record<string, unknown>): RequestRow {
  const g = <T,>(snake: string, camel: string, d: T): T => {
    const v = raw[snake] ?? raw[camel];
    return (v === undefined || v === null ? d : v) as T;
  };
  return {
    id: g<number>('id', 'id', -(++sseSeq)),
    ts: g<number>('ts', 'ts', Date.now()),
    endpoint: g<string>('endpoint', 'endpoint', ''),
    proxy_key: g<string | null>('proxy_key', 'proxyKey', null),
    upstream_key_id: g<number | null>('upstream_key_id', 'upstreamKeyId', null),
    model: g<string | null>('model', 'model', null),
    status_code: g<number | null>('status_code', 'statusCode', null),
    stream: g<number | boolean>('stream', 'stream', 0) ? 1 : 0,
    duration_ms: g<number | null>('duration_ms', 'durationMs', null),
    input_tokens: g<number>('input_tokens', 'inputTokens', 0),
    output_tokens: g<number>('output_tokens', 'outputTokens', 0),
    cached_tokens: g<number>('cached_tokens', 'cachedTokens', 0),
    finish_reason: g<string | null>('finish_reason', 'finishReason', null),
    error_type: g<string | null>('error_type', 'errorType', null),
    client_disconnected: g<number | boolean>('client_disconnected', 'clientDisconnected', 0) ? 1 : 0,
  };
}

// 详情展开行的键值对
function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0 text-txt3">{label}</span>
      <span className="tnum min-w-0 break-all text-txt">{value ?? '—'}</span>
    </div>
  );
}

// 单行(含展开详情)独立 memo:SSE 新增一条 / 展开 / 收起时,
// 只有变化的行重渲染,不再整表重建(表可达数百行,整表重渲是实时流的卡顿源)。
const LogRow = memo(function LogRow({ r, expanded, onToggle }: {
  r: RequestRow; expanded: boolean; onToggle: (id: number) => void;
}) {
  return (
    <Fragment>
      <tr onClick={() => onToggle(r.id)}
        className={`cursor-pointer transition-colors hover:bg-panel2/60 ${expanded ? 'bg-panel2/80' : ''}`}>
        <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtTime(r.ts)}</Td>
        <Td className="max-w-44 truncate font-mono text-xs">{r.endpoint || '—'}</Td>
        <Td className="max-w-32 truncate text-xs text-txt2">{r.proxy_key ?? '—'}</Td>
        <Td className="max-w-36 truncate text-xs">{r.model ?? '—'}</Td>
        <Td><Badge kind={statusKind(r.status_code)}>{r.status_code ?? '—'}</Badge></Td>
        <Td className="text-xs text-txt2">{r.stream ? '是' : '否'}</Td>
        <Td className="tnum text-xs">{fmtMs(r.duration_ms)}</Td>
        <Td className="tnum text-xs">{fmtK(r.input_tokens)} / {fmtK(r.output_tokens)}</Td>
        <Td className="max-w-24 truncate font-mono text-xs text-txt2">{r.finish_reason ?? '—'}</Td>
        <Td className="max-w-32 truncate text-xs">{r.error_type
          ? <span className="font-mono text-err">{r.error_type}</span> : <span className="text-txt3">—</span>}</Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} className="border-b border-line/50 bg-panel2/50 px-4 py-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs md:grid-cols-3">
              <KV label="id" value={String(r.id)} />
              <KV label="完整时间" value={fmtTime(r.ts)} />
              <KV label="端点" value={r.endpoint || '—'} />
              <KV label="proxy_key" value={r.proxy_key ?? '—'} />
              <KV label="upstream_key_id" value={r.upstream_key_id != null ? String(r.upstream_key_id) : '—'} />
              <KV label="模型" value={r.model ?? '—'} />
              <KV label="状态码" value={r.status_code != null ? String(r.status_code) : '—'} />
              <KV label="流式" value={r.stream ? '是' : '否'} />
              <KV label="耗时" value={fmtMs(r.duration_ms)} />
              <KV label="input_tokens" value={fmtInt(r.input_tokens)} />
              <KV label="output_tokens" value={fmtInt(r.output_tokens)} />
              <KV label="cached_tokens" value={fmtInt(r.cached_tokens)} />
              <KV label="finish_reason" value={r.finish_reason ?? '—'} />
              <KV label="error_type" value={r.error_type
                ? <span className="text-err">{r.error_type}</span> : '—'} />
              <KV label="client_disconnected" value={r.client_disconnected ? '是' : '否'} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
});

export function Logs() {
  // 过滤条件('' = 不过滤;2xx/4xx/5xx 为前端分组过滤,具体值走服务端)
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keys, setKeys] = useState<ClientKey[]>([]);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [live, setLive] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // 状态过滤值:精确(200/401…)或分组(2xx/4xx/5xx)都直传服务端,
  // 分页 total 与过滤后的行集一致;SSE 实时行在客户端按同口径匹配。
  const statusMatch = useCallback((r: RequestRow) => {
    if (!status) return true;
    const c = r.status_code;
    if (c == null) return false;
    if (/^\d{3}$/.test(status)) return c === Number(status);
    const lo = Number(status[0]) * 100;
    return c >= lo && c <= lo + 99;
  }, [status]);

  // keyId 过滤:后端按 upstream_key_id 匹配,故取客户端 key 映射的上游 key id(去重)
  const keyOptions = useMemo(() => {
    const seen = new Set<number>();
    const out: { id: number; label: string }[] = [];
    for (const k of keys) {
      if (k.upstream_key_id == null || seen.has(k.upstream_key_id)) continue;
      seen.add(k.upstream_key_id);
      out.push({ id: k.upstream_key_id, label: k.name });
    }
    return out;
  }, [keys]);

  const matchFilter = useCallback((r: RequestRow) =>
    (!endpoint || r.endpoint === endpoint) && statusMatch(r) &&
    (!keyId || r.upstream_key_id === Number(keyId))
  , [endpoint, statusMatch, keyId]);

  // onmessage 闭包里读最新过滤条件与页码
  const matchRef = useRef(matchFilter);
  useEffect(() => { matchRef.current = matchFilter; }, [matchFilter]);
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);

  // ── 历史加载(过滤条件/页码变化时重新拉取;服务端分页 limit/offset) ──
  // 序号守卫:快速切换筛选/翻页时,只认最后一次发起的响应 —— 旧的慢响应
  // 后到会覆盖新数据(表格与筛选错位、total 错乱),过期响应一律丢弃
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (endpoint) qs.set('endpoint', endpoint);
      if (status) qs.set('status', status);
      if (keyId) qs.set('keyId', keyId);
      const d = await fetchLogs(`?${qs.toString()}`);
      if (seq !== loadSeqRef.current) return;
      setRows(d.rows); setTotal(d.total);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setErr((e as Error).message || '加载失败');
      toast('err', '加载请求日志失败');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [endpoint, status, keyId, page]);

  useEffect(() => { void load(); }, [load]);

  // 页码 clamp:后台按保留期清理日志会让 total 收缩,停在高页码会困在空页
  // (分页控件在 totalPages<=1 时整体消失,没有路回去),这里自动退回末页
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [total, page]);

  // 客户端 key 下拉数据
  useEffect(() => {
    fetchClientKeys().then(d => setKeys(d.rows)).catch(() => { /* 下拉静默降级为空 */ });
  }, []);

  // ── SSE 实时追加 ──
  const liveRef = useRef(true);
  const disposedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(async () => {
    if (disposedRef.current) return;
    try {
      // EventSource 无法带 Authorization 头:启用 CCP_ADMIN_TOKEN 时令牌走查询参数
      esRef.current?.close();
      const es = new EventSource('/admin/api/logs/stream' + tokenQuery());
      esRef.current = es;
      es.onmessage = ev => {
        if (!liveRef.current) return; // 暂停期间丢弃(恢复实时时统一补拉,见 toggleLive)
        try {
          const row = normalize(JSON.parse(ev.data) as Record<string, unknown>);
          if (!matchRef.current(row)) return;
          // 只在第 1 页前插实时行:翻页中前插会把当前页内容整体顶走。
          // 离开第 1 页期间的事件只累计 total,回第 1 页时 load() 会重新拉取。
          if (pageRef.current !== 1) { setTotal(n => n + 1); return; }
          setRows(prev => [row, ...prev].slice(0, MAX_ROWS));
          setTotal(n => n + 1);
        } catch { /* 忽略坏帧 */ }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (disposedRef.current) return;
        timerRef.current = setTimeout(() => { void connect(); }, 1500);
      };
    } catch {
      if (disposedRef.current) return;
      timerRef.current = setTimeout(() => { void connect(); }, 1500);
    }
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    void connect();
    return () => {
      disposedRef.current = true;
      esRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [connect]);

  const toggleLive = () => {
    const next = !live;
    liveRef.current = next;
    setLive(next);
    // 恢复实时:补拉暂停窗口内错过的行,total 计数也一并归位
    if (next) void load();
  };

  const clearFilters = () => { setEndpoint(''); setStatus(''); setKeyId(''); setPage(1); };
  // 行展开/收起(LogRow memo 的稳定回调,避免每次渲染生成新函数打散 memo)
  const toggleRow = useCallback((id: number) => setExpandedId(prev => (prev === id ? null : id)), []);

  return (
    <div className="space-y-5">
      {/* ── 过滤栏 + 实时开关 ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-48">
          <Select value={endpoint} onChange={e => { setEndpoint(e.target.value); setPage(1); }}>
            <option value="">全部端点</option>
            {ENDPOINTS.map(ep => <option key={ep} value={ep}>{ep}</option>)}
          </Select>
        </div>
        <div className="w-44">
          <Select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        <div className="w-48">
          <Select value={keyId} onChange={e => { setKeyId(e.target.value); setPage(1); }}>
            <option value="">全部 Key</option>
            {keyOptions.map(k => <option key={k.id} value={String(k.id)}>{k.label}</option>)}
          </Select>
        </div>
        <Button size="md" onClick={clearFilters} disabled={!endpoint && !status && !keyId}>清空过滤</Button>
        <div className="ml-auto flex items-center gap-2">
          <Badge kind={live ? 'ok' : 'default'}>{live ? '● 实时' : '已暂停'}</Badge>
          <Button size="sm" variant={live ? 'default' : 'primary'} onClick={toggleLive}>
            {live ? '暂停实时' : '开启实时'}
          </Button>
        </div>
      </div>

      {/* ── 日志表 ── */}
      <Card>
        <CardHeader
          title="请求日志"
          extra={<span className="tnum text-xs text-txt3">共 {fmtInt(total)} 条</span>} />
        {err && !loading ? (
          <EmptyState title="日志加载失败" hint={`${err} —— 请确认代理服务可达后重试。`} />
        ) : loading ? (
          <Loading>加载请求日志…</Loading>
        ) : rows.length === 0 ? (
          <EmptyState title="暂无请求" hint="当前过滤条件下没有请求记录,实时请求会自动出现在这里。" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>时间</Th><Th>端点</Th><Th>Key</Th><Th>模型</Th><Th>状态</Th><Th>流式</Th>
                  <Th>耗时</Th><Th>tokens (in/out)</Th><Th>finish</Th><Th>错误</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <LogRow key={r.id} r={r} expanded={expandedId === r.id} onToggle={toggleRow} />
                ))}
              </tbody>
            </Table>
            <Pagination page={page} total={total} pageSize={PAGE_SIZE} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
