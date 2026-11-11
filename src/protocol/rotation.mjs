// 额度/窗口耗尽自动轮转(H5 + 到限轮转):上游明确表示「该账户暂时用不了」时,
// 依次尝试未受限的启用密钥,每个账号最多一次。三类耗尽:
//   402(payment required)        —— 信用耗尽:持久标记,落库 status='exhausted';
//   429 + 额度码/额度措辞        —— 5 小时滚动 / 周窗口到顶:运行时标记到 resetAt
//                                   (见 window-state.mjs),窗口重置后自动恢复;
//   200 + 流内 error 事件        —— 上游把「no credits remaining」塞进 200 的 SSE 体里,
//                                   状态码看不出来,靠 peekEarlyError 探首段;
//   401                          —— key 失效/被吊销(实测 {"code":"UNAUTHORIZED",
//                                   "message":"Invalid 'Authorization' header or token."},issue #14):
//                                   运行时标记 invalid 并轮转。不落库:用量刷新/探活一旦
//                                   成功即自动回链,上游鉴权抖动的误判也能自愈;
//                                   真要换 key 走删除重导(没有原地改 key 的入口)。
// 其余 429/200 错误是瞬态限速或请求本身的问题,**不**轮转(换 key=换设备指纹,
// 只在确属耗尽时才值得);每把密钥独立设备指纹/会话的既有设计保证了轮转后的形态自洽。
// 已入库的直通 user_* 与 config 兜底同样参与轮转,未入库凭据保持直通。
import { ensureInitialized } from './init.mjs';
import { forwardToCC } from './upstream.mjs';
import { resolveUpstreamKey } from '../auth.mjs';
import { setUpstreamKeyStatus, findUpstreamKeyByApiKey, listUpstreamKeys } from '../store/keys.mjs';
import { classifyExhaustion, markWindowBlocked } from './window-state.mjs';
import { peekEarlyError } from './early-error.mjs';
import { refreshAccountUsage } from './account-usage.mjs';
import { log } from '../log.mjs';

/**
 * 带耗尽轮转的转发:ensureInitialized + forwardToCC 的统一入口。
 * 返回 { response, auth } —— auth 是实际使用的密钥上下文(轮转后 telemetry 按它归因)。
 * 分类用 response.clone() / peekEarlyError 读:原 response 未消费,路由层的 mapCcError 路径不变。
 */
export async function forwardWithRotation(auth, headers, ccBody, signal, promptCacheKey) {
  let current = auth;
  const attemptedIds = new Set();
  const attemptedKeys = new Set();
  // 固定请求开始时的上限,并发添加账号不能让重试链无界增长。
  const maxAttempts = Math.max(1, (await listUpstreamKeys()).length);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    attemptedKeys.add(current.apiKey);
    await ensureInitialized(current.apiKey, signal);
    const response = await forwardToCC(ccBody, current.apiKey, headers, signal, promptCacheKey);

    // 三路分类:状态码 402/429 → 读错误体;200 → 窥探流内错误事件;其余原样返回。
    let ex = null;
    if (response.status === 401) {
      // key 失效/被吊销:换下一把才有意义,留在链上只会让每笔请求都白撞一次 401。
      // 1 小时后放行重探(上限频率的有界浪费);期间用量刷新/探活成功即提前回链。
      ex = { kind: 'invalid', until: Date.now() + 60 * 60_000, persist: false };
    } else if (response.status === 402 || response.status === 429) {
      let bodyText = '';
      try { bodyText = await response.clone().text(); } catch { /* 分类失败按瞬态处理 */ }
      ex = classifyExhaustion(response.status, bodyText);
    } else if (response.ok) {
      const early = await peekEarlyError(response);
      if (early) ex = classifyExhaustion(200, early);
    }
    if (!ex) return { response, auth: current };

    // 耗尽账户的库内 id(direct 模式按密钥反查;未入库 → 无从标记/轮转)
    const keyId = current.upstreamKeyId
      ?? (await findUpstreamKeyByApiKey(current.apiKey))?.id
      ?? null;
    if (keyId == null) return { response, auth: current };
    attemptedIds.add(keyId);

    if (ex.persist) {
      // 标记必须先于所有返回路径 —— 轮转链最后一把(重试后仍耗尽)同样要标,
      // 否则它仍是 active,下一笔请求还会选中它、对已耗尽密钥再打一次上游。
      log('warn', 'Upstream key exhausted (402)', { upstreamKeyId: keyId });
      await setUpstreamKeyStatus(keyId, 'exhausted');
    } else {
      // 窗口/信用到顶/凭据失效:运行时标记到重置时间(信用未知期限按 6 小时重探);
      // 面板侧延迟几秒拉一次该账户,inflight 去重(invalid 的 key 这次刷新会失败,
      // 账号页正好以「拉取失败」暴露问题)
      markWindowBlocked(keyId, { source: 'live', window: ex.kind, until: ex.until });
      const why = ex.kind === 'credit' ? 'Upstream key out of credits'
        : ex.kind === 'invalid' ? 'Upstream key rejected (401), rotating away'
        : 'Upstream window limit hit';
      log('warn', why, {
        upstreamKeyId: keyId, window: ex.kind, until: new Date(ex.until).toISOString(),
      });
      const t = setTimeout(() => { refreshAccountUsage(keyId).catch(() => {}); }, 3000);
      t.unref?.();
    }

    if (attempt + 1 >= maxAttempts) {
      return { response, auth: current };
    }
    const next = await resolveUpstreamKey(headers, { skipUpstreamIds: attemptedIds });
    if (!next || next.error || attemptedKeys.has(next.apiKey)) {
      return { response, auth: current }; // 无可轮转密钥:按原语义返回
    }
    await response.body?.cancel().catch(() => {});
    log('info', 'Rotated to next upstream key', { from: keyId, to: next.upstreamKeyId ?? '?' });
    current = next;
  }
}