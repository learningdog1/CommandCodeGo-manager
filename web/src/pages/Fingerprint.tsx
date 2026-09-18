// 设备指纹页:展示「伪造了什么、上报结果如何」——让指纹模拟这件事在界面上可见、可验证。
// 数据来自运行时内存(keystate),进程重启后重建;只含启动后使用过的上游密钥。
import { useCallback, useEffect, useState } from 'react';
import { Fingerprint as FingerprintIcon, RefreshCw } from 'lucide-react';
import { fetchFingerprints, type FingerprintsInfo, type FingerprintKeyRow, type FingerprintReport } from '../api';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Loading, toast, fmtTime } from '../ui';

// 哈希只显前 12 位,完整值放 title 悬浮
const shortHash = (h: string | null) => (h ? `${h.slice(0, 12)}…` : '—');

function ReportStatus({ label, report, nextInitAt }: { label: string; report: FingerprintReport | null; nextInitAt: number | null }) {
  if (!report) {
    return (
      <span className="text-xs text-txt3">
        {label}:未上报{nextInitAt === null ? '(首次请求时触发)' : ''}
      </span>
    );
  }
  const outcome = report.ok
    ? '成功'
    : `失败${report.status ? ` (HTTP ${report.status})` : ''}${report.error ? ` · ${report.error}` : ''}`;
  return (
    <span className={`text-xs ${report.ok ? 'text-ok' : 'text-err'}`} title={report.error ?? undefined}>
      {label}:{outcome} · {fmtTime(report.ts)}
    </span>
  );
}

function KeyCard({ k }: { k: FingerprintKeyRow }) {
  const reported = k.fingerprintReport?.ok === true && k.lifecycleReport?.ok === true;
  const failed = k.fingerprintReport?.ok === false || k.lifecycleReport?.ok === false;
  return (
    <Card>
      <CardHeader
        title={<span className="font-mono">{k.keyPrefix}…</span>}
        icon={<FingerprintIcon size={15} />}
        extra={
          failed ? <Badge kind="err">上报失败</Badge>
          : reported ? <Badge kind="ok">已上报</Badge>
          : <Badge kind="default">待首次上报</Badge>
        }
      />
      <CardBody>
        {/* 伪造的设备形态(上游看到的"这台机器") */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
          <div><span className="text-txt3">CPU</span><div className="text-txt">{k.cpuModel ?? '—'}</div></div>
          <div><span className="text-txt3">核心 / 内存</span><div className="tnum text-txt">{k.cpuCount ?? '—'} 核 / {k.memGiB ?? '—'} GB</div></div>
          <div><span className="text-txt3">时区</span><div className="text-txt">{k.timezone ?? '—'}</div></div>
          <div><span className="text-txt3">网卡 MAC</span><div className="tnum text-txt">{k.macCount} 个(去重排序)</div></div>
          <div><span className="text-txt3">指纹生成于</span><div className="text-txt">{k.createdAt ? fmtTime(k.createdAt) : '—'}</div></div>
          <div><span className="text-txt3">下次刷新</span><div className="text-txt">{k.nextInitAt ? fmtTime(k.nextInitAt) : '首次请求时'}</div></div>
        </div>
        {/* 上游可核对的哈希(与官方 CLI 同盐同算法) */}
        <div className="mt-3 space-y-1 border-t border-line pt-3 font-mono text-[11px] text-txt2">
          <div className="truncate" title={k.thumbmark ?? undefined}>thumbmark <span className="text-txt">{shortHash(k.thumbmark)}</span></div>
          <div className="truncate" title={k.machineIdHash ?? undefined}>machineId <span className="text-txt">{shortHash(k.machineIdHash)}</span></div>
          <div className="truncate" title={k.hostnameHash ?? undefined}>hostname <span className="text-txt">{shortHash(k.hostnameHash)}</span></div>
          <div className="truncate" title={k.gitEmailHash ?? undefined}>gitEmail <span className="text-txt">{shortHash(k.gitEmailHash)}</span></div>
        </div>
        <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
          <ReportStatus label="指纹上报" report={k.fingerprintReport} nextInitAt={k.nextInitAt} />
          <ReportStatus label="生命周期事件" report={k.lifecycleReport} nextInitAt={k.nextInitAt} />
        </div>
      </CardBody>
    </Card>
  );
}

export function Fingerprint() {
  const [info, setInfo] = useState<FingerprintsInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // silent=true 供 30s 后台轮询:不驱动按钮转圈、失败不弹 toast(只静默保数据新鲜)
  const load = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      setInfo(await fetchFingerprints());
    } catch (e) {
      if (!silent) toast('err', `加载指纹状态失败:${(e as Error).message}`);
    } finally {
      if (!silent) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 30_000); // 状态轻量,30s 轮询足够"活"
    return () => clearInterval(timer);
  }, [load]);

  if (!info) return <Card><Loading>加载指纹状态…</Loading></Card>;

  const { profile, keys } = info;

  return (
    <div className="space-y-5">
      {/* ── 机制说明 ── */}
      <Card>
        <CardBody>
          <p className="text-[13px] leading-relaxed text-txt2">
            本代理为每个上游密钥<b className="text-txt">确定性伪造一台 Windows 设备身份</b>(CPU / 内存 / 时区 / MAC / MachineGuid / 主机名 / git 邮箱),
            按 8h±2h 周期上报指纹与生命周期事件,并在每次生成请求中携带同一份设备档案。
            同一密钥重启、多实例、停用数周后恢复,上游看到的始终是同一台设备;<b className="text-txt">宿主机的真实平台、Node 版本与工作目录不会透出</b>。
            哈希算法与官方 CLI 逐字对齐(同盐 <code className="rounded bg-panel2 px-1 font-mono text-[11px]">command-code:device-fingerprint:v1</code>)。
          </p>
        </CardBody>
      </Card>

      {/* ── 全局设备档案 ── */}
      <Card>
        <CardHeader title="统一设备档案" icon={<FingerprintIcon size={15} />}
          extra={<Badge kind="accent">{keys.length} 个密钥在用</Badge>} />
        <CardBody>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
            <div><span className="text-txt3">平台</span><div className="text-txt">{profile.platform} / {profile.arch}</div></div>
            <div><span className="text-txt3">系统版本</span><div className="text-txt">{profile.osRelease}</div></div>
            <div><span className="text-txt3">伪造项目目录</span><div className="truncate font-mono text-[11px] text-txt" title={profile.projectDir}>{profile.projectDir}</div></div>
            <div><span className="text-txt3">x-project-slug</span><div className="font-mono text-[11px] text-txt">{profile.projectSlug}</div></div>
            <div><span className="text-txt3">上报周期</span><div className="text-txt">{profile.refreshEvery}</div></div>
            <div><span className="text-txt3">指纹盐 (CC_FINGERPRINT_SALT)</span><div>{profile.fingerprintSalt ? <Badge kind="ok">已配置</Badge> : <Badge kind="default">默认</Badge>}</div></div>
          </div>
        </CardBody>
      </Card>

      {/* ── 每密钥指纹 ── */}
      <div className="flex items-center gap-3">
        <Button onClick={() => void load()} loading={busy}><RefreshCw size={14} />刷新</Button>
        <span className="text-xs text-txt3">指纹状态为运行时数据,进程重启后按需重建;仅显示启动后使用过的密钥</span>
      </div>
      {keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FingerprintIcon size={36} />}
            title="暂无指纹状态"
            hint="还没有上游密钥在本进程内被使用。客户端发起第一次请求后,此处会显示为对应密钥伪造的设备。"
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {keys.map(k => <KeyCard key={k.keyPrefix} k={k} />)}
        </div>
      )}
    </div>
  );
}
