// preload 桥(issue #11):管理界面本身是反代服务的 Web 页,不跑在 Electron 的
// Node 环境里;桌面版专有能力(更新检查/下载/重启更新)经 contextBridge 暴露,
// 浏览器/容器部署下 window.ccpDesktop 不存在,界面自动退化为纯 Web 形态。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccpDesktop', {
  isDesktop: true,
  platform: process.platform,
  getUpdateState: () => ipcRenderer.invoke('ccp:update-state'),
  checkUpdate: () => ipcRenderer.invoke('ccp:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('ccp:update-download'),
  applyUpdate: () => ipcRenderer.invoke('ccp:update-apply'),
  revealDownload: () => ipcRenderer.invoke('ccp:update-reveal'),
  openReleasePage: () => ipcRenderer.invoke('ccp:update-open-release'),
  onUpdateState: cb => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('ccp:update-state-changed', listener);
    return () => ipcRenderer.removeListener('ccp:update-state-changed', listener);
  },
});
