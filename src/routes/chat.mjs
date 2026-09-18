// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
// 唯一适配:consecutiveTimeouts → timeoutStats.consecutive(见 src/protocol/upstream.mjs)。
import { randomUUID } from 'crypto';
import { resolveUpstreamKey, authErrorMessage } from '../auth.mjs';
import { buildCcRequest } from '../protocol/envelope.mjs';
import { readBody } from '../http/body.mjs';
import { waitDrain } from '../http/drain.mjs';
import { createIdleWatchdog } from '../http/idle.mjs';
import { sendJSON } from '../http/respond.mjs';
import { ensureInitialized } from '../protocol/init.mjs';
import { forwardWithRotation } from '../protocol/rotation.mjs';
import { STREAM_IDLE_TIMEOUT_MS, NONSTREAM_IDLE_TIMEOUT_MS, CLIENT_DRAIN_TIMEOUT_MS } from '../limits.mjs';
import { log, summarizeUpstreamError } from '../log.mjs';
import {
  normalizeUsage, mapFinishReason, toOpenAIFinishReason, incompleteUpstreamDetail, incompleteUpstreamError,
  mapCcError, mapCcEventError, forwardToCC, TIMEOUT_REDUCE_CONTEXT_THRESHOLD, timeoutStats,
} from '../protocol/upstream.mjs';
import { nowUnix } from '../util.mjs';
import { instrumentRequest } from '../telemetry.mjs';
// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  // 是否见过终态 finish 事件。CLI 用同一个标志判定「流是不是被截断了」。
  let sawFinish = false;
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          // 本地按事件计数:上游偶发不回 totalUsage 时,零输出判定仍要有依据
          // (对齐 /v1/messages 流式;usage 到达时在 finish 里覆盖)
          this.outputTokens += 1;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          this.outputTokens += 1; // 纯思考响应(无正文)同样是有效输出
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          this.outputTokens += 20; // 粗估,对齐 /v1/messages 流式
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          sawFinish = true;
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            // || 而非 ??:usage 报 0 但本地已数到内容时保留本地计数(内容优先于零账单)
            this.outputTokens = event.usage.outputTokens || this.outputTokens;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          sawFinish = true;
          const fr = toOpenAIFinishReason(finishReason || mapFinishReason(event.finishReason || 'stop'));
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens || this.outputTokens;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          this.upstreamError = mapCcEventError(event);
          // 先映射再记日志，并把上游自带的状态/可重试性一并打出 ——
          // 排查容量/限流类问题时，真正需要的就是这两个字段
          log('warn', 'CC stream error', {
            message: msg,
            upstreamStatus: this.upstreamError.reportedStatus,
            upstreamRetryable: event.error?.isRetryable,
            code: this.upstreamError.code,
            mappedTo: this.upstreamError.status,
          });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 这次上游流若没有正常走完 finish，返回可读原因；正常则为 null。 */
    incompleteDetail() {
      return incompleteUpstreamDetail(sawFinish, finishReason);
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  const t = instrumentRequest(req, res, '/v1/chat/completions');
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendJSON(res, 413, { error: { message: e.message, type: 'invalid_request_error' } });
      return;
    }
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const auth = await resolveUpstreamKey(req.headers);
  req.ccpAuth = auth; // 请求上下文(遥测读取 mode/clientKeyName/upstreamKeyId)
  if (!auth) {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header', type: 'auth_error' } });
    return;
  }
  if (auth.error) {
    sendJSON(res, 401, { error: { message: authErrorMessage(auth.error), type: 'auth_error' } });
    return;
  }
  const apiKey = auth.apiKey;

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  t.model = model; t.stream = stream;
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq);

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  const abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0; let fullText = '';
  let reader = null;
  let translator = null;

  // 下游断连检测:必须在 await forwardWithRotation **之前**注册 —— close 只发一次,
  // 客户端若在上游等待期间断开,迟注册的监听器永远收不到事件:上游流会被完整
  // 读下去(token 照常消耗)、abort 不会触发、断连日志也缺失(/v1/responses 同款时序)。
  res.on('close', () => {
    if (res.writableEnded) return; // Normal completion, not a disconnect
    aborted = true;
    const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
      : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
      : 'client-hangup';
    abortController.signal.aborted || log('warn', 'Client disconnected', {
      path: '/v1/chat/completions',
      model, completionId, reason,
      streaming: stream,
      elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived,
      lastCcEvent: lastCcEvent || '(none)',
      keepaliveCount,
      inputTokens: translator?.inputTokens ?? 0,
      outputTokens: translator?.outputTokens ?? 0,
      cachedInputTokens: translator?.cachedInputTokens ?? 0,
    });
    if (!abortController.signal.aborted) {
      // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
      try {
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {}
      try { abortController.abort(); } catch {}
    }
  });

  try {
    // 首次初始化（fingerprint + lifecycle）
    const { response: ccResponse, auth: finalAuth } = await forwardWithRotation(auth, req.headers, ccBody, abortController.signal, openaiReq.prompt_cache_key);
    req.ccpAuth = finalAuth; // 轮转后按实际使用的上游密钥归因(H5)

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    if (stream) {
      // ── 流式响应 ──
      translator = createSseTranslator(model, completionId, created);
      t.provider = () => ({ usage: { inputTokens: translator?.inputTokens ?? 0, outputTokens: translator?.outputTokens ?? 0, cachedInputTokens: translator?.cachedInputTokens ?? 0 }, finishReason: null });
      let buffer = '';
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };

      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          if (aborted) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          // 仅在新到数据含换行时才切分：buffer 中永不残留 '\n'，故无换行即无完整行。
          // 避免对增长中的超长单行（大 tool-call / tool_result）反复做全量 split —— O(n²) → O(n)。
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          let hadOutput = false;
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              if (!started) {
                res.writeHead(200, SSE_HEADERS);
                started = true;
              }
              for (const evt of events) res.write(evt);
              await waitDrain(res);
              hadOutput = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
          // silent events 期间发 keepalive，防止客户端超时断开
          if (started && !hadOutput) {
            try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {}
            await waitDrain(res);
          }
        }

        if (!aborted) {
          // 成功完成一次请求，重置连续超时计数
          timeoutStats.consecutive = 0;
          // 处理剩余 buffer
          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              // 必须真正写 header:只置 started 标志会让响应以 implicit 200(无
              // Content-Type)发出,后续 sendJSON 还会因头已发再 writeHead 抛错
              if (!started) {
                res.writeHead(200, SSE_HEADERS);
                started = true;
              }
              for (const evt of events) res.write(evt);
              await waitDrain(res);
            }
          }
          if (translator.upstreamError) {
            if (!started) {
              sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
              return;
            }
            try { res.write(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`); } catch {}
          // 上游没有正常走完 finish（无 finish 事件 / provider 报连接失败）：
          // 不能补一个 finish_reason 就 [DONE] —— 那等于把截断谎报成完整回答。
          // 对齐 CLI：这一族一律按可重试的 502 处理。
          // 必须排在零输出判定之前 —— 上游压根没发 finish 时，「no finish event」才是根因，
          // 零输出只是它的表象（此时按 429 报会掩盖真实原因）。
          } else if (translator.incompleteDetail()) {
            const detail = translator.incompleteDetail();
            log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: detail });
            const err = incompleteUpstreamError(detail);
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) { sendJSON(res, err.status, err.body); return; }
            try { res.write(`data: ${JSON.stringify(err.body)}\n\n`); } catch {}
          // 输出 token 为 0 时记为错误，避免下游异常计费。
          // 判定依据 = usage 计数与本地内容计数(translator.outputTokens 两者取其一,
          // 上游漏发 totalUsage 时不再把完整回答误杀成 429,对齐 /v1/messages)
          } else if (translator.outputTokens === 0) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
          } else {
            if (!started) {
              res.writeHead(200, SSE_HEADERS);
              started = true;
            }
            res.write(translator.getDoneEvent());
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          try { reader.cancel(); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel(); } catch {}
          try { abortController.abort(); } catch {} // 打断 CC 上游，避免浪费 token
          timeoutStats.consecutive++;
          const timeoutMsg = timeoutStats.consecutive >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            // 必须 end() 而不是 destroy()：res.write 是异步的，紧接着 destroy 会把尚未
            // 刷出的缓冲丢掉并发 RST。反向代理看到上游连接被重置，要么回 502，要么让
            // 客户端看到 connection error —— 这正是"吐字慢 + 间歇性 502"的成因之一。
            // end() 会把错误事件正常送进 SSE 流再发 FIN，客户端 SDK 能按可重试错误处理。
            // 下游若已僵死（不读也不断），由 CLIENT_DRAIN_TIMEOUT_MS 那条路径负责兜底。
            try { res.end(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
          }
        } else {
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let reasoningContent = '';
      let finishReason = 'stop';
      let sawFinish = false;
      let usage = null;
      let toolCalls = null;
      let upstreamError = null;
      t.provider = () => ({ usage: usage || {}, finishReason });

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish-step':
              case 'finish':
                lastCcEvent = event.type;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                upstreamError = mapCcEventError(event);
                log('warn', 'CC stream error (non-stream)', {
                  message: event.error?.message || event.message,
                  upstreamStatus: upstreamError.reportedStatus,
                  upstreamRetryable: event.error?.isRetryable,
                  code: upstreamError.code,
                  mappedTo: upstreamError.status,
                });
                break;
              // 无内容的事件：与流式翻译器的静默列表保持一致。
              // text-start / start / start-step / reasoning-start 原先只在流式路径被识别，
              // 非流式路径会掉进 default 打成 'Unknown CC event type' —— 上游每个响应都会发，
              // 于是线上刷屏。它们本身不携带内容（内容在 text-delta），纯粹是噪音。
              case 'text-start': case 'text-end': case 'start': case 'start-step':
              case 'reasoning-start': case 'reasoning-end':
              case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
              case 'tool-error':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        // 无换行则不可能产生完整行，跳过全量 split（见 handleChatCompletions 流式段同处说明）
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendJSON(res, upstreamError.status, upstreamError.body);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: incomplete });
        const err = incompleteUpstreamError(incomplete);
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, err.status, err.body);
        return;
      }

      // 零输出判定:内容与 usage 双证据 —— 有任何内容(文本/思考/工具调用)即有效;
      // 无内容时按 usage 判(上游明确计了输出则放行)。上游偶发不回 totalUsage 时,
      // 旧逻辑(usage?.outputTokens ?? 0 === 0)会把有完整文本的响应误杀成 429
      // (对齐 /v1/messages 的按内容判定,同时保留计费信号优先于本地观察的语义)
      if (!fullText && !reasoningContent && !toolCalls && (usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      timeoutStats.consecutive = 0;
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: toOpenAIFinishReason(finishReason),
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      timeoutStats.consecutive++;
      const timeoutMsg = timeoutStats.consecutive >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
    }
  }
}

export { handleChatCompletions };
