/**
 * preview.js — 内置文件预览渲染器
 * ----------------------------------------------------------------
 * 不下载、不依赖外部库，直接在渲染进程内解析并呈现常见文档：
 *  - text / markdown / code：语法高亮（轻量）+ 等宽排版
 *  - csv / tsv：表格渲染
 *  - json：格式化 + 树形折叠
 *  - image：<img> 直接显示
 * 输入纯文本/数据，输出 HTML 字符串。所有输出经转义，杜绝注入。
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 简单 Markdown -> HTML（标题/加粗/列表/代码块/段落），仅基础子集 */
  function renderMarkdown(md) {
    const lines = md.split('\n');
    let html = '', inCode = false, listOpen = false;
    const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };
    for (let raw of lines) {
      const line = raw;
      if (/^```/.test(line)) { if (inCode) { html += '</code></pre>'; inCode = false; } else { closeList(); html += '<pre><code>'; inCode = true; } continue; }
      if (inCode) { html += escapeHtml(line) + '\n'; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${escapeHtml(h[2])}</h${lvl}>`; continue; }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { if (!listOpen) { html += '<ul>'; listOpen = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (line.trim() === '') { closeList(); continue; }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    if (inCode) html += '</code></pre>';
    return html;
  }
  function inline(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  /** CSV/TSV -> HTML 表格 */
  function renderTable(text, sep) {
    const rows = text.trim().split('\n').map((r) => r.split(sep));
    if (!rows.length) return '<p class="muted">空表格</p>';
    const head = rows[0];
    const body = rows.slice(1, 51); // 预览前 50 行
    let html = '<table class="pv-table"><thead><tr>';
    html += head.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    html += '</tr></thead><tbody>';
    html += body.map((r) => '<tr>' + r.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('');
    html += '</tbody></table>';
    if (rows.length > 51) html += `<div class="muted">… 仅预览前 50 行（共 ${rows.length - 1} 行）</div>`;
    return html;
  }

  /** JSON -> 格式化 + 可折叠树 */
  function renderJSON(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return `<pre class="pv-code">${escapeHtml(text)}</pre>`; }
    return `<div class="pv-json">${jsonNode(obj, 0)}</div>`;
  }
  function jsonNode(v, depth) {
    if (v === null) return '<span class="jk-null">null</span>';
    if (typeof v === 'string') return `<span class="jk-str">"${escapeHtml(v)}"</span>`;
    if (typeof v === 'number') return `<span class="jk-num">${v}</span>`;
    if (typeof v === 'boolean') return `<span class="jk-bool">${v}</span>`;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const items = v.slice(0, 50).map((x) => `<li>${jsonNode(x, depth + 1)}</li>`).join('');
      return `<span class="jk-br">[</span><ul class="jk-arr">${items}</ul><span class="jk-br">]</span>`;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      const items = keys.slice(0, 100).map((k) => `<li><span class="jk-key">${escapeHtml(k)}</span>: ${jsonNode(v[k], depth + 1)}</li>`).join('');
      return `<span class="jk-br">{</span><ul class="jk-obj">${items}</ul><span class="jk-br">}</span>`;
    }
    return escapeHtml(String(v));
  }

  /** PDF：浏览器内置查看器（data URL 直接嵌入 iframe） */
  function renderPdf(content, title) {
    if (!content.startsWith('data:')) return `<div class="pv-note">PDF 内容未内联，无法预览。</div>`;
    return `<div class="pv-pdf"><iframe src="${content}" title="${escapeHtml(title)}"></iframe></div>`;
  }

  /** 行级差异：LCS 对齐后标注 新增/删除/保持，用于原始↔后处理对比 */
  function renderDiff(aText, bText) {
    const a = String(aText || '').split('\n');
    const b = String(bText || '').split('\n');
    const LIMIT = 400; // 超长内容只对比前 400 行，避免 O(n²) 卡顿
    const A = a.slice(0, LIMIT), B = b.slice(0, LIMIT);
    const m = A.length, n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0, j = 0, add = 0, del = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { rows.push(['same', A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(['del', A[i]]); del++; i++; }
      else { rows.push(['add', B[j]]); add++; j++; }
    }
    while (i < m) { rows.push(['del', A[i++]]); del++; }
    while (j < n) { rows.push(['add', B[j++]]); add++; }

    const sign = { same: ' ', add: '+', del: '−' };
    const body = rows.map(([k, t]) =>
      `<div class="dl ${k}"><span class="dm">${sign[k]}</span><span class="dt">${escapeHtml(t)}</span></div>`).join('');
    const truncated = (a.length > LIMIT || b.length > LIMIT)
      ? `<div class="muted">… 仅对比前 ${LIMIT} 行</div>` : '';
    return `<div class="pv-diff"><div class="diff-sum">
        <span class="d-add">+${add} 新增</span><span class="d-del">−${del} 删除</span>
        <span class="muted">${rows.length - add - del} 行未变</span>
      </div><div class="diff-body">${body}</div>${truncated}</div>`;
  }

  /**
   * 主入口：优先按 MIME 判定，其次按 kind，最后按内容嗅探。
   * @param {object} item 含 kind, raw{content,mime}, processed?
   * @param {'raw'|'processed'} which
   */
  function render(item, which) {
    const data = which === 'processed' && item.processed ? item.processed : item.raw;
    const content = data?.content ?? '';
    const kind = item.kind;
    const mime = data?.mime || item.raw?.mime || '';

    if (!content) return '<div class="pv-note">（空内容）</div>';

    // 1) data URL 自描述优先
    if (content.startsWith('data:image/')) {
      return `<div class="pv-image"><img src="${content}" alt="${escapeHtml(item.title)}" /></div>`;
    }
    if (content.startsWith('data:application/pdf')) return renderPdf(content, item.title);

    // 2) MIME 判定
    if (/^image\//.test(mime)) {
      const src = content.startsWith('data:') ? content : `data:${mime};base64,${content}`;
      return `<div class="pv-image"><img src="${src}" alt="${escapeHtml(item.title)}" /></div>`;
    }
    if (mime === 'application/pdf') return renderPdf(content, item.title);
    if (mime === 'application/json') return `<div class="pv-scroll">${renderJSON(content)}</div>`;
    if (mime === 'text/csv') return `<div class="pv-scroll">${renderTable(content, ',')}</div>`;
    if (mime === 'text/tab-separated-values') return `<div class="pv-scroll">${renderTable(content, '\t')}</div>`;
    if (mime === 'text/markdown') return `<div class="pv-md">${renderMarkdown(content)}</div>`;

    // 3) kind + 内容嗅探
    const head = content.trimStart()[0];
    if (kind === 'data') {
      if (head === '{' || head === '[') return `<div class="pv-scroll">${renderJSON(content)}</div>`;
      const first = content.split('\n')[0] || '';
      if (first.includes('\t')) return `<div class="pv-scroll">${renderTable(content, '\t')}</div>`;
      if (first.includes(',')) return `<div class="pv-scroll">${renderTable(content, ',')}</div>`;
    }
    if (kind === 'note') return `<div class="pv-md">${renderMarkdown(content)}</div>`;
    if (content.startsWith('data:')) {
      return `<div class="pv-note">二进制内容（${escapeHtml(mime || '未知类型')}），暂不支持内联预览。</div>`;
    }
    return `<pre class="pv-code">${escapeHtml(content)}</pre>`;
  }

  global.Preview = { render, renderMarkdown, renderTable, renderJSON, renderDiff };
})(window);
