/**
 * store.js — 状态管理模块（中心化、可预测）
 * ----------------------------------------------------------------
 * 职责：
 *  - 持有 UI 所需的全部应用状态（资料库、条目、筛选、排序、选择、主题…）。
 *  - 通过 reducer 纯函数计算新状态，保证状态变更可追踪、可重放。
 *  - 状态变化后以发布/订阅方式通知 UI（UI 层只订阅，不直接改状态）。
 *
 * 派生数据（filtered）在 reducer 内一次性算好，避免 UI 每帧重复计算。
 * 本模块不依赖任何 UI/DOM，纯逻辑，可独立测试。
 */
(function (global) {
  'use strict';

  const initialState = {
    ready: false,
    libraries: [],
    activeLibraryId: null,
    activeFolderId: 'root',
    items: [],               // 当前资料库的**全部**条目（文件夹过滤在 filtered 中派生）
    query: '',
    filters: { kind: 'all', starred: false, processed: 'all' }, // processed: all|yes|no
    sort: 'created_desc',    // created_desc|created_asc|title_asc|updated_desc
    filtered: [],
    selection: [],           // 批量选择的 id
    focusedId: null,
    density: 'comfortable',
    theme: 'light',
    cryptoLocked: true,
    viewMode: 'split',       // split | raw | processed
    engine: 'FileSystemAdapter',
    audit: [],
    integrity: null,         // 最近一次完整性自检报告
    drawer: null,            // null | 'audit' | 'settings'
    toast: null,
    error: null,
  };

  function reducer(state, action) {
    switch (action.type) {
      case 'STORAGE_READY':
        return { ...state, ready: true };
      case 'SET_LIBRARIES':
        return { ...state, libraries: action.libraries, activeLibraryId: action.activeId ?? state.activeLibraryId };
      case 'SET_ACTIVE_LIBRARY':
        return recompute({ ...state, activeLibraryId: action.id, activeFolderId: action.folder ?? 'root', selection: [], focusedId: null });
      case 'SET_FOLDER':
        return recompute({ ...state, activeFolderId: action.folderId, selection: [], focusedId: null });
      case 'SET_ITEMS': {
        const folderId = action.folderId ?? state.activeFolderId;
        return recompute({ ...state, items: action.items, activeFolderId: folderId });
      }
      case 'SET_VIEW_MODE':
        return { ...state, viewMode: action.mode };
      case 'ADD_ITEM':
        return recompute(mergeItems(state, action.item));
      case 'UPDATE_ITEM':
        return recompute(mergeItems(state, action.item, action.item && action.item.id));
      case 'REMOVE_ITEM': {
        const items = state.items.filter((i) => i.id !== action.id);
        return recompute({
          ...state, items,
          selection: state.selection.filter((s) => s !== action.id),
          focusedId: state.focusedId === action.id ? null : state.focusedId,
        });
      }
      case 'SET_QUERY':
        return recompute({ ...state, query: action.query });
      case 'SET_FILTER':
        return recompute({ ...state, filters: { ...state.filters, ...action.patch } });
      case 'SET_SORT':
        return recompute({ ...state, sort: action.sort });
      case 'SET_SELECTION':
        return { ...state, selection: action.ids };
      case 'TOGGLE_SELECT': {
        const has = state.selection.includes(action.id);
        return { ...state, selection: has ? state.selection.filter((x) => x !== action.id) : [...state.selection, action.id] };
      }
      case 'SELECT_ALL':
        return { ...state, selection: state.filtered.map((i) => i.id) };
      case 'CLEAR_SELECTION':
        return { ...state, selection: [] };
      case 'SET_FOCUSED':
        return { ...state, focusedId: action.id };
      case 'SET_DENSITY':
        return { ...state, density: action.density };
      case 'SET_THEME':
        return { ...state, theme: action.theme };
      case 'SET_CRYPTO':
        return { ...state, cryptoLocked: action.locked };
      case 'SET_ENGINE':
        return { ...state, engine: action.engine };
      case 'SET_AUDIT':
        return { ...state, audit: action.audit };
      case 'SET_INTEGRITY':
        return { ...state, integrity: action.report };
      case 'SET_DRAWER':
        return { ...state, drawer: action.drawer };
      case 'TOAST':
        return { ...state, toast: action.toast };
      case 'ERROR':
        return { ...state, error: action.error };
      case 'SET_LIB_FOLDERS': {
        const libraries = state.libraries.map((l) =>
          l.id === action.libraryId ? { ...l, folders: action.folders, activeFolder: action.activeFolder ?? l.activeFolder } : l);
        return { ...state, libraries };
      }
      default:
        return state;
    }
  }

  /** 统一重算派生列表：子项目文件夹 -> 搜索 -> 筛选 -> 排序 */
  function recompute(state) {
    let list = state.items;

    // 子项目文件夹视图：根目录只显示顶层，进入子项目才显示其内容
    const fid = state.activeFolderId || 'root';
    list = fid === 'root'
      ? list.filter((i) => !i.folderId || i.folderId === 'root')
      : list.filter((i) => i.folderId === fid);

    const q = (state.query || '').trim().toLowerCase();
    if (q) {
      list = list.filter((it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.name || '').toLowerCase().includes(q) ||
        (it.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        (it.raw?.content || '').toLowerCase().includes(q)
      );
    }
    const f = state.filters || {};
    if (f.kind && f.kind !== 'all') list = list.filter((i) => i.kind === f.kind);
    if (f.starred) list = list.filter((i) => i.starred);
    if (f.processed === 'yes') list = list.filter((i) => (i.processedVersions || []).length > 0);
    if (f.processed === 'no') list = list.filter((i) => !(i.processedVersions || []).length);

    const sorters = {
      created_desc: (a, b) => b.createdAt - a.createdAt,
      created_asc: (a, b) => a.createdAt - b.createdAt,
      updated_desc: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      title_asc: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'),
    };
    list = [...list].sort(sorters[state.sort] || sorters.created_desc);

    // 选择集只保留仍可见的条目，避免"看不见却被批量操作"
    const visible = new Set(list.map((i) => i.id));
    const selection = state.selection.filter((id) => visible.has(id));
    return { ...state, filtered: list, selection };
  }

  function mergeItems(state, item, byId) {
    if (!item) return state;
    const id = byId || item.id;
    const exists = state.items.some((i) => i.id === id);
    const items = exists
      ? state.items.map((i) => (i.id === id ? { ...i, ...item } : i))
      : [...state.items, item];
    return { ...state, items };
  }

  class Store {
    constructor(rootReducer, initial) {
      this._reducer = rootReducer;
      this._state = initial;
      this._subs = new Set();
    }
    getState() { return this._state; }
    dispatch(action) {
      const next = this._reducer(this._state, action);
      if (next !== this._state) {
        this._state = next;
        this._subs.forEach((fn) => fn(this._state, action));
      }
      return action;
    }
    subscribe(fn) {
      this._subs.add(fn);
      return () => this._subs.delete(fn);
    }
  }

  global.Store = Store;
  global.createStore = (initial = initialState) => new Store(reducer, initial);
  global.rootReducer = reducer;
  global.initialState = initialState;
})(window);
