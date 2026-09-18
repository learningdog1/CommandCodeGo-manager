// 密钥管理(Phase 3.4):上游密钥(user_* 订阅密钥)与客户端密钥(sk-ccp-*)双 Tab,
// 覆盖 CRUD、探活、启停切换与创建结果的一次性 token 展示。
import { useCallback, useEffect, useState } from 'react';
import { Repeat, Terminal } from 'lucide-react';
import { ApiError, api, batchImportUpstreamKeys, fetchClientKeys, fetchUpstreamKeys, type ClientKey, type UpstreamKey } from '../api';
import {
  Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Loading, Select,
  Table, Tabs, Td, Th, inputCls, toast, fmtAgo, fmtTime,
} from '../ui';

// 与后端同款校验:/^user_[a-zA-Z0-9_-]+$/
const USER_KEY_RE = /^user_[a-zA-Z0-9_-]+$/;

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge kind="ok">启用</Badge>;
  if (status === 'exhausted') return <Badge kind="warn">额度耗尽</Badge>;
  return <Badge>停用</Badge>;
}

// 剪贴板写入(非安全上下文降级 execCommand)
async function copyText(text: string): Promise<boolean> {
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

// ── 上游密钥 Tab ───────────────────────────────────────────
function UpstreamPanel({ rows, clients, reload }: {
  rows: UpstreamKey[] | null; clients: ClientKey[] | null; reload: () => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // 批量导入(多账户免 CLI 退出重登:Studio 复制密钥,一行一个粘贴)
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [delTarget, setDelTarget] = useState<UpstreamKey | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  // Command Code CLI 登录检测(Go 订阅推荐路径:cmd login 后一键导入)
  const [cli, setCli] = useState<{ installed: boolean; keyMask: string | null; path: string } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api<{ installed: boolean; keyMask: string | null; path: string }>('/admin/api/cc-cli')
      .then(setCli)
      .catch(() => setCli(null));
  }, []);

  const importCli = async () => {
    setImporting(true);
    try {
      const r = await api<{ existing?: boolean; id: number; name?: string }>('/admin/api/cc-cli/import', { method: 'POST' });
      toast('ok', r.existing
        ? `该 CLI 密钥已导入过(「${r.name ?? '已存在'}」)`
        : `已导入账户「${r.name ?? 'CommandCode 账户'}」(名称取自 commandcode 账户名)`);
      await reload();
    } catch (err) {
      toast('err', `导入失败:${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const keyValid = USER_KEY_RE.test(apiKey.trim());

  const openAdd = () => { setName(''); setApiKey(''); setAddOpen(true); };

  const submitBatch = async () => {
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const r = await batchImportUpstreamKeys(batchText);
      const names = r.created.map(c => c.name).join('、');
      toast('ok', `批量导入完成:新建 ${r.created.length} 个账户${names ? `(${names})` : ''}`
        + (r.existing.length ? `,已存在跳过 ${r.existing.length} 个` : '')
        + (r.unmatchedLines > 0 ? `,${r.unmatchedLines} 行未识别已忽略` : ''));
      setBatchOpen(false);
      setBatchText('');
      await reload();
    } catch (err) {
      toast('err', `批量导入失败:${(err as Error).message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !keyValid || busy) return;
    setBusy(true);
    try {
      await api('/admin/api/upstream-keys', { method: 'POST', body: { name: name.trim(), apiKey: apiKey.trim() } });
      toast('ok', '上游密钥已添加');
      setAddOpen(false);
      await reload();
    } catch (err) {
      toast('err', `添加失败:${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (k: UpstreamKey) => {
    const next = k.status === 'active' ? 'disabled' : 'active';
    setTogglingId(k.id);
    try {
      await api(`/admin/api/upstream-keys/${k.id}`, { method: 'PUT', body: { status: next } });
      toast('ok', next === 'active' ? '已启用' : '已停用');
      await reload();
    } catch (err) {
      toast('err', `操作失败:${(err as Error).message}`);
    } finally {
      setTogglingId(null);
    }
  };

  const testKey = async (k: UpstreamKey) => {
    setTestingId(k.id);
    try {
      const r = await api<{ ok: boolean; status?: number; models?: number | null; error?: string }>(
        `/admin/api/upstream-keys/${k.id}/test`, { method: 'POST' });
      if (r.ok) toast('ok', `探活成功:HTTP ${r.status}${r.models != null ? `,可用模型 ${r.models} 个` : ''}`);
      else toast('err', `探活失败:${r.error ?? `HTTP ${r.status ?? '?'}`}`);
    } catch (err) {
      toast('err', `探活失败:${(err as Error).message}`);
    } finally {
      setTestingId(null);
    }
  };

  const submitDelete = async () => {
    if (!delTarget || delBusy) return;
    setDelBusy(true);
    setDelErr('');
    try {
      await api(`/admin/api/upstream-keys/${delTarget.id}`, { method: 'DELETE' });
      toast('ok', `已删除「${delTarget.name}」`);
      setDelTarget(null);
      await reload();
    } catch (err) {
      const ae = err as ApiError;
      if (ae.status === 409) {
        // 409 {error:'bound_client_keys', bound:N} —— 优先取服务端返回的 bound;
        // 响应体缺失再从本地客户端列表数,列表也没加载成功时不要编造 "0 个"
        const bound = typeof (ae.body as { bound?: number } | undefined)?.bound === 'number'
          ? (ae.body as { bound: number }).bound
          : clients?.filter(c => c.upstream_key_id === delTarget.id).length ?? null;
        setDelErr(bound == null
          ? '该密钥仍绑定着客户端密钥,请先解绑(或改绑)后再删除。'
          : `该密钥仍绑定着 ${bound} 个客户端密钥,请先解绑后再删除。`);
      } else {
        setDelErr(ae.message || '删除失败');
      }
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <>
      {/* 多账户与自动轮转说明(H5:功能显性化,单账户时也可见) */}
      <Card className="px-4 py-3.5">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-xs leading-relaxed text-txt2">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-txt">
            <Repeat size={15} className="text-accent" />多账户与额度轮转
          </div>
          <div className="min-w-56 flex-1">
            <span className="text-txt">加账户:</span>点「批量导入」,把各账号的 user_* 密钥一行一个粘贴进来
            (网页后台 → API keys 复制,名称自动取账户名);也可用 CLI 登录后「一键导入」
          </div>
          <div className="min-w-56 flex-1">
            <span className="text-txt">自动轮转:</span>harness 用客户端密钥(sk-ccp-*)接入时,绑定账户额度耗尽(402)自动切换其他启用账户并当场重试;耗尽的标记为黄色,额度重置后点「重新启用」
          </div>
        </div>
        {rows && rows.length > 0 && (
          <div className="mt-2 border-t border-line pt-2 text-xs text-txt3">
            当前:{rows.filter(k => k.status === 'active').length} 枚启用 · {rows.filter(k => k.status === 'exhausted').length} 枚额度耗尽 · {rows.filter(k => k.status === 'disabled').length} 枚停用
            {rows.filter(k => k.status === 'active').length < 2 && <span className="ml-2 text-warn">仅 1 枚启用中的账户,无轮转余量——多导入一枚订阅即可在额度耗尽时无缝切换</span>}
          </div>
        )}
      </Card>

      {/* CLI 登录一键导入(Go 订阅推荐路径;切换账号后可重复导入,叠加多账户) */}
      {cli?.installed && (
        <Card className="flex flex-wrap items-center gap-3 border-accent/30 bg-accent-dim px-4 py-3">
          <Terminal className="h-5 w-5 shrink-0 text-accent" size={20} />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-txt">检测到 Command Code CLI 登录</span>
            <span className="tnum ml-2 text-xs text-txt2">{cli.keyMask}</span>
            <div className="mt-0.5 text-xs text-txt2">
              导入当前 CLI 登录的账户;要叠加多个账号,用「批量导入」粘贴各账号密钥即可,无需在 CLI 里退出重登
            </div>
          </div>
          <Button variant="primary" loading={importing} onClick={() => void importCli()}>一键导入</Button>
        </Card>
      )}

      <Card>
        <CardHeader title="上游密钥" extra={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setBatchOpen(true)}>批量导入</Button>
            <Button size="sm" variant="primary" onClick={openAdd}>添加上游密钥</Button>
          </div>
        } />
        {!rows ? (
          <Loading>加载上游密钥…</Loading>
        ) : rows.length === 0 ? (
          <EmptyState
            title={cli === null ? '加载中…' : '还没有上游密钥'}
            hint={cli?.installed
              ? '点上方「一键导入」即可使用你的 commandcode 订阅登录。'
              : `未检测到 CLI 登录(服务端检测路径 ${cli?.path ?? '~/.commandcode/auth.json'})。` +
                '本机部署:安装 commandcode 命令行并执行 cmd login,这里会自动检测、一键导入。' +
                '服务器/Docker 部署:检测的是服务端文件系统,在你自己电脑上登录不会被发现——' +
                '把宿主机的 ~/.commandcode 只读挂载进容器(见 README「方式三」)后重启即可,' +
                '或直接点右上角「批量导入」,粘贴 user_* 密钥效果相同。'} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>名称</Th><Th>密钥</Th><Th>状态</Th><Th>创建时间</Th><Th>最近使用</Th><Th className="text-right">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(k => (
                <tr key={k.id} className="transition-colors hover:bg-panel2/60">
                  <Td className="max-w-40 truncate font-medium">{k.name}</Td>
                  <Td className="tnum max-w-56 truncate text-xs text-txt2">{k.api_key}</Td>
                  <Td><StatusBadge status={k.status} /></Td>
                  <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtTime(k.created_at)}</Td>
                  <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtAgo(k.last_used_at)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" loading={testingId === k.id}
                        disabled={k.status !== 'active' || testingId === k.id}
                        title={k.status !== 'active' ? '仅启用状态的密钥可探活' : undefined}
                        onClick={() => void testKey(k)}>探活</Button>
                      <Button size="sm" loading={togglingId === k.id} onClick={() => void toggleStatus(k)}>
                        {k.status === 'active' ? '停用' : k.status === 'exhausted' ? '重新启用' : '启用'}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => { setDelErr(''); setDelTarget(k); }}>删除</Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* 批量导入:多账户一次粘贴,免 CLI 退出重登 */}
      <Dialog open={batchOpen} title="批量导入账户" width="max-w-lg" onClose={() => setBatchOpen(false)}>
        <div className="space-y-3">
          <Field label="密钥列表" hint="一行一枚 user_* 密钥;名称自动取 commandcode 账户名,重复的自动跳过">
            <textarea
              value={batchText}
              onChange={e => setBatchText(e.target.value)}
              placeholder={'user_aaaaaaaaaaaaaaaaaaaa\nuser_bbbbbbbbbbbbbbbbbbbb\nuser_ccccccccccccccccccc'}
              rows={7} autoFocus spellCheck={false}
              className={`${inputCls} h-36 font-mono text-xs`} />
          </Field>
          <div className="rounded-lg border border-line bg-panel2 px-3 py-2 text-xs leading-relaxed text-txt3">
            多账户推荐路径:在 <span className="text-txt2">commandcode.ai 网页后台 → API keys</span> 为每个账号生成 / 复制密钥,
            回到这里一行一个粘贴 —— 无需在 CLI 里退出再登录。也可混贴整段文本,系统会自动提取所有 user_* 密钥。
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setBatchOpen(false)}>取消</Button>
            <Button variant="primary" loading={batchBusy} disabled={!batchText.trim()} onClick={() => void submitBatch()}>
              导入
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 添加上游密钥 */}
      <Dialog open={addOpen} title="添加上游密钥" onClose={() => setAddOpen(false)}>
        <form onSubmit={submitAdd} className="space-y-3.5">
          <Field label="名称">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="如:主力订阅" autoFocus />
          </Field>
          <Field label="密钥" hint="Command Code 订阅密钥,以 user_ 开头">
            <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="user_…" autoComplete="off" className="font-mono text-xs" />
          </Field>
          {apiKey.trim() && !keyValid && (
            <div className="text-xs text-err">密钥格式不正确,需以 user_ 开头,仅含字母、数字、_ 或 -</div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setAddOpen(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !keyValid}>添加</Button>
          </div>
        </form>
      </Dialog>

      {/* 删除二次确认(409 时原地提示解绑) */}
      <Dialog open={delTarget != null} title="删除上游密钥" onClose={() => setDelTarget(null)} footer={
        <>
          <Button onClick={() => setDelTarget(null)}>取消</Button>
          <Button variant="danger" loading={delBusy} onClick={() => void submitDelete()}>确认删除</Button>
        </>
      }>
        <div className="space-y-2.5 text-sm">
          <div className="text-txt">确认删除上游密钥「<span className="font-medium">{delTarget?.name}</span>」?此操作不可恢复。</div>
          {delErr && <div className="rounded-md border border-err/25 bg-err/10 px-3 py-2 text-xs text-err">{delErr}</div>}
        </div>
      </Dialog>
    </>
  );
}

// ── 客户端密钥 Tab ─────────────────────────────────────────
function ClientPanel({ rows, ups, reload }: {
  rows: ClientKey[] | null; ups: UpstreamKey[]; reload: () => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [upstreamId, setUpstreamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [delTarget, setDelTarget] = useState<ClientKey | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const activeUps = ups.filter(k => k.status === 'active');

  const openAdd = () => {
    setName('');
    setUpstreamId(activeUps[0] ? String(activeUps[0].id) : '');
    setCopied(false);
    setAddOpen(true);
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !upstreamId || busy) return;
    setBusy(true);
    try {
      const r = await api<{ id: number; name: string; token: string; upstreamKeyId: number }>('/admin/api/client-keys', {
        method: 'POST',
        body: { name: name.trim(), upstreamKeyId: Number(upstreamId) },
      });
      setAddOpen(false);
      setCopied(false);
      setCreatedToken(r.token); // token 明文仅此一次,切到结果 Dialog
      toast('ok', '客户端密钥已创建');
      await reload();
    } catch (err) {
      toast('err', `创建失败:${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!createdToken) return;
    const ok = await copyText(createdToken);
    if (ok) { setCopied(true); toast('ok', '已复制到剪贴板'); }
    else toast('err', '复制失败,请手动选中文本复制');
  };

  const toggleStatus = async (k: ClientKey) => {
    const next = k.status === 'active' ? 'disabled' : 'active';
    setTogglingId(k.id);
    try {
      await api(`/admin/api/client-keys/${k.id}`, { method: 'PUT', body: { status: next } });
      toast('ok', next === 'active' ? '已启用' : '已停用');
      await reload();
    } catch (err) {
      toast('err', `操作失败:${(err as Error).message}`);
    } finally {
      setTogglingId(null);
    }
  };

  const submitDelete = async () => {
    if (!delTarget || delBusy) return;
    setDelBusy(true);
    try {
      await api(`/admin/api/client-keys/${delTarget.id}`, { method: 'DELETE' });
      toast('ok', `已删除「${delTarget.name}」`);
      setDelTarget(null);
      await reload();
    } catch (err) {
      toast('err', `删除失败:${(err as Error).message}`);
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-start gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs leading-relaxed text-txt2">
        <Repeat size={14} className="mt-0.5 shrink-0 text-accent" />
        <div>给 harness 用的接入密钥(sk-ccp-*)。<span className="text-txt">只有客户端密钥享受多账户自动轮转</span>;
          直接把 user_* 填进 harness 是直通模式,额度耗尽不会自动切换。</div>
      </div>
      <Card>
        <CardHeader title="客户端密钥" extra={
          <Button size="sm" variant="primary" onClick={openAdd}>创建客户端密钥</Button>
        } />
        {!rows ? (
          <Loading>加载客户端密钥…</Loading>
        ) : rows.length === 0 ? (
          <EmptyState
            title="还没有客户端密钥"
            hint="创建一枚 sk-ccp-* 密钥并绑定到某个已启用的上游密钥,即可接入代理。" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>名称</Th><Th>前缀</Th><Th>绑定上游</Th><Th>状态</Th><Th>创建时间</Th><Th>最近使用</Th><Th className="text-right">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(k => (
                <tr key={k.id} className="transition-colors hover:bg-panel2/60">
                  <Td className="max-w-40 truncate font-medium">{k.name}</Td>
                  <Td className="tnum text-xs text-txt2">{k.key_prefix}</Td>
                  <Td className="max-w-40 truncate text-txt2">{k.upstream_name ?? '—'}</Td>
                  <Td><StatusBadge status={k.status} /></Td>
                  <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtTime(k.created_at)}</Td>
                  <Td className="tnum whitespace-nowrap text-xs text-txt2">{fmtAgo(k.last_used_at)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" loading={togglingId === k.id} onClick={() => void toggleStatus(k)}>
                        {k.status === 'active' ? '停用' : '启用'}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDelTarget(k)}>删除</Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* 创建客户端密钥 */}
      <Dialog open={addOpen} title="创建客户端密钥" onClose={() => setAddOpen(false)}>
        <form onSubmit={submitAdd} className="space-y-3.5">
          <Field label="名称">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="如:本机 Claude Code" autoFocus />
          </Field>
          <Field label="绑定上游密钥" hint={activeUps.length === 0
            ? '暂无已启用的上游密钥,请先添加并启用'
            : '绑定优先;该密钥额度耗尽时自动切换其他已启用的上游密钥'}>
            <Select value={upstreamId} onChange={e => setUpstreamId(e.target.value)} disabled={activeUps.length === 0}>
              {activeUps.length === 0 && <option value="">无可用上游</option>}
              {activeUps.map(k => <option key={k.id} value={String(k.id)}>{k.name}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setAddOpen(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !upstreamId}>创建</Button>
          </div>
        </form>
      </Dialog>

      {/* 创建成功:一次性 token 展示 */}
      <Dialog open={createdToken != null} title="客户端密钥已创建" width="max-w-lg" onClose={() => setCreatedToken(null)} footer={
        <>
          <Button variant="primary" onClick={() => void copyToken()}>{copied ? '已复制' : '复制'}</Button>
          <Button onClick={() => setCreatedToken(null)}>我已保存,关闭</Button>
        </>
      }>
        <div className="space-y-3">
          <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-medium text-warn">
            token 仅显示一次,关闭后无法再次查看,请立即复制并妥善保存。
          </div>
          <div className="tnum break-all rounded-lg border border-line bg-bg px-3.5 py-3 text-base font-semibold text-accent">
            {createdToken}
          </div>
        </div>
      </Dialog>

      {/* 删除二次确认 */}
      <Dialog open={delTarget != null} title="删除客户端密钥" onClose={() => setDelTarget(null)} footer={
        <>
          <Button onClick={() => setDelTarget(null)}>取消</Button>
          <Button variant="danger" loading={delBusy} onClick={() => void submitDelete()}>确认删除</Button>
        </>
      }>
        <div className="text-sm text-txt">
          确认删除客户端密钥「<span className="font-medium">{delTarget?.name}</span>」({delTarget?.key_prefix})?使用该密钥的接入将立即失效,此操作不可恢复。
        </div>
      </Dialog>
    </>
  );
}

// ── 页面 ───────────────────────────────────────────────────
export function Keys() {
  const [tab, setTab] = useState('upstream');
  const [ups, setUps] = useState<UpstreamKey[] | null>(null); // null = 加载中
  const [clients, setClients] = useState<ClientKey[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([fetchUpstreamKeys(), fetchClientKeys()]);
      setUps(u.rows);
      setClients(c.rows);
    } catch (err) {
      // 失败时保留已有数据(首载则落空数组),不阻塞页面
      setUps(prev => prev ?? []);
      setClients(prev => prev ?? []);
      toast('err', `加载密钥列表失败:${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="space-y-5">
      <Tabs
        items={[
          { id: 'upstream', label: '上游密钥(Command Code)' },
          { id: 'client', label: '客户端密钥(sk-ccp-*)' },
        ]}
        value={tab}
        onChange={setTab} />

      {tab === 'upstream'
        ? <UpstreamPanel rows={ups} clients={clients} reload={reload} />
        : <ClientPanel rows={clients} ups={ups ?? []} reload={reload} />}
    </div>
  );
}
