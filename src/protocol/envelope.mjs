// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
import { CFG } from '../config.mjs';
import { DEVICE_PROFILE } from './fingerprint.mjs';
import { getDateStr } from '../util.mjs';
// ── CC 请求体构建 ─────────────────────────────────

// ── response_format / text.format 支持性判定 ─────────
// CC 上游是 agent 式接口(command-code CLI 信封),params 没有结构化输出字段,
// json_object / json_schema 约束根本无法送达。此前静默丢弃 + 返回 200,客户端
// 误以为拿到了受约束的 JSON(issue #10)。改为明确 400:OpenAI 生态客户端普遍
// 对「400 + param」有降级分支(收到后改走提示词软路径),比静默吞掉友好得多。
// {"type":"text"} 是缺省形态、不构成约束,放行(忽略即正确语义)。
// 返回 OpenAI 风格 error body;可受理则返回 null。param 用调用方传入的字段名
// (chat 路由是 "response_format",Responses 路由是 "text.format")。
function unsupportedResponseFormatError(responseFormat, param) {
  if (!responseFormat || typeof responseFormat !== 'object') return null;
  const type = responseFormat.type;
  if (type === undefined || type === null || type === 'text') return null; // 无约束,等价缺省
  return {
    error: {
      message: `${param} is not supported: the upstream agent protocol has no structured-output field, so '${type}' constraints would be silently ignored. Constrain the output format in the prompt instead.`,
      type: 'invalid_request_error',
      param,
      code: null,
    },
  };
}

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key } = openaiReq;

  // 提取系统提示：OpenAI 的 system / developer 都映射为系统提示。
  // 形态对齐 CLI 的 toWireSystem —— **块数组**，非最后一块补 \n，cache_control 逐块保留。
  // （CLI 的 composeSystemPrompt：基础提示词是字符串时发字符串、是 sections 时发块数组；
  //   真机验证两种形态服务端都接受，见 PROTOCOL-FACTS-1.53.1.md。这里统一用块数组，
  //   才能把客户端标在 system 上的缓存断点原样送上去。）
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemBlocks = [];
  for (const m of systemMsgs) {
    if (typeof m.content === 'string') {
      if (m.content) systemBlocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const text = c?.text ?? c?.content ?? '';
        if (text === '' && !c?.cache_control) continue;
        const block = { type: 'text', text: String(text) };
        if (c?.cache_control) block.cache_control = c.cache_control;
        systemBlocks.push(block);
      }
    } else if (m.content != null) {
      systemBlocks.push({ type: 'text', text: String(m.content) });
    }
  }
  for (let i = 0; i < systemBlocks.length - 1; i++) systemBlocks[i].text += '\n';
  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  // 转换 messages 为 CC 格式
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      // 多模态：数组 content 原样透传（text + image_url → CC image 格式）
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // CC CLI 真实格式: { type: "image", image: "data:<mime>;base64,...", mimeType: "<mime>" }
            const mediaType = /^data:([^;,]+)/.exec(url)?.[1];
            const imagePart = { type: 'image', image: url };
            if (mediaType) imagePart.mimeType = mediaType;
            return imagePart;
          }
          return part;
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      // 思考内容必须回传：CC 在 thinking 模式下校验 reasoning 是否随历史带回，
      // 丢弃会让上游直接拒绝。次序也必须与 CC CLI 的抓包格式一致 ——
      // [reasoning, text, tool-call]，reasoning 在最前。
      if (msg.reasoning_content) {
        parts.push({ type: 'reasoning', text: msg.reasoning_content });
      }
      if (msg.content && typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') parts.push(part);
          // 客户端直接把 reasoning 放在 content 数组里时同样透传；
          // 已有 reasoning_content 字段则不重复
          else if (part.type === 'reasoning' && !msg.reasoning_content) parts.push(part);
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
          output: { type: 'text', value: toWireToolOutputValue(msg.content) },
        }],
      };
    }
    // 未知 role 兜底：归一化为 user 并保证 content 为数组，避免 CC 校验拒绝
    return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] };
  });

  // 缓存断点：system 是块数组，断点可以原样留在 system 上（CLI 的 systemSections[].cache 同义）。
  // 客户端已在任意消息块 / system 块上打过断点就保留；否则若给了 OpenAI 系的 prompt_cache_key，
  // 把断点落在 system 最后一块 —— 缓存按前缀计算，system 正是最前的那段前缀。
  const hasCacheMarker = systemBlocks.some(b => b.cache_control) || ccMessages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(part => part?.cache_control));
  if (prompt_cache_key && !hasCacheMarker && systemBlocks.length) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  const body = {
    config: {
      // 伪造的项目目录（不再发宿主真实 cwd）；environment 用伪装的平台词，与指纹保持自洽
      workingDir: DEVICE_PROFILE.projectDir,
      date: getDateStr(),
      environment: DEVICE_PROFILE.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,          // CLI 发 null，不是空串
    permissionMode: 'standard',
    mode: CFG.cliMode || 'agent',
    // threadId 需为合法 UUID，否则整键省略（CLI 的 toWireThreadId）—— 在 forwardToCC 拿到 sessionId 后补
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      stream: true,  // CC API 总是 stream
    },
  };

  // 条件字段
  if (systemBlocks.length) {
    body.params.system = systemBlocks;
  } else if (CFG.emptySystemPlaceholder) {
    // CC 上游在 params.system 缺省时会注入自身约 7.5K token 的默认提示词（进入
    // 默认上下文/前缀路径），既产生大量 cached tokens 又污染对话（模型会以为
    // 自己在 CC 的可执行目录里，见 issue #17）。发一个空格占位即可绕过，
    // 真机验证 prompt_tokens 从 7653 降到 85。
    // 默认开启；config.json 设 "emptySystemPlaceholder": false 或环境变量
    // CC_EMPTY_SYSTEM_PLACEHOLDER=false 可关闭（回到原生的缺省行为）。
    body.params.system = [{ type: 'text', text: ' ' }];
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  if (reasoning_effort !== undefined) {
    body.params.reasoning_effort = reasoning_effort;
  }
  // CLI 总是下发 tools（没有工具时是空数组）—— 空数组与缺键在 wire 上可观测，这里对齐
  // CLI 的 toWireTools：只有 name / description / input_schema，没有 type 字段
  body.params.tools = (tools || []).map(t => ({
      name: toWireToolName(t.function?.name || t.name || ''),
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  if (tool_choice !== undefined) {
    // OpenAI 格式 → CC (Anthropic 风格) 格式
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

// CLI 发送前会重写部分工具名（resolveToolNameAlias / ow 表）
const TOOL_NAME_ALIASES = {
  bash_output: 'shell_output',
  task_output: 'shell_output',
  tool_search: 'search_tools',
  read_multiple_files: 'read_file',
};
function toWireToolName(name) { return TOOL_NAME_ALIASES[name] || name; }

// CLI 的 toWireToolOutput：只取文本块，用 '\n' 拼接
function toWireToolOutputValue(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text ?? '').join('\n');
  }
  return content == null ? '' : String(content);
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

export { buildCcRequest, unsupportedResponseFormatError, toWireToolName, toWireToolOutputValue, tryParseJSON };
