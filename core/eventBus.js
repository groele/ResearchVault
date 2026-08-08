/**
 * eventBus.js — 事件驱动的发布/订阅总线
 * ----------------------------------------------------------------
 * 所有模块间通信的唯一中枢。模块之间不直接 import 对方实例，
 * 而是通过 bus.on / bus.emit 解耦协作，保证低耦合、高内聚。
 *
 * 设计约定：
 *  - 事件名使用领域内聚的命名空间，例如 "vault:item:created"。
 *  - 所有事件名常量集中在 EVENTS，避免硬编码字符串散落各处。
 */
(function (global) {
  'use strict';

  class EventBus {
    constructor() {
      /** @type {Map<string, Set<Function>>} */
      this._listeners = new Map();
      /** @type {Map<string, Array<{fn:Function, once:boolean}>>} 历史快照（可选） */
      this._history = [];
    }

    /**
     * 订阅事件
     * @param {string} event
     * @param {Function} handler
     * @returns {Function} 取消订阅函数
     */
    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(handler);
      return () => this.off(event, handler);
    }

    /**
     * 订阅一次性事件
     */
    once(event, handler) {
      const wrap = (payload) => {
        this.off(event, wrap);
        handler(payload);
      };
      return this.on(event, wrap);
    }

    /**
     * 取消订阅
     */
    off(event, handler) {
      const set = this._listeners.get(event);
      if (set) set.delete(handler);
    }

    /**
     * 发布事件
     * @param {string} event
     * @param {*} payload
     */
    emit(event, payload) {
      this._history.push({ event, payload, t: Date.now() });
      if (this._history.length > 200) this._history.shift();
      const set = this._listeners.get(event);
      if (set) {
        // 复制一份，避免回调内增删监听导致迭代异常
        [...set].forEach((fn) => {
          try {
            fn(payload);
          } catch (err) {
            // 单个订阅者出错不影响其他订阅者
            console.error(`[eventBus] listener for "${event}" threw:`, err);
          }
        });
      }
      // 通配符 "*" 可监听所有事件（调试/日志用）
      const wild = this._listeners.get('*');
      if (wild) [...wild].forEach((fn) => fn({ event, payload }));
    }

    /** 清空全部监听（测试/重置用） */
    clear() {
      this._listeners.clear();
    }
  }

  // 全局唯一总线实例：渲染进程内共享
  const bus = new EventBus();

  // 领域事件名常量 —— 集中管理，防止拼写漂移
  const EVENTS = {
    // 存储层
    STORAGE_READY: 'storage:ready',
    STORAGE_ERROR: 'storage:error',
    // 资料库（业务）领域
    VAULT_INIT: 'vault:init',
    VAULT_ITEM_CREATED: 'vault:item:created',
    VAULT_ITEM_UPDATED: 'vault:item:updated',
    VAULT_ITEM_DELETED: 'vault:item:deleted',
    VAULT_ITEMS_LOADED: 'vault:items:loaded',
    VAULT_SEARCH: 'vault:search',
    VAULT_IMPORTED: 'vault:imported',
    VAULT_BULK_DONE: 'vault:bulk:done',
    // 可追溯性
    AUDIT_APPENDED: 'audit:appended',
    INTEGRITY_REPORT: 'integrity:report',
    // UI 意图（用户操作 -> 业务层）
    UI_CREATE_ITEM: 'ui:item:create',
    UI_OPEN_ITEM: 'ui:item:open',
    UI_TOGGLE_STAR: 'ui:item:toggleStar',
    UI_TAG_ITEM: 'ui:item:tag',
    UI_SEARCH: 'ui:search',
    UI_DELETE_ITEM: 'ui:item:delete',
    UI_SELECT_LIBRARY: 'ui:library:select',
    UI_MOVE_ITEM: 'ui:item:move',
    UI_BULK: 'ui:bulk',
    UI_SELECT_VERSION: 'ui:item:version',
    UI_FILTER: 'ui:filter',
    UI_SORT: 'ui:sort',
    UI_FOLDER_SELECT: 'ui:folder:select',
    UI_FOLDER_CREATE: 'ui:folder:create',
    UI_FOLDER_RENAME: 'ui:folder:rename',
    UI_FOLDER_DELETE: 'ui:folder:delete',
    UI_IMPORT_DROP: 'ui:import:drop',
    UI_RESTORE: 'ui:restore',
    UI_INTEGRITY: 'ui:integrity',
    UI_ENGINE_SWITCH: 'ui:engine:switch',
    UI_CLEAR_CACHE: 'ui:cache:clear',
    // 其他 UI 意图
    UI_EXPORT: 'ui:export',
    UI_THEME: 'ui:theme',
    UI_DENSITY: 'ui:density',
    UI_VIEWMODE: 'ui:viewMode',
    UI_DRAWER: 'ui:drawer',
    // 状态变化
    STATE_CHANGED: 'state:changed',
    // IPC / 原生能力
    IPC_INVOKE: 'ipc:invoke',
    IPC_EVENT: 'ipc:event',
    // 加密
    CRYPTO_LOCK: 'crypto:lock',
    CRYPTO_UNLOCK: 'crypto:unlock',
  };

  global.EventBus = EventBus;
  global.bus = bus;
  global.EVENTS = EVENTS;
})(window);
