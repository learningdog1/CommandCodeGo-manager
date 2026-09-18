// Admin REST API:挂 /admin/api/*,供 Web 管理界面调用。
// 鉴权:无 token(H1 已取消,管理界面免登录)。写操作做**同源 Origin 校验**
// 挡浏览器跨站请求(CSRF,issue #2):Origin 必须与请求自身的 Host 一致;
// curl/本机桌面不带 Origin,不受影响。host 配成非回环时管理面随监听地址
// 一起对网络开放(无鉴权,启动日志有醒目警告)——网络边界由部署者自负。
import { readFileSync } from 'node:fs';
import { CFG, saveConfig, configPath, dataDir, defaults, applyEnvOverrides } from '../config.mjs';
import { log } from '../log.mjs';
import { readBody } from '../http/body.mjs';
import { sendJSON } from '../http/respond.mjs';
import { subscribe } from '../telemetry.mjs';
import { isDegraded } from '../store/db.mjs';
import {
  listUpstreamKeys, createUpstreamKey, setUpstreamKeyStatus, deleteUpstreamKey,
  getUpstreamKeyById, listClientKeys, createClientKey, setClientKeyStatus, deleteClientKey,
  findUpstreamKeyByApiKey, maskKey,
} from '../store/keys.mjs';
import { detectCliAuth, extractUserKeys } from '../cli-auth.mjs';
import { listRequests, summarizeSince } from '../store/requests.mjs';
import { usageSummary } from '../store/usage.mjs';
import { driftStatus } from '../protocol/upstream.mjs';
import { keyStateStore } from '../protocol/keystate.mjs';
import { accountUsageSnapshot, refreshAccountUsage, switchAccount } from '../protocol/account-usage.mjs';
import { DEVICE_PROFILE, slugifyProjectPath } from '../protocol/fingerprint.mjs';
import { MODELS } from '../protocol/models.mjs';

// 版本号:bundle 打包时由 esbuild define 内联(scripts/bundle.mjs);
// 开发态读根 package.json(相对 import.meta.url),失败退 'unknown'。
const APP_VERSION = process.env.CCP_APP_VERSION ?? (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).version; }
  catch { return 'unknown'; }
})();

const startedAt = Date.now();

export function createAdminApi({ getInflight = () => 0 } = {}) {
  function end(res, status, data) { sendJSON(res, status, data); }

  async function handleAdmin(req, res, url) {
    const path = url.pathname.replace(/^\/admin\/api/, '');

    // 写操作的 CSRF 防线 = 同源 Origin 校验(issue #2):浏览器跨站请求会带
    // Origin,与请求自身的 Host 不一致即拒绝;本机桌面与 curl 无 Origin 不受影响;
    // 局域网用 http://<本机IP>:<port> 打开管理页时 Origin 与 Host 一致,可正常操作。
    // ('null'/非法 Origin —— 沙箱 iframe、file:// 等 —— 一律按跨站处理)
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let sameOrigin = false;
      try {
        const requestHost = req.headers.host || 'localhost';
        sameOrigin = new URL(origin).host === new URL(`http://${requestHost}`).host;
      } catch { /* 非法 Origin 视为跨站 */ }
      if (!sameOrigin) {
        return end(res, 403, { error: 'cross-origin write rejected' });
      }
    }

    // ── 总览 ──
    if (req.method === 'GET' && path === '/overview') {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const today = await summarizeSince(dayStart.getTime());
      const ups = await listUpstreamKeys();
      const clients = await listClientKeys();
      return end(res, 200, {
        version: APP_VERSION,
        startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        host: CFG.host, port: CFG.port, apiBase: CFG.apiBase,
        zdr: !!CFG.zdr,
        inflight: getInflight(),
        degraded: isDegraded(),
        keys: {
          upstream: { total: ups.length, active: ups.filter(k => k.status === 'active').length },
          client: { total: clients.length, active: clients.filter(k => k.status === 'active').length },
        },
        today,
        modelCount: MODELS.length,
        drift: { ...driftStatus },
      });
    }

    // ── 日志 ──
    if (req.method === 'GET' && path === '/logs') {
      const result = await listRequests({
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
        endpoint: url.searchParams.get('endpoint') ?? undefined,
        statusCode: url.searchParams.get('status') ?? undefined,
        keyId: url.searchParams.get('keyId') ?? undefined,
        fromTs: url.searchParams.get('from') ?? undefined,
        toTs: url.searchParams.get('to') ?? undefined,
      });
      return end(res, 200, result);
    }

    // ── 实时日志(SSE,复用 telemetry 总线) ──
    if (req.method === 'GET' && path === '/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const unsubscribe = subscribe((event) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      });
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 15_000);
      heartbeat.unref?.();
      res.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
      return;
    }

    // ── 用量 ──
    if (req.method === 'GET' && path === '/usage') {
      const rows = await usageSummary({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        groupBy: url.searchParams.get('groupBy') ?? 'day',
      });
      return end(res, 200, { rows });
    }

    // ── 账号用量(快照纯读内存缓存;仅显式刷新触达上游,见下) ──
    if (req.method === 'GET' && path === '/account-usage') {
      return end(res, 200, await accountUsageSnapshot());
    }
    if (req.method === 'POST' && path === '/account-usage/refresh') {
      const body = await readBody(req).catch(() => null);
      const id = Number(body?.id);
      const r = await refreshAccountUsage(Number.isInteger(id) && id > 0 ? id : null);
      if (r.notFound) return end(res, 404, { error: 'upstream key not found or disabled' });
      return end(res, 200, r);
    }
    // ── 手动切换账户:标记窗口受限,新请求自动落到其他账户;on=false 恢复 ──
    if (req.method === 'POST' && path === '/account-usage/switch') {
      const body = await readBody(req).catch(() => null);
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id <= 0 || typeof body?.on !== 'boolean') {
        return end(res, 400, { error: 'id and on (boolean) are required' });
      }
      const r = await switchAccount(id, body.on);
      if (r.notFound) return end(res, 404, { error: 'upstream key not found or disabled' });
      return end(res, 200, r);
    }

    // ── 设备指纹(只读:证明「模拟了什么、上报结果如何」) ──
    // 指纹状态是运行时内存数据:进程重启后重建,且只含启动后用过的上游 key
    //(与 12h 会话过期清理联动,见 session.mjs)。key 只回前 8 位,与日志口径一致。
    if (req.method === 'GET' && path === '/fingerprints') {
      const keys = [...keyStateStore.entries()].map(([apiKey, state]) => {
        const c = state.fingerprint?.components ?? {};
        return {
          keyPrefix: apiKey.slice(0, 8),
          createdAt: state.createdAt ?? null,
          thumbmark: state.fingerprint?.thumbmark ?? null,
          machineIdHash: c.machineIdHash ?? null,
          macCount: Array.isArray(c.macHashes) ? c.macHashes.length : 0,
          osUserHash: c.osUserHash ?? null,
          hostnameHash: c.hostnameHash ?? null,
          gitEmailHash: c.gitEmailHash ?? null,
          cpuModel: c.cpuModel ?? null,
          cpuCount: c.cpuCount ?? null,
          memGiB: c.memGiB ?? null,
          timezone: c.timezone ?? null,
          nextInitAt: state.nextInitAt || null,
          fingerprintReport: state.fingerprintReport ?? null,
          lifecycleReport: state.lifecycleReport ?? null,
        };
      });
      return end(res, 200, {
        profile: {
          platform: DEVICE_PROFILE.platform,
          arch: DEVICE_PROFILE.arch,
          osRelease: DEVICE_PROFILE.osRelease,
          projectDir: DEVICE_PROFILE.projectDir,
          projectSlug: slugifyProjectPath(DEVICE_PROFILE.projectDir),
          fingerprintSalt: !!CFG.fingerprintSalt,
          refreshEvery: '8h + 2h 抖动',
        },
        keys,
      });
    }

    // ── 模型一键刷新(遍历启用的上游密钥试探动态列表) ──
    if (req.method === 'POST' && path === '/models/refresh') {
      const { refreshModels } = await import('../protocol/models.mjs');
      return end(res, 200, await refreshModels());
    }

    // ── Command Code CLI 登录凭证(一键导入,Go 订阅用户的推荐路径) ──
    if (req.method === 'GET' && path === '/cc-cli') {
      const d = detectCliAuth(maskKey);
      // 检测结果不回传完整 key,只给掩码;导入时服务端自己读文件
      return end(res, 200, { installed: d.installed, keyMask: d.keyMask ?? null, path: d.path });
    }
    if (req.method === 'POST' && path === '/cc-cli/import') {
      const d = detectCliAuth(maskKey);
      if (!d.installed) return end(res, 404, { error: '未检测到 commandcode CLI 登录(需先安装 CLI 并执行 cmd login)' });
      const existing = await findUpstreamKeyByApiKey(d.key);
      if (existing) return end(res, 200, { existing: true, id: existing.id, name: existing.name });
      // 先用通用默认名建 key,导入后立刻拉一次账户信息,把名称换成 commandcode 账户名
      // (whoami 失败保持默认名,后续用量刷新拿到账户名时会自动迁移)
      const created = await createUpstreamKey({ name: 'CommandCode 账户', apiKey: d.key });
      let name = created.name;
      try {
        const r = await refreshAccountUsage(created.id);
        if (r.rows?.[0]?.name) name = r.rows[0].name;
      } catch { /* 命名失败不影响导入 */ }
      return end(res, 201, { ...created, name });
    }

    // ── 上游 key ──
    if (req.method === 'GET' && path === '/upstream-keys') {
      return end(res, 200, { rows: await listUpstreamKeys() });
    }
    if (req.method === 'POST' && path === '/upstream-keys') {
      const body = await readBody(req).catch(() => null);
      if (!body?.name || !body?.apiKey || !/^user_[a-zA-Z0-9_-]+$/.test(String(body.apiKey))) {
        return end(res, 400, { error: 'name and apiKey (user_*) are required' });
      }
      const created = await createUpstreamKey({ name: String(body.name), apiKey: String(body.apiKey) });
      return end(res, 201, created);
    }
    // ── 批量导入:粘贴多行 user_* 密钥一次建档(免 CLI 退出重登)──
    // 每枚建档后即拉账户信息按 commandcode 账户名命名;重复的跳过并回告。
    if (req.method === 'POST' && path === '/upstream-keys/batch') {
      const body = await readBody(req).catch(() => null);
      const text = String(body?.text ?? '');
      const keys = extractUserKeys(text);
      if (keys.length === 0) return end(res, 400, { error: '未在文本中找到 user_* 密钥' });
      if (keys.length > 50) return end(res, 400, { error: '单次最多导入 50 枚密钥' });
      const nonEmpty = text.split('\n').map(l => l.trim()).filter(Boolean);
      const created = [], existing = [];
      for (let i = 0; i < keys.length; i += 3) {
        await Promise.all(keys.slice(i, i + 3).map(async k => {
          const dup = await findUpstreamKeyByApiKey(k);
          if (dup) { existing.push({ id: dup.id, name: dup.name }); return; }
          const c = await createUpstreamKey({ name: 'CommandCode 账户', apiKey: k });
          let name = c.name;
          try {
            const r = await refreshAccountUsage(c.id);
            if (r.rows?.[0]?.name) name = r.rows[0].name;
          } catch { /* 命名失败不影响导入,刷新时会再迁移 */ }
          created.push({ id: c.id, name });
        }));
      }
      created.sort((a, b) => a.id - b.id);
      return end(res, 200, {
        created, existing,
        // 未识别行 = 完全不含 user_* 密钥的非空行(混贴了密钥的行不算)
        unmatchedLines: nonEmpty.filter(l => extractUserKeys(l).length === 0).length,
      });
    }
    {
      const m = path.match(/^\/upstream-keys\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (req.method === 'PUT') {
          const body = await readBody(req).catch(() => null);
          if (!['active', 'disabled'].includes(body?.status)) return end(res, 400, { error: 'status must be active|disabled' });
          await setUpstreamKeyStatus(id, body.status);
          return end(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          const r = await deleteUpstreamKey(id);
          return r.ok ? end(res, 200, { ok: true }) : end(res, 409, { error: r.reason, bound: r.bound });
        }
      }
      const t = path.match(/^\/upstream-keys\/(\d+)\/test$/);
      if (t && req.method === 'POST') {
        const upstream = await getUpstreamKeyById(Number(t[1]));
        if (!upstream) return end(res, 404, { error: 'upstream key not found or disabled' });
        // 探活:直接调上游 /provider/v1/models(绕过 fetchModels 的缓存)
        try {
          const r = await fetch(`${CFG.apiBase}/provider/v1/models`, {
            headers: { Authorization: `Bearer ${upstream.api_key}`, 'x-cli-environment': 'production' },
            signal: AbortSignal.timeout(8000),
          });
          const body = r.ok ? await r.json().catch(() => null) : null;
          return end(res, 200, { ok: r.ok, status: r.status, models: Array.isArray(body?.data) ? body.data.length : null });
        } catch (e) {
          return end(res, 200, { ok: false, error: e.message });
        }
      }
    }

    // ── 客户端 key ──
    if (req.method === 'GET' && path === '/client-keys') {
      return end(res, 200, { rows: await listClientKeys() });
    }
    if (req.method === 'POST' && path === '/client-keys') {
      const body = await readBody(req).catch(() => null);
      if (!body?.name || !body?.upstreamKeyId) return end(res, 400, { error: 'name and upstreamKeyId are required' });
      try {
        const created = await createClientKey({ name: String(body.name), upstreamKeyId: Number(body.upstreamKeyId) });
        return end(res, 201, created); // token 明文仅此一次返回
      } catch (e) {
        return end(res, 400, { error: e.message });
      }
    }
    {
      const m = path.match(/^\/client-keys\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (req.method === 'PUT') {
          const body = await readBody(req).catch(() => null);
          if (!['active', 'disabled'].includes(body?.status)) return end(res, 400, { error: 'status must be active|disabled' });
          await setClientKeyStatus(id, body.status);
          return end(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          await deleteClientKey(id);
          return end(res, 200, { ok: true });
        }
      }
    }

    // ── 设置 ──
    if (req.method === 'GET' && path === '/settings') {
      // 返回「默认值 + 文件层」合并(不含 env 覆写):文件缺键时 UI 仍有兜底值。
      // apiKey(兜底上游密钥)与 adminTokenHash 均不回明文/哈希,只报有无 ——
      // 管理面响应可能进截图与日志,密钥本身没有理由再回显
      let file = {};
      try { file = JSON.parse(readFileSync(configPath(), 'utf-8')); } catch {}
      const { adminTokenHash, apiKey, ...rest } = { ...defaults(), ...file };
      return end(res, 200, { ...rest, hasApiKey: !!apiKey, hasAdminToken: !!adminTokenHash, dataDir });
    }
    if (req.method === 'PUT' && path === '/settings') {
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== 'object') return end(res, 400, { error: 'invalid body' });
      const patch = { ...body };
      // 只读派生键与历史遗留键不允许写入(adminTokenHash 从未参与鉴权,H1 后已废弃)
      delete patch.adminTokenHash;
      delete patch.hasAdminToken;
      delete patch.hasApiKey;
      delete patch.adminToken;
      try {
        // host/port 只在下次启动生效(不 rebind):与当前生效值比较,实际改动了才提示
        const restartRequired = ['host', 'port'].filter(k => k in patch && String(patch[k]) !== String(CFG[k]));
        const saved = saveConfig(patch);
        // 立即生效的运行时键同步进 CFG;随后重放 env 覆写 —— 文件层保存不得覆盖
        // 以 env 启动的部署参数(CC_API_BASE/PORT 等,否则保存一次设置行为就漂移)
        for (const k of Object.keys(saved)) CFG[k] = saved[k];
        applyEnvOverrides(CFG);
        return end(res, 200, { ok: true, restartRequired, saved: { ...saved, adminTokenHash: undefined, apiKey: undefined } });
      } catch (e) {
        return end(res, 500, { error: e.message });
      }
    }

    return end(res, 404, { error: 'not found' });
  }

  return handleAdmin;
}
