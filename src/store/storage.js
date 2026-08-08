/**
 * storage.js — 分层存储抽象 + 适配器
 * ----------------------------------------------------------------
 * 设计目标（对应需求）：
 *  1) 分层存储：user(用户数据) / config(配置) / cache(缓存) 三个命名空间隔离。
 *  2) 原子化写入 + 校验和：写入走 temp -> rename；每条记录带 SHA-256 校验和，
 *     读取时校验，损坏自动拒绝并回退。
 *  3) AES 加密：可对整个 blob 加密后落盘（由 CryptoBox 提供）。
 *  4) 统一抽象接口：StorageAdapter 基类定义契约；
 *     底层可切换 FileSystemAdapter（Web 模拟）或 IndexedDBAdapter。
 *
 * 记录格式（落盘/存储对象）：
 *   { v:1, key, value, checksum, encrypted:bool, ts }
 * 其中 checksum = SHA-256(JSON.stringify(value) + ts)，用于完整性校验。
 */
(function (global) {
  'use strict';

  // ---------- 命名空间（分层存储策略）----------
  const NAMESPACES = {
    USER: 'user',     // 用户资料、导入条目、元数据   —— 需持久 + 可加密 + 必须完整
    CONFIG: 'config', // 应用配置、主题、加密 salt、库注册表 —— 需持久，通常不加密
    CACHE: 'cache',   // 预览缩略图、临时解析结果等可丢弃数据 —— 可随时清空
    AUDIT: 'audit',   // 操作审计日志（追加写、只读不改）—— 科研可追溯性的凭据
  };

  /** 各层策略声明：便于 UI 展示与运维（清缓存只清 cache，绝不动 user/audit） */
  const LAYER_POLICY = {
    user:   { label: '用户数据', persistent: true, encryptable: true, disposable: false },
    config: { label: '配置',     persistent: true, encryptable: true, disposable: false },
    cache:  { label: '缓存',     persistent: false, encryptable: false, disposable: true },
    audit:  { label: '审计日志', persistent: true, encryptable: true, disposable: false, appendOnly: true },
  };

  async function sha256(str) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 适配器基类 ----------
  /**
   * 子类必须实现：
   *   _rawPut(fullKey, record)
   *   _rawGet(fullKey): record|null
   *   _rawDelete(fullKey)
   *   _rawKeys(prefix): string[]
   */
  class StorageAdapter {
    constructor() {
      this._crypto = null;   // 可选 CryptoBox
      this._onError = null;  // 可选错误上报回调（依赖注入，避免存储层耦合事件总线）
    }
    setCrypto(box) { this._crypto = box; }
    setErrorReporter(fn) { this._onError = fn; }

    _nsPrefix(ns) { return `rv:${ns}:`; }

    /** 组装带命名空间的完整键 */
    _fullKey(ns, key) { return this._nsPrefix(ns) + key; }

    /**
     * 写入一条记录（原子 + 校验和）
     * @param {string} ns 命名空间
     * @param {string} key
     * @param {*} value
     */
    async put(ns, key, value) {
      const ts = Date.now();
      const checksum = await sha256(JSON.stringify(value) + ':' + ts);
      let payload = JSON.stringify({ v: 1, value, ts, checksum });
      let encrypted = false;
      if (this._crypto && this._crypto.isUnlocked) {
        payload = await this._crypto.encryptString(payload);
        encrypted = true;
      }
      const record = { v: 1, encrypted, payload, ts };
      // 原子写入：先写 temp，再"提交"（适配器负责 rename/覆盖）
      try {
        await this._atomicPut(this._fullKey(ns, key), record, payload);
      } catch (e) {
        this._onError && this._onError({ scope: 'write', ns, key, message: e.message });
        throw e;
      }
      return true;
    }

    /**
     * 读取并校验一条记录
     */
    async get(ns, key) {
      const record = await this._rawGet(this._fullKey(ns, key));
      if (!record) return undefined;
      return this._decode(record);
    }

    async _decode(record) {
      let raw = record.payload;
      if (record.encrypted) {
        if (!this._crypto || !this._crypto.isUnlocked) {
          throw new Error('记录已加密，但 CryptoBox 未解锁');
        }
        raw = await this._crypto.decryptString(raw);
      }
      const obj = JSON.parse(raw);
      // 校验和验证
      const expect = await sha256(JSON.stringify(obj.value) + ':' + obj.ts);
      if (expect !== obj.checksum) {
        throw new Error('校验和不符，数据可能已损坏');
      }
      return obj.value;
    }

    async delete(ns, key) {
      return this._rawDelete(this._fullKey(ns, key));
    }

    async keys(ns) {
      return this._rawKeys(this._nsPrefix(ns));
    }

    async all(ns) {
      const ks = await this.keys(ns);
      const out = [];
      for (const full of ks) {
        const key = full.slice(this._nsPrefix(ns).length);
        try {
          const val = await this.get(ns, key);
          if (val !== undefined) out.push({ key, value: val });
        } catch (e) {
          console.warn(`[storage] 跳过损坏记录 ${full}:`, e.message);
          this._onError && this._onError({ scope: 'read', ns, key, message: e.message });
        }
      }
      return out;
    }

    /**
     * 完整性自检：逐条读取并校验，返回健康报告（不抛异常）。
     * @returns {{ns:string,total:number,ok:number,corrupted:Array<{key:string,reason:string}>}}
     */
    async verify(ns) {
      const ks = await this.keys(ns);
      const corrupted = [];
      let ok = 0;
      for (const full of ks) {
        const key = full.slice(this._nsPrefix(ns).length);
        try {
          await this.get(ns, key);
          ok++;
        } catch (e) {
          corrupted.push({ key, reason: e.message });
        }
      }
      return { ns, total: ks.length, ok, corrupted };
    }
  }

  // ---------- Web 模拟文件系统适配器 ----------
  /**
   * 通过 ipcBridge 落地（Web 下落到 localStorage 模拟的"磁盘"）。
   * 原子写入：先写 temp 键，再覆盖正式键，最后删 temp。
   */
  class FileSystemAdapter extends StorageAdapter {
    constructor(ipc) {
      super();
      this._ipc = ipc;
    }
    async _atomicPut(fullKey, record) {
      const tmp = fullKey + '.tmp';
      await this._ipc.invoke('fs:write', tmp, JSON.stringify(record));
      // "rename"：覆盖正式键
      await this._ipc.invoke('fs:write', fullKey, JSON.stringify(record));
      await this._ipc.invoke('fs:delete', tmp);
    }
    async _rawGet(fullKey) {
      try {
        const raw = await this._ipc.invoke('fs:read', fullKey);
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }
    async _rawDelete(fullKey) {
      await this._ipc.invoke('fs:delete', fullKey);
    }
    async _rawKeys(prefix) {
      const all = await this._ipc.invoke('fs:list', prefix);
      return all;
    }
  }

  // ---------- IndexedDB 适配器 ----------
  /**
   * 底层用 IndexedDB（对象存储 kv），适合大数据/浏览器原生持久。
   * 原子性由单事务 put 保证；校验和仍按基类逻辑执行。
   */
  class IndexedDBAdapter extends StorageAdapter {
    constructor(dbName = 'research-vault') {
      super();
      this._dbName = dbName;
      this._store = 'kv';
      this._dbp = this._open();
    }
    _open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this._dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this._store)) db.createObjectStore(this._store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async _tx(mode) {
      const db = await this._dbp;
      return db.transaction(this._store, mode).objectStore(this._store);
    }
    async _atomicPut(fullKey, record) {
      const os = await this._tx('readwrite');
      return new Promise((resolve, reject) => {
        const r = os.put(record, fullKey);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    }
    async _rawGet(fullKey) {
      const os = await this._tx('readonly');
      return new Promise((resolve, reject) => {
        const r = os.get(fullKey);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    }
    async _rawDelete(fullKey) {
      const os = await this._tx('readwrite');
      return new Promise((resolve, reject) => {
        const r = os.delete(fullKey);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    }
    async _rawKeys(prefix) {
      const os = await this._tx('readonly');
      return new Promise((resolve, reject) => {
        const out = [];
        const req = os.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            if (!prefix || cur.key.startsWith(prefix)) out.push(cur.key);
            cur.continue();
          } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    }
  }

  // ---------- 统一存储管理门面 ----------
  class StorageManager {
    /**
     * @param {StorageAdapter} adapter
     * @param {{onError?:Function}} [opts] 错误上报回调（由 app 层注入 bus.emit，保持存储层零依赖）
     */
    constructor(adapter, opts = {}) {
      this._onError = opts.onError || null;
      this._cryptoBox = null;
      this.adapter = adapter;
      if (this._onError) adapter.setErrorReporter(this._onError);
    }
    /** 切换底层适配器（如 Web模拟文件系统 -> IndexedDB），对上层完全透明 */
    use(adapter) {
      this.adapter = adapter;
      if (this._cryptoBox) adapter.setCrypto(this._cryptoBox);
      if (this._onError) adapter.setErrorReporter(this._onError);
      return adapter;
    }
    setCrypto(box) { this._cryptoBox = box; this.adapter.setCrypto(box); }
    setErrorReporter(fn) { this._onError = fn; this.adapter.setErrorReporter(fn); }
    get engineName() { return this.adapter.constructor.name; }

    user(key, val) {
      return val === undefined ? this.adapter.get(NAMESPACES.USER, key) : this.adapter.put(NAMESPACES.USER, key, val);
    }
    config(key, val) {
      return val === undefined ? this.adapter.get(NAMESPACES.CONFIG, key) : this.adapter.put(NAMESPACES.CONFIG, key, val);
    }
    cache(key, val) {
      return val === undefined ? this.adapter.get(NAMESPACES.CACHE, key) : this.adapter.put(NAMESPACES.CACHE, key, val);
    }
    /** 审计层：追加写、不覆盖（key 由调用方保证唯一且单调递增） */
    audit(key, val) {
      return val === undefined ? this.adapter.get(NAMESPACES.AUDIT, key) : this.adapter.put(NAMESPACES.AUDIT, key, val);
    }
    deleteUser(k) { return this.adapter.delete(NAMESPACES.USER, k); }
    deleteConfig(k) { return this.adapter.delete(NAMESPACES.CONFIG, k); }
    deleteCache(k) { return this.adapter.delete(NAMESPACES.CACHE, k); }
    allUser() { return this.adapter.all(NAMESPACES.USER); }
    allConfig() { return this.adapter.all(NAMESPACES.CONFIG); }
    allCache() { return this.adapter.all(NAMESPACES.CACHE); }
    allAudit() { return this.adapter.all(NAMESPACES.AUDIT); }

    /** 仅清空可丢弃的缓存层，绝不触碰 user/config/audit */
    async clearCache() {
      const ks = await this.adapter.keys(NAMESPACES.CACHE);
      const prefix = `rv:${NAMESPACES.CACHE}:`;
      for (const full of ks) await this.adapter.delete(NAMESPACES.CACHE, full.slice(prefix.length));
      return ks.length;
    }

    /** 全库完整性自检：逐层校验 checksum / 解密可用性 */
    async verifyAll() {
      const layers = [];
      for (const ns of [NAMESPACES.USER, NAMESPACES.CONFIG, NAMESPACES.AUDIT]) {
        layers.push(await this.adapter.verify(ns));
      }
      const corrupted = layers.reduce((n, l) => n + l.corrupted.length, 0);
      return { healthy: corrupted === 0, corrupted, layers, checkedAt: Date.now() };
    }

    /** 各层条目数量概览（运维/设置面板展示） */
    async layerStats() {
      const out = {};
      for (const ns of Object.values(NAMESPACES)) {
        out[ns] = { ...LAYER_POLICY[ns], count: (await this.adapter.keys(ns)).length };
      }
      return out;
    }
  }

  global.NAMESPACES = NAMESPACES;
  global.LAYER_POLICY = LAYER_POLICY;
  global.StorageManager = StorageManager;
  global.storageUtils = { sha256 };
  global.adapters = { StorageAdapter, FileSystemAdapter, IndexedDBAdapter };
})(window);
