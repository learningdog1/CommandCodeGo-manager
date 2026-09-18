// 配置层:默认值 + data/config.json 读写 + 环境变量覆写。
// 派生自 MAXeaglet/commandcode-proxy(MIT,基线 9bdfafc)的 loadConfig ——
// 环境变量覆写与键名逐字保留;差异:①配置文件从「脚本同目录」改为「数据目录
// {CCP_DATA_DIR}/config.json」,首启自动落一份默认配置;②默认 host 收紧为
// 127.0.0.1(参考是 0.0.0.0;本项目在 DB 里存密钥);③新增三个
// 本项目键(adminTokenHash / allowDirectUpstreamKey / logRetentionDays)。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { appDir } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 数据目录:CCP_DATA_DIR 覆盖,默认 <运行基目录>/data(SQLite 库与配置都放这里)。
// appDir = 入口脚本目录:npm start 为项目根,bundle 单文件为分发目录。
export const dataDir = process.env.CCP_DATA_DIR
  ? resolve(process.env.CCP_DATA_DIR)
  : join(appDir, 'data');

const configPath = () => resolve(dataDir, 'config.json');

export function defaults() {
  return {
    port: 3050,
    host: '127.0.0.1',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    apiKey: '',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,  // 5 minutes
    accountUsageRefreshMs: 30 * 60 * 1000, // 账号用量自动刷新间隔(0 = 关闭;面板手动刷新不受影响)
    zdr: false,
    cliMode: 'agent', // 信封 mode。服务端枚举（真机 400 报出来的）：agent|learning|custom-agent|custom-agent-create|title-gen|tool-desc|compact|vision
    cliSessionMode: 'interactive', // lifecycle metadata 的 mode —— 注意这是另一个枚举：interactive | non-interactive
    fingerprintSalt: '',
    deviceProjectDir: '', // 伪造的项目目录（留空则用内置的 C:\Users\dev\projects\app） // 改这个值 = 让所有账号换一台设备（见设备指纹注释）
    emptySystemPlaceholder: true, // 无 system prompt 时发空格占位，阻止 CC 上游注入 ~7.5K token 默认提示词（issue #17）
    // ── 本项目新增键(参考实现没有) ──
    adminTokenHash: '',           // [已废弃 H1]管理界面已取消 token;键仅为兼容旧配置文件保留,不再使用
    allowDirectUpstreamKey: true, // 是否放行 user_* 上游密钥直通(参考项目的用法),关闭后只认 sk-ccp-*
    logRetentionDays: 30,         // 请求日志保留天数,定时清理
  };
}

// 允许写入配置文件的键(环境变量覆写值不回写,避免把部署参数烤死进文件)
const WRITABLE_KEYS = new Set(Object.keys(defaults()));

function readConfigFile() {
  const cfg = defaults();
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    Object.assign(cfg, JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[config] Failed to parse config.json:', e.message);
  }
  return cfg;
}

function loadConfig() {
  mkdirSync(dataDir, { recursive: true });
  const cfg = readConfigFile();
  // 首启:数据目录里没有配置文件时落一份默认值,便于直接编辑
  if (!existsSync(configPath())) {
    try { writeFileSync(configPath(), JSON.stringify(defaults(), null, 2) + '\n'); } catch {}
  }

  // 环境变量覆写
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.CC_API_BASE) cfg.apiBase = process.env.CC_API_BASE;
  if (process.env.PROJECT_SLUG) cfg.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.LOG_FILE) cfg.logFile = process.env.LOG_FILE;
  if (process.env.CC_USE_PROVIDER_MODELS) cfg.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';
  if (process.env.CMD_ZDR !== undefined) cfg.zdr = process.env.CMD_ZDR === '1';
  if (process.env.CC_FINGERPRINT_SALT !== undefined) cfg.fingerprintSalt = process.env.CC_FINGERPRINT_SALT;
  if (process.env.CC_DEVICE_PROJECT_DIR) cfg.deviceProjectDir = process.env.CC_DEVICE_PROJECT_DIR;
  if (process.env.CC_CLI_MODE) cfg.cliMode = process.env.CC_CLI_MODE;
  if (process.env.CC_CLI_SESSION_MODE) cfg.cliSessionMode = process.env.CC_CLI_SESSION_MODE;
  if (process.env.CC_EMPTY_SYSTEM_PLACEHOLDER) cfg.emptySystemPlaceholder = process.env.CC_EMPTY_SYSTEM_PLACEHOLDER !== 'false';

  return cfg;
}

const CFG = loadConfig();

/** 把补丁合并进 data/config.json 并返回写入后的文件内容(不含 env 覆写)。 */
function saveConfig(patch) {
  const current = readConfigFile();
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (WRITABLE_KEYS.has(k)) current[k] = v;
  }
  writeFileSync(configPath(), JSON.stringify(current, null, 2) + '\n');
  return current;
}

export { CFG, loadConfig, saveConfig, configPath };
