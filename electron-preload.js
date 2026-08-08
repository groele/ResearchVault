/**
 * electron-preload.js — Electron 安全上下文预加载桥接层
 * -------------------------------------------------------
 * 在开启 contextIsolation: true 的安全沙盒模式下，
 * 通过 contextBridge 将精确白名单通道暴露给渲染进程（src/core/ipcBridge.js）。
 *
 * 渲染进程通过 window.electronAPI.invoke / on / send 与主进程通信，
 * 不会直接接触 Node.js / Electron API，确保最高安全性。
 */
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = new Set([
  'fs:read', 'fs:write', 'fs:list', 'fs:delete',
  'fs:pick', 'fs:pickDir', 'fs:readFiles', 'fs:stat',
  'fs:pathJoin', 'os:info', 'app:version', 'shell:open',
]);

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 渲染进程 → 主进程：请求-响应（invoke/handle）
   */
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /**
   * 主进程 → 渲染进程：推送订阅
   */
  on: (channel, handler) => {
    if (!ALLOWED_CHANNELS.has(channel)) return () => {};
    const listener = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  /**
   * 渲染进程 → 主进程：单向通知（无需回执）
   */
  send: (channel, ...args) => {
    if (ALLOWED_CHANNELS.has(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },

  /** 平台信息（供 UI 展示"运行于桌面"标识） */
  platform: process.platform,
  versions: { electron: process.versions.electron, node: process.versions.node },
});
