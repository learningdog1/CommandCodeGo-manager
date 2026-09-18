// Command Code CLI 登录凭证检测与导入(G4)。
// 背景(调研结论,2026-09):Go 套餐没有 Provider API 权限,但 CLI(cmd login)登录后
// 持有一把 user_* 密钥,存在 ~/.commandcode/auth.json(0600),它在代理所走的
// /alpha/generate 端点上完全可用——这就是 Go 订阅可被反代的原理。
// 桌面/本机部署时可直接读取该文件帮用户一键导入,免去手工找 key。
// auth.json 的内部字段结构官方未公开,故做防御性深度遍历:任何位置出现的
// user_[a-zA-Z0-9_-]+ 字符串都视为候选,取最长者(避免截断片段)。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 测试可用 CCP_CLI_AUTH_FILE 覆盖路径
export const cliAuthPath = () =>
  process.env.CCP_CLI_AUTH_FILE ?? join(homedir(), '.commandcode', 'auth.json');

const USER_KEY_RE = /user_[a-zA-Z0-9_-]{8,}/g;

/** 从任意文本提取全部 user_* 密钥(按出现顺序去重)。批量粘贴导入用。 */
export function extractUserKeys(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(USER_KEY_RE)) out.add(m[0]);
  return [...out];
}

/** 深度遍历 JSON 值,收集所有 user_* 形态的字符串。 */
function collectKeys(value, out) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(USER_KEY_RE)) out.add(m[0]);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectKeys(v, out);
  }
}

/**
 * 检测 CLI 登录凭证。
 * 返回 { installed: false, path } 或 { installed: true, key, keyMask, path }。
 * 任何读取/解析异常都按「未安装」处理,不向上抛。
 */
export function detectCliAuth(maskKey) {
  const path = cliAuthPath();
  try {
    const raw = readFileSync(path, 'utf-8');
    const keys = new Set();
    try {
      collectKeys(JSON.parse(raw), keys);
    } catch {
      collectKeys(raw, keys); // 非 JSON:全文正则兜底
    }
    if (keys.size === 0) return { installed: false, path };
    // 取最长候选(最完整的 key)
    const key = [...keys].sort((a, b) => b.length - a.length)[0];
    return { installed: true, key, keyMask: maskKey(key), path };
  } catch {
    return { installed: false, path };
  }
}
