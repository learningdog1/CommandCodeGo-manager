// issue #10：response_format / text.format 不能静默丢弃。
// 上游 agent 协议没有结构化输出字段，json_object / json_schema 无法送达 ——
// 必须明确 400（带 param，OpenAI 风格 error body），让客户端的降级分支
// （收到 400 后改走提示词软路径）能被触发；{"type":"text"} 是缺省无约束
// 形态，放行照常 200。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

const JSON_OBJECT_REQ = {
  model: 'm', max_tokens: 300, messages: [{ role: 'user', content: '列出三种水果' }],
  response_format: { type: 'json_object' },
};
const JSON_SCHEMA_REQ = {
  model: 'm', max_tokens: 300, messages: [{ role: 'user', content: '列出三种水果' }],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'f', strict: true,
      schema: { type: 'object', properties: { fruit: { type: 'string' } }, required: ['fruit'], additionalProperties: false },
    },
  },
};

// ── /v1/chat/completions ─────────────────────────────

test('#10 chat：response_format=json_object → 400 invalid_request_error + param，不上转发上游', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', JSON_OBJECT_REQ, AUTH);
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.type, 'invalid_request_error');
    assert.equal(json.error.param, 'response_format');
    assert.ok(json.error.message.includes('response_format'), 'message 应点名字段本身');
    assert.equal(s.mock.generateCount(), 0, '被拒绝的请求不应消耗上游额度');
  } finally { await s.close(); }
});

test('#10 chat：response_format=json_schema(strict) → 400，与 json_object 同路径', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', JSON_SCHEMA_REQ, AUTH);
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.param, 'response_format');
    assert.equal(s.mock.generateCount(), 0);
  } finally { await s.close(); }
});

test('#10 chat：response_format={"type":"text"} 是缺省无约束形态 → 放行 200', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'text' } }, AUTH);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.choices[0].message.content, 'hello');
  } finally { await s.close(); }
});

test('#10 chat：stream 请求带 response_format 也必须在开流前 400（JSON，不是 SSE）', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { ...JSON_OBJECT_REQ, stream: true }, AUTH);
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const json = await r.json();
    assert.equal(json.error.param, 'response_format');
    assert.equal(s.mock.generateCount(), 0);
  } finally { await s.close(); }
});

// ── /v1/responses（text.format 是同族字段）─────────────

test('#10 responses：text.format=json_object → 400 + param=text.format', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/responses',
      { model: 'm', input: '列出三种水果', text: { format: { type: 'json_object' } } }, AUTH);
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.type, 'invalid_request_error');
    assert.equal(json.error.param, 'text.format');
    assert.equal(s.mock.generateCount(), 0);
  } finally { await s.close(); }
});

test('#10 responses：text.format=json_schema → 400', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/responses', {
      model: 'm', input: '列出三种水果',
      text: { format: { type: 'json_schema', name: 'f', strict: true, schema: { type: 'object' } } },
    }, AUTH);
    assert.equal(r.status, 400);
    const json = await r.json();
    assert.equal(json.error.param, 'text.format');
    assert.equal(s.mock.generateCount(), 0);
  } finally { await s.close(); }
});

test('#10 responses：text.format=text / 不带 text → 放行 200', async () => {
  const s = await setup();
  try {
    const r1 = await s.proxy.post('/v1/responses',
      { model: 'm', input: 'hi', text: { format: { type: 'text' } } }, AUTH);
    assert.equal(r1.status, 200);
    const r2 = await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH);
    assert.equal(r2.status, 200);
    assert.equal(s.mock.generateCount(), 2);
  } finally { await s.close(); }
});

// ── 判定函数单元直测（边界形态）────────────────────────

process.env.CCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-rf-'));
process.on('exit', () => { try { rmSync(process.env.CCP_DATA_DIR, { recursive: true, force: true }); } catch {} });
const { unsupportedResponseFormatError } = await import('../src/protocol/envelope.mjs');

test('#10 判定函数：undefined / null / 非对象 / 缺 type → 放行 null', () => {
  assert.equal(unsupportedResponseFormatError(undefined, 'response_format'), null);
  assert.equal(unsupportedResponseFormatError(null, 'response_format'), null);
  // 非对象形态(如裸字符串)不是合法 response_format,但也无从判定约束 ——
  // 放行,与旧行为一致,不为畸形输入新增失败面
  assert.equal(unsupportedResponseFormatError('json_object', 'response_format'), null);
  assert.equal(unsupportedResponseFormatError({}, 'response_format'), null); // 缺 type = 缺省无约束
});

test('#10 判定函数：未知 type（未来新增）→ 同样 400，宁可明确拒绝也不静默吞', () => {
  const err = unsupportedResponseFormatError({ type: 'grammar' }, 'response_format');
  assert.equal(err.error.type, 'invalid_request_error');
  assert.equal(err.error.param, 'response_format');
});
