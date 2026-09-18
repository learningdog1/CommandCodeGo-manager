// 特征化测试:把 vendored 实现的 wire 行为固化为契约,
// 防止后续接缝改造(鉴权/遥测)意外改变协议形态。
// 分两部分:
//  A) buildCcRequest 单元直测 —— src/protocol/envelope.mjs 可安全 import
//     (依赖链 config/fingerprint/util 均无定时器;CCP_DATA_DIR 先行设置)。
//  B) HTTP 全链路 —— 经 mock 上游断言最终 wire(threadId/键序/请求头/状态码语义),
//     与 helpers.mjs 的部署复刻形态一致。
// 协议事实出处:src/protocol/envelope.mjs、src/protocol/upstream.mjs(forwardToCC)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── A) 单元直测 ─────────────────────────────────────────────
process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-wire-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });

const { buildCcRequest } = await import('../src/protocol/envelope.mjs');
const { DEVICE_PROFILE } = await import('../src/protocol/fingerprint.mjs');

test('信封顶层键序 = config, memory, taste, skills, permissionMode, mode, params(threadId 由 forwardToCC 注入)', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(Object.keys(body),
    ['config', 'memory', 'taste', 'skills', 'permissionMode', 'mode', 'params']);
});

test('config 段伪装为指纹同源设备:workingDir/environment 用 DEVICE_PROFILE,不泄漏宿主机', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.config.workingDir, DEVICE_PROFILE.projectDir);
  assert.equal(body.config.environment, DEVICE_PROFILE.platform);
  assert.equal(body.config.isGitRepo, false);
  assert.equal(body.config.recentCommits.length, 0);
});

test('skills 发 null(CLI 形态),不是空串也不是缺键', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('skills' in body, true);
  assert.equal(body.skills, null);
});

test('params 常量:CC API 总是 stream=true;model 缺省 deepseek/deepseek-v4-flash;max_tokens 缺省 64000', () => {
  const body = buildCcRequest({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.params.stream, true);
  assert.equal(body.params.model, 'deepseek/deepseek-v4-flash');
  assert.equal(body.params.max_tokens, 64000);
});

test('max_tokens 钳制到 200000', () => {
  const body = buildCcRequest({ model: 'm', max_tokens: 999999, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.params.max_tokens, 200000);
});

test('system 用块数组,非末块补 \\n(对齐 CLI toWireSystem)', () => {
  const body = buildCcRequest({ model: 'm', messages: [
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'hi' },
  ] });
  assert.deepEqual(body.params.system, [
    { type: 'text', text: 'A\n' },
    { type: 'text', text: 'B' },
  ]);
});

test('system 块上的 cache_control 逐块保留', () => {
  const body = buildCcRequest({ model: 'm', messages: [
    { role: 'system', content: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: 'hi' },
  ] });
  assert.deepEqual(body.params.system[0].cache_control, { type: 'ephemeral' });
});

test('prompt_cache_key 且客户端未打断点 → 断点落 system 末块(缓存前缀)', () => {
  const body = buildCcRequest({ model: 'm', prompt_cache_key: 'k', messages: [
    { role: 'system', content: 'S' }, { role: 'user', content: 'hi' },
  ] });
  assert.deepEqual(body.params.system.at(-1).cache_control, { type: 'ephemeral' });
});

test('无 system 时发空格占位(issue #17:阻止上游注入 ~7.5K 默认提示词)', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(body.params.system, [{ type: 'text', text: ' ' }]);
});

test('tools 空数组也下发(CLI 的 toWireTools,空数组与缺键在 wire 上可观测)', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('tools' in body.params, true);
  assert.deepEqual(body.params.tools, []);
});

test('tools 形态:name/description/input_schema,没有 type 字段', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [
    { type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: {} } } },
  ] });
  assert.deepEqual(body.params.tools, [
    { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.equal('type' in body.params.tools[0], false);
});

test('工具名按 CLI 别名表重写:bash_output→shell_output、tool_search→search_tools', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [
    { type: 'function', function: { name: 'bash_output', parameters: {} } },
    { type: 'function', function: { name: 'tool_search', parameters: {} } },
  ] });
  assert.equal(body.params.tools[0].name, 'shell_output');
  assert.equal(body.params.tools[1].name, 'search_tools');
});

test('image_url(data URI)→ CC image 块,带 mimeType;非 data URI 不带 mimeType', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'user', content: [
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
  ] }] });
  const parts = body.params.messages[0].content;
  assert.deepEqual(parts[1], { type: 'image', image: 'data:image/png;base64,AAAA', mimeType: 'image/png' });
  assert.deepEqual(parts[2], { type: 'image', image: 'https://example.com/a.png' });
});

test('assistant 消息次序:reasoning 最前,其次 text,最后 tool-call(对齐 CC 抓包)', () => {
  const body = buildCcRequest({ model: 'm', messages: [
    { role: 'assistant', reasoning_content: 'think', content: 'answer', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } },
    ] },
  ] });
  const parts = body.params.messages[0].content;
  assert.deepEqual(parts.map(p => p.type), ['reasoning', 'text', 'tool-call']);
  assert.deepEqual(parts[2], {
    type: 'tool-call', toolCallId: 'call_1', toolName: 'Read',
    input: { path: 'a' },
  });
});

test('tool 消息 → tool-result 块:toolName 经 assistant tool_calls 反查;字符串 arguments 解析为对象', () => {
  const body = buildCcRequest({ model: 'm', messages: [
    { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'Bash', content: 'ok' },
  ] });
  const toolMsg = body.params.messages[1];
  assert.deepEqual(toolMsg.content[0], {
    type: 'tool-result', toolCallId: 'call_1', toolName: 'Bash',
    output: { type: 'text', value: 'ok' },
  });
});

test('tool 输出为块数组时只取文本块并以 \\n 拼接(toWireToolOutput)', () => {
  const body = buildCcRequest({ model: 'm', messages: [
    { role: 'tool', tool_call_id: 'c1', content: [
      { type: 'text', text: 'line1' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,X' } }, { type: 'text', text: 'line2' },
    ] },
  ] });
  assert.equal(body.params.messages[0].content[0].output.value, 'line1\nline2');
});

test('tool_choice 映射:auto/none/required→auto/none/any;function 对象→{type:tool,name}', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  assert.deepEqual(buildCcRequest({ ...base, tool_choice: 'required' }).params.tool_choice, { type: 'any' });
  assert.deepEqual(buildCcRequest({ ...base, tool_choice: 'none' }).params.tool_choice, { type: 'none' });
  assert.deepEqual(buildCcRequest({ ...base, tool_choice: { type: 'function', function: { name: 'f' } } }).params.tool_choice,
    { type: 'tool', name: 'f' });
});

test('temperature / reasoning_effort 原样透传;未给时不下发', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const withAll = buildCcRequest({ ...base, temperature: 0.2, reasoning_effort: 'high' });
  assert.equal(withAll.params.temperature, 0.2);
  assert.equal(withAll.params.reasoning_effort, 'high');
  const bare = buildCcRequest(base);
  assert.equal('temperature' in bare.params, false);
  assert.equal('reasoning_effort' in bare.params, false);
});

test('未知 role 兜底归一化为 user(避免 CC 校验拒绝)', () => {
  const body = buildCcRequest({ model: 'm', messages: [{ role: 'weird', content: 'x' }] });
  assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
});

// ── B) HTTP 全链路 ───────────────────────────────────────────
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

test('wire:合法 UUID 的 x-session-id → threadId 注入且顶层键序重排为 CLI 形态', async () => {
  const s = await setup();
  try {
    const uuid = randomUUID();
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { ...AUTH, 'x-session-id': uuid });
    const g = s.mock.lastGenerate();
    assert.equal(g.body.threadId, uuid);
    assert.deepEqual(Object.keys(g.body),
      ['config', 'memory', 'taste', 'skills', 'permissionMode', 'threadId', 'mode', 'params']);
  } finally { await s.close(); }
});

test('wire:非 UUID 的 session id → 整个 threadId 键省略(CLI 的 toWireThreadId)', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { ...AUTH, 'x-session-id': 'my-custom-session-123' });
    const g = s.mock.lastGenerate();
    assert.equal('threadId' in g.body, false);
    assert.equal(g.headers['x-session-id'], 'my-custom-session-123');
  } finally { await s.close(); }
});

test('wire:请求头对齐 CLI(User-Agent=cli、x-cli-environment、x-project-slug、Bearer、无 x-co-flag)', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    const h = s.mock.lastGenerate().headers;
    assert.equal(h['user-agent'], 'cli');
    assert.equal(h['x-cli-environment'], 'production');
    assert.ok(h['x-project-slug']);
    assert.equal(h['authorization'], 'Bearer user_test');
    assert.equal(h['x-co-flag'], undefined);
    assert.ok(h['traceparent']); // 00-<32hex>-<16hex>-01
  } finally { await s.close(); }
});

test('wire:zdr 默认关;请求带 x-cmd-zdr:1 → 上游收到 x-cmd-zdr:1', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    assert.equal(s.mock.lastGenerate().headers['x-cmd-zdr'], undefined);
    await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { ...AUTH, 'x-cmd-zdr': '1' });
    assert.equal(s.mock.lastGenerate().headers['x-cmd-zdr'], '1');
  } finally { await s.close(); }
});

test('wire:上游 402 → 代理报 429 rate_limit_error(CCS_STATUS_MAP:payment required → rate limit)', async () => {
  const s = await setup({ status: 402 });
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    assert.equal(r.status, 429);
    const json = await r.json();
    assert.equal(json.error.type, 'rate_limit_error');
  } finally { await s.close(); }
});

test('wire:正常 finish 但 outputTokens=0 → 429(零输出转可重试,防异常计费)', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-end"}',
    '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":9,"outputTokens":0,"cachedInputTokens":0}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    assert.equal(r.status, 429);
    const json = await r.json();
    assert.equal(json.error.type, 'rate_limit_error');
    assert.equal(json.retry_after, 10);
  } finally { await s.close(); }
});

test('wire:未知 finishReason 原样透出(chat 非流式,下游自行处理)', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"hi"}',
    '{"type":"text-end"}',
    '{"type":"finish","finishReason":"weird_custom","totalUsage":{"inputTokens":9,"outputTokens":3,"cachedInputTokens":0}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.choices[0].finish_reason, 'weird_custom');
  } finally { await s.close(); }
});

test('wire(/v1/messages):system → params.system 块;tool_result 优先于同消息文本入队', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/messages', {
      model: 'm', max_tokens: 100, system: 'You are helpful',
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file1\nfile2' },
          { type: 'text', text: 'now summarize' },
        ] },
      ],
    }, { 'x-api-key': 'user_test' });
    const g = s.mock.lastGenerate();
    assert.deepEqual(g.body.params.system, [{ type: 'text', text: 'You are helpful' }]);
    const msgs = g.body.params.messages;
    // 次序:user → assistant(tool-call) → tool(tool-result) → user(文本)
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
    assert.deepEqual(msgs[1].content, [{
      type: 'tool-call', toolCallId: 'toolu_1', toolName: 'Bash', input: { cmd: 'ls' },
    }]);
    assert.deepEqual(msgs[2].content, [{
      type: 'tool-result', toolCallId: 'toolu_1', toolName: 'Bash',
      output: { type: 'text', value: 'file1\nfile2' },
    }]);
    assert.deepEqual(msgs[3].content, [{ type: 'text', text: 'now summarize' }]);
  } finally { await s.close(); }
});

test('wire(/v1/messages):Anthropic image 块 → data URI → CC image 块', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/messages', {
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'text', text: 'what is this' },
      ] }],
    }, { 'x-api-key': 'user_test' });
    const parts = s.mock.lastGenerate().body.params.messages[0].content;
    assert.deepEqual(parts[0], { type: 'image', image: 'data:image/jpeg;base64,QUJD', mimeType: 'image/jpeg' });
    assert.deepEqual(parts[1], { type: 'text', text: 'what is this' });
  } finally { await s.close(); }
});

test('wire:上游漏发 totalUsage 但有内容 → 200(零输出判定按内容,不误杀)', async () => {
  // 上游偶发不回 usage:旧逻辑 (usage?.outputTokens ?? 0) === 0 会把有完整文本的
  // 响应误报 429(流式则先吐完正文再追加 429 error,SDK 重试造成重复计费)
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"hello"}',
    '{"type":"text-end"}',
    '{"type":"finish","finishReason":"stop"}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.choices[0].message.content, 'hello');

    const r2 = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, AUTH);
    assert.equal(r2.status, 200);
    assert.match(r2.headers.get('content-type') || '', /text\/event-stream/);
    const body = await r2.text();
    assert.match(body, /hello/);
    assert.match(body, /data: \[DONE\]/);
    assert.doesNotMatch(body, /zero output tokens/);
  } finally { await s.close(); }
});
