// 模型清单(H4):静态内置 = command-code@1.58.1 包内权威清单(72 个,含最低套餐);
// 动态 = /provider/v1/models(需 GOAT 及以上套餐,Go 套餐 403 时回落内置)。
// refreshModels 供管理界面「一键刷新」:逐把启用的上游密钥试探,成功即更新动态缓存。
import { CFG } from '../config.mjs';
import { log } from '../log.mjs';
import { CC_VERSION } from './upstream.mjs';
import { listUpstreamKeys, getUpstreamKeyById } from '../store/keys.mjs';

// 由 scripts 里的一次性脚本从 command-code@1.58.1 包内
// dist/bundled/command-code-knowledge/reference/models.md 生成(权威清单,含各模型最低套餐)。
const MODELS = [
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", plan: "go" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", plan: "go" },
  { id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision", plan: "go" },
  { id: "deepseek/deepseek-v4-flash-fast", name: "DeepSeek V4 Flash Fast", plan: "go" },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", plan: "go" },
  { id: "moonshotai/Kimi-K3", name: "Kimi K3", plan: "go" },
  { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", plan: "go" },
  { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code HighSpeed", plan: "go" },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", plan: "go" },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", plan: "go" },
  { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", plan: "go" },
  { id: "z-ai/glm-5.3-flashx", name: "GLM-5.3 FlashX", plan: "go" },
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", plan: "go" },
  { id: "zai-org/GLM-5.2", name: "GLM-5.2", plan: "go" },
  { id: "zai-org/GLM-5.2-Fast", name: "GLM-5.2 Fast", plan: "go" },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1", plan: "go" },
  { id: "zai-org/GLM-5", name: "GLM-5", plan: "go" },
  { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", plan: "go" },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", plan: "go" },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", plan: "go" },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", plan: "go" },
  { id: "xiaomi/mimo-v2.5", name: "MiMo V2.5", plan: "go" },
  { id: "Qwen/Qwen3.8-Omni-Flash", name: "Qwen 3.8 Omni Flash", plan: "go" },
  { id: "Qwen/Qwen3.8-Max-0902", name: "Qwen 3.8 Max 0902", plan: "go" },
  { id: "Qwen/Qwen3.8-Max", name: "Qwen 3.8 Max", plan: "go" },
  { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", plan: "go" },
  { id: "Qwen/Qwen3.8-Flash", name: "Qwen 3.8 Flash", plan: "go" },
  { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", plan: "go" },
  { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus", plan: "go" },
  { id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", plan: "go" },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview", plan: "go" },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus", plan: "go" },
  { id: "meituan/LongCat-2.0", name: "LongCat 2.0", plan: "go" },
  { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash", plan: "go" },
  { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash", plan: "go" },
  { id: "tencent/hy3-paid", name: "Tencent Hy3", plan: "go" },
  { id: "tencent/hy4-preview", name: "Tencent Hy4 Preview", plan: "go" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", plan: "go" },
  { id: "thinkingmachines/inkling", name: "Inkling", plan: "go" },
  { id: "thinkingmachines/inkling-small", name: "Inkling Small", plan: "go" },
  { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", plan: "go" },
  { id: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante", plan: "go" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", plan: "pro" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", plan: "pro" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", plan: "max" },
  { id: "claude-fable-5", name: "Claude Fable 5", plan: "max" },
  { id: "claude-opus-5", name: "Claude Opus 5", plan: "max" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", plan: "max" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", plan: "max" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", plan: "pro" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", plan: "max" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", plan: "goat" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", plan: "pro" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", plan: "go" },
  { id: "gpt-5.5", name: "GPT-5.5", plan: "pro" },
  { id: "gpt-5.4", name: "GPT-5.4", plan: "pro" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", plan: "pro" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", plan: "pro" },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", plan: "goat" },
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", plan: "goat" },
  { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", plan: "pro" },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", plan: "pro" },
  { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", plan: "pro" },
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", plan: "pro" },
  { id: "sakana/fugu-ultra", name: "Fugu Ultra", plan: "max" },
  { id: "meta/muse-spark-1.1", name: "Muse Spark 1.1", plan: "pro" },
  { id: "meta/muse-spark-1.2", name: "Muse Spark 1.2", plan: "goat" },
  { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", plan: "go" },
  { id: "meta/muse-spark-1.3", name: "Muse Spark 1.3", plan: "goat" },
  { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", plan: "go" },
  { id: "xai/grok-4.5", name: "Grok 4.5", plan: "go" },
  { id: "xai/grok-4.6", name: "Grok 4.6", plan: "goat" },
];
// 共 72 个模型

let dynamicModels = null;
let modelsLastFetch = 0;

async function fetchModels(apiKey) {
  const now = Date.now();
  if (dynamicModels && (now - modelsLastFetch) < CFG.modelRefreshIntervalMs) {
    return dynamicModels;
  }

  try {
    if (!apiKey || !CFG.useProviderModels) throw new Error('Provider models disabled');

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data)) {
        dynamicModels = data.data.map(m => ({
          id: m.id,
          name: m.id,
        }));
        modelsLastFetch = now;
        log('info', 'Fetched models from Provider API', { count: dynamicModels.length });
        return dynamicModels;
      }
    }
    log('warn', 'Provider models fetch failed, using builtin list', { status: response.status });
  } catch (e) {
    log('warn', 'Provider models fetch error, using builtin list', { error: e.message });
  }

  // Fallback to builtin MODELS
  return MODELS;
}

/**
 * 一键刷新(管理界面):逐把启用的上游密钥试探 /provider/v1/models,
 * 首把成功即更新动态缓存。全部失败(如 Go 套餐 403)返回内置清单与原因。
 */
async function refreshModels() {
  try {
    const ups = (await listUpstreamKeys()).filter(k => k.status === 'active');
    let lastStatus = null;
    for (const k of ups) {
      const full = await getUpstreamKeyById(k.id);
      if (!full) continue;
      try {
        const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
          headers: {
            'Authorization': `Bearer ${full.api_key}`,
            'x-cli-environment': 'production',
            'x-command-code-version': CC_VERSION,
          },
          signal: AbortSignal.timeout(10000),
        });
        lastStatus = response.status;
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.data)) {
            dynamicModels = data.data.map(m => ({ id: m.id, name: m.id }));
            modelsLastFetch = Date.now();
            log('info', 'Models refreshed from Provider API', { count: dynamicModels.length, keyId: k.id });
            return { source: 'upstream', count: dynamicModels.length };
          }
        }
      } catch (e) {
        lastStatus = 0;
        log('warn', 'Models refresh key failed', { keyId: k.id, error: e.message });
      }
    }
    const reason = ups.length === 0
      ? '没有已启用的上游密钥,请先在密钥管理中导入'
      : `上游拒绝了动态列表请求(HTTP ${lastStatus},Go 套餐不支持),已展示内置权威清单(${MODELS.length} 个)`;
    return { source: 'builtin', count: MODELS.length, reason };
  } catch (e) {
    return { source: 'builtin', count: MODELS.length, reason: e.message };
  }
}

export { MODELS, fetchModels, refreshModels };
