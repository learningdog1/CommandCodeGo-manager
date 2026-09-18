// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的单文件 proxy.mjs —— 纯移动拆分,实现与原注释逐字保留。
import crypto from 'crypto';
import { CFG } from '../config.mjs';
import { log } from '../log.mjs';
import { CC_VERSION } from './upstream.mjs';
import { getOrCreateKeyState } from './keystate.mjs';

// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动；未全成功 1~5min 后重试） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动
const INIT_RETRY_MS   = 60 * 1000;             // 上报未全成功:1min 后重试
const INIT_RETRY_JITTER_MS = 4 * 60 * 1000;    // +最多 4min 抖动(共 1~5min)

async function ensureInitialized(apiKey, signal) {
  const state = getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    // 并行发两个预请求
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': CC_VERSION,
      ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
    };
    const fingerprint = state.fingerprint || {};

    // 两个 fetch 的失败都被各自 catch 消化(只记 state 不外抛),所以用返回值收集本次
    // 尝试的真实成败 —— 中断(AbortError)也算未完成,一并交给短间隔重试。
    const results = await Promise.all([
      fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      }).then(r => {
        state.fingerprintReport = { ts: Date.now(), ok: r.ok, ...(r.ok ? {} : { status: r.status }) };
        if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status });
        else log('info', 'Fingerprint recorded');
        return r.ok;
      }).catch(e => {
        if (e.name !== 'AbortError') {
          state.fingerprintReport = { ts: Date.now(), ok: false, error: e.message };
          log('warn', 'Fingerprint record error', { error: e.message });
        }
        return false;
      }),

      fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,
            cliVersion: CC_VERSION,
            mode: CFG.cliSessionMode || 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }).then(r => {
        state.lifecycleReport = { ts: Date.now(), ok: r.ok, ...(r.ok ? {} : { status: r.status }) };
        if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status });
        else log('info', 'Lifecycle event sent');
        return r.ok;
      }).catch(e => {
        if (e.name !== 'AbortError') {
          state.lifecycleReport = { ts: Date.now(), ok: false, error: e.message };
          log('warn', 'Lifecycle event error', { error: e.message });
        }
        return false;
      }),
    ]);

    if (results.every(Boolean)) {
      // 全成功：8h + 2h 随机抖动
      const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
      state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
      log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
    } else {
      // 有失败:短间隔重试。之前失败也照推 8h,一次网络抖动会让该 key 的指纹上报"消失"大半天
      const retryMs = INIT_RETRY_MS + Math.floor(Math.random() * INIT_RETRY_JITTER_MS);
      state.nextInitAt = Date.now() + retryMs;
      log('warn', 'Fingerprint/lifecycle not fully reported, will retry', { retryIn: `${Math.round(retryMs / 60000)}min` });
    }
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

export { ensureInitialized };
