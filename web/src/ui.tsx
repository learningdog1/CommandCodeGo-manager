// 组件基件库(Step 3.1):Button/Card/Table/Badge/Dialog/Input/Tabs/Toast/空态/骨架屏/EChart。
// 全部自实现,零第三方 UI 依赖;设计 token 见 styles.css 的 @theme。
// echarts 不在此处同步引入:见 echart.tsx(按需注册 + 异步 chunk)。
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { X, Sun, Moon } from 'lucide-react';

/** 图表配置项(宽松类型:页面侧都是字面量对象,无需耦合 echarts 类型)。 */
export type ChartOption = Record<string, unknown>;

// ── 主题(F1):默认亮色,可切暗色;持久化 localStorage ──────
export type Theme = 'light' | 'dark';
export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) === 'dark' ? 'dark' : 'light';
}
export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ccp-theme', t); } catch { /* 私密模式等 */ }
}
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setT] = useState<Theme>(getTheme());
  useEffect(() => {
    const obs = new MutationObserver(() => setT(getTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return [theme, setTheme];
}

/** 读取当前主题下某个 CSS 颜色变量(图表内联色跟随主题用)。 */
export function themeColor(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#888';
}

/** 主题切换按钮(顶栏用)。 */
export function ThemeToggle() {
  const [theme, setT] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      onClick={() => setT(next)}
      title={next === 'dark' ? '切换到暗色' : '切换到亮色'}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-panel text-txt2 transition-all duration-150 hover:border-line2 hover:text-txt active:scale-90">
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

// ── Button ────────────────────────────────────────────────
type BtnVariant = 'primary' | 'default' | 'danger' | 'ghost';
export function Button({
  variant = 'default', size = 'md', loading, className = '', children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed select-none active:scale-[0.97] active:brightness-95';
  const sizes = { sm: 'h-7 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' };
  const variants: Record<BtnVariant, string> = {
    primary: 'brand-gradient text-white hover:brightness-110 font-semibold shadow-sm',
    default: 'bg-panel text-txt border border-line hover:border-line2 hover:bg-panel2',
    danger: 'bg-err/10 text-err border border-err/30 hover:bg-err/20',
    ghost: 'text-txt2 hover:text-txt hover:bg-panel2',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// ── Card ───────────────────────────────────────────────────
export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`card-shadow rounded-xl border border-line bg-panel ${className}`}>{children}</div>;
}
export function CardHeader({ title, extra, icon }: { title: React.ReactNode; extra?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-txt">
        {icon && <span className="text-accent">{icon}</span>}
        {title}
      </div>
      {extra}
    </div>
  );
}
export function CardBody({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

// ── 统计卡(H 视觉升级:六色系渐变 icon、大数字、hover 浮起)──
const STAT_TONES: Record<string, { grad: string; num: string }> = {
  // 同色系深浅渐变(单色 500→600):统一克制,避免跨色打架
  brand:  { grad: 'from-teal-500 to-teal-600',      num: 'text-accent' },
  sky:    { grad: 'from-sky-500 to-sky-600',         num: 'text-brand2' },
  violet: { grad: 'from-violet-500 to-violet-600',   num: 'text-violet' },
  rose:   { grad: 'from-rose-400 to-rose-500',       num: 'text-rose' },
  amber:  { grad: 'from-amber-400 to-amber-500',     num: 'text-warn' },
  ok:     { grad: 'from-emerald-500 to-emerald-600', num: 'text-ok' },
};
export function StatCard({ label, value, unit, icon, tone = 'brand', status, sub }: {
  label: string; value: React.ReactNode; unit?: string; icon?: React.ReactNode;
  tone?: 'brand' | 'sky' | 'violet' | 'rose' | 'amber' | 'ok';
  status?: 'ok' | 'warn' | 'err';
  sub?: React.ReactNode; // 数值下方的补充说明行(两个页面共用的扩展)
}) {
  const t = STAT_TONES[tone] ?? STAT_TONES.brand;
  const statusColor = status === 'warn' ? 'text-warn' : status === 'err' ? 'text-err' : status === 'ok' ? 'text-ok' : '';
  return (
    <Card className="group flex items-center gap-4 px-4 py-4 transition-transform duration-200 hover:-translate-y-0.5">
      {icon && (
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${t.grad} text-white shadow-sm`}>
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-txt2">{label}</span>
          {unit && <span className="shrink-0 text-[10px] text-txt3">{unit}</span>}
        </div>
        <div className={`tnum truncate text-[22px] font-bold leading-7 tracking-tight ${statusColor || t.num}`}>
          {value}
        </div>
        {sub && <div className="tnum mt-0.5 truncate text-[11px] text-txt3">{sub}</div>}
      </div>
    </Card>
  );
}

// ── Badge ──────────────────────────────────────────────────
export function Badge({ kind = 'default', children }: { kind?: 'default' | 'ok' | 'warn' | 'err' | 'accent'; children: React.ReactNode }) {
  const kinds = {
    default: 'bg-panel2 text-txt2 border-line2',
    ok: 'bg-ok/10 text-ok border-ok/25',
    warn: 'bg-warn/10 text-warn border-warn/25',
    err: 'bg-err/10 text-err border-err/25',
    accent: 'bg-accent-dim text-accent border-accent/25',
  };
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${kinds[kind]}`}>{children}</span>;
}

// ── Table ─────────────────────────────────────────────────
export function Table({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}
export function Th({ className = '', children }: { className?: string; children?: React.ReactNode }) {
  return <th className={`whitespace-nowrap border-b border-line px-3 py-2.5 text-xs font-medium text-txt2 ${className}`}>{children}</th>;
}
export function Td({ className = '', children }: { className?: string; children?: React.ReactNode }) {
  return <td className={`border-b border-line/50 px-3 py-2.5 align-middle ${className}`}>{children}</td>;
}

// ── Pagination(日志/总览最近请求共用;服务端或前端切片分页) ──
// 页码窗口:总页数 ≤7 全显;否则始终含首尾页,当前页±1,余下用省略号折叠。
function pageWindow(current: number, totalPages: number): (number | '…l' | '…r')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const out: (number | '…l' | '…r')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);
  if (start > 2) out.push('…l');
  for (let p = start; p <= end; p++) out.push(p);
  if (end < totalPages - 1) out.push('…r');
  out.push(totalPages);
  return out;
}
export function Pagination({ page, total, pageSize, onChange, unit = '条' }: {
  page: number; total: number; pageSize: number; onChange: (p: number) => void; unit?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const nums = pageWindow(page, totalPages);
  const btn = (label: React.ReactNode, target: number, disabled: boolean, key: string) => (
    <button key={key} onClick={() => !disabled && onChange(target)} disabled={disabled}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-xs transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 ${
        disabled ? 'text-txt3' : 'text-txt2 hover:bg-panel2 hover:text-txt'}`}>
      {label}
    </button>
  );
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
      <span className="tnum text-xs text-txt3">共 {fmtInt(total)} {unit} · 第 {page} / {totalPages} 页</span>
      <div className="flex items-center gap-0.5">
        {btn('‹', page - 1, page <= 1, 'prev')}
        {nums.map(n => n === '…l' || n === '…r'
          ? <span key={n} className="px-1 text-xs text-txt3">…</span>
          : <button key={n} onClick={() => onChange(n)}
              className={`h-7 min-w-7 rounded-md px-2 text-xs transition-all duration-150 active:scale-95 ${
                n === page ? 'bg-accent-dim font-semibold text-accent' : 'text-txt2 hover:bg-panel2 hover:text-txt'}`}>
              {n}
            </button>)}
        {btn('›', page + 1, page >= totalPages, 'next')}
      </div>
    </div>
  );
}

// ── Input / Select ────────────────────────────────────────
export const inputCls = 'h-9 w-full rounded-md border border-line bg-bg px-3 text-sm text-txt placeholder:text-txt3 focus:border-accent/60 outline-none transition-colors';
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-medium text-txt2">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-txt3">{hint}</div>}
    </label>
  );
}

// ── Tabs ───────────────────────────────────────────────────
export function Tabs({ items, value, onChange }: { items: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 rounded-lg border border-line bg-panel p-1">
      {items.map(it => (
        <button key={it.id} onClick={() => onChange(it.id)}
          className={`min-h-[26px] rounded-md px-3 py-1.5 text-sm transition-all duration-150 active:scale-[0.96] ${value === it.id ? 'bg-accent-dim font-medium text-accent' : 'text-txt2 hover:bg-panel2 hover:text-txt'}`}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── Dialog ─────────────────────────────────────────────────
export function Dialog({ open, title, onClose, children, footer, width = 'max-w-md' }: {
  open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 anim-pop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`card-shadow anim-pop w-full ${width} rounded-xl border border-line bg-panel`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-semibold text-txt">{title}</div>
          <button onClick={onClose} className="rounded p-1 text-txt3 transition-all duration-150 hover:bg-panel2 hover:text-txt active:scale-90"><X size={16} /></button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ── Toast ──────────────────────────────────────────────────
type ToastItem = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
let toastSeq = 0;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toastItems: ToastItem[] = [];
function emitToasts() { toastListeners.forEach(f => f([...toastItems])); }
export function toast(kind: ToastItem['kind'], text: string) {
  const item = { id: ++toastSeq, kind, text };
  toastItems = [...toastItems, item];
  emitToasts();
  setTimeout(() => { toastItems = toastItems.filter(t => t.id !== item.id); emitToasts(); }, 3500);
}
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => { toastListeners.delete(setItems); };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-2">
      {items.map(t => (
        <div key={t.id} className={`anim-up pointer-events-auto rounded-lg border px-4 py-2.5 text-sm shadow-xl backdrop-blur ${
          t.kind === 'ok' ? 'border-ok/30 bg-panel text-ok' : t.kind === 'err' ? 'border-err/30 bg-panel text-err' : 'border-line2 bg-panel text-txt'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ── 空态 / 骨架屏 / 居中加载 ───────────────────────────────
export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="text-txt3">{icon ?? '·'}</div>
      <div className="text-sm font-medium text-txt2">{title}</div>
      {hint && <div className="max-w-sm text-xs text-txt3">{hint}</div>}
    </div>
  );
}
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}
export function Loading({ children = '加载中…' }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-txt3">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line2 border-t-accent" />
      {children}
    </div>
  );
}

// ── EChart 封装(自动 resize + dispose;echarts 本体异步加载) ──
const EChartReal = lazy(() => import('./echart'));
export function EChart({ option, className = 'h-64' }: { option: ChartOption; className?: string }) {
  // chunk 加载期间用与图表同尺寸的骨架占位,避免布局跳动
  return (
    <Suspense fallback={<div className={`skeleton ${className}`} />}>
      <EChartReal option={option} className={className} />
    </Suspense>
  );
}

/** 柱状图垂直渐变填充(上亮下沉,大气感)。纯对象字面量,echarts 直接识别。 */
export function vgrad(top: string, bottom: string) {
  return {
    type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: top },
      { offset: 1, color: bottom },
    ],
  };
}

// ECharts 基础配置:随当前主题生成(颜色取设计 token,图表与界面一致)
export function echartsBase() {
  const dark = getTheme() === 'dark';
  return {
    backgroundColor: 'transparent',
    textStyle: { color: themeColor('--color-txt2'), fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace' },
    grid: { top: 36, right: 16, bottom: 28, left: 52 },
    tooltip: {
      backgroundColor: themeColor('--color-panel'),
      borderColor: themeColor('--color-line2'),
      textStyle: { color: themeColor('--color-txt'), fontSize: 12 },
      trigger: 'axis' as const,
      extraCssText: dark ? '' : 'box-shadow: 0 4px 16px rgba(23,32,48,0.12);',
    },
  };
}

// ── 工具函数 ───────────────────────────────────────────────
export function fmtInt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('zh-Hans-CN');
}
export function fmtK(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}
export function fmtMs(n: number | null | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-Hans-CN', { hour12: false });
}
export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return '从未';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 剪贴板写入:优先 Clipboard API,非安全上下文(HTTP/局域网 IP 访问)降级 execCommand
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
