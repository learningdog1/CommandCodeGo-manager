// 额度/窗口耗尽自动轮转(H5 + 到限轮转):上游明确表示「该账户暂时用不了」时,
// 换下一把启用中的密钥重试一次。两类耗尽:
//   402(payment required)        —— 信用耗尽:持久标记,落库 status='exhausted';
//   429 + USAGE_EXCEEDED/window  —— 5 小时滚动 / 周窗口到顶:运行时标记到 resetAt
//                                   (见 window-state.mjs),窗口重置后自动恢复。
// 其余 429 是瞬态限速,**不**轮转(换 key=换设备指纹,只在确属耗尽时才值得);
// 每把密钥独立设备指纹/会话的既有设计保证了轮转后的形态自洽。
// 直通 user_* 已入库的密钥同样参与轮转(未入库的纯直通与 config 兜底不轮转)。
import { ensureInitialized } from './init.mjs';
import { forwardToCC } from './upstream.mjs';
import { resolveUpstreamKey } from '../auth.mjs';
import { setUpstreamKeyStatus, findUpstreamKeyByApiKey } from '../store/keys.mjs';
import { classifyExhaustion, markWindowBlocked } from './window-state.mjs';
import { refreshAccountUsage } from './account-usage.mjs';
import { log } from '../log.mjs';

/**
 * 带耗尽轮转的转发:ensureInitialized + forwardToCC 的统一入口。
 * 返回 { response, auth } —— auth 是实际使用的密钥上下文(轮转后 telemetry 按它归因)。
 * 分类用 response.clone() 读错误体:原 response 未消费,路由层的 mapCcError 路径不变。
 */
export async function forwardWithRotation(auth, headers, ccBody, signal, promptCacheKey) {
  let current = auth;
  for (let attempt = 0; ; attempt++) {
    await ensureInitialized(current.apiKey, signal);
    const response = await forwardToCC(ccBody, current.apiKey, headers, signal, promptCacheKey);
    if (response.status !== 402 && response.status !== 429) {
      return { response, auth: current };
    }

    let bodyText = '';
    try { bodyText = await response.clone().text(); } catch { /* 分类失败按瞬态处理 */ }
    const ex = classifyExhaustion(response.status, bodyText);
    if (!ex) return { response, auth: current };

    // 耗尽账户的库内 id(direct 模式按密钥反查;未入库 → 无从标记/轮转)
    const keyId = current.upstreamKeyId
      ?? (await findUpstreamKeyByApiKey(current.apiKey))?.id
      ?? null;
    if (keyId == null) return { response, auth: current };

    if (ex.kind === 'credit') {
      // 标记必须先于所有返回路径 —— 轮转链最后一把(重试后仍耗尽)同样要标,
      // 否则它仍是 active,下一笔请求还会选中它、对已耗尽密钥再打一次上游。
      log('warn', 'Upstream key exhausted (402)', { upstreamKeyId: keyId });
      await setUpstreamKeyStatus(keyId, 'exhausted');
    } else {
      // 窗口到顶:运行时标记到 resetAt;面板侧延迟几秒拉一次该账户,inflight 去重
      markWindowBlocked(keyId, { source: 'live', window: ex.kind, until: ex.until });
      log('warn', 'Upstream window limit hit', {
        upstreamKeyId: keyId, window: ex.kind, until: new Date(ex.until).toISOString(),
      });
      const t = setTimeout(() => { refreshAccountUsage(keyId).catch(() => {}); }, 3000);
      t.unref?.();
    }

    if (attempt > 0) {
      return { response, auth: current }; // 已重试过一次:按原语义返回(402/429 → 映射后给下游)
    }
    const next = await resolveUpstreamKey(headers, { skipUpstreamId: keyId });
    if (!next || next.error || next.apiKey === current.apiKey) {
      return { response, auth: current }; // 无可轮转密钥:按原语义返回
    }
    log('info', 'Rotated to next upstream key', { from: keyId, to: next.upstreamKeyId ?? '?' });
    current = next;
  }
}
