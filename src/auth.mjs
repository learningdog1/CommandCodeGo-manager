// 鉴权接缝:四个 handler 的统一密钥解析入口。
// 优先级:① sk-ccp-* 客户端 key(哈希验证 → 绑定的上游 key)
//        ② user_* 直通(参考项目的用法,受 allowDirectUpstreamKey 开关)
//        ③ config.apiKey 兜底
// 会话与设备指纹始终按**上游 key** 隔离(与参考实现一致);直通记为 unmanaged。
// getApiKey 为参考原实现(user_* 提取器),行为逐字保留。
import { CFG } from './config.mjs';
import { verifyClientKey, getUpstreamKeyById, touchUpstreamKey, listUpstreamKeys, findUpstreamKeyByApiKey } from './store/keys.mjs';
import { isWindowBlocked } from './protocol/window-state.mjs';

function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

const AUTH_ERRORS = {
  invalid_client_key: 'Invalid or disabled client key (sk-ccp-*)',
  upstream_disabled: 'The upstream key bound to this client key is missing or disabled',
  direct_disabled: 'Direct upstream keys (user_*) are disabled on this proxy; use a client key (sk-ccp-*)',
};

export function authErrorMessage(error) {
  return AUTH_ERRORS[error] ?? 'Authentication failed';
}

/** 启用中的候选池(排除 skip),用于轮转/窗口受限时换 key。 */
async function activeCandidates(skipId) {
  const out = [];
  for (const k of await listUpstreamKeys()) {
    if (k.status !== 'active' || k.id === skipId) continue;
    const full = await getUpstreamKeyById(k.id); // 复核 active(并发停用)
    if (full) out.push(full);
  }
  return out;
}

/**
 * 解析请求头 → 上游密钥上下文。
 * options.skipUpstreamId:轮转时排除指定上游密钥(额度/窗口耗尽重试用)。
 * 返回:
 *   null                          —— 请求未携带任何凭据(由调用方决定 401 或回落)
 *   { error: 'invalid_client_key' | 'upstream_disabled' | 'direct_disabled' } —— 401
 *   { apiKey, mode, clientKeyId, clientKeyName, upstreamKeyId, rotated } —— 命中
 *     mode: 'client'(经客户端 key)| 'direct'(user_* 直通)| 'config'(兜底)
 *     rotated: 绑定的上游密钥不可用(停用/额度耗尽)或窗口受限(5h/周到顶、手动切换)
 *              时自动切到了其他启用密钥(H5 + issue:到限真正轮转)
 */
export async function resolveUpstreamKey(headers, options = {}) {
  const bearer = (headers['authorization'] || '').startsWith('Bearer ')
    ? headers['authorization'].slice(7) : '';
  const token = bearer || headers['x-api-key'] || '';

  // ① 客户端 key
  if (token.startsWith('sk-ccp-')) {
    const client = await verifyClientKey(token);
    if (!client) return { error: 'invalid_client_key' };
    let upstream = await getUpstreamKeyById(client.upstream_key_id);
    let rotated = false;
    // 必须换:绑定密钥不可用(active 才可用,exhausted/disabled 均不可)或被要求跳过;
    // 值得换:绑定密钥窗口受限(5h/周到顶或手动切换)。
    const mustReplace = !upstream
      || (options.skipUpstreamId != null && upstream.id === options.skipUpstreamId);
    const windowBlocked = !mustReplace && isWindowBlocked(upstream.id);
    if (mustReplace || windowBlocked) {
      // 候选优先取窗口未受限的;全部受限时:必须换 → 退而取第一个(旧行为),
      // 只是值得换 → 保持绑定(可用性优先,真到限由 429 轮转兜底)
      const pool = await activeCandidates(options.skipUpstreamId);
      const fresh = pool.find(k => !isWindowBlocked(k.id));
      if (fresh) { upstream = fresh; rotated = true; }
      else if (mustReplace) {
        if (pool.length === 0) return { error: 'upstream_disabled' };
        upstream = pool[0]; rotated = true;
      }
    }
    await touchUpstreamKey(upstream.id);
    return { apiKey: upstream.api_key, mode: 'client', clientKeyId: client.id, clientKeyName: client.name, upstreamKeyId: upstream.id, rotated };
  }

  // ② user_* 直通:密钥已入库时参与轮转 —— 窗口受限/额度耗尽(不可用)/被要求跳过
  //    都切到其他未受限账户;不入库的纯直通维持原语义(操作者没把它纳入管理,不代作主张)
  const direct = getApiKey(headers);
  if (direct) {
    if (!CFG.allowDirectUpstreamKey) return { error: 'direct_disabled' };
    let apiKey = direct, upstreamKeyId = null, rotated = false;
    const row = await findUpstreamKeyByApiKey(direct);
    const rowActive = row && row.status === 'active';
    if (rowActive) upstreamKeyId = row.id; // 归因(telemetry/日志按真实账户)
    const needRotate = (row && !rowActive)
      || (rowActive && (row.id === options.skipUpstreamId || isWindowBlocked(row.id)));
    if (needRotate) {
      const pool = await activeCandidates(options.skipUpstreamId ?? null);
      const fresh = pool.find(k => !isWindowBlocked(k.id));
      if (fresh) { apiKey = fresh.api_key; upstreamKeyId = fresh.id; rotated = true; }
      // 找不到可轮转:保持直通原 key(402/429 按原语义返回)
    }
    if (upstreamKeyId != null) await touchUpstreamKey(upstreamKeyId);
    return { apiKey, mode: 'direct', clientKeyId: null, clientKeyName: null, upstreamKeyId, rotated };
  }

  // ③ config 兜底(部署在受信环境时可用)
  if (CFG.apiKey) {
    return { apiKey: CFG.apiKey, mode: 'config', clientKeyId: null, clientKeyName: null, upstreamKeyId: null };
  }

  return null;
}

export { getApiKey };
