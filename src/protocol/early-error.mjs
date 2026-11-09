// 200 响应体的「流内错误」探测:额度耗尽的第三种形态。
// 上游有时把错误塞进 200 的 SSE 体(实测:{"type":"start"} {"type":"start-step"}
// {"type":"error",…no credits remaining…}),只看状态码会把它当成功。
// 转发前窥探 clone 出来的那一支首段:见到错误事件就交回文本给分类器,
// 见到正文事件就立刻放行 —— 原响应体始终未被消费,路由层的转发路径不变。
// 这里只放纯函数:不 import 任何带定时器/网络的模块,便于单元测试直接引用。
import { ERROR_MARKER } from './window-state.mjs';

// 边界:16KB / 3s —— 正常响应的第一个内容事件远早于这个预算,不会给首字节添延迟;
// 上游整个沉默时最多等 3s,而客户端那时本来也在等首字节。
export const PEEK_MAX_BYTES = 16 * 1024;
export const PEEK_MAX_MS = 3000;
// 正文已经开始的事件:见到它立刻放行(此时客户端本来就要开始收内容了)。
// reasoning-start/reasoning-delta 是本协议(chat.mjs 解析的)thinking 事件 —— 缺了它们,
// 推理先行的流会被扣满 3s 预算才放行,等于给每个 thinking 请求加首字节延迟。
export const CONTENT_STARTED = /"type"\s*:\s*"(?:text_start|text-start|text-delta|reasoning-start|reasoning-delta|content_block_start|content_block_delta|thinking_delta|input_json_delta|tool-call|tool-input-start|tool-input-delta|response\.)/;

/**
 * 窥探 200 响应首段,命中错误事件则返回该片段文本,否则 null。
 * 用 response.clone() 读:原 response 未被消费。
 */
export async function peekEarlyError(response, budgetBytes = PEEK_MAX_BYTES, budgetMs = PEEK_MAX_MS) {
  if (!response?.body || typeof response.clone !== 'function') return null;
  let reader;
  try { reader = response.clone().body?.getReader(); } catch { return null; }
  if (!reader) return null;
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let acc = '';
  let sawError = false;
  try {
    while (acc.length < budgetBytes) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((res) => { const t = setTimeout(() => res({ timeout: true }), left); t.unref?.(); }),
      ]);
      if (chunk.timeout || chunk.done) break;
      acc += decoder.decode(chunk.value, { stream: true });
      if (ERROR_MARKER.test(acc)) { sawError = true; break; }
      if (CONTENT_STARTED.test(acc)) return null;
    }
  } catch { return null; } finally { try { reader.cancel().catch(() => {}); } catch {} }
  if (!sawError) return null;
  const at = acc.search(ERROR_MARKER);
  return at >= 0 ? acc.slice(at, at + 2048) : acc.slice(-2048);
}
