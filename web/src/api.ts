// Admin API 客户端(H1:管理界面已取消 token,API 仅监听回环地址,
// 服务端以 Origin 校验挡跨站修改请求)。
// 所有页面的数据获取/变更都走这里,类型即前后端契约。

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch { /* 保留原文 */ }
    throw new ApiError(String(msg) || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

// ── 契约类型(与 src/admin/api.mjs 对应) ────────────────────
export interface Overview {
  version: string;
  startedAt: number;
  uptimeSec: number;
  host: string;
  port: number;
  apiBase: string;
  zdr: boolean;
  inflight: number;
  degraded: boolean;
  keys: {
    upstream: { total: number; active: number };
    client: { total: number; active: number };
  };
  today: { requests: number; errors: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  modelCount: number;
  drift: { lastCheckedAt: number | null; latestVersion: string | null; protocolVersion: string; changed: boolean; lastError: string | null };
}

export interface RequestRow {
  id: number; ts: number; endpoint: string; proxy_key: string | null; upstream_key_id: number | null;
  model: string | null; status_code: number | null; stream: number; duration_ms: number | null;
  input_tokens: number; output_tokens: number; cached_tokens: number;
  finish_reason: string | null; error_type: string | null; client_disconnected: number;
}

export interface UpstreamKey {
  id: number; name: string; api_key: string; status: string;
  created_at: number; last_used_at: number | null;
}

export interface ClientKey {
  id: number; name: string; key_prefix: string; upstream_key_id: number;
  upstream_name?: string | null; status: string; created_at: number; last_used_at: number | null;
}

export interface UsageRow {
  day?: string; model?: string; key_id?: number | null; key_name?: string;
  input_tokens: number; output_tokens: number; cached_tokens: number; requests: number;
}

export interface Settings {
  port?: number; host?: string; apiBase?: string; projectSlug?: string;
  logFile?: string; logLevel?: string; zdr?: boolean; useProviderModels?: boolean;
  modelRefreshIntervalMs?: number; accountUsageRefreshMs?: number; allowDirectUpstreamKey?: boolean; logRetentionDays?: number;
  emptySystemPlaceholder?: boolean; dataDir?: string;
}

export interface ModelItem {
  id: string; object?: string; created?: number; owned_by?: string;
  plan?: 'go' | 'pro' | 'goat' | 'max' | 'team' | null;
}

export interface FingerprintReport {
  ts: number; ok: boolean; status?: number; error?: string;
}

export interface FingerprintKeyRow {
  keyPrefix: string;
  createdAt: number | null;
  thumbmark: string | null;
  machineIdHash: string | null;
  macCount: number;
  osUserHash: string | null;
  hostnameHash: string | null;
  gitEmailHash: string | null;
  cpuModel: string | null;
  cpuCount: number | null;
  memGiB: number | null;
  timezone: string | null;
  nextInitAt: number | null;
  fingerprintReport: FingerprintReport | null;
  lifecycleReport: FingerprintReport | null;
}

export interface FingerprintsInfo {
  profile: {
    platform: string; arch: string; osRelease: string;
    projectDir: string; projectSlug: string;
    fingerprintSalt: boolean; refreshEvery: string;
  };
  keys: FingerprintKeyRow[];
}

// ── 账号用量(/alpha/billing + /alpha/usage 的管理侧投影) ──
export interface WindowLimit {
  used: number; cap: number; exceeded: boolean; resetAt: number;
}
export interface AccountUsageData {
  whoami: { userName: string | null; email: string | null; orgId: string | null };
  plan: {
    id: string | null; name: string | null; status: string | null; cancelAtPeriodEnd: boolean;
    currentPeriodStart: string | null; currentPeriodEnd: string | null;
    daysRemaining: number | null; monthlyTotal: number | null;
  } | null;
  credits: {
    monthly: number; purchased: number; free: number; totalRemaining: number; belowThreshold: boolean;
    monthlyTotal: number | null; monthlyUsed: number | null;
  } | null;
  windowLimits: { limited: boolean; exceeded: boolean | null; fiveHour: WindowLimit | null; weekly: WindowLimit | null } | null;
  period: {
    totalCount: number; completedCount: number; failedCount: number; successRate: number;
    totalCost: number; averageCost: number;
    totalTokensIn: number; totalTokensOut: number; totalTokens: number;
    totalCredits: number; totalMonthlyCredits: number; totalPurchasedCredits: number; totalFreeCredits: number;
    periodBasis: string | null;
  } | null;
}
export interface AccountUsageRow {
  id: number; name: string; status: string;
  fetchedAt: number | null; error: string | null; data: AccountUsageData | null;
  windowState?: { blocked: boolean; source: 'live' | 'usage' | 'manual' | null; window: string | null; until: number | null };
}

export const fetchAccountUsage = () => api<{ rows: AccountUsageRow[] }>('/admin/api/account-usage');
export const refreshAccountUsage = (id?: number) =>
  api<{ rows: AccountUsageRow[]; refreshed: number; failed: number }>('/admin/api/account-usage/refresh',
    { method: 'POST', body: id !== undefined ? { id } : {} });
export const switchAccount = (id: number, on: boolean) =>
  api<{ rows: AccountUsageRow[]; switched: 'away' | 'back' }>('/admin/api/account-usage/switch',
    { method: 'POST', body: { id, on } });

export const fetchOverview = () => api<Overview>('/admin/api/overview');
export const fetchLogs = (qs = '') => api<{ rows: RequestRow[]; total: number }>(`/admin/api/logs${qs}`);
export const fetchUsage = (qs = '') => api<{ rows: UsageRow[] }>(`/admin/api/usage${qs}`);
export const fetchUpstreamKeys = () => api<{ rows: UpstreamKey[] }>('/admin/api/upstream-keys');
export const batchImportUpstreamKeys = (text: string) =>
  api<{ created: { id: number; name: string }[]; existing: { id: number; name: string }[]; unmatchedLines: number }>(
    '/admin/api/upstream-keys/batch', { method: 'POST', body: { text } });
export const fetchClientKeys = () => api<{ rows: ClientKey[] }>('/admin/api/client-keys');
export const fetchSettings = () => api<Settings>('/admin/api/settings');
export const putSettings = (patch: Partial<Settings>) =>
  api<{ ok: boolean }>('/admin/api/settings', { method: 'PUT', body: patch });
export const refreshModels = () =>
  api<{ source: 'upstream' | 'builtin'; count: number; reason?: string }>('/admin/api/models/refresh', { method: 'POST' });
export const fetchFingerprints = () => api<FingerprintsInfo>('/admin/api/fingerprints');
