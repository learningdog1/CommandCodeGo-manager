// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
// 唯一适配:consecutiveTimeouts → timeoutStats.consecutive(见 src/protocol/upstream.mjs)。
import { randomUUID } from 'crypto';
import { resolveUpstreamKey, authErrorMessage } from '../auth.mjs';
import { handleChatCompletions } from './chat.mjs';
import { buildCcRequest } from '../protocol/envelope.mjs';
import { readBody } from '../http/body.mjs';
import { waitDrain } from '../http/drain.mjs';
import { createIdleWatchdog } from '../http/idle.mjs';
import { sendJSON } from '../http/respond.mjs';
import { ensureInitialized } from '../protocol/init.mjs';
import { forwardWithRotation } from '../protocol/rotation.mjs';
import { STREAM_IDLE_TIMEOUT_MS, NONSTREAM_IDLE_TIMEOUT_MS } from '../limits.mjs';
import { log, summarizeUpstreamError } from '../log.mjs';
import {
  normalizeUsage, mapFinishReason, incompleteUpstreamDetail, incompleteUpstreamError,
  mapCcError, mapCcEventError, forwardToCC, TIMEOUT_REDUCE_CONTEXT_THRESHOLD, timeoutStats,
} from '../protocol/upstream.mjs';
import { nowUnix } from '../util.mjs';
import { instrumentRequest } from '../telemetry.mjs';
// ── OpenAI Responses API（/v1/responses）──────────────
// 供 Codex 等使用 Responses 协议的客户端接入。代理仍是无状态转换层：
// 把 input 翻译成内部 Chat 格式，复用同一套 CC 转发管线。
// 不支持 previous_response_id / store（需要服务端保存会话，与无状态定位冲突），
// 收到直接 400，避免静默降级成错误答案。

function responsesTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && typeof p === 'object' ? (p.text || '') : '')).join('');
}

function responsesReasoningOf(item) {
  if (!item) return '';
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map(p => (p && p.text) || '').join('');
  if (Array.isArray(item.content) && item.content.length) return item.content.map(p => (p && p.text) || '').join('');
  return typeof item.text === 'string' ? item.text : '';
}

function newResponsesId(prefix) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 24);
}

function convertResponsesToChat(respReq) {
  const messages = [];

  if (respReq.instructions !== undefined && respReq.instructions !== null) {
    const sys = responsesTextOf(respReq.instructions);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // Responses 把 reasoning / message / function_call 拆成并列 item，
  // Chat 要求它们挂在同一条 assistant 消息上，故先累积再冲刷。
  let pending = null;
  const ensurePending = () => (pending = pending || { role: 'assistant', content: null, tool_calls: [] });
  const flushPending = () => {
    if (!pending) return;
    if (!pending.tool_calls.length) delete pending.tool_calls;
    if (!pending.reasoning_content) delete pending.reasoning_content;
    if (pending.content === null && !pending.tool_calls) { pending = null; return; }
    messages.push(pending);
    pending = null;
  };

  const input = respReq.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      // OpenAI 规范里 input 数组的联合类型第一个成员是 EasyInputMessage，它的
      // required 只有 role 与 content —— type 是可选的（官方文档与 SDK 示例普遍写作
      // { role: 'user', content: 'hi' }）。item.type 为 undefined 但有 role 时按
      // message 处理，否则这类 item 会落进 default 被丢弃：全部省略时只剩
      // "input is required" 的误导性报错；混合形态时更糟 —— 校验能过，用户在
      // HTTP 200 下静默丢消息。这里只在 type 缺失时兜底，带 type 的 item 判定不变。
      switch (item.type ?? (item.role ? 'message' : undefined)) {
        case 'reasoning': {
          const t = responsesReasoningOf(item);
          if (t) ensurePending().reasoning_content = t;
          break;
        }
        case 'message': {
          const text = responsesTextOf(item.content);
          if (item.role === 'assistant') {
            if (text) ensurePending().content = text;
          } else if (item.role === 'system' || item.role === 'developer') {
            flushPending();
            messages.push({ role: 'system', content: text });
          } else {
            flushPending();
            messages.push({ role: 'user', content: text });
          }
          break;
        }
        case 'function_call': {
          ensurePending().tool_calls.push({
            id: item.call_id || item.id || ('call_' + randomUUID().slice(0, 8)),
            type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '{}' },
          });
          break;
        }
        case 'function_call_output': {
          flushPending();
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || '',
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output === undefined ? '' : item.output),
          });
          break;
        }
        default: {
          log('warn', 'Unknown Responses input item type', { type: item.type });
          break;
        }
      }
    }
  }
  flushPending();

  let tools;
  if (Array.isArray(respReq.tools) && respReq.tools.length) {
    tools = respReq.tools.filter(t => t && (t.type === 'function' || t.name)).map(t => ({
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    if (!tools.length) tools = undefined;
  }

  let toolChoice;
  const tc = respReq.tool_choice;
  if (typeof tc === 'string') toolChoice = tc;
  else if (tc && typeof tc === 'object' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } };

  const out = { model: respReq.model, messages, stream: respReq.stream === true };
  if (tools) out.tools = tools;
  if (toolChoice) out.tool_choice = toolChoice;
  if (respReq.max_output_tokens !== undefined) out.max_tokens = respReq.max_output_tokens;
  if (respReq.temperature !== undefined) out.temperature = respReq.temperature;
  if (respReq.top_p !== undefined) out.top_p = respReq.top_p;
  if (respReq.parallel_tool_calls !== undefined) out.parallel_tool_calls = respReq.parallel_tool_calls;
  const eff = respReq.reasoning && typeof respReq.reasoning === 'object' ? respReq.reasoning.effort : undefined;
  if (eff) out.reasoning_effort = eff;
  return out;
}

// Responses 的 input_tokens 是总数，cached / cache_write 均为其子集 ——
// 与 Anthropic 相反（那里 cache_read 是独立增量，必须做减法，见 issue #25）。
// 本代理上游 CC 的 inputTokens 同样已含缓存，故此处直接沿用、不做减法。
// 实测：total_tokens === input_tokens + output_tokens（即使 cached 占绝大多数）。
function buildResponsesUsage(usage, fallbackOutputTokens) {
  const u = usage || {};
  normalizeUsage(u);
  const inTok = u.inputTokens || 0;
  const outTok = u.outputTokens || fallbackOutputTokens || 0;
  return {
    input_tokens: inTok,
    // 规范里 cached_tokens 与 cache_write_tokens 都是 required
    input_tokens_details: {
      cached_tokens: u.cachedInputTokens || 0,
      cache_write_tokens: (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0,
    },
    output_tokens: outTok,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inTok + outTok,
  };
}

function buildResponsesOutput(fullText, thinkingText, toolCalls) {
  const output = [];
  if (thinkingText) {
    output.push({ type: 'reasoning', id: newResponsesId('rs_'), summary: [{ type: 'summary_text', text: thinkingText }] });
  }
  if (fullText) {
    output.push({
      type: 'message', id: newResponsesId('msg_'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }
  for (const tc of (toolCalls || [])) {
    const rawArgs = tc.function ? tc.function.arguments : '{}';
    output.push({
      type: 'function_call', id: newResponsesId('fc_'), call_id: tc.id,
      name: tc.function ? (tc.function.name || '') : '',
      arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}),
      status: 'completed',
    });
  }
  return output;
}

function buildResponsesObject(responseId, model, created, fullText, thinkingText, toolCalls, usage, opts) {
  const o = opts || {};
  const truncated = o.finishReason === 'length';
  const paused = o.finishReason === 'pause_turn';
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: (truncated || paused) ? 'incomplete' : 'completed',
    completed_at: nowUnix(),
    error: null,
    incomplete_details: truncated ? { reason: 'max_output_tokens' }
      : paused ? { reason: 'pause_turn' } : null,
    input: o.input || [],
    instructions: o.instructions === undefined ? null : o.instructions,
    max_output_tokens: o.max_output_tokens === undefined ? null : o.max_output_tokens,
    model,
    output: buildResponsesOutput(fullText, thinkingText, toolCalls),
    output_text: fullText || '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: o.reasoning || null,
    store: false,
    temperature: o.temperature === undefined ? 1 : o.temperature,
    text: { format: { type: 'text' } },
    tool_choice: o.tool_choice || 'auto',
    tools: o.tools || [],
    top_p: o.top_p === undefined ? 1 : o.top_p,
    truncation: 'disabled',
    usage: buildResponsesUsage(usage, 0),
    user: null,
    metadata: {},
  };
}

function sendResponsesError(res, status, type, message, retryAfter) {
  const body = { error: { message, type, code: null, param: null } };
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  sendJSON(res, status, body);
}

// CC NDJSON → Responses 具名 SSE 事件（每个事件都必需的 sequence_number 递增发送）
function createResponsesSseTranslator(model, responseId, created) {
  let seq = 0;
  const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type, sequence_number: seq++ }, data)) + '\n\n';
  let createdSent = false;
  let current = null;
  let outputIndex = 0;
  const doneItems = [];
  let usage = null;
  let textAcc = '';
  let finishReason = null;
  // 是否见过完成信号（见 incompleteUpstreamDetail 的口径说明）
  let sawFinish = false;

  const baseResponse = (status, output) => ({
    id: responseId, object: 'response', created_at: created, status,
    output: output || [], output_text: '', model, error: null, incomplete_details: null,
    parallel_tool_calls: true, previous_response_id: null, store: false, tools: [], metadata: {},
  });

  function startResponse() {
    createdSent = true;
    return [
      sse('response.created', { response: baseResponse('in_progress') }),
      sse('response.in_progress', { response: baseResponse('in_progress') }),
    ];
  }

  function closeItem() {
    if (!current) return [];
    const out = [];
    const item = current.item;
    const idx = current.index;
    if (current.kind === 'message') {
      out.push(sse('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text: current.textBuf, logprobs: [] }));
      out.push(sse('response.content_part.done', {
        item_id: item.id, output_index: idx, content_index: 0,
        part: { type: 'output_text', text: current.textBuf, annotations: [] },
      }));
      item.content = [{ type: 'output_text', text: current.textBuf, annotations: [] }];
      item.status = 'completed';
    } else if (current.kind === 'function_call') {
      out.push(sse('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments }));
      item.status = 'completed';
    } else if (current.kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_text.done', { item_id: item.id, output_index: idx, summary_index: 0, text: current.textBuf }));
      out.push(sse('response.reasoning_summary_part.done', {
        item_id: item.id, output_index: idx, summary_index: 0,
        part: { type: 'summary_text', text: current.textBuf },
      }));
      item.summary = [{ type: 'summary_text', text: current.textBuf }];
      item.status = 'completed';
    }
    out.push(sse('response.output_item.done', { output_index: idx, item }));
    doneItems.push(item);
    current = null;
    return out;
  }

  function openItem(kind, item) {
    const out = closeItem();
    current = { kind, index: outputIndex++, item, textBuf: '' };
    out.push(sse('response.output_item.added', { output_index: current.index, item }));
    if (kind === 'message') {
      out.push(sse('response.content_part.added', {
        item_id: item.id, output_index: current.index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    } else if (kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: current.index, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    return out;
  }

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    get started() { return createdSent; },
    get stopReason() { return finishReason; },
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;
      const out = [];

      switch (event.type) {
        case 'text-start': case 'reasoning-start': case 'start': case 'start-step':
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'message') {
            out.push.apply(out, openItem('message', { type: 'message', id: newResponsesId('msg_'), status: 'in_progress', role: 'assistant', content: [] }));
          }
          current.textBuf += text;
          textAcc += text;
          out.push(sse('response.output_text.delta', { item_id: current.item.id, output_index: current.index, content_index: 0, delta: text, logprobs: [] }));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'reasoning') {
            out.push.apply(out, openItem('reasoning', { type: 'reasoning', id: newResponsesId('rs_'), summary: [], status: 'in_progress' }));
          }
          current.textBuf += text;
          out.push(sse('response.reasoning_summary_text.delta', {
            item_id: current.item.id, output_index: current.index, summary_index: 0, delta: text,
          }));
          break;
        }

        case 'tool-call': {
          if (!createdSent) out.push.apply(out, startResponse());
          const callId = event.toolCallId || newResponsesId('call_');
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          out.push.apply(out, openItem('function_call', {
            type: 'function_call', id: newResponsesId('fc_'), call_id: callId,
            name: event.toolName || '', arguments: '', status: 'in_progress',
          }));
          current.item.arguments = args;
          out.push(sse('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: args }));
          break;
        }

        case 'finish': {
          sawFinish = true;
          // 必须归一化：截断类不止 'length'（还有 max_output_tokens /
          // model_context_window_exceeded），原来直接比对原始值会漏判成 completed。
          finishReason = event.finishReason ? mapFinishReason(event.finishReason) : null;
          const u = event.totalUsage || event.usage || null;
          if (u) {
            normalizeUsage(u);
            usage = u;
            this.inputTokens = u.inputTokens || 0;
            this.outputTokens = u.outputTokens || 0;
            this.cachedInputTokens = u.cachedInputTokens || 0;
          }
          break;
        }

        case 'error': {
          this.upstreamError = mapCcEventError(event);
          break;
        }

        default: break;
      }
      return out.length ? out : null;
    },
    finish() {
      if (!createdSent) return [];
      const out = closeItem();
      // 上游没有正常走完 finish —— 不能报 response.completed（那是把截断谎报成完整）。
      // 对齐 CLI：按可重试的 upstream_error 处理。
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
        out.push(sse('response.failed', {
          response: Object.assign(baseResponse('failed'), {
            error: { code: 'upstream_error', message: incompleteUpstreamError(incomplete).body.error.message },
          }),
        }));
        return out;
      }
      // 'length' 表示被截断（max_output_tokens / model_context_window_exceeded 都归一到这里）；
      // 'pause_turn' 同样是「后面还有内容没发完」，规范要求 status=incomplete。
      const truncated = finishReason === 'length';
      const paused = finishReason === 'pause_turn';
      out.push(sse(truncated || paused ? 'response.incomplete' : 'response.completed', {
        response: Object.assign(baseResponse(truncated || paused ? 'incomplete' : 'completed', doneItems.slice()), {
          output_text: textAcc,
          incomplete_details: truncated ? { reason: 'max_output_tokens' }
            : paused ? { reason: 'pause_turn' } : null,
          usage: buildResponsesUsage(usage, this.outputTokens),
        }),
      }));
      return out;
    },
    fail(message) {
      if (!createdSent) return [];
      return [sse('response.failed', {
        response: Object.assign(baseResponse('failed'), {
          error: { code: 'upstream_error', message: message || 'Upstream error' },
        }),
      })];
    },
    errorEvent(message) {
      return sse('error', { code: null, message: message || 'Upstream error', param: null });
    },
  };
}

async function handleResponses(req, res) {
  const t = instrumentRequest(req, res, '/v1/responses');
  let respReq;
  try {
    respReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) { sendResponsesError(res, 413, 'invalid_request_error', e.message); return; }
    sendResponsesError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  if (respReq.previous_response_id) {
    sendResponsesError(res, 400, 'invalid_request_error',
      'previous_response_id is not supported (this proxy is stateless); send the full input each turn');
    return;
  }

  const auth = await resolveUpstreamKey(req.headers);
  req.ccpAuth = auth; // 请求上下文(遥测读取 mode/clientKeyName/upstreamKeyId)
  if (!auth) {
    sendResponsesError(res, 401, 'authentication_error',
      'Missing API key. Send in Authorization: Bearer <key> or x-api-key header');
    return;
  }
  if (auth.error) {
    sendResponsesError(res, 401, 'authentication_error', authErrorMessage(auth.error));
    return;
  }
  const apiKey = auth.apiKey;

  let chatReq = convertResponsesToChat(respReq);
  if (!chatReq.messages.length) {
    sendResponsesError(res, 400, 'invalid_request_error', 'input is required');
    return;
  }

  const stream = chatReq.stream === true;
  const model = chatReq.model || 'deepseek/deepseek-v4-flash';
  t.model = model; t.stream = stream;
  const responseId = newResponsesId('resp_');
  const created = nowUnix();
  const echoOpts = {
    instructions: respReq.instructions === undefined ? null : respReq.instructions,
    max_output_tokens: respReq.max_output_tokens === undefined ? null : respReq.max_output_tokens,
    temperature: respReq.temperature,
    top_p: respReq.top_p,
    reasoning: respReq.reasoning || null,
    tool_choice: typeof respReq.tool_choice === 'string' ? respReq.tool_choice : 'auto',
    tools: respReq.tools || [],
  };
  const ccBody = buildCcRequest(chatReq);
  const promptCacheKey = chatReq.prompt_cache_key;
  chatReq = null;

  const abortController = new AbortController();
  let aborted = false;
  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let reader = null;
  let translator = null;

  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    log('warn', 'Client disconnected', {
      path: '/v1/responses', model, responseId, elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived, lastCcEvent: lastCcEvent || '(none)',
    });
    if (!abortController.signal.aborted) { try { abortController.abort(); } catch (e2) {} }
  });

  try {
    const { response: ccResponse, auth: finalAuth } = await forwardWithRotation(auth, req.headers, ccBody, abortController.signal, promptCacheKey);
    req.ccpAuth = finalAuth; // 轮转后按实际使用的上游密钥归因(H5)

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, path: '/v1/responses', code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
      return;
    }

    if (stream) {
      translator = createResponsesSseTranslator(model, responseId, created);
      t.provider = () => ({ usage: { inputTokens: translator?.inputTokens ?? 0, outputTokens: translator?.outputTokens ?? 0, cachedInputTokens: translator?.cachedInputTokens ?? 0 }, finishReason: null });
      let buffer = '';
      let started = false;
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();
      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const writeEvents = async (evts) => {
        if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
        for (const e2 of evts) res.write(e2);
        await waitDrain(res);
      };

      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const done = result.done;
          const value = result.value;
          if (done) break;
          if (aborted || res.destroyed) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          for (const line of lines) {
            const evts = translator.parseLine(line);
            if (evts) await writeEvents(evts);
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
        }

        if (!aborted) {
          if (buffer.trim()) {
            const evts = translator.parseLine(buffer);
            if (evts) await writeEvents(evts);
          }
          if (translator.upstreamError) {
            if (!started) {
              sendResponsesError(res, translator.upstreamError.status,
                translator.upstreamError.body.error.type, translator.upstreamError.body.error.message,
                translator.upstreamError.body.retry_after);
              return;
            }
            const failed = translator.fail(translator.upstreamError.body.error.message);
            if (failed.length) await writeEvents(failed);
          } else if (translator.outputTokens === 0 && !translator.started) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
            sendResponsesError(res, 429, 'rate_limit_error',
              'Empty response from upstream (zero output tokens)', 10);
            return;
          } else {
            if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
            for (const e2 of translator.finish()) res.write(e2);
          }
          timeoutStats.consecutive = 0;
        }
      } catch (e) {
        if (aborted) {
          try { reader.cancel(); } catch (e2) {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/responses', model, streaming: true, timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
          });
          timeoutStats.consecutive++;
          const timeoutMsg = timeoutStats.consecutive >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) { sendResponsesError(res, 429, 'rate_limit_error', timeoutMsg, 5); return; }
          if (!res.writableEnded) {
            // end() 而不是 destroy()：理由见 handleChatCompletions 流式超时分支
            try { res.end(translator.errorEvent(timeoutMsg)); } catch (e2) {}
          }
        } else {
          log('error', 'Stream error', { message: e.message, path: '/v1/responses' });
          try { abortController.abort(); } catch (e2) {}
          if (!started) {
            sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
            return;
          }
          if (!res.writableEnded) {
            try { res.write(translator.errorEvent(e.message)); } catch (e2) {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式：缓冲完整 NDJSON 后一次性构造 Responses 对象 ──
      let fullText = '';
      let thinkingText = '';
      let usage = null;
      let finishReason = 'stop';
      let sawFinish = false;
      let upstreamError = null;
      t.provider = () => ({ usage: usage || {}, finishReason });
      const toolCalls = [];
      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          let event;
          try { event = JSON.parse(trimmed); } catch (e2) { continue; }
          switch (event.type) {
            case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
            case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
            case 'tool-call': {
              lastCcEvent = event.type;
              toolCalls.push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: {
                  name: event.toolName || '',
                  arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                },
              });
              break;
            }
            case 'finish-step':
            case 'finish':
              lastCcEvent = event.type;
              sawFinish = true;
              finishReason = mapFinishReason(event.finishReason || 'stop');
              if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
              break;
            case 'error':
              lastCcEvent = event.type;
              upstreamError = mapCcEventError(event);
              log('warn', 'CC stream error (non-stream)', {
                message: event.error ? event.error.message : event.message,
                upstreamStatus: upstreamError.reportedStatus,
                upstreamRetryable: event.error?.isRetryable,
                code: upstreamError.code,
                mappedTo: upstreamError.status,
              });
              break;
            // 无内容的事件：与流式翻译器以及另两条非流式路径保持一致。
            // 这条路径原先**没有静默列表**，于是上游每个响应都会发的一串无内容事件
            //（text-start / text-end / start / start-step / reasoning-start / reasoning-end /
            //  provider-metadata / tool-input-* / tool-error）全部掉进 default 打成
            // 'Unknown CC event type'，线上刷屏、把真正的错误淹掉。
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
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const done = result.done;
        const value = result.value;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendResponsesError(res, upstreamError.status, upstreamError.body.error.type,
          upstreamError.body.error.message, upstreamError.body.retry_after);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      {
        const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
        if (incomplete) {
          log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
          const err = incompleteUpstreamError(incomplete);
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          sendResponsesError(res, err.status, err.body.error.type, err.body.error.message, err.retry_after);
          return;
        }
      }

      if (!fullText && !thinkingText && !toolCalls.length) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
        sendResponsesError(res, 429, 'rate_limit_error',
          'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      timeoutStats.consecutive = 0;
      echoOpts.finishReason = finishReason;
      sendJSON(res, 200, buildResponsesObject(
        responseId, model, created, fullText, thinkingText, toolCalls, usage, echoOpts));
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return;
    log('error', 'Responses handler error', { message: e.message });
    if (!res.headersSent) {
      sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
    } else if (!res.writableEnded) {
      try { res.write(translator ? translator.errorEvent(e.message) : ''); } catch (e2) {}
      try { res.end(); } catch (e2) {}
    }
  }
}

export { handleResponses };
