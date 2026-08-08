/**
 * ipcBridge.js — 原生能力统一桥接层（IPC 通信层，预留）
 * ----------------------------------------------------------------
 * 职责：
 *  渲染进程（UI / 业务逻辑）永远不直接调用 Node.js / Electron API，
 *  而是通过这个 bridge 请求原生能力（文件读写、对话框、系统信息等）。
 *
 * 当前实现：Web 模拟（MockIpcBridge）
 *  纯浏览器环境用 localStorage / in-memory / <input type=file> 模拟原生能力，
 *  接口与未来 Electron 实现完全一致。
 *
 * 未来切换为 Electron：仅需把 DEFAULT_BRIDGE 换成 ElectronIpcBridge，
 *  后者内部调用 window.electronAPI（由 preload 暴露的 contextBridge），
 *  UI / 业务 / 状态 / 存储层代码无需任何改动。
 *
 * 接口契约（所有 bridge 必须实现）：
 *   invoke(channel, ...args): Promise<any>      // 请求-响应
 *   on(channel, handler): () => void            // 主进程主动推送
 *   send(channel, ...args): void                // 单向通知（无需回执）
 */
(function (global) {
  'use strict';

  const CHANNELS = {
    FS_READ: 'fs:read',
    FS_WRITE: 'fs:write',
    FS_LIST: 'fs:list',
    FS_DELETE: 'fs:delete',
    FS_PICK: 'fs:pick', // 打开系统文件选择对话框
    FS_PICK_DIR: 'fs:pickDir',
    FS_READ_FILES: 'fs:readFiles', // 读取一批文件（拖放场景）；Electron 下按 path 读盘
    FS_STAT: 'fs:stat',
    PATH_JOIN: 'fs:pathJoin',
    OS_INFO: 'os:info',
    APP_VERSION: 'app:version',
    SHELL_OPEN: 'shell:open', // 外部关联程序打开 (PDF, Excel, PPT, VSCode, System)
  };

  /**
   * Web 模拟实现：用浏览器能力兜底原生能力。
   */
  class MockIpcBridge {
    constructor() {
      this._pushers = new Map();
      this._fs = new Map(); // 模拟"文件系统"：path -> content（内存 + localStorage 持久）
      this._load();
    }

    _load() {
      try {
        const raw = localStorage.getItem('rv-mock-fs');
        if (raw) this._fs = new Map(JSON.parse(raw));
      } catch (_) {}
    }
    _save() {
      try {
        localStorage.setItem('rv-mock-fs', JSON.stringify([...this._fs.entries()]));
      } catch (_) {}
    }

    async invoke(channel, ...args) {
      switch (channel) {
        case CHANNELS.FS_WRITE: {
          const [path, content] = args;
          this._fs.set(path, content);
          this._save();
          return { ok: true, path };
        }
        case CHANNELS.FS_READ: {
          const [path] = args;
          if (!this._fs.has(path)) throw new Error('ENOENT: ' + path);
          return this._fs.get(path);
        }
        case CHANNELS.FS_DELETE: {
          const [path] = args;
          this._fs.delete(path);
          this._save();
          return { ok: true };
        }
        case CHANNELS.FS_LIST: {
          const [prefix] = args;
          return [...this._fs.keys()].filter((k) => !prefix || k.startsWith(prefix));
        }
        case CHANNELS.FS_PICK: {
          // 浏览器用 <input type=file> 模拟"选择文件"
          return this._pickFile();
        }
        case CHANNELS.FS_PICK_DIR: {
          // 浏览器用 <input type=file webkitdirectory> 模拟"选择文件夹"
          return this._pickDirectory();
        }
        case CHANNELS.FS_READ_FILES: {
          // 拖放场景：渲染层只负责把 File 列表交给 bridge，读取逻辑收敛在此
          const [fileList] = args;
          return this._readFiles([...(fileList || [])]);
        }
        case CHANNELS.FS_STAT: {
          const [path] = args;
          const c = this._fs.get(path);
          return c == null ? null : { path, size: String(c).length, exists: true };
        }
        case CHANNELS.PATH_JOIN: {
          return args.filter(Boolean).join('/').replace(/\/+/g, '/');
        }
        case CHANNELS.SHELL_OPEN: {
          const [filePath, targetApp] = args;
          const appNames = { pdf: 'PDF 阅读器', excel: 'Excel 电子表格', ppt: 'PowerPoint 演示文稿', vscode: 'VS Code 代码编辑器', explorer: '文件资源管理器', default: '系统默认应用' };
          const appName = appNames[targetApp] || appNames.default;
          console.log(`[ipcBridge] 调起外部程序: ${appName} -> ${filePath}`);
          return { ok: true, path: filePath, app: targetApp || 'default', appName, message: `已使用 ${appName} 打开此文件` };
        }
        case CHANNELS.OS_INFO:
          return { platform: 'web', arch: 'browser', webMock: true };
        case CHANNELS.APP_VERSION:
          return '0.1.0-web';
        default:
          throw new Error('MockIpcBridge: unknown channel ' + channel);
      }
    }

    _pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async () => resolve(await this._readFiles([...input.files]));
        // 用户取消时 change 不触发，用 focus 兜底避免 Promise 永久挂起
        const settle = () => setTimeout(() => { if (!input.files || !input.files.length) resolve([]); }, 400);
        window.addEventListener('focus', settle, { once: true });
        input.click();
      });
    }

    _pickDirectory() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.directory = true;
        input.multiple = true;
        input.onchange = async () => resolve(await this._readFiles([...input.files]));
        const settle = () => setTimeout(() => { if (!input.files || !input.files.length) resolve([]); }, 400);
        window.addEventListener('focus', settle, { once: true });
        input.click();
      });
    }

    /**
     * 读取一批 File 对象。二进制（图片等）转 dataURL，文本按 UTF-8 读取。
     * Electron 下改为按 file.path 走主进程 fs.readFile，接口返回结构保持一致。
     */
    async _readFiles(files) {
      const BINARY = /^(image|audio|video|application\/pdf|application\/zip)/;
      const MAX = 8 * 1024 * 1024; // 单文件 8MB 上限，超限只记录元数据
      const out = [];
      for (const f of files) {
        const isBin = BINARY.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp|pdf|zip)$/i.test(f.name);
        const base = {
          name: f.name,
          relativePath: f.webkitRelativePath || f.name,
          size: f.size,
          mime: f.type || '',
          binary: isBin,
          truncated: false,
        };
        if (f.size > MAX) {
          out.push({ ...base, content: '', truncated: true });
          continue;
        }
        try {
          base.content = isBin ? await this._asDataURL(f) : await f.text();
        } catch (e) {
          base.content = '';
          base.error = e.message;
        }
        out.push(base);
      }
      return out;
    }

    _asDataURL(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error || new Error('读取失败'));
        r.readAsDataURL(file);
      });
    }

    /** 主进程推送（Web 模拟下无主进程，预留为空实现） */
    on(channel, handler) {
      if (!this._pushers.has(channel)) this._pushers.set(channel, new Set());
      this._pushers.get(channel).add(handler);
      return () => this._pushers.get(channel)?.delete(handler);
    }

    send(channel, ...args) {
      // Web 模拟：仅记录
      console.debug('[ipc:send]', channel, ...args);
    }

    /** 主进程推送入口（Electron 下由 ipcRenderer.on 触发；此处暴露给 future 调用） */
    _deliver(channel, payload) {
      this._pushers.get(channel)?.forEach((fn) => fn(payload));
    }
  }

  /**
   * Electron 实现模板（未来启用）。
   * 由 preload 通过 contextBridge 暴露 window.electronAPI。
   * 启用方式：DEFAULT_BRIDGE = new ElectronIpcBridge();
   */
  class ElectronIpcBridge {
    constructor(api = global.electronAPI) {
      if (!api) throw new Error('ElectronIpcBridge 需要 window.electronAPI（preload 暴露）');
      this._api = api;
    }
    invoke(channel, ...args) {
      return this._api.invoke(channel, ...args);
    }
    on(channel, handler) {
      return this._api.on(channel, handler);
    }
    send(channel, ...args) {
      this._api.send(channel, ...args);
    }
  }

  // 默认使用 Web 模拟；后续无缝替换为 Electron：
  const DEFAULT_BRIDGE = new MockIpcBridge();

  global.CHANNELS = CHANNELS;
  global.ipcBridge = DEFAULT_BRIDGE;
  global.IpcBridges = { MockIpcBridge, ElectronIpcBridge };
})(window);
