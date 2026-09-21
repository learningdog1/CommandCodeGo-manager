// 模型价格目录:由 command-code@1.58.1 官方知识库 reference/models.md 解析生成
// (单价为官方公开价目,$/1M tokens,输入/输出/缓存读,部分厂商另计缓存写)。
// 生成方式:一次性脚本解析 markdown 表格;上游价目更新时需重新生成。
// plan 为该模型要求的最低套餐(官方排序 Go < GOAT < Pro < Max)。
export interface CatalogEntry {
  id: string;
  name: string;
  context: string | null;
  efforts: string[] | null;
  priceIn: number;   // $/1M 输入
  priceOut: number;  // $/1M 输出
  cacheRead: number; // $/1M 缓存读
  cacheWrite: number | null; // $/1M 缓存写(不计则 null)
  plan: 'go' | 'goat' | 'pro' | 'max' | 'team' | null;
  bestFor: string;
}

export const MODEL_CATALOG: CatalogEntry[] = [
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (latest)',
    context: '1M',
    efforts: [
      'high',
      'max'
    ],
    priceIn: 0.66,
    priceOut: 1.98,
    cacheRead: 0.022,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'hybrid-attention long-context reasoning'
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash (latest)',
    context: '1M',
    efforts: [
      'high',
      'max'
    ],
    priceIn: 0.15,
    priceOut: 0.6,
    cacheRead: 0.003,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'fast hybrid-attention reasoning'
  },
  {
    id: 'deepseek/deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision (exp)',
    context: '1M',
    efforts: [
      'high',
      'max'
    ],
    priceIn: 0.15,
    priceOut: 0.6,
    cacheRead: 0.003,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'fast hybrid-attention reasoning with vision'
  },
  {
    id: 'deepseek/deepseek-v4-flash-fast',
    name: 'DeepSeek V4 Flash Fast',
    context: '1M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 0.28,
    priceOut: 0.56,
    cacheRead: 0.07,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'low-latency V4 Flash deployment'
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    context: '1M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 0.15,
    priceOut: 0.6,
    cacheRead: 0.003,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'V4.1 hybrid-attention reasoning with vision'
  },
  {
    id: 'moonshotai/Kimi-K3',
    name: 'Kimi K3',
    context: '1M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 3,
    priceOut: 15,
    cacheRead: 0.3,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'long-horizon coding & knowledge work with 1M context'
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    name: 'Kimi K2.7 Code',
    context: '256K',
    efforts: null,
    priceIn: 0.95,
    priceOut: 4,
    cacheRead: 0.19,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'improved long-horizon coding with vision'
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code-Highspeed',
    name: 'Kimi K2.7 Code HighSpeed',
    context: '262K',
    efforts: null,
    priceIn: 1.9,
    priceOut: 8,
    cacheRead: 0.38,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'high-speed long-horizon coding with vision'
  },
  {
    id: 'moonshotai/Kimi-K2.6',
    name: 'Kimi K2.6',
    context: '256K',
    efforts: null,
    priceIn: 0.95,
    priceOut: 4,
    cacheRead: 0.16,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'long-horizon coding with vision'
  },
  {
    id: 'moonshotai/Kimi-K2.5',
    name: 'Kimi K2.5',
    context: '256K',
    efforts: null,
    priceIn: 0.6,
    priceOut: 3,
    cacheRead: 0.1,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'multimodal frontend coding'
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    context: '1.05M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 0.15,
    priceOut: 0.5,
    cacheRead: 0.03,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'fast, affordable GLM coding with 1M context'
  },
  {
    id: 'z-ai/glm-5.3-flashx',
    name: 'GLM-5.3 FlashX',
    context: '1M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 0.37,
    priceOut: 1.25,
    cacheRead: 0.075,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'high-speed GLM-5.3 Flash with 1M context'
  },
  {
    id: 'zai-org/GLM-5.3',
    name: 'GLM-5.3',
    context: '1M',
    efforts: [
      'low',
      'high',
      'max'
    ],
    priceIn: 1.4,
    priceOut: 4.4,
    cacheRead: 0.26,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'frontier coding with emergent cyber capabilities'
  },
  {
    id: 'zai-org/GLM-5.2',
    name: 'GLM-5.2',
    context: '1M',
    efforts: [
      'high',
      'max'
    ],
    priceIn: 1.4,
    priceOut: 4.4,
    cacheRead: 0.26,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'powerful coding with 1M context and long-horizon tasks'
  },
  {
    id: 'zai-org/GLM-5.2-Fast',
    name: 'GLM-5.2 Fast',
    context: '1M',
    efforts: null,
    priceIn: 3,
    priceOut: 10.25,
    cacheRead: 0.5,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'high-throughput GLM-5.2 with 1M context'
  },
  {
    id: 'zai-org/GLM-5.1',
    name: 'GLM-5.1',
    context: null,
    efforts: null,
    priceIn: 1.4,
    priceOut: 4.4,
    cacheRead: 0.26,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'long-horizon autonomous coding agent'
  },
  {
    id: 'zai-org/GLM-5',
    name: 'GLM-5',
    context: '200K',
    efforts: null,
    priceIn: 1,
    priceOut: 3.2,
    cacheRead: 0.2,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'multi-mode thinking & long-range planning'
  },
  {
    id: 'MiniMaxAI/MiniMax-M3',
    name: 'MiniMax M3',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 0.3,
    priceOut: 1.2,
    cacheRead: 0.06,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'frontier coding, agents & native multimodality'
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.7',
    name: 'MiniMax M2.7',
    context: null,
    efforts: null,
    priceIn: 0.3,
    priceOut: 1.2,
    cacheRead: 0.06,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'end-to-end software engineering agent'
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax M2.5',
    context: '200K',
    efforts: null,
    priceIn: 0.3,
    priceOut: 1.2,
    cacheRead: 0.03,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'cross-platform full-stack agentic dev'
  },
  {
    id: 'xiaomi/mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    context: '1M',
    efforts: null,
    priceIn: 0.435,
    priceOut: 0.87,
    cacheRead: 0.0036,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'high-capability long-context agentic coding'
  },
  {
    id: 'xiaomi/mimo-v2.5',
    name: 'MiMo V2.5',
    context: '1M',
    efforts: null,
    priceIn: 0.14,
    priceOut: 0.28,
    cacheRead: 0.0028,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'efficient long-context agentic coding'
  },
  {
    id: 'Qwen/Qwen3.8-Omni-Flash',
    name: 'Qwen 3.8 Omni Flash',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'xhigh'
    ],
    priceIn: 0.15,
    priceOut: 0.47,
    cacheRead: 0.016,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'omni-modal understanding & multimedia agentic work'
  },
  {
    id: 'Qwen/Qwen3.8-Max-0902',
    name: 'Qwen 3.8 Max 0902',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'xhigh'
    ],
    priceIn: 2,
    priceOut: 6,
    cacheRead: 0.25,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'upgraded Qwen 3.8 Max: stronger coding & agentic tool use'
  },
  {
    id: 'Qwen/Qwen3.8-Max',
    name: 'Qwen 3.8 Max',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'xhigh'
    ],
    priceIn: 2,
    priceOut: 6,
    cacheRead: 0.25,
    cacheWrite: 2.5,
    plan: 'go',
    bestFor: 'autonomous long-horizon coding & professional work'
  },
  {
    id: 'Qwen/Qwen3.8-27B',
    name: 'Qwen 3.8 27B',
    context: '262K',
    efforts: [
      'low',
      'medium',
      'xhigh'
    ],
    priceIn: 0.4,
    priceOut: 3,
    cacheRead: 0.04,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'compact vision-language coding & agentic work'
  },
  {
    id: 'Qwen/Qwen3.8-Flash',
    name: 'Qwen 3.8 Flash',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'xhigh'
    ],
    priceIn: 0.16,
    priceOut: 0.47,
    cacheRead: 0.016,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'fast low-cost agentic coding & reasoning'
  },
  {
    id: 'Qwen/Qwen3.7-Max',
    name: 'Qwen 3.7 Max',
    context: '1M',
    efforts: null,
    priceIn: 2.5,
    priceOut: 7.5,
    cacheRead: 0.5,
    cacheWrite: 3.13,
    plan: 'go',
    bestFor: 'frontier coding & long-horizon agent execution'
  },
  {
    id: 'Qwen/Qwen3.7-Plus',
    name: 'Qwen 3.7 Plus',
    context: '1M',
    efforts: null,
    priceIn: 0.4,
    priceOut: 1.6,
    cacheRead: 0.08,
    cacheWrite: 0.5,
    plan: 'go',
    bestFor: 'agentic coding & reasoning at lower cost'
  },
  {
    id: 'Qwen/Qwen3.7-Flash',
    name: 'Qwen 3.7 Flash',
    context: '1M',
    efforts: null,
    priceIn: 0.03,
    priceOut: 0.13,
    cacheRead: 0.006,
    cacheWrite: 0.038,
    plan: 'go',
    bestFor: 'fast low-cost agentic coding & reasoning'
  },
  {
    id: 'Qwen/Qwen3.6-Max-Preview',
    name: 'Qwen 3.6 Max Preview',
    context: null,
    efforts: null,
    priceIn: 1.3,
    priceOut: 7.8,
    cacheRead: 0.26,
    cacheWrite: 1.63,
    plan: 'go',
    bestFor: 'vibe coding & efficient agent execution'
  },
  {
    id: 'Qwen/Qwen3.6-Plus',
    name: 'Qwen 3.6 Plus',
    context: null,
    efforts: null,
    priceIn: 0.5,
    priceOut: 3,
    cacheRead: 0.1,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'agentic coding & reasoning'
  },
  {
    id: 'meituan/LongCat-2.0',
    name: 'LongCat 2.0',
    context: '1.05M',
    efforts: null,
    priceIn: 0.3,
    priceOut: 1.2,
    cacheRead: 0.006,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'trillion-parameter agentic coding with 1M context'
  },
  {
    id: 'stepfun/Step-3.7-Flash',
    name: 'Step 3.7 Flash',
    context: '256K',
    efforts: null,
    priceIn: 0.2,
    priceOut: 1.15,
    cacheRead: 0.04,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'multimodal sparse-MoE reasoning'
  },
  {
    id: 'stepfun/Step-3.5-Flash',
    name: 'Step 3.5 Flash',
    context: '1M',
    efforts: null,
    priceIn: 0.1,
    priceOut: 0.3,
    cacheRead: 0.02,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'fast sparse-MoE agentic reasoning'
  },
  {
    id: 'tencent/hy3-paid',
    name: 'Tencent Hy3',
    context: '262K',
    efforts: null,
    priceIn: 0.14,
    priceOut: 0.58,
    cacheRead: 0.035,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'sparse-MoE reasoning & agentic tool use'
  },
  {
    id: 'tencent/hy4-preview',
    name: 'Tencent Hy4 Preview',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 0.834,
    priceOut: 2.501,
    cacheRead: 0.042,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'agentic coding & sustained multi-step tool use'
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    name: 'Nemotron 3 Ultra',
    context: '1M',
    efforts: null,
    priceIn: 0.6,
    priceOut: 2.4,
    cacheRead: 0.12,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'open reasoning model for long-horizon autonomous agents'
  },
  {
    id: 'thinkingmachines/inkling',
    name: 'Inkling',
    context: '256K',
    efforts: null,
    priceIn: 1,
    priceOut: 4.05,
    cacheRead: 0.17,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'multimodal MoE reasoning'
  },
  {
    id: 'thinkingmachines/inkling-small',
    name: 'Inkling Small',
    context: '1M',
    efforts: null,
    priceIn: 0.5,
    priceOut: 1.2,
    cacheRead: 0.1,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'lightweight MoE reasoning at lower cost and latency'
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Laguna S 2.1',
    context: '256K',
    efforts: null,
    priceIn: 0,
    priceOut: 0,
    cacheRead: 0,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'open-weight agentic coding and long-horizon work'
  },
  {
    id: 'inclusionai/ling-3.0-flash-sante:free',
    name: 'Ling 3.0 Flash Sante',
    context: '262K',
    efforts: null,
    priceIn: 0,
    priceOut: 0,
    cacheRead: 0,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'health & medicine tuned lightweight-MoE, still strong on code'
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 2,
    priceOut: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    plan: 'pro',
    bestFor: 'best combo of speed & intelligence (recommended)'
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 3,
    priceOut: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    plan: 'pro',
    bestFor: 'prev Sonnet, still fast & capable'
  },
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 10,
    priceOut: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    plan: 'max',
    bestFor: 'most capable for demanding reasoning & long-horizon agents'
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 10,
    priceOut: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    plan: 'max',
    bestFor: 'prev Fable, still strong for deep reasoning & agents'
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 5,
    priceOut: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    plan: 'max',
    bestFor: 'most intelligent Opus for agents and coding'
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 5,
    priceOut: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    plan: 'max',
    bestFor: 'prev flagship, still strong for agents and coding'
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 5,
    priceOut: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    plan: 'max',
    bestFor: 'older Opus, still strong for agents and coding'
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    context: '200K',
    efforts: null,
    priceIn: 1,
    priceOut: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    plan: 'pro',
    bestFor: 'fastest & most compact, great for quick tasks'
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 10,
    priceOut: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    plan: 'max',
    bestFor: 'most capable OpenAI model for demanding reasoning & agents'
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 5,
    priceOut: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    plan: 'goat',
    bestFor: 'frontier model for complex professional work'
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 2,
    priceOut: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    plan: 'pro',
    bestFor: 'balances intelligence and cost'
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 0.2,
    priceOut: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    plan: 'go',
    bestFor: 'optimized for cost-sensitive workloads'
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    context: '400K',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 5,
    priceOut: 30,
    cacheRead: 0.5,
    cacheWrite: 0,
    plan: 'pro',
    bestFor: 'latest frontier model for general complex work'
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    context: '400K',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 2.5,
    priceOut: 15,
    cacheRead: 0.25,
    cacheWrite: 0,
    plan: 'pro',
    bestFor: 'frontier model for general complex work'
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    context: '400K',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 2,
    priceOut: 8,
    cacheRead: 0.5,
    cacheWrite: 0,
    plan: 'pro',
    bestFor: 'frontier coding model'
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    context: '400K',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 0.75,
    priceOut: 4.5,
    cacheRead: 0.075,
    cacheWrite: 0,
    plan: 'pro',
    bestFor: 'fast, cost-effective model for everyday tasks'
  },
  {
    id: 'google/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 1.5,
    priceOut: 7.5,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'goat',
    bestFor: 'newest Gemini Flash, improved core reasoning'
  },
  {
    id: 'google/gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 1.5,
    priceOut: 7.5,
    cacheRead: 0.15,
    cacheWrite: 0.08334,
    plan: 'goat',
    bestFor: 'higher-quality coding & agentic workflows, fewer tokens'
  },
  {
    id: 'google/gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 1.5,
    priceOut: 7.5,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'pro',
    bestFor: 'previous Gemini Flash, still fast & capable'
  },
  {
    id: 'google/gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 1.5,
    priceOut: 9,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'pro',
    bestFor: 'Pro-level coding proficiency, parallel agentic execution'
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 0.3,
    priceOut: 2.5,
    cacheRead: 0.03,
    cacheWrite: null,
    plan: 'pro',
    bestFor: 'upgraded agentic capabilities, ideal for subagents'
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    context: '1M',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 0.25,
    priceOut: 1.5,
    cacheRead: 0.03,
    cacheWrite: null,
    plan: 'pro',
    bestFor: 'high-volume workhorse model with implicit caching'
  },
  {
    id: 'sakana/fugu-ultra',
    name: 'Fugu Ultra',
    context: '1M',
    efforts: [
      'high',
      'xhigh'
    ],
    priceIn: 5,
    priceOut: 30,
    cacheRead: 0.5,
    cacheWrite: null,
    plan: 'max',
    bestFor: 'multi-agent orchestration across frontier models'
  },
  {
    id: 'meta/muse-spark-1.1',
    name: 'Muse Spark 1.1',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 1.25,
    priceOut: 4.25,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'pro',
    bestFor: 'agentic performance, tool use, and computer use'
  },
  {
    id: 'meta/muse-spark-1.2',
    name: 'Muse Spark 1.2',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 1.25,
    priceOut: 4.25,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'goat',
    bestFor: 'coding-optimized for agentic workflows and large codebases'
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    name: 'Muse Spark 1.2 Contributor',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 0.1,
    priceOut: 0.2,
    cacheRead: 0.002,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'Muse Spark 1.2 at ~95% off'
  },
  {
    id: 'meta/muse-spark-1.3',
    name: 'Muse Spark 1.3',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ],
    priceIn: 1.25,
    priceOut: 4.25,
    cacheRead: 0.15,
    cacheWrite: null,
    plan: 'goat',
    bestFor: 'multimodal reasoning for long-horizon agentic and coding workflows'
  },
  {
    id: 'meta/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    context: '1.05M',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 0.1,
    priceOut: 0.2,
    cacheRead: 0.002,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'Muse Spark 1.3 at up to 95% off'
  },
  {
    id: 'xai/grok-4.5',
    name: 'Grok 4.5',
    context: '500K',
    efforts: [
      'low',
      'medium',
      'high'
    ],
    priceIn: 2,
    priceOut: 6,
    cacheRead: 0.5,
    cacheWrite: null,
    plan: 'go',
    bestFor: 'smartest model for coding, agentic tasks, knowledge work'
  },
  {
    id: 'xai/grok-4.6',
    name: 'Grok 4.6',
    context: '500K',
    efforts: [
      'low',
      'medium',
      'high',
      'xhigh'
    ],
    priceIn: 2,
    priceOut: 6,
    cacheRead: 0.5,
    cacheWrite: null,
    plan: 'goat',
    bestFor: 'frontier performance on coding, knowledge work, and STEM'
  }
];

export const CATALOG_BY_ID = new Map(MODEL_CATALOG.map(e => [e.id, e]));
