// 桌面版桥接(issue #11):页面跑在反代服务上,Electron 打开时由 preload
// 注入 window.ccpDesktop(更新检查/下载/重启更新);浏览器/容器部署没有此对象,
// 一切桌面专属 UI 依 desktop 桥是否存在自行退隐。
export interface DesktopUpdateState {
  supported: boolean;
  canSelfUpdate: boolean; // Windows 打包版才支持一键「重启以更新」
  platform: string;
  currentVersion: string;
  status: 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'applying';
  checkedAt: number | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  notes: string | null;
  asset: { kind: string; name: string; url: string; size: number; digest: string } | null;
  progress: number | null; // 下载进度 0-1
  error: string | null;
  updatedTo?: string;      // 仅一次性广播:更新后首次健康启动
}

export interface CcpDesktop {
  isDesktop: true;
  platform: string;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkUpdate(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  applyUpdate(): Promise<boolean>;
  revealDownload(): Promise<void>;
  openReleasePage(): Promise<void>;
  onUpdateState(cb: (s: DesktopUpdateState) => void): () => void;
}

declare global {
  interface Window { ccpDesktop?: CcpDesktop }
}

export const desktop = typeof window !== 'undefined' ? window.ccpDesktop : undefined;
