/**
 * ui.js — UI 渲染层（视图）
 * ----------------------------------------------------------------
 * 三栏布局：左侧栏（资料库 + 子项目文件夹树）/ 中间条目列表 / 右侧预览(原始↔后处理)。
 * 仅订阅 Store 渲染；业务类操作经 EVENTS.* 意图广播给 app.js 接线到 VaultService，
 * 纯视图状态（主题/密度/视图模式/抽屉/选择/聚焦/搜索/筛选/排序）直接 dispatch 到 Store。
 *
 * 设计要点：
 *  - 文件夹视图由 Store.recompute 派生，侧栏各文件夹计数基于"资料库全部条目"精确计算。
 *  - 右侧预览支持版本选择器、原始↔后处理差异对比、原始数据 SHA-256 指纹实时校验徽章。
 *  - 支持批量多选（Space/复选框）、拖放导入、键盘快捷键、审计抽屉与设置抽屉。
 *
 * 性能与健壮性：
 *  - 每个渲染小节带"脏检查签名"，无关状态变化时跳过整段 DOM 重建，避免输入/选择时的全量重绘与闪烁。
 *  - 列表仅在"数据签名"变化时全量重建；仅选择/聚焦变化时就地打补丁，不重建卡片。
 *  - 预览渲染包裹 try/catch，单条异常文件不致拖垮整个渲染循环。
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const qs = (id) => document.getElementById(id);
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
    catch { return String(ts || ''); }
  }
  function kindLabel(k) {
    return ({ note: '笔记', data: '数据', paper: '论文', image: '图片', other: '其他' })[k] || k || '其他';
  }
  function kindIcon(k) {
    return ({ note: '📝', data: '📊', paper: '📄', image: '🖼️', other: '📦' })[k] || '📦';
  }

  class UI {
    constructor(store, bus) {
      this.store = store;
      this.bus = bus;
      this._diffOpen = false;
      this._verifyCache = new Map(); // 指纹校验结果缓存（key = id|hash），避免每次渲染重复计算 SHA-256
      this._sig = {};                // 各渲染小节的脏检查签名
      this._toast = undefined;       // 当前 Toast 文案（防止重复重建导致闪烁）
      this._modalEl = null;
      this._collapsed = new Set();   // 已折叠的文件夹 id（侧栏树形折叠）
      this._dragIds = [];            // 拖拽中选中的条目 id（拖到文件夹即归类）
      this._lastActiveFolder = null; // 用于仅在文件夹切换时滚动定位
      this._sideQuery = '';          // 侧栏搜索过滤词（UI 本地，不进 store）
      this._editingFolder = null;    // 正在内联重命名的文件夹 id（重命名期间冻结侧栏）
      this._pvTab = 'doc';           // 侧栏预览当前页签 (doc | meta | provenance | diff)
      this._bindStatic();
      this._bindKeys();
      this._bindResizer();
      store.subscribe((s) => this.render(s));
    }

    // ============ 静态元素绑定（一次性）============
    _bindStatic() {
      qs('searchInput').addEventListener('input', (e) =>
        this.store.dispatch({ type: 'SET_QUERY', query: e.target.value }));
      const btnNew = qs('btnNew');
      const newMenu = qs('newMenu');
      if (btnNew && newMenu) {
        btnNew.addEventListener('click', (e) => {
          e.stopPropagation();
          newMenu.hidden = !newMenu.hidden;
        });
        document.addEventListener('click', () => { newMenu.hidden = true; });
      }
      qs('menuNewNote')?.addEventListener('click', () => this._openCreate());
      qs('menuImportFile')?.addEventListener('click', () => this.bus.emit('ui:import:pick', {}));
      qs('menuImportDir')?.addEventListener('click', () => this.bus.emit('ui:import:dir', {}));
      qs('menuNewFolder')?.addEventListener('click', () => this._openNewFolder());
      qs('btnNew')?.addEventListener('click', () => {});
      qs('btnImport')?.addEventListener('click', () => this.bus.emit('ui:import:pick', {}));
      qs('btnImportFolder')?.addEventListener('click', () => this.bus.emit('ui:import:dir', {}));
      qs('btnNewFolder')?.addEventListener('click', () => this._openNewFolder());
      qs('btnLineage').addEventListener('click', () => this._openLineageModal());
      qs('btnCmd').addEventListener('click', () => this._openCmdPalette());
      qs('btnTheme').addEventListener('click', () => {
        const t = this.store.getState().theme === 'dark' ? 'light' : 'dark';
        this.bus.emit(global.EVENTS.UI_THEME, { theme: t });
      });
      qs('btnLock').addEventListener('click', () => this._openCrypto());
      qs('btnHelp').addEventListener('click', () => this._openHelpModal());
      qs('btnExport').addEventListener('click', () => this.bus.emit(global.EVENTS.UI_EXPORT, {}));
      qs('btnNewLib').addEventListener('click', () => this._openNewLib());
      qs('btnSettings').addEventListener('click', () =>
        this.store.dispatch({ type: 'SET_DRAWER', drawer: 'settings' }));
      qs('btnAudit').addEventListener('click', () =>
        this.store.dispatch({ type: 'SET_DRAWER', drawer: 'audit' }));

      // 侧栏搜索：按名称过滤资料库 / 子项目（不重建输入框本身，故不丢焦点）
      const ss = qs('sideSearch');
      const ssClear = qs('sideSearchClear');
      if (ss) {
        ss.addEventListener('input', (e) => {
          this._sideQuery = e.target.value.trim();
          if (ssClear) ssClear.hidden = !this._sideQuery;
          this.render(this.store.getState());
        });
        ss.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { ss.value = ''; this._sideQuery = ''; if (ssClear) ssClear.hidden = true; this.render(this.store.getState()); }
        });
      }
      if (ssClear) ssClear.addEventListener('click', () => {
        const s2 = qs('sideSearch'); if (s2) s2.value = ''; this._sideQuery = ''; ssClear.hidden = true; if (s2) s2.focus(); this.render(this.store.getState());
      });

      // 视图分段：原始 / 对比 / 后处理
      qs('viewSeg').querySelectorAll('[data-view]').forEach((b) =>
        b.addEventListener('click', () =>
          this.store.dispatch({ type: 'SET_VIEW_MODE', mode: b.dataset.view })));

      qs('selKind').addEventListener('change', (e) =>
        this.store.dispatch({ type: 'SET_FILTER', patch: { kind: e.target.value } }));
      qs('selProcessed').addEventListener('change', (e) =>
        this.store.dispatch({ type: 'SET_FILTER', patch: { processed: e.target.value } }));
      qs('selRepro').addEventListener('change', (e) =>
        this.store.dispatch({ type: 'SET_FILTER', patch: { reproducibility: e.target.value } }));
      qs('selSort').addEventListener('change', (e) =>
        this.store.dispatch({ type: 'SET_SORT', sort: e.target.value }));
      qs('btnStarFilter').addEventListener('click', () => {
        const cur = this.store.getState().filters.starred;
        this.store.dispatch({ type: 'SET_FILTER', patch: { starred: !cur } });
      });

      // 拖放导入
      const main = qs('mainPane');
      const dz = qs('dropzone');
      let depth = 0;
      main.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dz.classList.add('show'); });
      main.addEventListener('dragover', (e) => e.preventDefault());
      main.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('show'); });
      main.addEventListener('drop', (e) => {
        e.preventDefault(); depth = 0; dz.classList.remove('show');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          this.bus.emit(global.EVENTS.UI_IMPORT_DROP, { fileList: e.dataTransfer.files });
        }
      });
    }

    // ============ 预览侧边栏动态拖拽宽度 ============
    _bindResizer() {
      const resizer = qs('pvResizer');
      const preview = qs('preview');
      if (!resizer || !preview) return;

      const savedWidth = localStorage.getItem('rv_preview_width');
      if (savedWidth) preview.style.width = savedWidth + 'px';

      let isDragging = false;
      let startX = 0;
      let startWidth = 0;

      resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = preview.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const delta = startX - e.clientX;
        const newWidth = Math.max(320, Math.min(850, startWidth + delta));
        preview.style.width = newWidth + 'px';
        localStorage.setItem('rv_preview_width', newWidth);
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // ============ 键盘快捷键 ============
    _bindKeys() {
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this._openCmdPalette();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          const pane = qs('preview');
          const resizer = qs('pvResizer');
          if (pane) {
            const isHidden = pane.style.display === 'none';
            pane.style.display = isHidden ? 'flex' : 'none';
            if (resizer) resizer.style.display = isHidden ? 'block' : 'none';
            this.store.dispatch({ type: 'TOAST', toast: isHidden ? '📖 已展开侧栏预览 (Ctrl+P)' : '✕ 已收起侧栏预览 (Ctrl+P)' });
          }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
          e.preventDefault();
          this._openLineageModal();
          return;
        }
        if (e.key === '?' || e.key === 'F1') {
          e.preventDefault();
          this._openHelpModal();
          return;
        }
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (this._modalEl) return; // 模态打开时，背景快捷键全部让位给模态自身处理
        const s = this.store.getState();
        const list = s.filtered;
        switch (e.key) {
          case '/': e.preventDefault(); qs('searchInput').focus(); break;
          case 'j': case 'ArrowDown': if (list.length) { e.preventDefault(); this._moveFocus(1); } break;
          case 'k': case 'ArrowUp': if (list.length) { e.preventDefault(); this._moveFocus(-1); } break;
          case 'Enter': if (s.focusedId) { e.preventDefault(); this.store.dispatch({ type: 'SET_FOCUSED', id: s.focusedId }); } break;
          case 'x': if (s.focusedId) { e.preventDefault(); this.bus.emit(global.EVENTS.UI_TOGGLE_STAR, { id: s.focusedId }); } break;
          case ' ': if (s.focusedId) { e.preventDefault(); this.store.dispatch({ type: 'TOGGLE_SELECT', id: s.focusedId }); } break;
          case 'Delete': case 'Backspace': if (s.focusedId) { e.preventDefault(); this._confirmDelete(s.focusedId); } break;
          case 'Escape': this._closeOverlays(); break;
        }
      });
    }

    _moveFocus(dir) {
      const s = this.store.getState();
      const list = s.filtered;
      if (!list.length) return;
      const idx = list.findIndex((i) => i.id === s.focusedId);
      let next = idx < 0 ? 0 : idx + dir;
      next = Math.max(0, Math.min(list.length - 1, next));
      const id = list[next].id;
      this.store.dispatch({ type: 'SET_FOCUSED', id });
      const el = document.querySelector(`[data-item="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    _confirmDelete(id) {
      const s = this.store.getState();
      const it = s.items.find((i) => i.id === id);
      if (!it) return;
      if (confirm(`确认删除「${it.title || it.name}」？该操作会留痕审计，且不可自动恢复。`)) {
        this.bus.emit(global.EVENTS.UI_DELETE_ITEM, { id });
      }
    }

    _closeOverlays() {
      if (this._modalEl) { this._closeModal(); return; }
      const s = this.store.getState();
      if (s.drawer) { this.store.dispatch({ type: 'SET_DRAWER', drawer: null }); return; }
      if (s.selection.length) { this.store.dispatch({ type: 'CLEAR_SELECTION' }); return; }
      if (s.focusedId) this.store.dispatch({ type: 'SET_FOCUSED', id: null });
    }

    // ============ 主渲染（按小节容错，避免单点失败拖垮整体）============
    render(s) {
      try {
        if (document.documentElement.getAttribute('data-theme') !== s.theme) {
          document.documentElement.setAttribute('data-theme', s.theme);
        }
      } catch (e) { /* 忽略属性写入异常 */ }

      const sections = [
        this._renderSidebar, this._renderTopbar, this._renderToolbar, this._renderStats,
        this._renderList, this._renderBulk, this._renderPreview, this._renderDrawer, this._renderToast,
      ];
      for (const fn of sections) {
        try { fn.call(this, s); }
        catch (e) { console.error('[UI] ' + (fn.name || 'section') + ' 渲染出错（已隔离）:', e); }
      }
    }

    // ---------- 侧边栏 ----------
    _renderSidebar(s) {
      if (this._editingFolder) return; // 内联重命名进行中：冻结侧栏，避免输入被打断
      const q = this._sideQuery || '';
      const ql = q.toLowerCase();
      const sig = JSON.stringify([
        s.activeLibraryId, s.activeFolderId, s.libraryStats, q,
        s.libraries.map((l) => [l.id, l.name, l.color, l.activeFolder, l.folders.map((f) => [f.id, f.name, f.parent, f.icon])]),
      ]);
      if (this._sig.sidebar === sig) return;
      this._sig.sidebar = sig;

      // 空状态：尚未创建任何资料库
      if (!s.libraries.length) {
        qs('libList').innerHTML = `<div class="side-empty">
          <div class="se-icon">🗂️</div>
          <div class="se-title">还没有资料库</div>
          <div class="se-sub">创建第一个资料库，开始管理科研数据</div>
          <button class="btn primary sm" id="sideNewLib">＋ 新建资料库</button>
        </div>`;
        const b = qs('sideNewLib');
        if (b) b.onclick = () => this._openNewLib();
        return;
      }

      // 搜索过滤：仅保留名称命中的资料库
      const libMatch = (l) => !ql || (l.name || '').toLowerCase().includes(ql) || (l.icon || '').toLowerCase().includes(ql);
      const shownLibs = s.libraries.filter(libMatch);
      if (ql && !shownLibs.length) {
        qs('libList').innerHTML = `<div class="side-empty">
          <div class="se-icon">🔍</div>
          <div class="se-title">未找到匹配</div>
          <div class="se-sub">没有名称包含「${escapeHtml(q)}」的资料库或子项目</div>
        </div>`;
        return;
      }

      const libs = shownLibs.map((l) => {
        const active = l.id === s.activeLibraryId;
        const expandTree = active || !!ql; // 激活库或搜索时展开树
        const tree = expandTree ? this._folderTree(l, s.activeFolderId, ql) : '';
        const count = this._countInLib(s, l.id);
        return `
          <div class="lib-block">
            <div class="lib-card ${active ? 'active' : ''}" data-lib="${l.id}">
              <span class="dot" style="background:${l.color}"></span>
              <div class="meta">
                <div class="name">${escapeHtml(l.icon || '📁')} ${escapeHtml(l.name)}</div>
                <div class="sub">${(l.status || 'active')} · ${count} 项</div>
              </div>
              <span class="chev">${active ? '▾' : '▸'}</span>
            </div>
            ${tree}
          </div>`;
      }).join('');
      qs('libList').innerHTML = libs;

      // 仅在切换文件夹时，将激活文件夹滚动到可见区（避免每次选择都跳）
      if (s.activeFolderId !== this._lastActiveFolder) {
        this._lastActiveFolder = s.activeFolderId;
        const af = qs('libList').querySelector('.folder.active');
        if (af) af.scrollIntoView({ block: 'nearest' });
      }

      qs('libList').querySelectorAll('[data-lib]').forEach((el) =>
        el.onclick = () => this.bus.emit(global.EVENTS.UI_SELECT_LIBRARY, { id: el.dataset.lib }));
      qs('libList').querySelectorAll('[data-folder]').forEach((el) => {
        el.onclick = (e) => {
          if (e.target.closest('.fop') || e.target.closest('.fcaret')) return;
          // 点击非激活资料库下的文件夹：先切换资料库，再进入该文件夹
          const libEl = el.closest('.lib-block')?.querySelector('[data-lib]');
          const libId = libEl?.dataset.lib;
          if (libId && libId !== s.activeLibraryId) this.bus.emit(global.EVENTS.UI_SELECT_LIBRARY, { id: libId });
          this.bus.emit(global.EVENTS.UI_FOLDER_SELECT, { folderId: el.dataset.folder });
        };
        // 拖拽归类：把选中的条目拖到某文件夹即移动
        el.addEventListener('dragover', (e) => { if (this._dragIds.length) { e.preventDefault(); el.classList.add('drag-over'); } });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', (e) => {
          e.preventDefault(); el.classList.remove('drag-over');
          if (this._dragIds.length) {
            const ids = this._dragIds.slice();
            this._dragIds = [];
            this.bus.emit(global.EVENTS.UI_BULK, { action: 'move', ids, payload: { folderId: el.dataset.folder } });
            this.bus.emit(global.EVENTS.UI_FOLDER_SELECT, { folderId: el.dataset.folder });
            this.store.dispatch({ type: 'CLEAR_SELECTION' });
          }
        });
      });
      qs('libList').querySelectorAll('[data-fren]').forEach((el) =>
        el.onclick = (e) => { e.stopPropagation(); this._renameFolder(el.dataset.fren); });
      qs('libList').querySelectorAll('[data-fdel]').forEach((el) =>
        el.onclick = (e) => { e.stopPropagation(); this._deleteFolder(el.dataset.fdel); });
      qs('libList').querySelectorAll('[data-fcol]').forEach((el) =>
        el.onclick = (e) => { e.stopPropagation(); this._toggleCollapse(el.dataset.fcol); });
    }

    _toggleCollapse(folderId) {
      if (this._collapsed.has(folderId)) this._collapsed.delete(folderId);
      else this._collapsed.add(folderId);
      this._sig.sidebar = null; // 强制重渲染侧栏
      this.render(this.store.getState());
    }

    _folderTree(lib, activeFolderId, ql) {
      const folders = lib.folders || [{ id: 'root', name: '根目录', parent: null }];
      const byParent = {};
      const byId = {};
      folders.forEach((f) => { (byParent[f.parent] = byParent[f.parent] || []).push(f); byId[f.id] = f; });
      const hasKids = (pid) => (byParent[pid] || []).length > 0;

      // 需保留/展开的文件夹集合：
      //  - 搜索模式：命中项 + 其祖先（保持树连贯），并强制展开
      //  - 非搜索模式：激活文件夹的祖先链（确保当前位置始终可见，即便曾被折叠）
      let keepSet = null;
      if (ql) {
        keepSet = new Set();
        folders.forEach((f) => {
          if ((f.name || '').toLowerCase().includes(ql)) {
            let c = f; while (c) { keepSet.add(c.id); c = c.parent ? byId[c.parent] : null; }
          }
        });
      } else {
        let cur = folders.find((f) => f.id === activeFolderId);
        while (cur && cur.parent) { (keepSet = keepSet || new Set()).add(cur.parent); cur = byId[cur.parent]; }
      }

      const walk = (pid, depth) => {
        let kids = byParent[pid] || [];
        if (ql) kids = kids.filter((f) => keepSet.has(f.id));
        return kids.map((f) => {
          const count = this._countInFolder(lib.id, f.id);
          const isCollapsed = !ql && this._collapsed.has(f.id) && !(keepSet && keepSet.has(f.id));
          const kidsHtml = (!isCollapsed && hasKids(f.id)) ? `<div class="subtree">${walk(f.id, depth + 1)}</div>` : '';
          const caret = hasKids(f.id)
            ? `<span class="fcaret" data-fcol="${f.id}">${isCollapsed ? '▸' : '▾'}</span>`
            : '<span class="fcaret empty"></span>';
          const isParent = hasKids(f.id);
          const icon = f.id === 'root' ? '📦' : (isParent ? (isCollapsed ? '📁' : '📂') : '📄');
          const ops = f.id === 'root' ? '' :
            `<span class="fop"><button class="fmini" data-fren="${f.id}" title="重命名">✎</button><button class="fmini danger" data-fdel="${f.id}" title="删除（条目上移父级）">🗑</button></span>`;
          // 搜索命中项高亮名称
          const nameHtml = (ql && (f.name || '').toLowerCase().includes(ql))
            ? `<span class="fname hit">${escapeHtml(f.name)}</span>`
            : `<span class="fname">${escapeHtml(f.name)}</span>`;
          return `
            <div class="folder ${f.id === activeFolderId ? 'active' : ''} ${isCollapsed ? 'collapsed' : ''}" data-folder="${f.id}">
              ${caret}
              <span class="ficon">${icon}</span>
              ${nameHtml}
              <span class="fcount">${count}</span>
              ${ops}
            </div>
            ${kidsHtml}`;
        }).join('');
      };
      return `<div class="tree">${walk('root', 0)}</div>`;
    }

    _countInLib(s, libId) { return s.libraryStats[libId]?.total ?? 0; }
    _countInFolder(libId, folderId) {
      return this.store.getState().libraryStats[libId]?.folders?.[folderId] ?? 0;
    }

    // ---------- 顶栏面包屑 ----------
    _renderTopbar(s) {
      const sig = JSON.stringify([s.activeLibraryId, s.activeFolderId, s.density, s.cryptoLocked]);
      if (this._sig.topbar === sig) return;
      this._sig.topbar = sig;

      const lib = s.libraries.find((l) => l.id === s.activeLibraryId);
      const folders = lib?.folders || [];
      const path = this._folderPath(folders, s.activeFolderId);
      qs('crumb').innerHTML = `<span class="c-lib">${escapeHtml(lib?.icon || '📁')} ${escapeHtml(lib?.name || '资料库')}</span>` +
        path.map((f) => `<span class="c-sep">/</span><span class="c-f ${f.id === s.activeFolderId ? 'cur' : ''}">${escapeHtml(f.name)}</span>`).join('');
      qs('btnDensity').textContent = s.density === 'compact' ? '☰ 紧凑' : '▦ 舒适';
      qs('btnLock').textContent = s.cryptoLocked ? '🔓' : '🔒';
      qs('btnLock').title = s.cryptoLocked ? '加密存储：未锁（点击解锁/设置密码）' : '加密存储：已锁定';
      qs('btnLock').classList.toggle('on', !s.cryptoLocked);
    }
    _folderPath(folders, activeId) {
      const map = Object.fromEntries((folders || []).map((f) => [f.id, f]));
      const out = []; let cur = map[activeId];
      while (cur) { out.unshift(cur); cur = cur.parent ? map[cur.parent] : null; }
      return out;
    }

    // ---------- 工具栏激活态 ----------
    _renderToolbar(s) {
      const sig = JSON.stringify([s.filters, s.sort, s.viewMode]);
      if (this._sig.toolbar === sig) return;
      this._sig.toolbar = sig;

      qs('viewSeg').querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === s.viewMode));
      if (qs('selKind').value !== s.filters.kind) qs('selKind').value = s.filters.kind;
      if (qs('selProcessed').value !== s.filters.processed) qs('selProcessed').value = s.filters.processed;
      if (qs('selSort').value !== s.sort) qs('selSort').value = s.sort;
      qs('btnStarFilter').classList.toggle('on', !!s.filters.starred);
      qs('btnStarFilter').textContent = s.filters.starred ? '★ 收藏' : '☆ 收藏';
    }

    // ---------- 统计 ----------
    _renderStats(s) {
      const vis = s.filtered;
      const starred = vis.filter((i) => i.starred).length;
      const processed = vis.filter((i) => (i.processedVersions || []).length > 0).length;
      const tags = new Set(s.items.flatMap((i) => i.tags || [])).size;
      const sig = `${vis.length}|${s.items.length}|${starred}|${processed}|${tags}`;
      if (this._sig.stats === sig) return;
      this._sig.stats = sig;

      qs('stats').innerHTML = `
        <div class="stat"><div class="num">${vis.length}</div><div class="lbl">可见</div></div>
        <div class="stat"><div class="num">${s.items.length}</div><div class="lbl">资料库总计</div></div>
        <div class="stat"><div class="num">${starred}</div><div class="lbl">收藏</div></div>
        <div class="stat"><div class="num">${processed}</div><div class="lbl">已后处理</div></div>
        <div class="stat"><div class="num">${tags}</div><div class="lbl">标签</div></div>`;
    }

    // ---------- 卡片列表（脏检查 + 选择/聚焦就地补丁）----------
    _renderList(s) {
      const wrap = qs('cards');
      wrap.className = 'cards' + (s.density === 'compact' ? ' compact' : '');
      if (!s.ready) {
        if (this._sig.listReady !== false) {
          wrap.innerHTML = Array.from({ length: 8 }).map(() => '<div class="skeleton"></div>').join('');
          this._sig.listReady = false;
        }
        this._sig.list = '';
        return;
      }
      this._sig.listReady = true;

      // 空状态：区分"搜索/筛选无果"与"真无条目"
      if (!s.filtered.length) {
        const filtered = s.query || s.filters.kind !== 'all' || s.filters.starred || s.filters.processed !== 'all' || s.filters.reproducibility !== 'all';
        const emptySig = 'empty:' + (filtered ? 'f' : '0') + ':' + (s.query || '');
        if (this._sig.list !== emptySig) {
          if (filtered) {
            wrap.innerHTML = `<div class="empty"><div class="big">🔍</div><div>未找到匹配的资产条目</div><div class="muted">试试重置筛选条件或调整关键词${s.query ? `：「${escapeHtml(s.query)}」` : ''}</div></div>`;
          } else {
            wrap.innerHTML = `
              <div class="empty-hero">
                <div class="hero-icon">🔬</div>
                <h3 class="hero-title">欢迎使用 ResearchVault 科研项目综合管理系统</h3>
                <p class="hero-subtitle">课题数据、代码脚本、文献与模型一体化管理，支持不可变指纹链与智能分类打标签</p>
                <div class="hero-cards">
                  <div class="hero-card" id="heroNewNote">
                    <div class="hc-icon">📝</div>
                    <div class="hc-title">新建科研笔记</div>
                    <div class="hc-desc">记录实验思路、算法公式与推导步骤</div>
                  </div>
                  <div class="hero-card" id="heroImportDir">
                    <div class="hc-icon">📁</div>
                    <div class="hc-title">导入课题数据集 / 文件夹</div>
                    <div class="hc-desc">选择文件夹，自动按扩展名归类打标签</div>
                  </div>
                  <div class="hero-card" id="heroImportFile">
                    <div class="hc-icon">💻</div>
                    <div class="hc-title">导入代码或模型权重</div>
                    <div class="hc-desc">支持 Python、PyTorch 权重、PDF 文献</div>
                  </div>
                </div>
              </div>`;
            qs('heroNewNote')?.addEventListener('click', () => this._openCreate());
            qs('heroImportDir')?.addEventListener('click', () => this.bus.emit('ui:import:dir', {}));
            qs('heroImportFile')?.addEventListener('click', () => this.bus.emit('ui:import:pick', {}));
          }
          this._sig.list = emptySig;
        }
        return;
      }

      // 数据签名：捕获会影响卡片 HTML 的全部字段；签名不变则只补丁选择/聚焦
      const dataSig = s.filtered.map((i) =>
        `${i.id}:${i.starred ? 1 : 0}:${(i.processedVersions || []).length}:${i.currentVersion || ''}:${i.raw?.hash || ''}:${(i.tags || []).join(',')}:${i.title}:${i.kind}:${s.density}`
      ).join('|');

      if (this._sig.list === dataSig) {
        this._patchListVisual(s); // 仅选择/聚焦变化 → 就地改类，不重建
        return;
      }
      wrap.innerHTML = s.filtered.map((it) => this._cardHtml(it, s)).join('');
      this._bindCards(s);
      this._sig.list = dataSig;
    }

    /** 仅更新每张卡片的选中/聚焦态（含复选框），不重建 DOM */
    _patchListVisual(s) {
      const sel = new Set(s.selection);
      qs('cards').querySelectorAll('[data-item]').forEach((el) => {
        const id = el.dataset.item;
        el.classList.toggle('sel', sel.has(id));
        el.classList.toggle('focused', id === s.focusedId);
        const chk = el.querySelector('[data-check]');
        if (chk) chk.checked = sel.has(id);
      });
    }

    _bindCards(s) {
      qs('cards').querySelectorAll('[data-item]').forEach((el) => {
        const id = el.dataset.item;
        el.onclick = (e) => {
          if (e.target.closest('.card-actions') || e.target.closest('.card-check')) return;
          this.store.dispatch({ type: 'SET_FOCUSED', id });
        };
        const chk = el.querySelector('[data-check]');
        if (chk) chk.onclick = (e) => { e.stopPropagation(); this.store.dispatch({ type: 'TOGGLE_SELECT', id }); };
        el.querySelector('[data-star]').onclick = (e) => { e.stopPropagation(); this.bus.emit(global.EVENTS.UI_TOGGLE_STAR, { id }); };
        el.querySelector('[data-del]').onclick = (e) => { e.stopPropagation(); this._confirmDelete(id); };
        // 拖拽归类：记录待移动条目（多选则整体移动，单选则仅该条目）
        el.addEventListener('dragstart', (e) => {
          const selNow = this.store.getState().selection;
          this._dragIds = selNow.includes(id) ? selNow.slice() : [id];
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this._dragIds.join(','));
          }
          el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => { el.classList.remove('dragging'); this._dragIds = []; });
      });
    }

    _cardHtml(it, s) {
      const tags = (it.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('');
      const vcount = (it.processedVersions || []).length;
      const procBadge = vcount ? `<span class="badge proc" title="含 ${vcount} 个后处理版本">⚙ ${vcount} 版</span>` : '';
      const curBadge = it.currentVersion ? '<span class="badge cur">处理后视图</span>' : '';
      const starBadge = it.starred ? '<span class="star-i" title="已收藏">★</span>' : '';
      const repro = it.researchMeta?.reproducibility || 'unverified';
      const reproBadge = repro === 'reproduced'
        ? '<span class="badge repro ok" title="实验已复现">✔ 复现</span>'
        : repro === 'failed'
        ? '<span class="badge repro bad" title="复现失败">❌ 失败</span>'
        : '';
      const sel = s.selection.includes(it.id) ? 'sel' : '';
      const focused = it.id === s.focusedId ? 'focused' : '';
      const src = it.raw?.source === 'file' ? '📄 导入' : '✎ 手建';
      const verified = this._verifyBadge(it);
      return `
        <div class="card ${sel} ${focused} ${it.starred ? 'starred' : ''}" data-item="${it.id}" draggable="true">
          <label class="card-check"><input type="checkbox" data-check ${sel ? 'checked' : ''} /></label>
          <div class="card-ico" title="${escapeHtml(kindLabel(it.kind))}">${kindIcon(it.kind)}</div>
          <div class="card-main">
            <div class="kind">${escapeHtml(kindLabel(it.kind))} <span class="src">${src}</span> ${reproBadge} ${procBadge} ${curBadge} ${starBadge} ${verified}</div>
            <div class="title">${escapeHtml(it.title || it.name)}</div>
            <div class="tags">${tags}</div>
          </div>
          <div class="card-actions">
            <button data-star title="收藏">${it.starred ? '★' : '☆'}</button>
            <button data-del title="删除">🗑</button>
          </div>
        </div>`;
    }

    _verifyBadge(it) {
      const key = (it.id || '') + '|' + (it.raw?.hash || '');
      if (this._verifyCache.has(key)) return this._verifyCache.get(key);
      let html = '';
      try {
        const actual = global.storageUtils.sha256(it.raw?.content ?? '');
        const ok = actual === it.raw?.hash;
        html = ok
          ? '<span class="badge ok" title="原始数据 SHA-256 指纹已校验">✔ 指纹</span>'
          : '<span class="badge bad" title="指纹不符，原始数据可能已被改动">⚠ 指纹异常</span>';
      } catch { html = ''; }
      this._verifyCache.set(key, html);
      return html;
    }

    // ---------- 批量操作栏 ----------
    _renderBulk(s) {
      const bar = qs('bulkBar');
      const ids = s.selection;
      const sig = ids.join(',') + '|' + (s.libraries.find((l) => l.id === s.activeLibraryId)?.folders || []).map((f) => f.id).join(',');
      if (this._sig.bulk === sig) return;
      this._sig.bulk = sig;

      if (!ids.length) { bar.hidden = true; bar.innerHTML = ''; return; }
      bar.hidden = false;
      const lib = s.libraries.find((l) => l.id === s.activeLibraryId);
      const folders = (lib?.folders || []).filter((f) => f.id !== 'root');
      bar.innerHTML = `
        <span class="bulk-info">已选 <b>${ids.length}</b> 项</span>
        <div class="spacer"></div>
        <button class="btn sm" data-b="star">★ 收藏</button>
        <button class="btn sm" data-b="unstar">☆ 取消</button>
        <button class="btn sm" data-b="tag"># 打标签</button>
        <select class="sel" data-b="kind"><option value="">变更类型…</option><option value="code">💻 代码</option><option value="model">🤖 模型</option><option value="note">📝 笔记</option><option value="data">📊 数据</option><option value="paper">📄 论文</option><option value="image">🖼️ 图片</option><option value="other">📦 其他</option></select>
        <select class="sel" data-b="move"><option value="">移动到…</option>${folders.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}</select>
        <button class="btn sm danger" data-b="delete">🗑 删除</button>
        <button class="btn sm ghost" data-b="clear">清除</button>`;
      bar.querySelector('[data-b="star"]').onclick = () => this.bus.emit(global.EVENTS.UI_BULK, { action: 'star', ids, payload: { on: true } });
      bar.querySelector('[data-b="unstar"]').onclick = () => this.bus.emit(global.EVENTS.UI_BULK, { action: 'star', ids, payload: { on: false } });
      bar.querySelector('[data-b="tag"]').onclick = () => this._bulkTag(ids);
      bar.querySelector('[data-b="kind"]').onchange = (e) => {
        if (e.target.value) this.bus.emit(global.EVENTS.UI_BULK, { action: 'kind', ids, payload: { kind: e.target.value } });
      };
      bar.querySelector('[data-b="move"]').onchange = (e) => {
        if (e.target.value) this.bus.emit(global.EVENTS.UI_BULK, { action: 'move', ids, payload: { folderId: e.target.value } });
      };
      bar.querySelector('[data-b="delete"]').onclick = () => {
        if (confirm(`确认批量删除 ${ids.length} 个条目？`)) this.bus.emit(global.EVENTS.UI_BULK, { action: 'delete', ids });
      };
      bar.querySelector('[data-b="clear"]').onclick = () => this.store.dispatch({ type: 'CLEAR_SELECTION' });
    }

    // ---------- 预览（侧边栏页签切换 + 拖拽宽度 + 真实性与多版本）----------
    _renderPreview(s) {
      const pane = qs('preview');
      const it = s.items.find((i) => i.id === s.focusedId);
      this._pvTab = this._pvTab || 'doc';

      const sig = JSON.stringify([
        s.focusedId, s.viewMode, this._diffOpen, this._pvTab,
        it ? [it.raw?.hash, (it.processedVersions || []).length, it.currentVersion, it.title, (it.tags || []).join(','), it.processed?.hash, JSON.stringify(it.researchMeta || {})] : null,
      ]);
      if (this._sig.preview === sig && pane.dataset.bound) return;
      this._sig.preview = sig;

      if (!it) {
        pane.dataset.bound = '0';
        pane.innerHTML = `<div class="pv-empty">👈 选择左侧条目以预览<br><small>支持文本 / Markdown / CSV / JSON / 图片内置预览；学术元数据与后处理可逐行对比</small></div>`;
        return;
      }
      pane.dataset.bound = '1';
      const mode = s.viewMode;
      const vcount = (it.processedVersions || []).length;
      const verified = this._verifyBadge(it);
      const rm = it.researchMeta || {};
      const reproVal = rm.reproducibility || 'unverified';

      // 顶部 Tab 导航与关闭按钮
      const navHeader = `
        <div class="pv-nav">
          <div class="pv-tabs">
            <button class="pv-tab ${this._pvTab === 'doc' ? 'active' : ''}" data-pvtab="doc">📄 资产内容</button>
            <button class="pv-tab ${this._pvTab === 'meta' ? 'active' : ''}" data-pvtab="meta">🔬 学术元数据</button>
            <button class="pv-tab ${this._pvTab === 'provenance' ? 'active' : ''}" data-pvtab="provenance">🛡️ 真实性指纹</button>
            <button class="pv-tab ${this._pvTab === 'diff' ? 'active' : ''}" data-pvtab="diff">⚙ 版本对比 ${vcount ? `(${vcount})` : ''}</button>
          </div>
          <button class="pv-close-btn" id="pvCloseBtn" title="收起预览 (Ctrl+P)">✕</button>
        </div>`;

      // 顶部 Head：标题 + 标签 + 快捷编辑
      const head = `
        <div class="pv-head">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div class="pv-title">${escapeHtml(it.title || it.name)}</div>
            <button class="btn sm ghost" id="pvInlineEdit" title="快速编辑名称、标签与元数据">✎ 编辑</button>
          </div>
          <div class="pv-tags">${(it.tags || []).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>
        </div>`;

      let tabBody = '';

      if (this._pvTab === 'doc') {
        const cur = (it.processedVersions || []).find((v) => v.id === it.currentVersion) || null;
        const opts = [`<option value="">原始数据 (Raw)</option>`].concat(
          (it.processedVersions || []).map((v, idx) =>
            `<option value="${v.id}" ${v.id === it.currentVersion ? 'selected' : ''}>v${idx + 1} · ${escapeHtml(v.note || v.method || '处理后')} · ${fmtTime(v.processedAt)}</option>`).join(''));
        const versionSel = vcount ? `<select class="sel pv-ver" id="pvVer">${opts}</select>` : '';

        const actions = `
          <div class="pv-actions">
            ${versionSel}
            <button class="btn sm" id="pvProc">⚙ 添加后处理版本</button>
            ${it.currentVersion ? '<button class="btn sm ghost" id="pvRevert">↩ 还原原始</button>' : ''}
            <button class="btn sm ghost" id="pvOpenApp" title="调起外部程序打开">🚀 外部打开</button>
            <button class="btn sm ghost" id="pvMove">📁 移动</button>
            <button class="btn sm ghost" id="pvTag"># 标签</button>
          </div>`;

        let body = '';
        const showRaw = mode === 'raw' || mode === 'split' || mode === 'details';
        const showProc = mode === 'processed' || mode === 'split' || mode === 'details';
        if (showRaw) {
          body += `<div class="pv-pane"><div class="pv-pane-h">原始 (Raw)</div><div class="pv-body">${this._safePreview(() => global.Preview.render(it, 'raw'), '原始预览渲染失败')}</div></div>`;
        }
        if (showProc) {
          const pHtml = it.processed ? this._safePreview(() => global.Preview.render(it, 'processed'), '后处理预览渲染失败') : '<div class="pv-note">尚未添加后处理版本</div>';
          body += `<div class="pv-pane"><div class="pv-pane-h">后处理 (Processed) ${it.processed ? '' : '— 暂无'}</div><div class="pv-body">${pHtml}</div></div>`;
        }
        tabBody = actions + `<div class="pv-split ${mode}">${body}</div>`;

      } else if (this._pvTab === 'meta') {
        const doiLink = rm.doi ? `<a href="https://doi.org/${escapeHtml(rm.doi)}" target="_blank" rel="noreferrer" style="color:var(--primary);">https://doi.org/${escapeHtml(rm.doi)}</a>` : '<span class="muted">未填写</span>';
        const reproSel = `
          <select class="sel" id="pvRepro" style="width:100%;margin-top:4px;">
            <option value="unverified" ${reproVal === 'unverified' ? 'selected' : ''}>⏳ 尚未验证复现</option>
            <option value="reproduced" ${reproVal === 'reproduced' ? 'selected' : ''}>✔ 实验已完全复现</option>
            <option value="failed" ${reproVal === 'failed' ? 'selected' : ''}>❌ 实验不可复现</option>
          </select>`;

        tabBody = `
          <div class="pv-body" style="line-height:1.8;">
            <div class="field"><label>DOI 链接</label><div>${doiLink}</div></div>
            <div class="field"><label>作者 / 课题组成员</label><div>${escapeHtml(rm.authors || '未填写')}</div></div>
            <div class="field"><label>实验可复现性状态</label>${reproSel}</div>
            <div class="field" style="margin-top:16px;">
              <label>学术引用快捷工具</label>
              <div style="display:flex;gap:8px;margin-top:6px;">
                <button class="btn sm primary" id="pvCiteBib">📋 复制 BibTeX 节点</button>
                <button class="btn sm" id="pvCiteMd">📝 复制 Markdown 引用</button>
              </div>
            </div>
          </div>`;

      } else if (this._pvTab === 'provenance') {
        tabBody = `
          <div class="pv-body" style="line-height:1.8;">
            <div class="pv-prov" style="margin-bottom:12px;border-radius:var(--radius-sm);">
              <div class="prov-row"><b>真实性状态</b>：${verified}</div>
              <div class="prov-row"><b>SHA-256 指纹</b>：<code style="font-size:11px;user-select:all;">${escapeHtml(it.raw?.hash || '')}</code></div>
              <div class="prov-row"><b>数据来源</b>：${escapeHtml(it.raw?.source || 'manual')} (${fmtTime(it.raw?.sourceTime || it.createdAt)})</div>
              <div class="prov-row"><b>文件大小</b>：${it.raw?.size || 0} 字节 · MIME: ${escapeHtml(it.raw?.mime || 'text/plain')}</div>
            </div>
            <div class="field"><label>数据不可变承诺</label><p class="muted" style="font-size:12px;">原始数据在首次创建时已进行密码学哈希锁定，后续任何针对本资产的操作均作为后处理衍生版本进行留痕追加，保障科研证据绝对可信。</p></div>
          </div>`;

      } else if (this._pvTab === 'diff') {
        const cur = (it.processedVersions || []).find((v) => v.id === it.currentVersion) || null;
        if (!cur) {
          tabBody = `<div class="pv-body"><div class="pv-note">当前为原始数据视图，尚无后处理版本可对比。点击「资产内容」页签下的「添加后处理版本」后再进行对比。</div></div>`;
        } else {
          tabBody = `<div class="pv-body">${this._safePreview(() => global.Preview.renderDiff(it.raw.content, cur.content), '差异渲染失败')}</div>`;
        }
      }

      pane.innerHTML = navHeader + head + tabBody;

      // 绑定 Tab 切换事件
      pane.querySelectorAll('[data-pvtab]').forEach((btn) => {
        btn.onclick = () => {
          this._pvTab = btn.dataset.pvtab;
          this.render(this.store.getState());
        };
      });

      const closeBtn = qs('pvCloseBtn');
      if (closeBtn) {
        closeBtn.onclick = () => {
          pane.style.display = 'none';
          const resizer = qs('pvResizer');
          if (resizer) resizer.style.display = 'none';
        };
      }

      const inlineEdit = qs('pvInlineEdit');
      if (inlineEdit) inlineEdit.onclick = () => this._openInlineEdit(it);

      const proc = qs('pvProc'); if (proc) proc.onclick = () => this._openProcess(it);
      const rev = qs('pvRevert'); if (rev) rev.onclick = () => this.bus.emit(global.EVENTS.UI_SELECT_VERSION, { id: it.id, versionId: null });
      const ver = qs('pvVer'); if (ver) ver.onchange = (e) => this.bus.emit(global.EVENTS.UI_SELECT_VERSION, { id: it.id, versionId: e.target.value || null });
      const openApp = qs('pvOpenApp'); if (openApp) openApp.onclick = async () => {
        try {
          const res = await global.__vault.openWith(it.id, 'default');
          this.store.dispatch({ type: 'TOAST', toast: `已尝试调起程序 [${res.appName || '默认应用'}]` });
        } catch (e) { console.error(e); }
      };
      const reproEl = qs('pvRepro'); if (reproEl) reproEl.onchange = async (e) => {
        try {
          await global.__vault.setReproducibility(it.id, e.target.value);
          this.store.dispatch({ type: 'TOAST', toast: '已更新可复现状态' });
        } catch (err) { console.error(err); }
      };
      const citeBib = qs('pvCiteBib'); if (citeBib) citeBib.onclick = async () => {
        try {
          const bib = await global.__vault.generateCitation(it.id, 'bibtex');
          await navigator.clipboard.writeText(bib);
          this.store.dispatch({ type: 'TOAST', toast: '📋 已复制 BibTeX 学术引用卡片' });
        } catch (e) { console.error(e); }
      };
      const citeMd = qs('pvCiteMd'); if (citeMd) citeMd.onclick = async () => {
        try {
          const md = await global.__vault.generateCitation(it.id, 'markdown');
          await navigator.clipboard.writeText(md);
          this.store.dispatch({ type: 'TOAST', toast: '📝 已复制 Markdown 引用链接' });
        } catch (e) { console.error(e); }
      };
      const mv = qs('pvMove'); if (mv) mv.onclick = () => this._moveItem(it);
      const tg = qs('pvTag'); if (tg) tg.onclick = () => this._tagItem(it);
    }

    _openInlineEdit(it) {
      const rm = it.researchMeta || {};
      this._modal(`
        <h3>✎ 快速编辑资产元数据</h3>
        <div class="field"><label>标题 / 名称</label><input id="ieTitle" value="${escapeHtml(it.title || it.name)}" /></div>
        <div class="field"><label>标签（逗号分隔）</label><input id="ieTags" value="${escapeHtml((it.tags || []).join(', '))}" /></div>
        <div class="field"><label>DOI 编号</label><input id="ieDoi" value="${escapeHtml(rm.doi || '')}" placeholder="例如 10.1038/s41586-021-03819-2" /></div>
        <div class="field"><label>作者 / 课题组成员</label><input id="ieAuthors" value="${escapeHtml(rm.authors || '')}" placeholder="例如 Zhang et al." /></div>
        <div class="modal-actions"><button class="btn ghost" id="ieCancel">取消</button><button class="btn primary" id="ieSave">保存修改</button></div>`);
      document.getElementById('ieCancel').onclick = () => this._closeModal();
      document.getElementById('ieSave').onclick = async () => {
        const title = document.getElementById('ieTitle').value.trim();
        if (!title) return;
        const tags = document.getElementById('ieTags').value.split(',').map((t) => t.trim()).filter(Boolean);
        const researchMeta = {
          ...rm,
          doi: document.getElementById('ieDoi').value.trim(),
          authors: document.getElementById('ieAuthors').value.trim(),
        };
        try {
          await global.__vault.updateItem(it.id, { title, name: title, tags, researchMeta });
          this.store.dispatch({ type: 'TOAST', toast: '元数据已成功更新' });
          this._closeModal();
        } catch (e) { console.error(e); }
      };
    }

    /** 包裹预览渲染，异常时返回降级提示，避免单条坏数据拖垮整个 UI */
    _safePreview(fn, label) {
      try { return fn() || ''; }
      catch (e) { console.warn('[preview]', label, e); return `<div class="pv-note">⚠ ${escapeHtml(label)}</div>`; }
    }

    // ---------- 抽屉：审计 / 设置 ----------
    _renderDrawer(s) {
      const dw = qs('drawer');
      const sig = JSON.stringify([s.drawer, s.audit[0]?.ts || 0, s.audit.length, s.integrity?.checkedAt || 0]);
      if (this._sig.drawer === sig) return;
      this._sig.drawer = sig;

      if (!s.drawer) { dw.hidden = true; dw.innerHTML = ''; return; }
      dw.hidden = false;
      if (s.drawer === 'audit') this._renderAudit(dw, s);
      else if (s.drawer === 'settings') this._renderSettings(dw, s);
      else if (s.drawer === 'stats') this._renderStatsDrawer(dw, s);
    }

    _renderStatsDrawer(dw, s) {
      const items = s.items || [];
      const kinds = { code: 0, model: 0, data: 0, paper: 0, image: 0, note: 0, other: 0 };
      let totalVer = 0;
      let starredCount = 0;

      for (const it of items) {
        kinds[it.kind || 'note'] = (kinds[it.kind || 'note'] || 0) + 1;
        totalVer += (it.processedVersions || []).length;
        if (it.starred) starredCount++;
      }

      const total = items.length || 1;
      const kIcons = { code: '💻 代码', model: '🤖 模型', data: '📊 数据', paper: '📄 论文', image: '🖼️ 图片', note: '📝 笔记', other: '📦 其他' };
      const bars = Object.entries(kinds).map(([k, cnt]) => {
        const pct = Math.round((cnt / total) * 100);
        return `
          <div class="stat-bar-row">
            <span class="sb-label">${kIcons[k]}</span>
            <div class="sb-track"><div class="sb-fill" style="width:${pct}%"></div></div>
            <span class="sb-val">${cnt} 项 (${pct}%)</span>
          </div>`;
      }).join('');

      dw.innerHTML = `
        <div class="drawer">
          <div class="drawer-head"><span>📊 科研数据资产看板</span><button class="icon-btn" id="dwClose">✕</button></div>
          <div class="drawer-sub">实时统计当前资料库的资产类型分布、演进版本数与收藏状态。</div>
          <div class="drawer-body scroll">
            <div class="set-block">
              <div class="set-title">概览指标</div>
              <div class="stat-cards-grid">
                <div class="stat-c"><div class="num">${items.length}</div><div class="lbl">资产总数</div></div>
                <div class="stat-c"><div class="num">${totalVer}</div><div class="lbl">后处理版本</div></div>
                <div class="stat-c"><div class="num">${starredCount}</div><div class="lbl">星标收藏</div></div>
              </div>
            </div>
            <div class="set-block">
              <div class="set-title">资产类型分布</div>
              ${bars}
            </div>
            <div class="set-block">
              <div class="set-title">智能去重治理</div>
              <button class="btn sm primary" id="btnFindDup">🔍 检出重复与相近条目</button>
            </div>
          </div>
        </div>`;
      dw.querySelector('#dwClose').onclick = () => this.store.dispatch({ type: 'SET_DRAWER', drawer: null });
      const findDup = dw.querySelector('#btnFindDup');
      if (findDup) findDup.onclick = async () => {
        try {
          const res = await global.__vault.findDuplicates();
          if (!res.count) {
            this.store.dispatch({ type: 'TOAST', toast: '✅ 未发现重复或相近条目' });
          } else {
            alert(`共发现 ${res.count} 组潜在重复条目：\n- 全同哈希重复：${res.exact.length} 组\n- 标题相近/重名：${res.titleSimilar.length} 组`);
          }
        } catch (e) { console.error(e); }
      };
    }

    _renderAudit(dw, s) {
      const list = s.audit || [];
      const rows = list.length ? list.map((a) => `
        <div class="audit-row">
          <div class="a-time">${fmtTime(a.ts)}</div>
          <div class="a-act"><span class="a-badge">${escapeHtml(a.action)}</span></div>
          <div class="a-sum">${escapeHtml(a.summary || '')}</div>
        </div>`).join('') : '<div class="pv-note">暂无操作记录</div>';
      dw.innerHTML = `
        <div class="drawer">
          <div class="drawer-head"><span>🧾 操作审计日志</span><button class="icon-btn" id="dwClose">✕</button></div>
          <div class="drawer-sub">所有写操作均留痕，可追溯到每一条数据的创建、处理、移动、删除。</div>
          <div class="drawer-body scroll">${rows}</div>
        </div>`;
      dw.querySelector('#dwClose').onclick = () => this.store.dispatch({ type: 'SET_DRAWER', drawer: null });
    }

    _renderSettings(dw, s) {
      const integ = s.integrity;
      const integHtml = integ ? `
        <div class="set-block">
          <div class="set-title">最近完整性自检 · ${fmtTime(integ.checkedAt)}</div>
          <div class="set-line ${integ.healthy ? 'ok' : 'bad'}">${integ.healthy ? '✔ 全部通过' : '⚠ 发现问题'}</div>
          <div class="set-line">存储层损坏：${integ.storage.corrupted} 条 · 指纹不符：${integ.items.tampered} 条 · 条目总数：${integ.items.total}</div>
          ${integ.items.list.length ? '<div class="set-line bad">问题条目：' + integ.items.list.map((x) => escapeHtml(x.title)).join('、') + '</div>' : ''}
        </div>` : '<div class="set-block"><div class="set-line muted">尚未执行完整性自检</div></div>';

      dw.innerHTML = `
        <div class="drawer">
          <div class="drawer-head"><span>⚙ 设置</span><button class="icon-btn" id="dwClose">✕</button></div>
          <div class="drawer-body scroll">
            <div class="set-block">
              <div class="set-title">外观</div>
              <button class="btn sm" id="setTheme">切换主题（当前 ${s.theme === 'dark' ? '深色' : '浅色'}）</button>
              <button class="btn sm" id="setDensity">密度（当前 ${s.density === 'compact' ? '紧凑' : '舒适'}）</button>
            </div>
            <div class="set-block">
              <div class="set-title">数据安全</div>
              <button class="btn sm ${s.cryptoLocked ? 'primary' : ''}" id="setCrypto">${s.cryptoLocked ? '🔓 启用加密存储 (AES)' : '🔒 加密已启用（点击锁定）'}</button>
              <button class="btn sm" id="setIntegrity">🩺 执行完整性自检</button>
              <button class="btn sm" id="setClearCache">🧹 清空缓存层</button>
              ${integHtml}
            </div>
            <div class="set-block">
              <div class="set-title">备份与恢复</div>
              <button class="btn sm" id="setExport">⬇ 导出 JSON</button>
              <button class="btn sm" id="setRestore">⬆ 从 JSON 恢复</button>
              <input type="file" id="setRestoreFile" accept="application/json" hidden />
            </div>
            <div class="set-block">
              <div class="set-title">存储引擎</div>
              <div class="set-line">当前：${escapeHtml(s.engine || 'FileSystemAdapter')}</div>
              <button class="btn sm" id="setEngine">切换 IndexedDB ↔ 文件系统</button>
            </div>
          </div>
        </div>`;

      dw.querySelector('#dwClose').onclick = () => this.store.dispatch({ type: 'SET_DRAWER', drawer: null });
      dw.querySelector('#setTheme').onclick = () => this.bus.emit(global.EVENTS.UI_THEME, { theme: s.theme === 'dark' ? 'light' : 'dark' });
      dw.querySelector('#setDensity').onclick = () => this.bus.emit(global.EVENTS.UI_DENSITY, { density: s.density === 'compact' ? 'comfortable' : 'compact' });
      dw.querySelector('#setCrypto').onclick = () => this._openCrypto();
      dw.querySelector('#setIntegrity').onclick = () => this.bus.emit(global.EVENTS.UI_INTEGRITY, {});
      dw.querySelector('#setClearCache').onclick = () => this.bus.emit(global.EVENTS.UI_CLEAR_CACHE, {});
      dw.querySelector('#setExport').onclick = () => this.bus.emit(global.EVENTS.UI_EXPORT, {});
      dw.querySelector('#setRestore').onclick = () => dw.querySelector('#setRestoreFile').click();
      dw.querySelector('#setRestoreFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this.bus.emit(global.EVENTS.UI_RESTORE, { file: f });
      };
      dw.querySelector('#setEngine').onclick = () => this.bus.emit(global.EVENTS.UI_ENGINE_SWITCH, {});
    }

    // ---------- Toast（去重，避免每次渲染重建导致闪烁）----------
    _renderToast(s) {
      if (this._toast === s.toast) return; // 文案未变，保持现状
      this._toast = s.toast;
      const old = document.querySelector('.toast');
      if (old) old.remove();
      if (!s.toast) return;
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = s.toast;
      document.body.appendChild(t);
      setTimeout(() => this.store.dispatch({ type: 'TOAST', toast: null }), 2200);
    }

    // ============ 模态 ============
    _modal(html) {
      this._closeModal();
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `<div class="modal">${html}</div>`;
      ov.onclick = (e) => { if (e.target === ov) this._closeModal(); };
      // 模态内键盘：Esc 关闭；单行输入框内 Enter 提交主操作（多行 textarea 的 Enter 用于换行，不拦截）
      ov.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this._closeModal(); return; }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const ok = ov.querySelector('.btn.primary'); if (ok) ok.click(); }
      });
      document.body.appendChild(ov);
      this._modalEl = ov;
      // 自动聚焦首个可输入控件
      const f = ov.querySelector('input, textarea, select');
      if (f) { try { f.focus(); } catch (_) {} }
      return ov;
    }
    _closeModal() { if (this._modalEl) { this._modalEl.remove(); this._modalEl = null; } }

    _openCreate() {
      this._modal(`
        <h3>新建科研条目</h3>
        <div class="field"><label>标题 / 名称</label><input id="mTitle" placeholder="例如：Transformer 训练损失曲线上报" /></div>
        <div class="field"><label>科研资产类型</label><select id="mKind">
          <option value="code">💻 代码 code</option><option value="model">🤖 模型 model</option>
          <option value="data">📊 数据 data</option><option value="paper">📄 论文 paper</option>
          <option value="image">🖼️ 图片 image</option><option value="note">📝 笔记 note</option><option value="other">📦 其他</option></select></div>
        <div class="field"><label>标签（逗号分隔）</label><input id="mTags" placeholder="ml, nlp, pytorch" /></div>
        <div class="field"><label>DOI / 关联引用 (可选)</label><input id="mDoi" placeholder="例如：10.1038/s41586-021-03819-2" /></div>
        <div class="field"><label>作者 / 课题组成员 (可选)</label><input id="mAuthors" placeholder="例如：Zhang et al." /></div>
        <div class="field"><label>原始内容（不可变数据证据）</label><textarea id="mRaw" rows="4" placeholder="粘贴或输入最原始的数据/代码/文本…"></textarea></div>
        <div class="modal-actions"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">创建资产条目</button></div>`);
      document.getElementById('mCancel').onclick = () => this._closeModal();
      document.getElementById('mOk').onclick = () => {
        const title = document.getElementById('mTitle').value.trim(); if (!title) return;
        const tags = document.getElementById('mTags').value.split(',').map((t) => t.trim()).filter(Boolean);
        const researchMeta = {
          doi: document.getElementById('mDoi').value.trim(),
          authors: document.getElementById('mAuthors').value.trim(),
          reproducibility: 'unverified',
        };
        this.bus.emit(global.EVENTS.UI_CREATE_ITEM, {
          title, kind: document.getElementById('mKind').value, tags, researchMeta,
          raw: { content: document.getElementById('mRaw').value, source: 'manual', sourceTime: Date.now() },
        });
        this._closeModal();
      };
    }

    _openProcess(it) {
      this._modal(`
        <h3>添加后处理版本</h3>
        <p class="muted">原始数据保持不变，这里仅记录衍生/处理后的内容及其说明，便于追溯对比。</p>
        <div class="field"><label>处理说明（方法/变换）</label><input id="pNote" placeholder="例如：去重 + 归一化" /></div>
        <div class="field"><label>后处理内容</label><textarea id="pContent" rows="6" placeholder="处理后的数据/文本…">${escapeHtml(it.raw?.content || '')}</textarea></div>
        <div class="modal-actions"><button class="btn ghost" id="pCancel">取消</button><button class="btn primary" id="pOk">保存后处理</button></div>`);
      document.getElementById('pCancel').onclick = () => this._closeModal();
      document.getElementById('pOk').onclick = () => {
        this.bus.emit('ui:process', { id: it.id, content: document.getElementById('pContent').value, note: document.getElementById('pNote').value });
        this._closeModal();
      };
    }

    _openNewLib() {
      this._modal(`
        <h3>新建资料库</h3>
        <div class="field"><label>名称</label><input id="lName" placeholder="例如：博士课题" /></div>
        <div class="field"><label>图标 emoji</label><input id="lIcon" value="📁" /></div>
        <div class="field"><label>主题色</label><input id="lColor" type="color" value="#4f6ef7" /></div>
        <div class="modal-actions"><button class="btn ghost" id="lCancel">取消</button><button class="btn primary" id="lOk">创建</button></div>`);
      document.getElementById('lCancel').onclick = () => this._closeModal();
      document.getElementById('lOk').onclick = () => {
        const name = document.getElementById('lName').value.trim(); if (!name) return;
        this.bus.emit('ui:library:create', {
          name,
          icon: document.getElementById('lIcon').value || '📁',
          color: document.getElementById('lColor').value || '#4f6ef7',
        });
        this._closeModal();
      };
    }

    _openNewFolder() {
      const s = this.store.getState();
      this._modal(`
        <h3>新建子项目文件夹</h3>
        <div class="field"><label>名称</label><input id="fName" placeholder="例如：实验A" /></div>
        <div class="modal-actions"><button class="btn ghost" id="fCancel">取消</button><button class="btn primary" id="fOk">创建</button></div>`);
      document.getElementById('fCancel').onclick = () => this._closeModal();
      document.getElementById('fOk').onclick = () => {
        const name = document.getElementById('fName').value.trim(); if (!name) return;
        this.bus.emit(global.EVENTS.UI_FOLDER_CREATE, { name, parent: s.activeFolderId });
        this._closeModal();
      };
    }

    _openCrypto() {
      const s = this.store.getState();
      if (!s.cryptoLocked) {
        this._modal(`
          <h3>加密已启用</h3>
          <p class="muted">当前存储内容以 AES-GCM 加密。点击锁定将丢弃内存密钥，已加密数据需重新输入口令才能读取。</p>
          <div class="modal-actions"><button class="btn ghost" id="cCancel">取消</button><button class="btn" id="cLock">🔒 锁定</button></div>`);
        document.getElementById('cCancel').onclick = () => this._closeModal();
        document.getElementById('cLock').onclick = () => { this.bus.emit('ui:crypto:lock'); this._closeModal(); };
        return;
      }
      this._modal(`
        <h3>启用加密存储 (AES)</h3>
        <p class="muted">使用口令派生密钥（PBKDF2）对 user / config / audit 层加密，密钥不离开本地。</p>
        <div class="field"><label>口令</label><input id="cPwd" type="password" placeholder="设置加密口令" /></div>
        <div class="modal-actions"><button class="btn ghost" id="cCancel">取消</button><button class="btn primary" id="cOk">解锁并启用</button></div>`);
      document.getElementById('cCancel').onclick = () => this._closeModal();
      document.getElementById('cOk').onclick = () => {
        const pwd = document.getElementById('cPwd').value;
        if (!pwd) return;
        this.bus.emit('ui:crypto:unlock', { password: pwd });
        this._closeModal();
      };
    }

    _moveItem(it) {
      const s = this.store.getState();
      const lib = s.libraries.find((l) => l.id === s.activeLibraryId);
      const folders = (lib?.folders || []).filter((f) => f.id !== 'root');
      this._modal(`
        <h3>移动「${escapeHtml(it.title || it.name)}」</h3>
        <div class="field"><label>目标子项目</label><select id="mV">${['<option value="root">根目录</option>'].concat(folders.map((f) => `<option value="${f.id}" ${f.id === it.folderId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)).join('')}</select></div>
        <div class="modal-actions"><button class="btn ghost" id="mVc">取消</button><button class="btn primary" id="mVok">移动</button></div>`);
      document.getElementById('mVc').onclick = () => this._closeModal();
      document.getElementById('mVok').onclick = () => {
        this.bus.emit(global.EVENTS.UI_MOVE_ITEM, { id: it.id, folderId: document.getElementById('mV').value });
        this._closeModal();
      };
    }

    _tagItem(it) {
      this._modal(`
        <h3>给「${escapeHtml(it.title || it.name)}」加标签</h3>
        <div class="field"><label>标签</label><input id="tV" placeholder="例如：重要" /></div>
        <div class="modal-actions"><button class="btn ghost" id="tVc">取消</button><button class="btn primary" id="tVok">添加</button></div>`);
      document.getElementById('tVc').onclick = () => this._closeModal();
      document.getElementById('tVok').onclick = () => {
        const tag = document.getElementById('tV').value.trim();
        if (tag) this.bus.emit(global.EVENTS.UI_TAG_ITEM, { id: it.id, tag });
        this._closeModal();
      };
    }

    _bulkTag(ids) {
      this._modal(`
        <h3>给选中的 ${ids.length} 个条目加标签</h3>
        <div class="field"><label>标签</label><input id="btV" placeholder="例如：重要" /></div>
        <div class="modal-actions"><button class="btn ghost" id="btVc">取消</button><button class="btn primary" id="btVok">添加</button></div>`);
      document.getElementById('btVc').onclick = () => this._closeModal();
      document.getElementById('btVok').onclick = () => {
        const tag = document.getElementById('btV').value.trim();
        if (tag) this.bus.emit(global.EVENTS.UI_BULK, { action: 'tag', ids, payload: { tag } });
        this._closeModal();
      };
    }

    _renameFolder(folderId) {
      if (this._editingFolder || folderId === 'root') return;
      const el = qs('libList').querySelector(`[data-folder="${folderId}"] .fname`);
      if (!el) return;
      this._editingFolder = folderId;
      const old = el.textContent;
      el.classList.add('editing');
      el.innerHTML = `<input class="fname-input" value="${escapeHtml(old)}" />`;
      const inp = el.querySelector('input');
      if (!inp) { this._editingFolder = null; el.classList.remove('editing'); return; }
      inp.focus(); inp.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        this._editingFolder = null;
        el.classList.remove('editing');
        if (commit && v && v !== old) {
          this.bus.emit(global.EVENTS.UI_FOLDER_RENAME, { folderId, name: v });
          this._sig.sidebar = null; // 名称变更后强制刷新侧栏
          this.render(this.store.getState());
        } else {
          this._sig.sidebar = null;
          this.render(this.store.getState());
        }
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    }

    _deleteFolder(folderId) {
      const s = this.store.getState();
      const lib = s.libraries.find((l) => l.id === s.activeLibraryId);
      const f = (lib?.folders || []).find((x) => x.id === folderId);
      if (folderId === 'root') return;
      if (confirm(`确认删除子项目「${f?.name || folderId}」？其中的条目与子文件夹会安全上移到父级，不会删除数据。`)) {
        this.bus.emit(global.EVENTS.UI_FOLDER_DELETE, { folderId });
      }
    }

    // ============ 命令快捷面板 (Command Palette) ============
    _openCmdPalette() {
      const wrap = qs('cmdWrap');
      if (!wrap) return;
      wrap.innerHTML = `
        <div class="cmd-box">
          <div class="cmd-head">
            <span>⚡</span>
            <input id="cmdInput" placeholder="输入命令或关键词检索 (Esc 关闭)…" autofocus />
          </div>
          <div class="cmd-list" id="cmdList"></div>
        </div>`;
      wrap.hidden = false;
      wrap.onclick = (e) => { if (e.target === wrap) this._closeCmdPalette(); };

      const actions = [
        { icon: '＋', title: '新建科研条目', kbd: 'Cmd / Ctrl + N', run: () => this._openCreate() },
        { icon: '📁', title: '新建子项目文件夹', kbd: '', run: () => this._openNewFolder() },
        { icon: '🗂️', title: '新建资料库', kbd: '', run: () => this._openNewLib() },
        { icon: '📊', title: '查看科研数据资产分析看板', kbd: '', run: () => this.store.dispatch({ type: 'SET_DRAWER', drawer: 'stats' }) },
        { icon: '🔍', title: '检出重复与相近科研条目', kbd: '', run: async () => {
          try {
            const res = await global.__vault.findDuplicates();
            if (!res.count) this.store.dispatch({ type: 'TOAST', toast: '✅ 未发现重复或相近条目' });
            else alert(`共发现 ${res.count} 组潜在重复条目：\n- 全同哈希重复：${res.exact.length} 组\n- 标题相近/重名：${res.titleSimilar.length} 组`);
          } catch (e) { console.error(e); }
        }},
        { icon: '⬇', title: '全量导出 JSON 备份包', kbd: '', run: () => this.bus.emit(global.EVENTS.UI_EXPORT, {}) },
        { icon: '📊', title: '导出 CSV 表格数据清单', kbd: '', run: () => this.bus.emit('ui:export:csv', {}) },
        { icon: '🛡️', title: '全库数据完整性指纹校验', kbd: '', run: () => this.bus.emit(global.EVENTS.UI_INTEGRITY_CHECK, {}) },
        { icon: '🩺', title: '自愈修复孤立条目', kbd: '', run: () => this.bus.emit('ui:repair:orphans', {}) },
        { icon: '🌗', title: '切换深浅配色主题', kbd: '', run: () => {
          const t = this.store.getState().theme === 'dark' ? 'light' : 'dark';
          this.bus.emit(global.EVENTS.UI_THEME, { theme: t });
        }},
        { icon: '🧾', title: '查看审计追踪日志', kbd: '', run: () => this.store.dispatch({ type: 'SET_DRAWER', drawer: 'audit' }) },
        { icon: '⚙', title: '打开系统适配器设置', kbd: '', run: () => this.store.dispatch({ type: 'SET_DRAWER', drawer: 'settings' }) },
      ];

      const input = wrap.querySelector('#cmdInput');
      const listEl = wrap.querySelector('#cmdList');

      const renderCmds = (q = '') => {
        const filter = q.toLowerCase();
        const matches = actions.filter((a) => a.title.toLowerCase().includes(filter));
        if (!matches.length) {
          listEl.innerHTML = `<div class="empty sm">无匹配命令</div>`;
          return;
        }
        listEl.innerHTML = matches.map((a, idx) => `
          <div class="cmd-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
            <span class="c-icon">${a.icon}</span>
            <span class="c-title">${escapeHtml(a.title)}</span>
            <span class="c-kbd">${a.kbd}</span>
          </div>`).join('');
        listEl.querySelectorAll('.cmd-item').forEach((el, idx) => {
          el.onclick = () => { this._closeCmdPalette(); matches[idx].run(); };
        });
      };

      renderCmds();
      if (input) {
        input.focus();
        input.addEventListener('input', (e) => renderCmds(e.target.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') this._closeCmdPalette();
          if (e.key === 'Enter') {
            const active = listEl.querySelector('.cmd-item.active');
            if (active) {
              const idx = Number(active.dataset.idx);
              const q = input.value.toLowerCase();
              const matches = actions.filter((a) => a.title.toLowerCase().includes(q));
              if (matches[idx]) {
                this._closeCmdPalette();
                matches[idx].run();
              }
            }
          }
        });
      }
    }

    async _openLineageModal() {
      const s = this.store.getState();
      const libId = s.activeLibraryId;
      const graph = await global.__vault.getLineageGraph(libId);

      const nodeHtml = graph.nodes.map((n, i) => {
        const top = 30 + (i % 6) * 60;
        const left = 20 + Math.floor(i / 6) * 220;
        return `
          <div class="dag-node" style="position:absolute;top:${top}px;left:${left}px;" data-dagnode="${n.id}">
            <span>${kindIcon(n.kind)}</span>
            <span>${escapeHtml(n.label)}</span>
            <span class="badge sm">${n.reproducibility === 'reproduced' ? '✔' : '⏳'}</span>
          </div>`;
      }).join('');

      this._modal(`
        <div style="width:780px;max-width:90vw;">
          <h3>🌐 科研数据演化拓扑图 (Lineage Graph)</h3>
          <p class="muted">实时计算当前资料库内数据节点、文件依赖与双向 [[Wiki]] 关联结构</p>
          <div class="dag-canvas" style="position:relative;height:380px;">
            ${nodeHtml || '<p class="muted">当前资料库尚无资产节点</p>'}
          </div>
          <div class="modal-actions">
            <span class="muted" style="margin-right:auto;font-size:12px;">共 ${graph.nodes.length} 个节点，${graph.edges.length} 条演进关联边</span>
            <button class="btn primary" id="dagClose">关闭</button>
          </div>
        </div>`);

      document.getElementById('dagClose').onclick = () => this._closeModal();
      document.querySelectorAll('[data-dagnode]').forEach((el) => {
        el.onclick = () => {
          this.store.dispatch({ type: 'SET_FOCUSED', id: el.dataset.dagnode });
          this._closeModal();
        };
      });
    }

    _openHelpModal() {
      this._modal(`
        <div style="width:580px;max-width:90vw;">
          <h3>⌨ ResearchVault 快捷键速查中心</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0;font-size:13px;">
            <div><span class="kbd">Ctrl + K</span> 命令快捷面板</div>
            <div><span class="kbd">Ctrl + P</span> 展开/收起侧边栏预览</div>
            <div><span class="kbd">Ctrl + G</span> 科研演进拓扑图</div>
            <div><span class="kbd">Ctrl + M</span> 文件空间治理仪表盘</div>
            <div><span class="kbd">/</span> 聚焦全局搜索框</div>
            <div><span class="kbd">j</span> / <span class="kbd">↓</span> 选中下一条目</div>
            <div><span class="kbd">k</span> / <span class="kbd">↑</span> 选中上一条目</div>
            <div><span class="kbd">Space</span> 勾选/取消勾选多选</div>
            <div><span class="kbd">x</span> 收藏/取消收藏条目</div>
            <div><span class="kbd">Enter</span> 聚焦条目细节</div>
            <div><span class="kbd">Del</span> 删除当前条目</div>
            <div><span class="kbd">Esc</span> 关闭浮窗/模态框</div>
            <div><span class="kbd">?</span> / <span class="kbd">F1</span> 快捷键帮助</div>
          </div>
          <div class="modal-actions">
            <button class="btn primary" id="helpOk">理解并关闭</button>
          </div>
        </div>`);
      document.getElementById('helpOk').onclick = () => this._closeModal();
    }

    async _openSpaceModal() {
      const s = this.store.getState();
      const libId = s.activeLibraryId;
      const analytics = await global.__vault.getStorageAnalytics(libId);

      const formatSize = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      };

      const kindLabels = {
        code: '💻 代码文件',
        model: '🤖 模型/权重',
        data: '📊 实验数据集',
        paper: '📄 学术论文',
        note: '📝 科研笔记',
        image: '🖼️ 实验图片',
        other: '📦 其他资产',
      };

      const kindBars = Object.entries(analytics.kindMap).map(([k, count]) => {
        const pct = analytics.totalCount ? Math.round((count / analytics.totalCount) * 100) : 0;
        return `
          <div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
              <span>${kindLabels[k] || k}</span>
              <b>${count} 项 (${pct}%)</b>
            </div>
            <div style="height:6px;background:var(--surface-muted);border-radius:999px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:var(--primary);border-radius:999px;"></div>
            </div>
          </div>`;
      }).join('');

      this._modal(`
        <div style="width:640px;max-width:90vw;">
          <h3>📊 科研文件空间治理与健康仪表盘</h3>
          <p class="muted">基于顶层文件管理思维，评估当前资料库的文件资产分布、存储占用与健康指标</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0;">
            <div style="background:var(--surface-subtle);padding:14px;border-radius:var(--radius);border:1px solid var(--border);">
              <div class="muted" style="font-size:12px;">资产条目总数</div>
              <div style="font-size:24px;font-weight:800;margin-top:4px;">${analytics.totalCount} <span style="font-size:13px;font-weight:400;">项</span></div>
            </div>
            <div style="background:var(--surface-subtle);padding:14px;border-radius:var(--radius);border:1px solid var(--border);">
              <div class="muted" style="font-size:12px;">估算文本存储占用</div>
              <div style="font-size:24px;font-weight:800;margin-top:4px;">${formatSize(analytics.totalBytes)}</div>
            </div>
          </div>
          <h4 style="margin:16px 0 10px;">分类文件分布</h4>
          ${kindBars}
          <div style="display:flex;gap:12px;margin-top:16px;font-size:12px;color:var(--text-soft);">
            <div>⚠️ 未打标签文件: <b>${analytics.untaggedCount}</b> 项</div>
            <div>⏳ 待复现验证文件: <b>${analytics.unverifiedCount}</b> 项</div>
          </div>
          <div class="modal-actions">
            <button class="btn primary" id="spaceOk">关闭仪表盘</button>
          </div>
        </div>`);
      document.getElementById('spaceOk').onclick = () => this._closeModal();
    }

    _closeCmdPalette() {
      const wrap = qs('cmdWrap');
      if (wrap) { wrap.hidden = true; wrap.innerHTML = ''; }
    }
  }

  global.UI = UI;
})(window);
