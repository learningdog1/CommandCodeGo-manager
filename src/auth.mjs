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
  upstream_disabled: 'The upstream key bound to this client key is missing or disabled; no active upstream account is available',
  upstream_unavailable: 'All active upstream accounts are temporarily unavailable or manually switched away',
  direct_disabled: 'Direct upstream keys (user_*) are disabled on this proxy; use a client key (sk-ccp-*)',
};

export function authErrorMessage(error) {
  return AUTH_ERRORS[error] ?? 'Authentication failed';
}

/** 选择未受限的启用账号。排除整条重试链,绝不回退到手动切走的账号。 */
export async function selectUpstreamKey(preferredId, options = {}) {
  const skip = new Set(options.skipUpstreamIds ?? []);
  if (options.skipUpstreamId != null) skip.add(options.skipUpstreamId);
  const eligible = k => k && !skip.has(k.id) && !isWindowBlocked(k.id);
  const preferred = await getUpstreamKeyById(preferredId);
  if (eligible(preferred)) return preferred;
  for (const k of await listUpstreamKeys()) {
    if (k.status !== 'active' || !eligible(k)) continue;
    const full = await getUpstreamKeyById(k.id);
    if (eligible(full)) return full;
  }
  return null;
}

async function unavailable() {
  const active = (await listUpstreamKeys()).some(k => k.status === 'active');
  return { error: active ? 'upstream_unavailable' : 'upstream_disabled', status: active ? 429 : 401 };
}

/** 解析客户端凭据;入库的直通与配置密钥共享同一账号选择规则。 */
export async function resolveUpstreamKey(headers, options = {}) {
  const bearer = (headers['authorization'] || '').startsWith('Bearer ')
    ? headers['authorization'].slice(7) : '';
  const token = bearer || headers['x-api-key'] || '';

  if (token.startsWith('sk-ccp-')) {
    const client = await verifyClientKey(token);
    if (!client) return { error: 'invalid_client_key' };
    const upstream = await selectUpstreamKey(client.upstream_key_id, options);
    if (!upstream) return unavailable();
    await touchUpstreamKey(upstream.id);
    return {
      apiKey: upstream.api_key, mode: 'client', clientKeyId: client.id,
      clientKeyName: client.name, upstreamKeyId: upstream.id,
      rotated: upstream.id !== client.upstream_key_id,
    };
  }

  const direct = getApiKey(headers);
  if (direct && !CFG.allowDirectUpstreamKey) return { error: 'direct_disabled' };
  const apiKey = direct || CFG.apiKey;
  if (!apiKey) return null;
  const context = { apiKey, mode: direct ? 'direct' : 'config', clientKeyId: null, clientKeyName: null, upstreamKeyId: null, rotated: false };
  const row = await findUpstreamKeyByApiKey(apiKey);
  // 未入库凭据保持直通语义;加入管理后必须遵守停用/耗尽/手动切换状态。
  if (!row) return context;
  const upstream = await selectUpstreamKey(row.id, options);
  if (!upstream) return unavailable();
  await touchUpstreamKey(upstream.id);
  return { ...context, apiKey: upstream.api_key, upstreamKeyId: upstream.id, rotated: upstream.id !== row.id };
}

export { getApiKey };
