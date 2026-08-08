/**
 * electron-main.mjs — ResearchVault Electron 桌面主进程
 * -------------------------------------------------------
 * 职责：
 *  1. 创建原生 Windows 窗口（支持窗口位置/尺寸持久化）
 *  2. 处理所有 IPC 通道请求（文件系统、Shell、OS 信息）
 *  3. 绑定原生菜单与应用生命周期
 *
 * 迁移说明：
 *  本文件无需修改 src/ 下任何业务代码。
 *  src/core/ipcBridge.js 在检测到 window.electronAPI 时自动切换为原生通道。
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ 窗口状态持久化 ============
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

async function loadWindowState() {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { width: 1440, height: 900, x: undefined, y: undefined };
  }
}

async function saveWindowState(win) {
  try {
    const bounds = win.getBounds();
    await fs.writeFile(stateFile, JSON.stringify(bounds), 'utf8');
  } catch (_) {}
}

// ============ 创建主窗口 ============
let mainWindow = null;

async function createWindow() {
  const state = await loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: 'ResearchVault · 科研数据管理系统',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      contextIsolation: true,   // 安全沙盒隔离
      nodeIntegration: false,   // 渲染进程不直接访问 Node.js
      sandbox: false,            // preload 需要 require('electron')
    },
  });

  mainWindow.loadFile('index.html');

  // 开发时打开 DevTools
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 窗口关闭前保存状态
  mainWindow.on('close', () => saveWindowState(mainWindow));
}

// ============ 原生应用菜单 ============
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '导入文件...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:importFile') },
        { label: '导入文件夹...', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow?.webContents.send('menu:importDir') },
        { type: 'separator' },
        { label: '导出备份...', accelerator: 'CmdOrCtrl+E', click: () => mainWindow?.webContents.send('menu:export') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '科研演化拓扑图', accelerator: 'CmdOrCtrl+G', click: () => mainWindow?.webContents.send('menu:lineage') },
        { label: '文件空间仪表盘', accelerator: 'CmdOrCtrl+M', click: () => mainWindow?.webContents.send('menu:space') },
        { label: '命令快捷面板', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('menu:cmd') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '刷新页面' },
        { type: 'separator' },
        { label: '深色主题', type: 'checkbox', checked: nativeTheme.shouldUseDarkColors, click: (item) => {
          nativeTheme.themeSource = item.checked ? 'dark' : 'light';
        }},
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键速查 (?)', accelerator: '?', click: () => mainWindow?.webContents.send('menu:help') },
        { label: '查看架构设计文档', click: () => shell.openPath(path.join(__dirname, 'docs', 'ARCHITECTURE.md')) },
        { type: 'separator' },
        { label: '关于 ResearchVault', click: () => dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '关于 ResearchVault',
          message: 'ResearchVault v5.0.0',
          detail: '科研课题数据综合管理系统\n支持不可变证据链 · 双向 Wiki 链接 · 演化拓扑图\n\n© 2026 ResearchVault Team',
          buttons: ['确定'],
        })},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============ IPC 通道处理器 ============

/** 文件系统：读文件 */
ipcMain.handle('fs:read', async (_event, filePath) => {
  const content = await fs.readFile(filePath, 'utf8');
  return { content };
});

/** 文件系统：写文件 */
ipcMain.handle('fs:write', async (_event, filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return { ok: true };
});

/** 文件系统：删除文件 */
ipcMain.handle('fs:delete', async (_event, filePath) => {
  if (existsSync(filePath)) await fs.unlink(filePath);
  return { ok: true };
});

/** 文件系统：列目录 */
ipcMain.handle('fs:list', async (_event, dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
});

/** 原生文件选择对话框（单/多文件） */
ipcMain.handle('fs:pick', async (_event, opts = {}) => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || '选择文件',
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  if (canceled || !filePaths.length) return { canceled: true, files: [] };

  const files = await Promise.all(filePaths.map(async (fp) => {
    const content = await fs.readFile(fp, 'utf8').catch(() => '');
    const stat = await fs.stat(fp);
    return {
      name: path.basename(fp),
      path: fp,
      content,
      size: stat.size,
      mime: 'application/octet-stream',
    };
  }));
  return { canceled: false, files };
});

/** 原生文件夹选择对话框（含递归子目录） */
ipcMain.handle('fs:pickDir', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '选择课题文件夹',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return { canceled: true, files: [] };

  const rootDir = filePaths[0];
  const files = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(fullPath);
      } else {
        const content = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const stat = await fs.stat(fullPath);
        files.push({
          name: e.name,
          path: fullPath,
          relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
          content,
          size: stat.size,
          mime: 'application/octet-stream',
        });
      }
    }
  }

  await walk(rootDir);
  return { canceled: false, files, rootDir };
});

/** Shell：用系统默认程序打开文件/路径 */
ipcMain.handle('shell:open', async (_event, filePath, _appType) => {
  const err = await shell.openPath(filePath);
  return { ok: !err, error: err || null };
});

/** OS 信息 */
ipcMain.handle('os:info', () => ({
  platform: process.platform,
  arch: process.arch,
  version: process.getSystemVersion?.() || process.version,
}));

/** 应用版本 */
ipcMain.handle('app:version', () => ({ version: app.getVersion() }));

// ============ 应用生命周期 ============
app.whenReady().then(async () => {
  buildMenu();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
