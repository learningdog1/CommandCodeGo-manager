// 设置(Phase 3.4):config 分组编辑(服务/上游/日志/安全)+ admin token 轮换 + 只读环境信息卡。
// 数字字段在表单里保留字符串,保存时再解析;校验不通过禁用保存。
import { useEffect, useMemo, useState } from 'react';
import { fetchSettings, putSettings, type Settings } from '../api';
import {
  Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Loading, Select, toast,
} from '../ui';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const ENV_KNOBS = [
  'CC_MAX_BODY_MB',
  'CC_MAX_INFLIGHT',
  'CC_STREAM_IDLE_MS',
  'CC_NONSTREAM_IDLE_MS',
  'CC_CLIENT_DRAIN_TIMEOUT_MS',
];

// 表单态:数字字段用字符串承载中间输入
interface FormState {
  port: string; host: string; apiBase: string; projectSlug: string;
  zdr: boolean; useProviderModels: boolean; modelRefreshIntervalMs: string;
  accountUsageRefreshMs: string;
  logLevel: string; logFile: string; logRetentionDays: string;
  allowDirectUpstreamKey: boolean;
}

// 开关:Button variant 切换样式自实现
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Button type="button" size="sm" variant={on ? 'primary' : 'default'} onClick={() => onChange(!on)}>
      {on ? '已开启' : '已关闭'}
    </Button>
  );
}

// 开关行:左侧说明 + 右侧开关
function ToggleRow({ title, hint, on, onChange }: {
  title: string; hint?: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-txt">{title}</div>
        {hint && <div className="mt-0.5 text-xs text-txt3">{hint}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

// 信息卡键值行
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/50 py-2.5 text-sm last:border-b-0 last:pb-0">
      <span className="shrink-0 text-txt2">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export function Settings() {
  const [form, setForm] = useState<FormState | null>(null); // null = 加载中
  const [loadErr, setLoadErr] = useState('');
  const [info, setInfo] = useState<{ dataDir?: string }>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchSettings();
        if (!alive) return;
        setInfo({ dataDir: s.dataDir });
        setForm({
          port: s.port != null ? String(s.port) : '',
          host: s.host ?? '',
          apiBase: s.apiBase ?? '',
          projectSlug: s.projectSlug ?? '',
          zdr: !!s.zdr,
          useProviderModels: !!s.useProviderModels,
          modelRefreshIntervalMs: s.modelRefreshIntervalMs != null ? String(s.modelRefreshIntervalMs) : '',
          accountUsageRefreshMs: s.accountUsageRefreshMs != null ? String(s.accountUsageRefreshMs) : '',
          logLevel: LOG_LEVELS.includes(s.logLevel ?? '') ? (s.logLevel as string) : 'info',
          logFile: s.logFile ?? '',
          logRetentionDays: s.logRetentionDays != null ? String(s.logRetentionDays) : '',
          allowDirectUpstreamKey: !!s.allowDirectUpstreamKey,
        });
      } catch (e) {
        if (alive) {
          setLoadErr((e as Error).message || '加载失败');
          toast('err', `加载设置失败:${(e as Error).message}`);
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => (f ? { ...f, [k]: v } : f));

  // 校验:port 1-65535、logRetentionDays ≥1;数值键一律要求正整数,避免脏值落盘
  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form) return e;
    if (!/^\d+$/.test(form.port.trim()) || Number(form.port) < 1 || Number(form.port) > 65535) {
      e.port = '端口需为 1-65535 的整数';
    }
    if (!/^\d+$/.test(form.modelRefreshIntervalMs.trim()) || Number(form.modelRefreshIntervalMs) < 1) {
      e.modelRefreshIntervalMs = '需为 ≥1 的整数(毫秒)';
    }
    if (!/^\d+$/.test(form.accountUsageRefreshMs.trim())) {
      e.accountUsageRefreshMs = '需为 ≥0 的整数(毫秒),0 = 关闭';
    }
    if (!/^\d+$/.test(form.logRetentionDays.trim()) || Number(form.logRetentionDays) < 1) {
      e.logRetentionDays = '需为 ≥1 的整数(天)';
    }
    return e;
  }, [form]);
  const hasErrors = Object.keys(errors).length > 0;

  const save = async () => {
    if (!form || hasErrors || saving) return;
    setSaving(true);
    try {
      // 空字符串的文本键不写入 patch,避免把占位空值烤进配置文件
      const patch: Partial<Settings> = {
        port: Number(form.port.trim()),
        zdr: form.zdr,
        useProviderModels: form.useProviderModels,
        modelRefreshIntervalMs: Number(form.modelRefreshIntervalMs.trim()),
        accountUsageRefreshMs: Number(form.accountUsageRefreshMs.trim()),
        logLevel: form.logLevel,
        logRetentionDays: Number(form.logRetentionDays.trim()),
        allowDirectUpstreamKey: form.allowDirectUpstreamKey,
      };
      if (form.host.trim()) patch.host = form.host.trim();
      if (form.apiBase.trim()) patch.apiBase = form.apiBase.trim();
      if (form.projectSlug.trim()) patch.projectSlug = form.projectSlug.trim();
      if (form.logFile.trim()) patch.logFile = form.logFile.trim();
      await putSettings(patch);
      toast('ok', '已保存,重启服务后生效');
    } catch (e) {
      toast('err', `保存失败:${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };



  if (!form) {
    return loadErr
      ? <Card><CardBody className="p-4 text-sm text-err">加载设置失败:{loadErr}</CardBody></Card>
      : <Loading>加载设置…</Loading>;
  }

  const fieldErr = (k: keyof FormState) =>
    errors[k] ? <div className="mt-1 text-xs text-err">{errors[k]}</div> : null;

  return (
    <div className="space-y-5">
      {/* ── 顶部操作条 ── */}
      <div className="flex items-center gap-3">
        {hasErrors && <span className="text-xs text-err">部分配置不合法,修正后才能保存</span>}
        <div className="ml-auto">
          <Button variant="primary" loading={saving} disabled={hasErrors} onClick={() => void save()}>保存</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 服务 ── */}
        <Card>
          <CardHeader title="服务" extra={<span className="text-xs text-txt3">重启后生效</span>} />
          <CardBody className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="端口">
              <Input type="number" inputMode="numeric" value={form.port}
                onChange={e => set('port', e.target.value)} className="tnum" />
              {fieldErr('port')}
            </Field>
            <Field label="监听地址" hint="默认 127.0.0.1,仅本机访问">
              <Input value={form.host} onChange={e => set('host', e.target.value)}
                placeholder="127.0.0.1" className="tnum" />
            </Field>
          </CardBody>
        </Card>

        {/* ── 上游 ── */}
        <Card>
          <CardHeader title="上游" extra={<span className="text-xs text-txt3">重启后生效</span>} />
          <CardBody className="space-y-1 p-4">
            <div className="grid gap-4 pb-2 sm:grid-cols-2">
              <Field label="API Base">
                <Input value={form.apiBase} onChange={e => set('apiBase', e.target.value)}
                  placeholder="https://api.commandcode.ai" className="tnum text-xs" />
              </Field>
              <Field label="Project Slug">
                <Input value={form.projectSlug} onChange={e => set('projectSlug', e.target.value)}
                  className="tnum text-xs" />
              </Field>
              <Field label="模型刷新间隔(毫秒)">
                <Input type="number" inputMode="numeric" value={form.modelRefreshIntervalMs}
                  onChange={e => set('modelRefreshIntervalMs', e.target.value)} className="tnum" />
                {fieldErr('modelRefreshIntervalMs')}
              </Field>
              <Field label="账号用量刷新间隔(毫秒)" hint="账号面板自动刷新;0 = 关闭,保存后即时生效">
                <Input type="number" inputMode="numeric" value={form.accountUsageRefreshMs}
                  onChange={e => set('accountUsageRefreshMs', e.target.value)} className="tnum" />
                {fieldErr('accountUsageRefreshMs')}
              </Field>
            </div>
            <ToggleRow title="零数据保留(ZDR)" hint="开启后上游不保留请求数据"
              on={form.zdr} onChange={v => set('zdr', v)} />
            <ToggleRow title="使用上游模型列表" hint="关闭则使用内置模型清单"
              on={form.useProviderModels} onChange={v => set('useProviderModels', v)} />
          </CardBody>
        </Card>

        {/* ── 日志与保留 ── */}
        <Card>
          <CardHeader title="日志与保留" extra={<span className="text-xs text-txt3">重启后生效</span>} />
          <CardBody className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="日志级别">
              <Select value={form.logLevel} onChange={e => set('logLevel', e.target.value)}>
                {LOG_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </Select>
            </Field>
            <Field label="日志文件" hint="留空则仅输出到控制台">
              <Input value={form.logFile} onChange={e => set('logFile', e.target.value)}
                placeholder="留空 = 不写文件" className="tnum text-xs" />
            </Field>
            <Field label="日志保留天数">
              <Input type="number" inputMode="numeric" value={form.logRetentionDays}
                onChange={e => set('logRetentionDays', e.target.value)} className="tnum" />
              {fieldErr('logRetentionDays')}
            </Field>
          </CardBody>
        </Card>

        {/* ── 安全 ── */}
        <Card>
          <CardHeader title="安全" extra={<span className="text-xs text-txt3">重启后生效</span>} />
          <CardBody className="p-4">
            <ToggleRow title="允许 user_* 上游密钥直通" hint="关闭后 user_* 直通失效,只认客户端密钥(sk-ccp-*)"
              on={form.allowDirectUpstreamKey} onChange={v => set('allowDirectUpstreamKey', v)} />
          </CardBody>
        </Card>

        {/* ── 运行环境信息(只读) ── */}
        <Card>
          <CardHeader title="运行环境信息" extra={<span className="text-xs text-txt3">只读</span>} />
          <CardBody className="p-4">
            <KV label="数据目录"><span className="tnum break-all text-xs">{info.dataDir ?? '—'}</span></KV>
            <div className="pt-2.5">
              <div className="mb-1.5 text-xs text-txt2">环境变量旋钮(需以环境变量设置后重启生效,不写入配置文件)</div>
              <div className="flex flex-wrap gap-1.5">
                {ENV_KNOBS.map(k => (
                  <span key={k} className="tnum rounded border border-line bg-bg px-1.5 py-0.5 text-[11px] text-txt2">{k}</span>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
