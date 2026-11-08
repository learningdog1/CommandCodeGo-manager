// 桌面版更新器(issue #11):GitHub Releases 检查 → 只提示不静默 →
// 用户确认后下载(sha256 校验)→ 「重启以更新」才落盘替换。
//
// 设计要点(对应 issue 验收):
// - 自动检查每 6h 一次;断网 / 限流 / 无权限一律静默跳过,手动检查才回显错误;
// - 数据红线:app.getPath('userData')/data(ccp.db + config.json + 日志)永不参与更新;
//   替换只动程序文件,且跳过安装目录里任何名为 data 的目录(老版本升级可能留下
//   resources\data junction,整目录覆盖会把数据分叉);
// - Windows 两种形态:NSIS 安装(目录里有 Uninstall *.exe)跑 Setup /S /D=目录;
//   Portable 用 release 附带的 Update zip 由独立 PowerShell 助手在应用退出后覆盖,
//   覆盖前把旧文件备份到 userData/rollback/<旧版本>/,失败自动还原;
// - macOS 产物未签名,不支持原位自更新:只做 检查+下载+Finder 揭示+打开发布页。
//
// 本文件顶层不 require electron(纯函数供 node --test 直接加载),
// electron 相关依赖经 createUpdater(ctx) 注入。
const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE_REPO = 'learningdog1/CommandCodeGo-manager';
const API_LATEST = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${RELEASE_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 自动检查间隔:6h(未认证限额 60 次/h,绰绰有余)
const FETCH_TIMEOUT_MS = 15000;

// ── 纯函数(有单测) ─────────────────────────────────────────
/** 'v0.2.14' / '0.2.14-beta.1' → 可比较版本对象;解析失败返回 null。 */
function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' };
}

/** 语义化比较:a>b → 1,相等 → 0,a<b → -1;任一解析失败按「不等且更大」处理返回 1(提示用户)。 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] > vb[k] ? 1 : -1;
  }
  // 无预发布 > 有预发布;预发布段按 semver 逐标识比较(数字<字母)
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  const pa = va.pre.split('.');
  const pb = vb.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 按平台/架构/安装形态从 release 资产里挑更新包;productName 与 electron-builder
 *  一致(空格在产物名里是点)。installForm 仅 win32 用:'nsis' 装了安装器
 *  (跑 Setup /S /D);'portable' 免安装(用 Update zip 覆盖,不写注册表)。
 *  返回 null 表示该 release 没有适配资产(早期 release 没有 Update zip)。 */
function pickAsset(release, platform, arch, productName, installForm = 'portable') {
  const pn = String(productName || 'CommandCodeGo Manager').replace(/ /g, '.');
  const esc = pn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const find = re => {
    const hit = assets.find(a => typeof a?.name === 'string' && re.test(a.name));
    if (!hit) return null;
    return {
      kind: '', name: hit.name,
      url: hit.browser_download_url || '',
      size: hit.size ?? 0,
      digest: digestToHex(hit.digest),
    };
  };
  const setup = () => {
    const a = find(new RegExp(`^${esc}-Setup-.+-${arch}\\.exe$`));
    if (a) a.kind = 'nsis-setup';
    return a;
  };
  const zip = () => {
    const a = find(new RegExp(`^${esc}-Update-.+-${arch}\\.zip$`));
    if (a) a.kind = 'update-zip';
    return a;
  };
  let hit = null;
  if (platform === 'win32') {
    // 便携形态只用 zip(Setup 会写注册表/快捷方式,破坏免安装属性);
    // NSIS 形态首选 Setup,资产缺失时也能退化用 zip 覆盖(同为文件替换)。
    hit = installForm === 'nsis' ? (setup() ?? zip()) : (zip() ?? null);
  } else if (platform === 'darwin') {
    hit = find(new RegExp(`^${esc}-.+-${arch}-mac\\.zip$`));
    if (hit) hit.kind = 'mac-zip';
  }
  return hit;
}

/** GitHub API 的 digest 字段 → hex;异常输入返回 ''(调用方降级为「跳过校验并提示」)。 */
function digestToHex(digest) {
  if (typeof digest !== 'string') return '';
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : '';
}

// ── PowerShell 更新助手(应用退出后接管:等待 → 备份 → 替换/安装 → 拉起)──
// 之所以用独立进程:服务与界面都活在 Electron 进程树里,运行中替换 exe/asar
// 必失败(Windows 锁定运行中的可执行文件);助手等主进程退出后再动手。
// robocopy 的 /XD data 在任何深度排除名为 data 的目录 —— resources\data
// junction(老版本升级产物,指向 %APPDATA% 的真实数据)绝不能被覆盖。
const HELPER_PS = String.raw`
param(
  [string]$Mode, [int]$WaitPid, [string]$Pkg,
  [string]$InstallDir, [string]$ExeName, [string]$RollbackDir, [string]$LogFile
)
$ErrorActionPreference = 'Stop'
function Log($m) { try { Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {} }
function Start-App { try { Start-Process -FilePath (Join-Path $InstallDir $ExeName) } catch { Log ("start failed: " + $_.Exception.Message) } }
function Backup-Install {
  New-Item -ItemType Directory -Force -Path $RollbackDir | Out-Null
  & robocopy $InstallDir $RollbackDir /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw ("robocopy backup failed: " + $LASTEXITCODE) }
}
try {
  Log "helper start mode=$Mode pid=$WaitPid"
  try { if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue } } catch {}
  Start-Sleep -Milliseconds 1500
  # 全量备份(除 data):替换会覆盖整个安装布局(exe/resources/dll/locales),
  # 只备份 exe+resources 的话回滚会拼出「旧 exe + 新 dll」的混合体,极易启动死循环
  Backup-Install
  if ($Mode -eq 'nsis') {
    $proc = Start-Process -FilePath $Pkg -ArgumentList "/S /D=$InstallDir" -PassThru -Wait
    if ($proc.ExitCode -ne 0) { throw ("installer exit code " + $proc.ExitCode) }
    Log 'nsis install done'
    Start-App
    exit 0
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ccp-update-" + [guid]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $Pkg -DestinationPath $tmp -Force
  if (-not (Test-Path (Join-Path $tmp 'resources'))) { throw 'update package layout unexpected (no resources/)' }
  & robocopy $tmp $InstallDir /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw ("robocopy replace failed: " + $LASTEXITCODE) }
  Log 'portable replace done'
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Start-App
  exit 0
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
  # 自动回滚:把备份复制回去再拉起旧版(尽力而为,失败留给下次启动的健康门)
  try {
    & robocopy $RollbackDir $InstallDir /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
    Log 'rolled back from backup'
  } catch { Log ("rollback failed: " + $_.Exception.Message) }
  Start-App
  exit 1
}
`;

// ── 状态机 ─────────────────────────────────────────────────
// idle → checking → uptodate | available → downloading → ready → applying
// 任何失败回到上一个稳定态;error 只在手动触发时呈现给用户(自动检查静默)。
function createUpdater(ctx) {
  const { app, notify } = ctx; // notify(state) 在状态变化时广播
  const log = (typeof ctx.getLogger === 'function' ? ctx.getLogger() : null) || (() => {});
  const downloadDir = path.join(app.getPath('userData'), 'downloads');
  const stateDir = path.join(app.getPath('userData'), 'update');
  const rollbackRoot = path.join(app.getPath('userData'), 'rollback');
  const pendingFile = path.join(stateDir, 'pending.json');

  const currentVersion = app.getVersion();
  const platform = process.platform;
  const productName = 'CommandCodeGo Manager';
  const installDir = app.isPackaged ? path.dirname(process.execPath) : '';
  const isNsisInstall = !!(installDir && existsSync(path.join(installDir, `Uninstall ${productName}.exe`)));
  // 一键重启更新:仅打包后的 Windows(安装/便携均可);macOS 未签名不支持原位替换
  const canSelfUpdate = app.isPackaged && platform === 'win32';

  let state = {
    supported: app.isPackaged,
    canSelfUpdate,
    platform,
    currentVersion,
    status: 'idle',
    checkedAt: null,
    latestVersion: null,
    releaseUrl: null,
    notes: null,
    asset: null,     // pickAsset 结果 {kind,name,url,size,digest}
    progress: null,  // 下载进度 0-1
    error: null,
  };
  let timer = null;
  let notifiedFor = null; // 已气泡提示过的版本,避免每 6h 重复弹
  let downloadedFile = null;

  const setState = patch => { state = { ...state, ...patch }; notify(state); };

  // Windows 上句柄关闭有延迟:强制删除 .part 要带重试,删除失败也不能让
  // 状态机卡死(catch 分支的 setState 必须执行)
  const rmPart = dest => {
    try { rmSync(dest + '.part', { force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { log(`remove .part failed: ${e.message}`); }
  };

  async function fetchJson(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ccp-desktop-updater' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /** 检查更新。manual=true 时错误写入 state.error 回显;自动轮询静默吞掉。 */
  async function check(manual = false) {
    if (['downloading', 'applying', 'checking'].includes(state.status)) return state;
    const prev = state.status;
    if (manual) setState({ status: 'checking', error: null });
    try {
      const rel = await fetchJson(API_LATEST);
      const latest = typeof rel.tag_name === 'string' ? rel.tag_name.replace(/^v/, '') : '';
      if (!latest) throw new Error('release 缺少 tag_name');
      const newer = compareVersions(latest, currentVersion) > 0;
      const prevLatest = state.latestVersion;
      // 已下载同一版本且停在 ready:6h 轮询/手动重查不推翻它,否则用户得重下整包
      const sameReady = prev === 'ready' && latest === prevLatest;
      const asset = pickAsset(rel, platform, process.arch, productName, isNsisInstall ? 'nsis' : 'portable');
      setState({
        status: sameReady ? 'ready' : newer ? 'available' : 'uptodate',
        checkedAt: Date.now(),
        latestVersion: latest,
        releaseUrl: typeof rel.html_url === 'string' ? rel.html_url : RELEASE_PAGE,
        notes: typeof rel.body === 'string' ? rel.body : '',
        asset: newer ? asset : null,
        progress: sameReady ? state.progress : null,
        error: null,
      });
      // 气泡只对「自动检查发现的新版本」弹一次;手动检查用户正盯着界面,不弹
      if (newer && !manual && notifiedFor !== latest) {
        notifiedFor = latest;
        ctx.onUpdateAvailable?.(latest, state.releaseUrl);
      }
      if (latest !== prevLatest) downloadedFile = null; // 目标版本变了,旧下载作废
      log(`update check: current=${currentVersion} latest=${latest} newer=${newer} asset=${asset?.name ?? 'none'}`);
      return state;
    } catch (e) {
      log(`update check failed: ${e.message}`);
      if (manual) setState({ status: prev === 'checking' ? 'idle' : prev, error: `检查更新失败:${e.message}` });
      else setState({ status: prev }); // 静默跳过,保持原状态
      return state;
    }
  }

  /** 流式下载 + 边下边算 sha256;digest 缺失时跳过校验(state.asset.digest === '')。 */
  async function download() {
    if (state.status !== 'available' || !state.asset) return state;
    if (!state.asset.url) {
      setState({ error: '该版本未提供适配本机的更新包,请到发布页手动下载' });
      return state;
    }
    const dest = path.join(downloadDir, state.asset.name);
    let sink = null;
    try {
      mkdirSync(downloadDir, { recursive: true });
      setState({ status: 'downloading', progress: 0, error: null });
      const r = await fetch(state.asset.url, { headers: { 'User-Agent': 'ccp-desktop-updater' } });
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
      const total = +(r.headers.get('content-length') || state.asset.size || 0);
      const hasher = createHash('sha256');
      let got = 0;
      let lastPct = -1;
      // 手写循环:统计进度、喂哈希、处理写流背压
      // (磁盘错误经 sinkErr 异步汇入本 try 的 catch,避免未捕获 'error' 事件炸主进程)
      sink = createWriteStream(dest + '.part');
      const sinkErr = new Promise((_, rej) => sink.on('error', rej));
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await Promise.race([reader.read(), sinkErr]);
        if (done) break;
        hasher.update(value);
        if (!sink.write(value)) await Promise.race([
          new Promise(res => sink.once('drain', res)), sinkErr,
        ]);
        got += value.length;
        if (total > 0) {
          const pct = Math.min(99, Math.floor((got / total) * 100));
          if (pct !== lastPct) { lastPct = pct; setState({ progress: pct / 100 }); }
        }
      }
      await Promise.race([
        new Promise((res, rej) => sink.end(err => (err ? rej(err) : res()))),
        sinkErr,
      ]);
      sink = null; // 已正常关闭,catch 分支不再销毁
      const hex = hasher.digest('hex');
      if (state.asset.digest && hex !== state.asset.digest) {
        rmPart(dest);
        throw new Error('sha256 校验失败,已丢弃下载文件');
      }
      renameSync(dest + '.part', dest);
      downloadedFile = dest;
      setState({ status: 'ready', progress: 1, error: null });
      log(`downloaded ${state.asset.name} sha256=${hex} verified=${!!state.asset.digest}`);
      return state;
    } catch (e) {
      try { sink?.destroy(); } catch { /* 已关 */ }
      rmPart(dest);
      log(`download failed: ${e.message}`);
      setState({ status: 'available', progress: null, error: `下载失败:${e.message}` });
      return state;
    }
  }

  const revealDownloaded = () => {
    if (downloadedFile && existsSync(downloadedFile)) ctx.shellShowItem?.(downloadedFile);
  };

  /** 「重启以更新」:写待更新标记 → 起独立助手 → 退出。替换动作全部发生在本进程退出后。 */
  function apply() {
    if (!canSelfUpdate || state.status !== 'ready' || !downloadedFile) return false;
    const mode = isNsisInstall ? 'nsis' : 'portable';
    const rollbackDir = path.join(rollbackRoot, currentVersion);
    mkdirSync(stateDir, { recursive: true });
    // 待更新标记:下次启动健康检查用(成功→清掉并提示;失败→回滚)
    writeFileSync(pendingFile, JSON.stringify({
      from: currentVersion, to: state.latestVersion, mode,
      installDir, rollbackDir, asset: state.asset.name, at: Date.now(),
    }));
    const psScript = path.join(stateDir, 'apply-update.ps1');
    const logFile = path.join(stateDir, 'update.log');
    writeFileSync(psScript, HELPER_PS, 'utf-8');
    ctx.spawnDetached('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript,
      '-Mode', mode,
      '-WaitPid', String(process.pid),
      '-Pkg', downloadedFile,
      '-InstallDir', installDir,
      '-ExeName', `${productName}.exe`,
      '-RollbackDir', rollbackDir,
      '-LogFile', logFile,
    ]);
    setState({ status: 'applying' });
    log(`applying update: mode=${mode} pkg=${downloadedFile}`);
    ctx.quitApp();
    return true;
  }

  /** 启动时读取待更新标记(刚完成更新/更新中断的健康门与回滚依据)。 */
  function readPending() {
    try { return JSON.parse(readFileSync(pendingFile, 'utf-8')); } catch { return null; }
  }

  /** 健康启动后调用:清除标记与回滚备份,提示新版本。 */
  function confirmBootOk() {
    const p = readPending();
    if (!p) return null;
    try { rmSync(pendingFile, { force: true }); } catch { /* 下次再清 */ }
    try { rmSync(rollbackRoot, { recursive: true, force: true }); } catch { /* 保留也无害 */ }
    notifiedFor = p.to;
    return p.to;
  }

  /** 新版启动失败时的回滚(尽力而为):备份已在磁盘,把运行中的新 exe 挪开后还原。
   *  返回错误信息供弹窗;返回 null 表示回滚动作已执行。
   *  同时清掉 pending 标记:回滚后的旧版本下次健康启动不得误报「已更新到新版」。 */
  function rollbackNow(pending, reason) {
    const logLine = m => log(`rollback: ${m}`);
    logLine(`boot failed after update to ${pending.to}: ${reason}`);
    try { rmSync(pendingFile, { force: true }); } catch { /* 留待下次清理 */ }
    if (pending.mode !== 'portable' || !pending.rollbackDir || !existsSync(pending.rollbackDir)) {
      return `新版本启动失败(${reason})。请重新运行下载好的安装包:${pending.asset}`;
    }
    try {
      // PowerShell 单引号字符串里的字面单引号写成两个(安装目录含撇号也不炸)
      const q = s => `'${String(s).replace(/'/g, "''")}'`;
      ctx.spawnDetached('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        [
          `try { $p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($p) { Wait-Process -Id ${process.pid} -Timeout 20 -ErrorAction SilentlyContinue } } catch {}`,
          'Start-Sleep -Milliseconds 1500',
          `& robocopy ${q(pending.rollbackDir)} ${q(pending.installDir)} /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null`,
          `Start-Process -FilePath (Join-Path ${q(pending.installDir)} ${q(`${productName}.exe`)})`,
        ].join('; '),
      ]);
      logLine('rollback helper spawned');
      return null;
    } catch (e) {
      logLine(`spawn rollback helper failed: ${e.message}`);
      return `回滚失败:${e.message}(备份在 ${pending.rollbackDir})`;
    }
  }

  function startAutoCheck() {
    if (!app.isPackaged || timer) return;
    const tick = () => { check(false).catch(() => {}); };
    setTimeout(tick, 30_000).unref?.();  // 启动后 30s 首查
    timer = setInterval(tick, CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    get state() { return state; },
    check, download, apply,
    revealDownloaded,
    readPending, confirmBootOk, rollbackNow,
    startAutoCheck,
    get downloadedFile() { return downloadedFile; },
    get releasePage() { return RELEASE_PAGE; },
  };
}

module.exports = { createUpdater, parseVersion, compareVersions, pickAsset, digestToHex };
