// CommandCodeGo Manager 桌面版主进程(Electron)。
// 职责:单实例 → 端口扫描 → 以子进程(ELECTRON_RUN_AS_NODE)
// 启动反代服务(esbuild 单文件 bundle)→ 等 /health → 打开管理界面窗口 + 托盘常驻。
// 服务与界面代码与命令行版完全同一份产物,桌面壳只做进程管理与窗口。
const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const isSmoke = process.argv.includes('--smoke');
const PRODUCT = 'CommandCodeGo Manager';

// ── 路径 ────────────────────────────────────────────────────
const dataDir = path.join(app.getPath('userData'), 'data');
const serverBundle = app.isPackaged
  ? path.join(process.resourcesPath, 'commandcodego-manager.mjs')
  : path.join(__dirname, '..', 'dist', 'commandcodego-manager.mjs');
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'build', 'icon.png');

// ── 单实例 ─────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  console.error('已有实例在运行');
  app.quit();
}

// ── 端口:配置首选,占用则向后扫描 ────────────────────────────
function readConfig() {
  try { return JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf-8')); }
  catch { /* 首启无配置 */ }
  return {};
}

function readPreferredPort() {
  const p = Number(readConfig().port);
  if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
  return 3050;
}

// 监听地址随配置(issue #2):此前无条件注入 HOST=127.0.0.1,把 config.json
// 里的 host(如 0.0.0.0/局域网 IP)整个覆盖掉,局域网设备永远访问不到。
function readPreferredHost() {
  const h = typeof readConfig().host === 'string' ? readConfig().host.trim() : '';
  return h || '127.0.0.1';
}

// 管理窗口/探活连接用的地址:通配监听(0.0.0.0/::)含回环,连 127.0.0.1 即可;
// 绑定到具体 IP 时只能连该 IP;裸 IPv6 字面量要加方括号才能进 URL。
function uiHostOf(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function probePort(port, host) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function pickPort(host) {
  const base = readPreferredPort();
  for (let p = base; p < base + 20; p++) {
    if (await probePort(p, host)) return p;
  }
  throw new Error(`端口 ${base}~${base + 19} 均被占用`);
}

// ── 服务子进程 ─────────────────────────────
let serverChild = null;
let serverPort = null;

function startServer(port, host) {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(serverBundle)) {
    throw new Error(`未找到服务文件:${serverBundle}(先在项目根执行 npm run bundle 与 npm run build:web)`);
  }
  serverChild = spawn(process.execPath, [serverBundle], {
    env: {
      ...process.env,
      // Electron 二进制以纯 Node 模式运行 bundle(内嵌 Node ≥22.5,node:sqlite 可用)
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: host, // 跟随 config.json 的 host(此前硬编码 127.0.0.1,见 issue #2)
      CCP_DATA_DIR: dataDir,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[server:${serverChild.pid}]`;
  serverChild.stdout.on('data', d => process.stdout.write(`${tag} ${d}`));
  serverChild.stderr.on('data', d => process.stderr.write(`${tag} ${d}`));
  serverChild.on('exit', (code) => {
    console.log(`${tag} exited code=${code}`);
    serverChild = null;
  });
}

function stopServer() {
  if (serverChild) { try { serverChild.kill(); } catch { /* 已退出 */ } serverChild = null; }
}

async function waitHealthy(uiHost, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverChild === null) throw new Error('服务进程意外退出,详见日志');
    try {
      const r = await fetch(`http://${uiHost}:${port}/health`);
      if (r.ok) return true;
    } catch { /* 尚未就绪 */ }
    // 探活极廉价,高频轮询把「就绪→开窗」的空转从最长 250ms 压到 60ms
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('服务启动超时(/health 未就绪)');
}

// ── 窗口与托盘 ─────────────────────────────────────────────
let win = null;
let tray = null;
// 启动 splash:内联 data: URL,零网络零磁盘,窗口创建即显示。
// 视觉与正式界面同底色(#f3f5f9 + teal 品牌色),服务就绪换页不跳变。
const SPLASH_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><style>' +
  'html{background:#f3f5f9;overflow:hidden}' +
  '.wrap{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font:500 13px -apple-system,"PingFang SC",sans-serif;color:#51607a}' +
  '.logo{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#0d9488,#0284c7);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(13,148,136,.25)}' +
  '.logo svg{width:26px;height:26px}' +
  '.spin{width:22px;height:22px;border-radius:50%;border:2.5px solid #c9d3e2;border-top-color:#0d9488;animation:r .8s linear infinite}' +
  '@keyframes r{to{transform:rotate(360deg)}}' +
  '</style><div class="wrap">' +
  '<div class="logo"><svg viewBox="0 0 32 32" fill="none"><path d="M8 12l5 4-5 4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 21h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg></div>' +
  '<div>CommandCodeGo Manager</div><div class="spin"></div><div>服务启动中…</div>' +
  '</div>');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f3f5f9',
    title: PRODUCT,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 关窗 = 隐藏到托盘,服务保持运行(托盘「退出」才真正结束)
  win.on('close', e => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

/** 打开(或复用)窗口并载入管理界面;服务未就绪时先落 splash。
 *  已载入正式页面的存活窗口只做 show/focus,不重复 loadURL(避免整页刷新)。 */
let appLoaded = false;
function showWindow(uiHost, port) {
  let fresh = false;
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
  } else {
    createWindow();
    fresh = true;
    win.loadURL(SPLASH_URL); // 新建窗口先给 splash,等调用方决定何时载入正式页面
  }
  if (fresh || !appLoaded) {
    appLoaded = true;
    win.loadURL(`http://${uiHost}:${port}/`);
  }
}

function createTray(uiHost, port) {
  if (!existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开管理界面', click: () => showWindow(uiHost, port) },
    { label: `服务地址 http://${uiHost}:${port}`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win && !win.isDestroyed() ? (win.isVisible() ? win.focus() : win.show()) : showWindow(uiHost, port)));
}

function setupMenu() {
  // 精简菜单:保留编辑快捷键与重载,去掉默认的多余项
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', e => e.preventDefault?.()); // 托盘常驻,不随窗口退出

// before-quit 必须先置 isQuitting:否则窗口 close 的 preventDefault(隐藏到托盘)
// 会取消整个 quit 流程,Cmd-Q / 系统退出 / SIGTERM 全部失效
app.on('before-quit', () => { app.isQuitting = true; stopServer(); });
app.on('quit', () => stopServer());
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

// ── 启动流程 ───────────────────────────────────────────────
// 窗口先行:whenReady 立即建窗显示内联 splash(不依赖服务),
// 服务健康后无缝换载管理界面 —— 不再让用户等完整串行链
// (服务启动 → 健康检查 → 建窗 → 加载页面)才见到窗口。
async function bootstrap() {
  if (!isSmoke) {
    setupMenu();
    createWindow();
    win.loadURL(SPLASH_URL);
  }

  const host = readPreferredHost();       // 跟随 config.json(issue #2)
  const uiHost = uiHostOf(host);          // 窗口/探活连接地址(通配 → 127.0.0.1)
  const port = await pickPort(host);
  serverPort = port;
  startServer(port, host);
  await waitHealthy(uiHost, port);

  if (isSmoke) {
    console.log(`SMOKE-OK port=${port} host=${host} ui=${uiHost} bundle=${serverBundle}`);
    app.exit(0);
    return;
  }

  createTray(uiHost, port);
  // 窗口可能已被用户关掉(隐藏)甚至销毁,loadURL 前判活
  if (win && !win.isDestroyed()) { appLoaded = true; win.loadURL(`http://${uiHost}:${port}/`); }
}

app.whenReady().then(() => {
  bootstrap().catch(err => {
    console.error('启动失败:', err);
    if (isSmoke) { console.error('SMOKE-FAIL', err.message); app.exit(1); return; }
    dialog.showErrorBox('启动失败', String(err.message || err));
    app.exit(1);
  });
});
