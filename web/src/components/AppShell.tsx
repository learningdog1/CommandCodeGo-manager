// App Shell:左侧导航 + 顶栏运行状态(轮询 /overview,15s)。
// H2:顶栏为窗口拖动区(macOS hiddenInset 无系统标题栏,Web 侧提供 drag);
// 顶栏内的交互控件(主题切换)需显式 no-drag 才可点击。
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useOutlet } from 'react-router-dom';
import {
  Terminal, LayoutDashboard, ScrollText, BarChart3, Boxes, KeyRound, Fingerprint, Settings, Users,
} from 'lucide-react';
import { fetchOverview, setAdminToken, type ApiError, type Overview } from '../api';
import { ThemeToggle, toast } from '../ui';

const NAV_GROUPS: { title: string; items: { to: string; label: string; icon: typeof LayoutDashboard; end: boolean }[] }[] = [
  {
    title: '监控',
    items: [
      { to: '/', label: '总览', icon: LayoutDashboard, end: true },
      { to: '/logs', label: '请求日志', icon: ScrollText, end: false },
      { to: '/usage', label: '用量统计', icon: BarChart3, end: false },
      { to: '/accounts', label: '账号用量', icon: Users, end: false },
    ],
  },
  {
    title: '配置',
    items: [
      { to: '/models', label: '模型', icon: Boxes, end: false },
      { to: '/keys', label: '密钥管理', icon: KeyRound, end: false },
      { to: '/fingerprints', label: '设备指纹', icon: Fingerprint, end: false },
      { to: '/settings', label: '设置', icon: Settings, end: false },
    ],
  },
];

// 页面标题区(大气感:每个页面统一的大标题 + 一句话描述)
const PAGE_META: { match: string; title: string; desc: string }[] = [
  { match: '/', title: '总览', desc: '订阅用量与代理运行状态一览' },
  { match: '/logs', title: '请求日志', desc: '实时请求流与历史查询' },
  { match: '/usage', title: '用量统计', desc: '按天 / 模型 / 密钥的 token 消耗' },
  { match: '/accounts', title: '账号用量', desc: '每个账号的模板条窗口、信用余额与期账累计' },
  { match: '/models', title: '模型', desc: '可用模型目录与套餐标注' },
  { match: '/keys', title: '密钥管理', desc: '上游订阅账户与客户端接入密钥' },
  { match: '/fingerprints', title: '设备指纹', desc: '每个上游密钥伪造的设备身份与上报状态' },
  { match: '/settings', title: '设置', desc: '服务与运行参数' },
];

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

// 全部页面保活:切换导航只切 display,不卸载重挂载。页面挂载成本高
//(重新拉数据 + ECharts 重建 + 大表渲染),弱 GPU 的 Windows/Electron 上
// 整页重建正是"切一次卡一次"的主因;保活后二次切换接近零成本,日志页
// 离开时仍实时接收。内存有界:页面固定 8 个,最大的模型页 ~1.4k DOM 节点。
const KEEP_ALIVE_PATHS = ['/', '/logs', '/usage', '/accounts', '/models', '/keys', '/fingerprints', '/settings'];

function KeepAliveOutlet() {
  const location = useLocation();
  const outlet = useOutlet();
  const cache = useRef(new Map<string, React.ReactNode>());
  const path = location.pathname;
  const keepAlive = KEEP_ALIVE_PATHS.includes(path);
  // 只缓存已知页面;未知路径(重定向中的 "*" 等)走直渲染,不进缓存
  if (keepAlive) cache.current.set(path, outlet);
  return (
    <>
      {[...cache.current.entries()].map(([p, el]) => (
        <div key={p} className={p === path ? undefined : 'hidden'}>{el}</div>
      ))}
      {!keepAlive && outlet}
    </>
  );
}

// 令牌输入门:服务端设了 CCP_ADMIN_TOKEN(容器/公网部署)时,任何 401 都会
// 落到这里;输入正确令牌存 localStorage 后自动放行整页。
function TokenGate({ onRetry }: { onRetry: () => void }) {
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!val.trim() || busy) return;
    setBusy(true); setErr('');
    setAdminToken(val.trim());
    try {
      await fetchOverview();   // 探针:令牌对不对由服务端说了算
      onRetry();
    } catch (e) {
      setErr((e as Error).message || '令牌无效');
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-lg">
        <div className="brand-gradient mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-white shadow-md">
          <Terminal size={24} strokeWidth={2.4} />
        </div>
        <div className="text-center text-[15px] font-bold text-txt">管理界面已启用令牌鉴权</div>
        <div className="mt-1 text-center text-xs text-txt3">令牌由部署者在 CCP_ADMIN_TOKEN(如 docker-compose.yml)中设置</div>
        <input
          type="password" autoFocus value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
          placeholder="输入管理令牌"
          className="tnum mt-5 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-txt outline-none transition-colors focus:border-accent"
        />
        {err && <div className="mt-2 text-center text-xs text-err">{err}</div>}
        <button
          onClick={() => void submit()} disabled={busy || !val.trim()}
          className="brand-gradient mt-4 w-full rounded-lg py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50">
          {busy ? '验证中…' : '进入管理界面'}
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const [ov, setOv] = useState<Overview | null>(null);
  // unknown=尚未判定;no=服务端要求令牌(401);yes=已通过(或服务端未启用鉴权)
  const [authed, setAuthed] = useState<'unknown' | 'no' | 'yes'>('unknown');
  const location = useLocation();
  const meta = PAGE_META.slice().reverse().find(m => location.pathname === m.match || location.pathname.startsWith(m.match + '/'))
    ?? PAGE_META[0];

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fetchOverview();
        if (alive) { setOv(d); setAuthed('yes'); }
      } catch (e) {
        // 401 = 服务端启用了 CCP_ADMIN_TOKEN 且当前令牌缺失/错误 → 弹令牌门;
        // 其余错误(服务重启中等)维持原有静默行为
        if (alive && (e as ApiError).status === 401) setAuthed('no');
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [authed]);

  if (authed === 'no') {
    return <TokenGate onRetry={() => { setAuthed('unknown'); }} />;
  }

  return (
    <div className="flex h-full">
      {/* ── 侧栏 ── */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-md">
            <Terminal size={20} strokeWidth={2.4} />
          </div>
          <div>
            <div className="text-[15px] font-extrabold leading-tight tracking-wide text-txt">CC Proxy</div>
            <div className="text-[10px] leading-tight text-txt3">CommandCode 订阅反代</div>
          </div>
        </div>

        <nav className="mt-1 flex flex-1 flex-col gap-4 px-2">
          {NAV_GROUPS.map(group => (
            <div key={group.title}>
              <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-txt3">{group.title}</div>
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink key={to} to={to} end={end}
                    className={({ isActive }) =>
                      `relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150 active:scale-[0.98] ${
                        isActive ? 'bg-accent-dim font-semibold text-accent' : 'text-txt2 hover:bg-panel2 hover:text-txt'}`}>
                    {({ isActive }) => (<>
                      {isActive && <span className="brand-gradient absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full" />}
                      <Icon size={16} strokeWidth={2} />
                      {label}
                    </>)}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* 底部状态块:填充侧栏并常驻关键信息 */}
        <div className="border-t border-line px-3.5 py-3">
          <div className="rounded-lg bg-panel2 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${ov ? (ov.degraded ? 'bg-warn' : 'bg-ok') : 'bg-txt3'}`} />
              <span className="text-txt">{ov ? (ov.degraded ? '存储降级运行' : '服务运行中') : '连接中…'}</span>
            </div>
            <button
              onClick={() => {
                // 用户实际访问的地址(而非写死 127.0.0.1:port):局域网/容器/反代
                // 部署下这才是对的「服务地址」
                navigator.clipboard?.writeText(window.location.origin).then(
                  () => toast('ok', '已复制服务地址'),
                  () => {},
                );
              }}
              className="tnum mt-1.5 block w-full truncate rounded bg-bg px-1.5 py-1 text-left text-[11px] text-txt2 transition-colors hover:text-accent"
              title="点击复制服务地址">
              {window.location.origin}
            </button>
            <div className="mt-1.5 flex items-center justify-between text-[10px] text-txt3">
              <span>在途 {ov?.inflight ?? 0}</span>
              <span className="tnum">v{ov?.version ?? '…'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── 主区 ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏状态条:整条可拖动窗口(H2),交互控件 no-drag */}
        <header
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          className="flex h-12 shrink-0 select-none items-center justify-end gap-4 border-b border-line bg-panel/60 px-5 text-xs text-txt2 backdrop-blur"
        >
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${ov ? (ov.degraded ? 'bg-warn' : 'bg-ok') : 'bg-txt3'}`} />
            <span className="whitespace-nowrap">{ov ? (ov.degraded ? '存储降级' : '运行中') : '连接中…'}</span>
          </span>
          <span className="tnum whitespace-nowrap">在途 {ov?.inflight ?? 0}</span>
          <span className="tnum whitespace-nowrap">运行 {ov ? fmtUptime(ov.uptimeSec) : '…'}</span>
          <span className="hidden min-w-0 truncate tnum text-txt3 lg:inline">{ov?.apiBase ?? ''}</span>
          <span style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <ThemeToggle />
          </span>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-6xl">
            {/* 页头:统一大标题 */}
            <div className="mb-4 border-b border-line pb-3.5">
              <h1 className="text-xl font-extrabold tracking-tight text-txt">{meta.title}</h1>
              <p className="mt-0.5 text-[13px] text-txt2">{meta.desc}</p>
            </div>
            <KeepAliveOutlet />
          </div>
        </main>
      </div>
    </div>
  );
}
