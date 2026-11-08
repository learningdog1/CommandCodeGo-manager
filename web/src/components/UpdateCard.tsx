// 「软件更新」卡(issue #11):仅在 Electron 桌面版注入 window.ccpDesktop 时渲染。
// 流程:检查更新 → 有新版先看更新说明 → 手动「下载更新」(sha256 校验)→
// 「重启以更新」才真正替换程序文件;绝不静默重启(服务可能正替客户端跑请求)。
import { useEffect, useState } from 'react';
import { desktop, type DesktopUpdateState } from '../desktop';
import { Badge, Button, Card, CardBody, CardHeader, toast } from '../ui';

function fmtMB(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-panel2">
      <div className="brand-gradient h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function UpdateCard() {
  const [st, setSt] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  // setState 由主进程推送(自动轮询也会推进状态),本地订阅合并
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    desktop.getUpdateState().then(s => { if (alive) setSt(s); }).catch(() => {});
    const off = desktop.onUpdateState(s => {
      setSt(s);
      if (s.updatedTo) toast('ok', `已成功更新到 v${s.updatedTo}`);
    });
    return () => { alive = false; off(); };
  }, []);

  if (!desktop) return null;
  // 闭包里引用模块常量不会被 TS 收窄,先落到局部
  const d = desktop;
  const call = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { toast('err', (e as Error).message || '操作失败'); }
    finally { setBusy(false); }
  };

  const status = st?.status ?? 'idle';
  const hasNew = ['available', 'downloading', 'ready'].includes(status);
  const asset = st?.asset ?? null;

  return (
    <Card>
      <CardHeader title="软件更新" extra={<span className="text-xs text-txt3">桌面版 · 检查/下载均需确认,不会自动重启</span>} />
      <CardBody className="p-4">
        {/* 版本行 */}
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
          <span className="text-txt2">当前版本 <span className="tnum font-semibold text-txt">v{st?.currentVersion ?? '…'}</span></span>
          <span className="text-txt2">最新版本{' '}
            {status === 'checking' ? <span className="text-txt3">检查中…</span>
              : st?.latestVersion ? <span className={`tnum font-semibold ${hasNew ? 'text-accent' : 'text-ok'}`}>v{st.latestVersion}</span>
                : <span className="text-txt3">尚未检查</span>}
          </span>
          {status === 'uptodate' && <Badge kind="ok">已是最新</Badge>}
        </div>

        {/* 更新说明(有新版时) */}
        {hasNew && st?.notes && (
          <div className="mb-3 max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-bg px-3 py-2.5 text-xs leading-relaxed text-txt2">
            {st.notes}
          </div>
        )}

        {/* 下载中:进度条 */}
        {status === 'downloading' && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between text-xs text-txt2">
              <span className="tnum truncate">{asset?.name}</span>
              <span className="tnum">{Math.round((st?.progress ?? 0) * 100)}%</span>
            </div>
            <ProgressBar value={st?.progress ?? 0} />
          </div>
        )}

        {/* 就绪:按平台给动作 */}
        {status === 'ready' && (
          <div className="mb-3 rounded-lg border border-accent/30 bg-accent-dim px-3 py-2.5 text-xs leading-relaxed text-txt">
            {st?.canSelfUpdate
              ? '新版本已下载并通过校验。点击「重启以更新」后会退出应用完成替换并自动重启,请确认当前没有正在进行的请求。'
              : '更新包已下载并通过校验。macOS 应用未签名,不支持自动替换:请在 Finder 中查看下载好的包,手动替换现有 .app 后重新打开。'}
            {asset && !asset.digest && <div className="mt-1 text-warn">该资产未提供 sha256 摘要,已跳过完整性校验。</div>}
          </div>
        )}

        {/* 错误(手动检查/下载) */}
        {st?.error && <div className="mb-3 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs text-err">{st.error}</div>}

        {/* 动作区 */}
        <div className="flex flex-wrap items-center gap-2">
          {(status === 'idle' || status === 'uptodate' || status === 'checking') && (
            <Button size="sm" loading={busy || status === 'checking'} onClick={call(() => d.checkUpdate())}>检查更新</Button>
          )}
          {status === 'available' && (asset?.url
            ? <>
              <Button size="sm" variant="primary" loading={busy} onClick={call(() => d.downloadUpdate())}>
                下载更新{asset.size ? `(${fmtMB(asset.size)})` : ''}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void d.openReleasePage()}>查看发布页</Button>
              {asset && !asset.digest && <span className="text-xs text-warn">该资产未提供 sha256,下载后将跳过校验</span>}
            </>
            : <>
              <Button size="sm" variant="primary" onClick={() => void d.openReleasePage()}>该版本未提供本平台更新包,前往发布页</Button>
            </>)}
          {status === 'downloading' && <span className="text-xs text-txt3">正在下载,可稍候…</span>}
          {status === 'ready' && (st?.canSelfUpdate
            ? <>
              <Button size="sm" variant="primary" onClick={() => void d.applyUpdate()}>重启以更新</Button>
              <Button size="sm" variant="ghost" onClick={() => void d.openReleasePage()}>稍后再说</Button>
            </>
            : <>
              <Button size="sm" variant="primary" onClick={() => void d.revealDownload()}>在 Finder 中显示</Button>
              <Button size="sm" variant="ghost" onClick={() => void d.openReleasePage()}>查看发布页</Button>
            </>)}
          {status === 'applying' && <span className="text-xs text-txt2">正在退出并应用更新,应用将自动重启…</span>}
        </div>
      </CardBody>
    </Card>
  );
}
