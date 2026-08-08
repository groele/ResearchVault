/**
 * vaultService.js — 业务逻辑层（VaultService）
 * ----------------------------------------------------------------
 * 职责：
 *  - 资料库 / 子项目文件夹 / 条目的全部领域操作。
 *  - **数据真实性保障（科研核心）**：
 *      · raw（原始数据）落库时计算 SHA-256 指纹并持久化，任何时候可复核；
 *      · raw 被声明为不可变，updateItem 走字段白名单，从 API 层面拒绝篡改；
 *      · 后处理不是"覆盖"，而是一条 **处理链**（processedVersions[]），
 *        每个版本记录父版本、方法、说明、时间与指纹，可回看任意历史版本；
 *      · "还原原始"只是把当前指针置空，历史版本一律保留，绝不销毁证据。
 *  - **审计日志**：所有写操作留痕到 audit 层，形成可追溯的操作证据链。
 *  - 仅通过 StorageManager 与 ipcBridge 工作，不碰 DOM。对外只广播 vault:* 事件。
 */
(function (global) {
  'use strict';

  const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sha256 = (s) => global.storageUtils.sha256(s);

  /** updateItem 允许修改的字段白名单 —— raw / processedVersions / id 永不在列 */
  const MUTABLE_FIELDS = ['title', 'name', 'kind', 'tags', 'starred', 'folderId', 'note'];

  const AUDIT_ACTIONS = {
    CREATE: 'item.create', IMPORT: 'item.import', UPDATE: 'item.update', DELETE: 'item.delete',
    PROCESS: 'item.process', REVERT: 'item.revert', VERSION: 'item.version.switch',
    MOVE: 'item.move', TAG: 'item.tag', STAR: 'item.star',
    LIB_CREATE: 'library.create', FOLDER_CREATE: 'folder.create',
    FOLDER_RENAME: 'folder.rename', FOLDER_DELETE: 'folder.delete',
    EXPORT: 'data.export', RESTORE: 'data.restore', VERIFY: 'data.verify',
  };

  class VaultService {
    constructor(storage, ipc, bus) {
      this.storage = storage;
      this.ipc = ipc;
      this.bus = bus;
      this._crypto = new global.CryptoBox();
    }

    // ================= 审计日志 =================
    /** 追加一条审计记录（失败不阻断主流程，但会上报） */
    async _audit(action, detail = {}) {
      try {
        const rec = { id: uid('a'), ts: Date.now(), action, ...detail };
        await this.storage.audit(rec.id, rec);
        this.bus.emit(global.EVENTS.AUDIT_APPENDED, { record: rec });
        return rec;
      } catch (e) {
        console.warn('[audit] 写入失败:', e.message);
      }
    }

    /** 读取审计日志（时间倒序） */
    async getAudit(limit = 200) {
      const all = await this.storage.allAudit();
      return all.map((e) => e.value).sort((a, b) => b.ts - a.ts).slice(0, limit);
    }

    // ================= 初始化 =================
    async init() {
      const reg = (await this.storage.config('libraries')) || { libraries: [], activeId: null };
      if (!reg.libraries.length) {
        const def = this._makeLibrary('我的资料库', '🔬', '#4f7cff');
        reg.libraries.push(def);
        reg.activeId = def.id;
      }
      // 迁移：补齐旧记录缺失的字段
      for (const lib of reg.libraries) {
        if (!lib.folders) lib.folders = [{ id: 'root', name: '根目录', parent: null }];
        if (lib.activeFolder == null) lib.activeFolder = 'root';
      }
      await this.storage.config('libraries', reg);
      await this._migrateItems();
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      this.bus.emit(global.EVENTS.STORAGE_READY);
      await this.loadItems(reg.activeId);
      return reg;
    }

    /** 把旧版单对象 processed 迁移为处理链，并为缺失指纹的 raw 补算 */
    async _migrateItems() {
      const all = await this.storage.allUser();
      for (const { value: it } of all) {
        if (!it || !it.raw) continue;
        let dirty = false;
        if (!Array.isArray(it.processedVersions)) {
          it.processedVersions = [];
          if (it.processed) {
            const v = {
              id: uid('v'), content: it.processed.content ?? '', note: it.processed.note || '',
              method: it.processed.method || '', processedAt: it.processed.processedAt || it.updatedAt || Date.now(),
              parent: null, hash: await sha256(it.processed.content ?? ''),
            };
            it.processedVersions.push(v);
            it.currentVersion = v.id;
          } else {
            it.currentVersion = null;
          }
          dirty = true;
        }
        if (!it.raw.hash) {
          it.raw.hash = await sha256(it.raw.content ?? '');
          it.raw.size = (it.raw.content ?? '').length;
          dirty = true;
        }
        if (dirty) await this.storage.user(it.id, this._project(it));
      }
    }

    _makeLibrary(name, icon, color) {
      return {
        id: uid('lib'), name, icon, color,
        description: '', startDate: null, endDate: null,
        status: 'active', createdAt: Date.now(),
        folders: [{ id: 'root', name: '根目录', parent: null }],
        activeFolder: 'root',
      };
    }

    async createLibrary({ name, icon = '📁', color = '#4f7cff', description = '' }) {
      const reg = (await this.storage.config('libraries')) || { libraries: [], activeId: null };
      const lib = this._makeLibrary(name, icon, color);
      lib.description = description;
      reg.libraries.push(lib);
      reg.activeId = lib.id;
      await this.storage.config('libraries', reg);
      await this._audit(AUDIT_ACTIONS.LIB_CREATE, { libraryId: lib.id, summary: `新建资料库「${name}」` });
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      return lib;
    }

    // ================= 子项目文件夹 =================
    async _reg() { return this.storage.config('libraries'); }
    async _lib(reg, libraryId) {
      return reg.libraries.find((l) => l.id === libraryId) || reg.libraries.find((l) => l.id === reg.activeId);
    }

    async createFolder(libraryId, { name, parent = 'root', type = 'general', icon = '' }) {
      const reg = await this._reg();
      const lib = await this._lib(reg, libraryId);
      const typeIcons = { code: '💻', model: '🤖', image: '🖼️', paper: '📄', data: '📊', note: '📝', general: '📁' };
      const folderIcon = icon || typeIcons[type] || '📁';
      const folder = { id: uid('f'), name, parent, type, icon: folderIcon, createdAt: Date.now() };
      lib.folders.push(folder);
      await this.storage.config('libraries', reg);
      await this._audit(AUDIT_ACTIONS.FOLDER_CREATE, { libraryId: lib.id, folderId: folder.id, summary: `新建【${folderIcon} ${name}】子项目（${type}）` });
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      return folder;
    }

    async renameFolder(libraryId, folderId, name) {
      if (folderId === 'root') throw new Error('根目录不可重命名');
      const reg = await this._reg();
      const lib = await this._lib(reg, libraryId);
      const f = lib.folders.find((x) => x.id === folderId);
      if (!f) return null;
      const old = f.name;
      f.name = name;
      await this.storage.config('libraries', reg);
      await this._audit(AUDIT_ACTIONS.FOLDER_RENAME, { libraryId: lib.id, folderId, summary: `子项目「${old}」→「${name}」` });
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      return f;
    }

    /**
     * 删除文件夹：**不删除任何条目**，子文件夹与条目一律上移到父级，避免数据意外丢失。
     */
    async deleteFolder(libraryId, folderId) {
      if (folderId === 'root') throw new Error('根目录不可删除');
      const reg = await this._reg();
      const lib = await this._lib(reg, libraryId);
      const target = lib.folders.find((x) => x.id === folderId);
      if (!target) return null;
      const parent = target.parent || 'root';
      lib.folders.forEach((f) => { if (f.parent === folderId) f.parent = parent; });
      lib.folders = lib.folders.filter((f) => f.id !== folderId);
      if (lib.activeFolder === folderId) lib.activeFolder = parent;
      await this.storage.config('libraries', reg);

      // 条目改归属到父级（保留数据）
      const all = await this.storage.allUser();
      let moved = 0;
      for (const { value: it } of all) {
        if (it && it.libraryId === lib.id && it.folderId === folderId) {
          it.folderId = parent; it.updatedAt = Date.now();
          await this.storage.user(it.id, this._project(it));
          moved++;
        }
      }
      await this._audit(AUDIT_ACTIONS.FOLDER_DELETE, {
        libraryId: lib.id, folderId,
        summary: `删除子项目「${target.name}」，${moved} 个条目已上移至父级（未删除任何数据）`,
      });
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      await this.loadItems(lib.id, lib.activeFolder);
      return { moved, parent };
    }

    async selectFolder(libraryId, folderId) {
      const reg = await this._reg();
      const lib = await this._lib(reg, libraryId);
      lib.activeFolder = folderId;
      await this.storage.config('libraries', reg);
      // 注意：不在此广播 UI 事件，文件夹切换是纯前端派生（Store.FOLDER），避免与 app 接线回环。
      await this.loadItems(libraryId, folderId);
    }

    async selectLibrary(id) {
      const reg = await this._reg();
      reg.activeId = id;
      await this.storage.config('libraries', reg);
      const lib = reg.libraries.find((l) => l.id === id);
      // 注意：不在此广播 UI_SELECT_LIBRARY，由 app 在意图处理后统一驱动状态，避免回环。
      await this.loadItems(id, lib?.activeFolder);
    }

    // ================= 条目读取 =================
    /**
     * 加载条目：若未传 folderId 则返回该资料库全量条目；若指定 folderId 则按文件夹过滤后返回。
     */
    async loadItems(libraryId, folderId) {
      const reg = await this._reg();
      libraryId = libraryId || reg.activeId;
      const items = (await this.storage.allUser())
        .filter((e) => e.value && e.value.libraryId === libraryId)
        .map((e) => e.value)
        .sort((a, b) => b.createdAt - a.createdAt);
      // 关键约定：此处始终返回该资料库「全量」条目，文件夹视图完全由 Store.recompute 派生。
      // 这样侧栏各文件夹计数基于全量数据、切换文件夹无需重新拉取，避免 store.items 被截断。
      this.bus.emit(global.EVENTS.VAULT_ITEMS_LOADED, { items, libraryId, folderId });
      return items;
    }

    /** 显式按文件夹过滤获取条目 */
    async getItemsByFolder(libraryId, folderId = 'root') {
      return this.loadItems(libraryId, folderId);
    }

    /** 某库全部条目（不受文件夹过滤影响，用于统计/文件夹计数） */
    async allInLibrary(libraryId) {
      const all = await this.storage.allUser();
      return all.filter((e) => e.value && e.value.libraryId === libraryId).map((e) => e.value);
    }

    /**
     * 全库各资料库的条目计数（按文件夹），用于侧栏准确显示数量。
     * 关键：应用只载入「当前资料库」的条目到 store.items，因此不能为每个资料库用 store.items 计数，
     * 必须扫描全量用户数据，否则非激活资料库的数量会恒为 0。
     */
    async stats() {
      const all = (await this.storage.allUser()).map((e) => e.value).filter(Boolean);
      const out = {};
      for (const it of all) {
        const libId = it.libraryId;
        if (!libId) continue;
        const lib = (out[libId] = out[libId] || { total: 0, folders: {} });
        lib.total++;
        const f = it.folderId || 'root';
        lib.folders[f] = (lib.folders[f] || 0) + 1;
      }
      return out;
    }

    // ================= 条目创建 =================
    /**
     * 创建条目。原始数据一经写入即视为**不可变证据**：记录来源、来源时间、MIME 与 SHA-256 指纹。
     */
    async createItem({ title, kind = 'note', tags = [], libraryId, folderId, raw, processed, content }) {
      const reg = await this._reg();
      libraryId = libraryId || reg.activeId;
      const lib = reg.libraries.find((l) => l.id === libraryId);
      folderId = folderId ?? lib?.activeFolder ?? 'root';

      const now = Date.now();
      const rawContent = raw?.content ?? content ?? '';
      const item = {
        id: uid('it'), title, name: title, kind, tags,
        libraryId, folderId, starred: false,
        // —— 原始数据：不可变 + 指纹 ——
        raw: {
          content: rawContent,
          source: raw?.source || 'manual',        // manual / file / url / api
          sourceTime: raw?.sourceTime || now,
          mime: raw?.mime || 'text/plain',
          hash: await sha256(rawContent),
          size: rawContent.length,
          binary: !!raw?.binary,
        },
        // —— 后处理：处理链（可无限追加版本，全部保留）——
        processedVersions: [],
        currentVersion: null,
        createdAt: now, updatedAt: now,
      };
      if (processed) {
        const v = await this._makeVersion(processed.content ?? rawContent, processed.note || '', processed.method || '', null);
        item.processedVersions.push(v);
        item.currentVersion = v.id;
      }
      const stored = this._project(item);
      await this.storage.user(item.id, stored);
      await this._audit(AUDIT_ACTIONS.CREATE, {
        itemId: item.id, libraryId, folderId,
        summary: `新建「${title}」（来源 ${item.raw.source}，指纹 ${item.raw.hash.slice(0, 12)}…）`,
      });
      this.bus.emit(global.EVENTS.VAULT_ITEM_CREATED, { item: stored });
      return stored;
    }

    /** 从存储/内存态派生对外字段：processed（当前版本）与 content（当前呈现内容） */
    _project(item) {
      const cur = (item.processedVersions || []).find((v) => v.id === item.currentVersion) || null;
      item.processed = cur ? { content: cur.content, note: cur.note, method: cur.method, processedAt: cur.processedAt, versionId: cur.id } : null;
      item.content = cur ? cur.content : (item.raw?.content ?? '');
      return item;
    }

    async _makeVersion(content, note, method, parent) {
      return {
        id: uid('v'), content: content ?? '', note: note || '', method: method || '',
        processedAt: Date.now(), parent: parent || null, hash: await sha256(content ?? ''),
      };
    }

    // ================= 导入 =================
    async importFiles() {
      const files = await this.ipc.invoke(global.CHANNELS.FS_PICK);
      return this._ingest(files, 'pick');
    }

    /** 拖放导入：支持拖至全局主区或指定侧边栏文件夹 */
    async importDropped(fileList, targetFolderId) {
      const files = await this.ipc.invoke(global.CHANNELS.FS_READ_FILES, fileList);
      return this._ingest(files, 'drop', targetFolderId);
    }

    async _ingest(files, via, targetFolderId) {
      if (!files || !files.length) return [];
      const reg = await this._reg();
      const lib = reg.libraries.find((l) => l.id === reg.activeId);
      const folderId = targetFolderId || lib?.activeFolder || 'root';
      const created = [];
      for (const f of files) {
        const item = await this.createItem({
          title: f.name, kind: this._guessKind(f.name), libraryId: reg.activeId, folderId,
          raw: {
            content: f.content || '', source: 'file', sourceTime: Date.now(),
            mime: f.mime || this._mimeOf(f.name), binary: !!f.binary,
          },
        });
        if (f.truncated) await this._audit(AUDIT_ACTIONS.IMPORT, { itemId: item.id, summary: `「${f.name}」超过 8MB，仅登记元数据未载入内容` });
        created.push(item);
      }
      await this._audit(AUDIT_ACTIONS.IMPORT, { libraryId: reg.activeId, folderId, summary: `导入 ${created.length} 个文件到文件夹 [${folderId}]（${via}）` });
      this.bus.emit(global.EVENTS.VAULT_IMPORTED, { items: created, folderId });
      return created;
    }

    // ================= 后处理（处理链） =================
    /** 追加一个后处理版本，父版本为当前版本。原始数据永不变动。 */
    async addProcessed(id, { content, note = '', method = '' }) {
      const item = await this.storage.user(id);
      if (!item) return;
      if (!Array.isArray(item.processedVersions)) item.processedVersions = [];
      const v = await this._makeVersion(content ?? item.raw.content, note, method, item.currentVersion || null);
      item.processedVersions.push(v);
      item.currentVersion = v.id;
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.PROCESS, {
        itemId: id, versionId: v.id,
        summary: `「${item.title}」新增处理版本 v${item.processedVersions.length}${note ? '：' + note : ''}`,
      });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    /** 切换到指定处理版本（versionId 为 null 表示回到原始视图） */
    async selectVersion(id, versionId) {
      const item = await this.storage.user(id);
      if (!item) return;
      if (versionId && !(item.processedVersions || []).some((v) => v.id === versionId)) return item;
      item.currentVersion = versionId || null;
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.VERSION, { itemId: id, versionId, summary: `「${item.title}」切换到${versionId ? '处理版本' : '原始数据'}` });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    /** 还原为原始数据视图：只置空当前指针，历史版本全部保留（可追溯） */
    async revertToRaw(id) {
      const item = await this.storage.user(id);
      if (!item) return;
      item.currentVersion = null;
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.REVERT, {
        itemId: id,
        summary: `「${item.title}」还原为原始数据（保留 ${(item.processedVersions || []).length} 个历史处理版本）`,
      });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    // ================= 真实性校验 =================
    /** 复核单条：重算 raw 指纹并与落库指纹比对 */
    async verifyItem(id) {
      const item = typeof id === 'string' ? await this.storage.user(id) : id;
      if (!item) return { ok: false, reason: '条目不存在' };
      const actual = await sha256(item.raw?.content ?? '');
      const ok = actual === item.raw?.hash;
      return { ok, expected: item.raw?.hash, actual, itemId: item.id };
    }

    /** 全库体检：存储层校验和 + 条目级 raw 指纹双重复核 */
    async integrityCheck() {
      const storageReport = await this.storage.verifyAll();
      const all = await this.storage.allUser();
      const bad = [];
      for (const { value: it } of all) {
        if (!it || !it.raw) continue;
        const r = await this.verifyItem(it);
        if (!r.ok) bad.push({ id: it.id, title: it.title, expected: r.expected, actual: r.actual });
      }
      const report = {
        checkedAt: Date.now(),
        storage: storageReport,
        items: { total: all.length, tampered: bad.length, list: bad },
        healthy: storageReport.healthy && bad.length === 0,
      };
      await this._audit(AUDIT_ACTIONS.VERIFY, {
        summary: report.healthy
          ? `完整性自检通过（${all.length} 条原始数据指纹一致）`
          : `完整性自检发现问题：存储损坏 ${storageReport.corrupted} 条、指纹不符 ${bad.length} 条`,
      });
      this.bus.emit(global.EVENTS.INTEGRITY_REPORT, report);
      return report;
    }

    // ================= 条目修改（受限） =================
    _guessKind(name) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (['py', 'js', 'ts', 'jsx', 'tsx', 'cpp', 'c', 'h', 'hpp', 'rs', 'go', 'java', 'sh', 'bash', 'cu', 'html', 'css', 'm', 'r', 'php'].includes(ext)) return 'code';
      if (['pt', 'pth', 'ckpt', 'onnx', 'safetensors', 'bin', 'h5', 'tflite', 'keras', 'gguf', 'pb'].includes(ext)) return 'model';
      if (['md', 'txt', 'markdown', 'rst'].includes(ext)) return 'note';
      if (['pdf', 'tex', 'doc', 'docx'].includes(ext)) return 'paper';
      if (['json', 'csv', 'tsv', 'parquet', 'npy', 'npz', 'feather', 'xml', 'yaml', 'yml'].includes(ext)) return 'data';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'ico'].includes(ext)) return 'image';
      return 'other';
    }
    _mimeOf(name) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      const map = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };
      return map[ext] || 'application/octet-stream';
    }

    async toggleStar(id) {
      const item = await this.storage.user(id);
      if (!item) return;
      item.starred = !item.starred;
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    async tagItem(id, tag) {
      const item = await this.storage.user(id);
      if (!item || !tag) return;
      item.tags = item.tags || [];
      if (!item.tags.includes(tag)) item.tags.push(tag);
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.TAG, { itemId: id, summary: `「${item.title}」打标签 #${tag}` });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    async untagItem(id, tag) {
      const item = await this.storage.user(id);
      if (!item) return;
      item.tags = (item.tags || []).filter((t) => t !== tag);
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    /**
     * 受限更新：仅允许修改白名单字段。
     * 试图修改 raw / processedVersions / id 等会被直接拒绝（数据真实性红线）。
     */
    async updateItem(id, patch) {
      const illegal = Object.keys(patch || {}).filter((k) => !MUTABLE_FIELDS.includes(k));
      if (illegal.length) {
        throw new Error(`字段不可修改（原始数据不可篡改）：${illegal.join(', ')}`);
      }
      const item = await this.storage.user(id);
      if (!item) return;
      Object.assign(item, patch, { updatedAt: Date.now() });
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.UPDATE, { itemId: id, summary: `更新「${item.title}」：${Object.keys(patch).join('/')}` });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    /** 移动条目到指定子项目文件夹 */
    async moveItem(id, folderId) {
      const item = await this.storage.user(id);
      if (!item) return;
      item.folderId = folderId || 'root';
      item.updatedAt = Date.now();
      const stored = this._project(item);
      await this.storage.user(id, stored);
      await this._audit(AUDIT_ACTIONS.MOVE, { itemId: id, folderId, summary: `移动「${item.title}」到子项目` });
      this.bus.emit(global.EVENTS.VAULT_ITEM_UPDATED, { item: stored });
      return stored;
    }

    async deleteItem(id) {
      const item = await this.storage.user(id);
      await this.storage.deleteUser(id);
      await this._audit(AUDIT_ACTIONS.DELETE, { itemId: id, summary: `删除「${item?.title || id}」` });
      this.bus.emit(global.EVENTS.VAULT_ITEM_DELETED, { id });
    }

    // ================= 批量与健康修复 =================
    async bulk(action, ids, payload = {}) {
      const out = [];
      for (const id of ids) {
        if (action === 'delete') { await this.deleteItem(id); out.push(id); }
        else if (action === 'star') { out.push(await this.updateItem(id, { starred: !!payload.on })); }
        else if (action === 'tag') { out.push(await this.tagItem(id, payload.tag)); }
        else if (action === 'untag') { out.push(await this.untagItem(id, payload.tag)); }
        else if (action === 'kind') { out.push(await this.updateItem(id, { kind: payload.kind })); }
        else if (action === 'move') { out.push(await this.moveItem(id, payload.folderId)); }
      }
      this.bus.emit(global.EVENTS.VAULT_BULK_DONE, { action, ids, count: out.length });
      return out;
    }

    /** 自愈修复孤立条目：重置非合法文件夹引用的条目为 root */
    async repairOrphanedItems(libraryId) {
      const reg = await this._reg();
      libraryId = libraryId || reg.activeId;
      const lib = reg.libraries.find((l) => l.id === libraryId);
      if (!lib) return 0;
      const validFolderIds = new Set((lib.folders || []).map((f) => f.id));
      validFolderIds.add('root');

      const items = await this.allInLibrary(libraryId);
      let count = 0;
      for (const item of items) {
        if (item.folderId && !validFolderIds.has(item.folderId)) {
          item.folderId = 'root';
          item.updatedAt = Date.now();
          await this.storage.user(item.id, this._project(item));
          count++;
        }
      }
      if (count > 0) {
        await this._audit(AUDIT_ACTIONS.UPDATE, { summary: `自愈修复：重置 ${count} 个孤立条目回到根目录` });
        await this.loadItems(libraryId);
      }
      return count;
    }

    // ================= 加密 =================
    async unlockCrypto(password) {
      const existing = await this.storage.config('cryptoSalt');
      const salt = await this._crypto.unlock(password, existing);
      if (!existing) await this.storage.config('cryptoSalt', salt);
      this.bus.emit(global.EVENTS.CRYPTO_UNLOCK);
      return salt;
    }
    lockCrypto() {
      this._crypto.lock();
      this.bus.emit(global.EVENTS.CRYPTO_LOCK);
    }
    get crypto() { return this._crypto; }

    // ================= 导出 / 恢复 =================
    /** 全量导出：库结构 + 全部条目（含完整处理链）+ 审计日志 + 清单指纹 */
    async exportJSON() {
      const reg = await this._reg();
      const all = (await this.storage.allUser()).map((e) => e.value);
      const audit = await this.getAudit(5000);
      const body = { libraries: reg.libraries, activeId: reg.activeId, items: all, audit };
      const manifestHash = await sha256(JSON.stringify(body));
      const pkg = {
        format: 'research-vault-export', version: 2,
        exportedAt: Date.now(), count: all.length, manifestHash, ...body,
      };
      await this._audit(AUDIT_ACTIONS.EXPORT, { summary: `导出 ${all.length} 条目 + ${audit.length} 条审计（清单指纹 ${manifestHash.slice(0, 12)}…）` });
      return pkg;
    }

    /** 导出 CSV 表格清单 */
    async exportCSV() {
      const all = (await this.storage.allUser()).map((e) => e.value).filter(Boolean);
      const headers = ['id', 'title', 'kind', 'tags', 'libraryId', 'folderId', 'createdAt', 'updatedAt', 'rawHash'];
      const rows = all.map((it) => [
        it.id,
        `"${(it.title || '').replace(/"/g, '""')}"`,
        it.kind || 'note',
        `"${(it.tags || []).join(',')}"`,
        it.libraryId || '',
        it.folderId || 'root',
        it.createdAt || '',
        it.updatedAt || '',
        it.raw?.hash || '',
      ].join(','));
      await this._audit(AUDIT_ACTIONS.EXPORT, { summary: `导出 CSV 表格清单（共 ${all.length} 条目）` });
      return [headers.join(','), ...rows].join('\n');
    }

    /**
     * 从导出包恢复。默认合并（同 id 跳过，不覆盖已有数据）。
     * 恢复前校验清单指纹，指纹不符会警告但仍允许用户确认导入。
     */
    async restoreJSON(pkg, { overwrite = false } = {}) {
      if (!pkg || pkg.format !== 'research-vault-export') throw new Error('不是有效的 ResearchVault 导出文件');
      const { libraries, activeId, items = [], audit = [], manifestHash } = pkg;
      let verified = null;
      if (manifestHash) {
        const calc = await sha256(JSON.stringify({ libraries, activeId, items, audit }));
        verified = calc === manifestHash;
      }
      const reg = (await this._reg()) || { libraries: [], activeId: null };
      const known = new Set(reg.libraries.map((l) => l.id));
      for (const l of libraries || []) if (!known.has(l.id)) reg.libraries.push(l);
      if (!reg.activeId) reg.activeId = activeId || reg.libraries[0]?.id;
      await this.storage.config('libraries', reg);

      let added = 0, skipped = 0;
      for (const it of items) {
        const exists = await this.storage.user(it.id);
        if (exists && !overwrite) { skipped++; continue; }
        await this.storage.user(it.id, this._project(it));
        added++;
      }
      for (const a of audit) {
        if (!(await this.storage.audit(a.id))) await this.storage.audit(a.id, a);
      }
      await this._audit(AUDIT_ACTIONS.RESTORE, {
        summary: `恢复导入：新增 ${added} 条、跳过 ${skipped} 条${verified === false ? '（⚠ 清单指纹不符）' : verified ? '（清单指纹校验通过）' : ''}`,
      });
      this.bus.emit(global.EVENTS.VAULT_INIT, reg);
      await this.loadItems(reg.activeId);
      return { added, skipped, verified };
    }

    /** 调用外部系统关联 App（PDF/Excel/PPT/VSCode/System）打开该条目 */
    async openWith(id, appType = 'default') {
      const item = await this.storage.user(id);
      if (!item) throw new Error('条目不存在');
      const path = `rv:user:${item.id}`;
      const res = await this.ipc.invoke(global.CHANNELS.SHELL_OPEN, path, appType);
      await this._audit('item.openWith', { itemId: id, app: appType, summary: `调用外部程序 [${res.appName || appType}] 打开「${item.title}」` });
      return { ...res, item };
    }
  }

  global.VaultService = VaultService;
  global.AUDIT_ACTIONS = AUDIT_ACTIONS;
  global.MUTABLE_FIELDS = MUTABLE_FIELDS;
})(window);
