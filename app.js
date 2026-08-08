/**
 * app.js — 应用装配（启动入口 / 唯一接线处）
 * ----------------------------------------------------------------
 * 仅负责"接线"：实例化各模块并把它们用事件总线连起来。
 * 模块之间互不 import 实例，全部通过 bus 通信 —— 低耦合的关键。
 *
 * 接线图：
 *   UI ──(意图 ui:*)──▶ bus ──▶ 业务层 VaultService
 *   业务层 ──(读写)──▶ StorageManager / ipcBridge
 *   业务层 ──(领域事件 vault:*)──▶ bus ──▶ Store(dispatch) ──▶ UI(订阅渲染)
 *
 * 设计约定：
 *  - 业务写操作以 vault:* 领域事件回传结果，app 统一把它们 dispatch 进 Store，
 *    这样 UI 意图处理器只需"调用 + toast"，不需要再手动 dispatch ADD/UPDATE/REMOVE，
 *    避免重复派发与潜在的状态回环。
 *  - 纯视图状态（搜索/筛选/排序/主题/密度/视图/选择/聚焦/文件夹）由 UI 直接 dispatch，不过 bus。
 *
 * 切换 Electron：把 ipcBridge 换成 ElectronIpcBridge 即可，其余不变。
 */
(function (global) {
  'use strict';

  async function boot() {
    const { bus, EVENTS, ipcBridge, StorageManager, adapters, VaultService, createStore, UI } = global;

    // 1) 状态中心先建好（onError 在 storage 上报错误时回调）
    const store = createStore();

    // 2) 存储层（Web 模拟文件系统适配器；注入错误上报）
    const storage = new StorageManager(
      new adapters.FileSystemAdapter(ipcBridge),
      {
        onError: (e) => {
          console.error('[storage]', e);
          store.dispatch({ type: 'ERROR', error: e });
        },
      }
    );

    // 3) 业务层
    const vault = new VaultService(storage, ipcBridge, bus);
    global.__vault = vault;

    // 4) 视图层
    const ui = new UI(store, bus); // eslint-disable-line no-unused-vars

    const toast = (msg) => store.dispatch({ type: 'TOAST', toast: msg });
    const err = (e) => {
      const msg = (e && e.message) || String(e);
      console.error('[ResearchVault]', e);
      store.dispatch({ type: 'ERROR', error: msg });
      store.dispatch({ type: 'TOAST', toast: '⚠️ ' + msg });
    };

    // ============================================================
    // 接线：UI 意图 -> 业务操作（结果经 vault:* 事件回到 Store）
    // ============================================================

    // 新建条目
    bus.on(EVENTS.UI_CREATE_ITEM, async ({ title, kind, tags, raw }) => {
      try {
        const it = await vault.createItem({ title, kind, tags, raw });
        toast(`已创建：${it.title || title}`);
      } catch (e) { err(e); }
    });

    // 收藏切换
    bus.on(EVENTS.UI_TOGGLE_STAR, async ({ id }) => {
      try { await vault.toggleStar(id); } catch (e) { err(e); }
    });

    // 打标签
    bus.on(EVENTS.UI_TAG_ITEM, async ({ id, tag }) => {
      try { await vault.tagItem(id, tag); toast(`已打标签 #${tag}`); } catch (e) { err(e); }
    });

    // 删除
    bus.on(EVENTS.UI_DELETE_ITEM, async ({ id }) => {
      try { await vault.deleteItem(id); toast('已删除（已留痕审计）'); } catch (e) { err(e); }
    });

    // 打开：仅设置 focused，预览由 UI 从 state 渲染
    bus.on(EVENTS.UI_OPEN_ITEM, ({ id }) => store.dispatch({ type: 'SET_FOCUSED', id }));

    // 切换后处理版本 / 还原原始
    bus.on(EVENTS.UI_SELECT_VERSION, async ({ id, versionId }) => {
      try { await vault.selectVersion(id, versionId); } catch (e) { err(e); }
    });

    // 添加后处理版本（原始数据不变，仅追加处理链）
    bus.on('ui:process', async ({ id, content, note }) => {
      try { await vault.addProcessed(id, { content, note }); toast('已保存后处理版本'); } catch (e) { err(e); }
    });

    // 移动到子项目
    bus.on(EVENTS.UI_MOVE_ITEM, async ({ id, folderId }) => {
      try { await vault.moveItem(id, folderId); toast('已移动到子项目'); } catch (e) { err(e); }
    });

    // 批量操作
    bus.on(EVENTS.UI_BULK, async ({ action, ids, payload }) => {
      try { await vault.bulk(action, ids, payload); } catch (e) { err(e); }
    });

    // 选择资料库
    bus.on(EVENTS.UI_SELECT_LIBRARY, async ({ id }) => {
      try {
        store.dispatch({ type: 'SET_ACTIVE_LIBRARY', id });
        await vault.selectLibrary(id); // 内部更新 reg.activeId 并 loadItems(lib.activeFolder)
      } catch (e) { err(e); }
    });

    // 选择子项目文件夹：持久化到注册表，并重新载入（全量条目，由 Store 派生视图）
    bus.on(EVENTS.UI_FOLDER_SELECT, async ({ folderId }) => {
      try {
        const libId = store.getState().activeLibraryId;
        await vault.selectFolder(libId, folderId);
      } catch (e) { err(e); }
    });

    // 新建资料库（带主题色）
    bus.on('ui:library:create', async ({ name, icon, color }) => {
      try {
        const lib = await vault.createLibrary({ name, icon, color });
        store.dispatch({ type: 'SET_ACTIVE_LIBRARY', id: lib.id });
        await vault.loadItems(lib.id);
        refreshStats();
        toast(`已创建资料库：${name}`);
      } catch (e) { err(e); }
    });

    // 子项目文件夹：新建 / 重命名 / 删除（条目安全上移）
    bus.on(EVENTS.UI_FOLDER_CREATE, async ({ name, parent, type, icon }) => {
      try {
        const libId = store.getState().activeLibraryId;
        await vault.createFolder(libId, { name, parent, type, icon });
        toast(`已创建子项目「${name}」`);
      } catch (e) { err(e); }
    });
    bus.on(EVENTS.UI_FOLDER_RENAME, async ({ folderId, name }) => {
      try {
        const libId = store.getState().activeLibraryId;
        await vault.renameFolder(libId, folderId, name);
        toast(`已重命名「${name}」`);
      } catch (e) { err(e); }
    });
    bus.on(EVENTS.UI_FOLDER_DELETE, async ({ folderId }) => {
      try {
        const libId = store.getState().activeLibraryId;
        await vault.deleteFolder(libId, folderId);
        refreshStats();
        toast('已删除子项目（条目已安全上移父级）');
      } catch (e) { err(e); }
    });

    // 导入：点击"导入"按钮（系统文件选择）
    bus.on('ui:import:pick', async () => {
      try {
        const created = await vault.importFiles();
        await vault.loadItems();
        toast(`已导入 ${created.length} 个文件`);
      } catch (e) { err(e); }
    });
    // 导入：拖放（可拖到主区或侧栏某文件夹）
    bus.on(EVENTS.UI_IMPORT_DROP, async ({ fileList, folderId }) => {
      try {
        const created = await vault.importDropped(fileList, folderId);
        await vault.loadItems();
        toast(`已导入 ${created.length} 个文件`);
      } catch (e) { err(e); }
    });

    // 加密
    bus.on('ui:crypto:unlock', async ({ password }) => {
      try {
        await vault.unlockCrypto(password);
        store.dispatch({ type: 'SET_CRYPTO', locked: false });
        storage.setCrypto(vault.crypto);
        // 解锁后必须重新载入：此前因未解锁而跳过的加密条目此刻才能解密读回
        await vault.loadItems();
        refreshStats();
        toast('加密存储已启用（AES-GCM 256）');
      } catch (e) { err(e); }
    });
    bus.on('ui:crypto:lock', () => {
      try {
        vault.lockCrypto();
        storage.setCrypto(null);
        store.dispatch({ type: 'SET_CRYPTO', locked: true });
        toast('已锁定加密存储');
      } catch (e) { err(e); }
    });

    // 导出 / 恢复
    bus.on(EVENTS.UI_EXPORT, async () => {
      try {
        const data = await vault.exportJSON();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'research-vault-export.json';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        toast('已导出 JSON（含完整处理链与审计日志）');
      } catch (e) { err(e); }
    });
    bus.on('ui:export:csv', async () => {
      try {
        const csv = await vault.exportCSV();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'research-vault-manifest.csv';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        toast('已导出 CSV 表格数据清单');
      } catch (e) { err(e); }
    });
    bus.on('ui:repair:orphans', async () => {
      try {
        const count = await vault.repairOrphanedItems();
        toast(count > 0 ? `已自愈修复 ${count} 个孤立条目` : '✅ 无孤立条目，库结构健全');
      } catch (e) { err(e); }
    });
    bus.on(EVENTS.UI_RESTORE, async ({ file }) => {
      try {
        const text = await file.text();
        const pkg = JSON.parse(text);
        const res = await vault.restoreJSON(pkg);
        refreshStats();
        const v = res.verified === false ? '（⚠ 清单指纹不符）' : res.verified ? '（指纹校验通过）' : '';
        toast(`恢复完成：新增 ${res.added}、跳过 ${res.skipped}${v}`);
      } catch (e) { err(e); }
    });

    // 完整性自检
    bus.on(EVENTS.UI_INTEGRITY, async () => {
      try {
        const report = await vault.integrityCheck();
        toast(report.healthy ? '✅ 数据完整性校验全过' : '⚠️ 自检发现指纹失配项');
      } catch (e) { err(e); }
    });
    // 清空缓存层
    bus.on(EVENTS.UI_CLEAR_CACHE, async () => {
      try {
        const n = await storage.clearCache();
        toast(`已清空 ${n} 条缓存`);
      } catch (e) { err(e); }
    });
    // 存储引擎切换（文件系统 ↔ IndexedDB）
    bus.on(EVENTS.UI_ENGINE_SWITCH, async () => {
      try {
        const cur = storage.adapter;
        const next = cur instanceof adapters.FileSystemAdapter
          ? new adapters.IndexedDBAdapter()
          : new adapters.FileSystemAdapter(ipcBridge);
        storage.use(next);
        await vault.init(); // 在新引擎上重建注册表与条目
        refreshStats();
        store.dispatch({ type: 'SET_ENGINE', engine: storage.engineName });
        const el = document.getElementById('engineInfo');
        if (el) el.textContent = '存储引擎：' + storage.engineName;
        toast(`已切换引擎：${storage.engineName}`);
      } catch (e) { err(e); }
    });

    // 纯视图状态：主题 / 密度 / 视图模式（直接进 Store，并对可持久项落盘）
    bus.on(EVENTS.UI_THEME, async ({ theme }) => {
      store.dispatch({ type: 'SET_THEME', theme });
      try { await storage.config('theme', theme); } catch (_) {}
    });
    bus.on(EVENTS.UI_DENSITY, async ({ density }) => {
      store.dispatch({ type: 'SET_DENSITY', density });
      try { await storage.config('density', density); } catch (_) {}
    });
    bus.on(EVENTS.UI_VIEWMODE, ({ mode }) => store.dispatch({ type: 'SET_VIEW_MODE', mode }));

    // ============================================================
    // 接线：业务领域事件 -> Store（单一可信来源）
    // ============================================================
    // 侧栏计数：扫描全量用户数据，保证非激活资料库也能正确显示数量
    const refreshStats = async () => {
      try { const stats = await vault.stats(); store.dispatch({ type: 'SET_LIBRARY_STATS', stats }); } catch (_) {}
    };

    bus.on(EVENTS.VAULT_INIT, ({ libraries, activeId }) => {
      store.dispatch({ type: 'SET_LIBRARIES', libraries, activeId });
      refreshStats();
    });
    bus.on(EVENTS.VAULT_ITEMS_LOADED, ({ items, folderId }) => {
      store.dispatch({ type: 'SET_ITEMS', items, folderId });
      refreshStats();
    });
    bus.on(EVENTS.VAULT_ITEM_CREATED, ({ item }) => { store.dispatch({ type: 'ADD_ITEM', item }); refreshStats(); });
    bus.on(EVENTS.VAULT_ITEM_UPDATED, ({ item }) => { store.dispatch({ type: 'UPDATE_ITEM', item }); refreshStats(); });
    bus.on(EVENTS.VAULT_ITEM_DELETED, ({ id }) => { store.dispatch({ type: 'REMOVE_ITEM', id }); refreshStats(); });

    // 审计日志：实时前插（抽屉无需每次重新拉取）
    bus.on(EVENTS.AUDIT_APPENDED, ({ record }) => {
      const cur = store.getState().audit;
      store.dispatch({ type: 'SET_AUDIT', audit: [record, ...cur].slice(0, 200) });
    });
    // 完整性报告
    bus.on(EVENTS.INTEGRITY_REPORT, (report) => store.dispatch({ type: 'SET_INTEGRITY', report }));
    // 批量完成：清空选择并提示
    bus.on(EVENTS.VAULT_BULK_DONE, ({ action, count }) => {
      store.dispatch({ type: 'CLEAR_SELECTION' });
      refreshStats();
      toast(`批量操作「${action}」完成（${count} 项）`);
    });
    // 存储就绪
    bus.on(EVENTS.STORAGE_READY, () => store.dispatch({ type: 'STORAGE_READY' }));

    // ============================================================
    // 启动
    // ============================================================
    // 恢复持久的外观偏好
    try {
      const savedTheme = await storage.config('theme');
      if (savedTheme) store.dispatch({ type: 'SET_THEME', theme: savedTheme });
      const savedDensity = await storage.config('density');
      if (savedDensity) store.dispatch({ type: 'SET_DENSITY', density: savedDensity });
    } catch (_) {}

    // 提示：Web Crypto 在 file:// 下可能不可用，建议通过本地服务器打开
    if (!global.crypto || !global.crypto.subtle) {
      toast('提示：请通过本地服务器打开（如 python -m http.server），否则加密/指纹不可用');
    }

    // 启动失败应优雅降级（如 file:// 下 crypto.subtle 不可用导致存储层失败），
    // 而不是永远卡在骨架屏。
    try {
      await vault.init();
      refreshStats();
    } catch (e) {
      console.error('[ResearchVault] 启动失败', e);
      const msg = String((e && e.message) || e);
      const hint = msg.includes('subtle') || msg.includes('crypto')
        ? '请改用本地服务器打开：在该目录执行 <code>node scripts/serve.mjs</code> 后访问 http://localhost:8099'
        : '请查看控制台日志，或改用本地服务器打开本应用。';
      const main = document.getElementById('cards');
      if (main) {
        main.className = 'cards';
        main.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>启动失败：${msg.replace(/</g, '&lt;')}</div><div class="muted">${hint}</div></div>`;
      }
      return;
    }
    // 载入既有审计日志到抽屉
    try {
      const initialAudit = await vault.getAudit();
      store.dispatch({ type: 'SET_AUDIT', audit: initialAudit });
    } catch (_) {}

    // 若此前启用过加密（存在 cryptoSalt），但本次启动时未解锁，
    // 加密条目会被存储层跳过而"消失"。主动弹出解锁框，避免用户误以为数据丢失。
    try {
      const salt = await storage.config('cryptoSalt');
      if (salt && store.getState().cryptoLocked) ui._openCrypto();
    } catch (_) {}

    console.log('[ResearchVault] 已启动：', {
      storage: storage.adapter.constructor.name,
      ipc: ipcBridge.constructor.name,
      engine: storage.engineName,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
