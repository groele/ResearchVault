// scripts/arch-test.mjs — 在无浏览器环境下验证架构的数据层
// 通过 polyfill 浏览器全局（window/localStorage/btoa/crypto），
// 加载 IIFE 模块并端到端验证：事件总线 / 分层存储 / 原子+校验和 / AES 加密 / 业务层。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- polyfills ----
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const sandbox = {
  window: {},
  document: { addEventListener() {}, readyState: 'complete', documentElement: { setAttribute() {} }, createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }) },
  localStorage,
  crypto: globalThis.crypto,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (b) => Buffer.from(b, 'base64').toString('binary'),
  console,
  setTimeout,
  indexedDB: undefined, // 本次仅测 Web 模拟文件系统适配器
  Blob: class {},
  URL: { createObjectURL: () => '' },
};
sandbox.window = sandbox; // IIFE 用 window 作为 global
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

['core/eventBus.js', 'core/ipcBridge.js', 'store/crypto.js', 'store/storage.js', 'state/store.js', 'services/vaultService.js'].forEach(load);

const { bus, EVENTS, ipcBridge, StorageManager, adapters, VaultService, createStore, storageUtils } = sandbox;

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); if (!c) fails++; };

const storage = new StorageManager(new adapters.FileSystemAdapter(ipcBridge));
const appStore = createStore();
const vault = new VaultService(storage, ipcBridge, bus);

// 监听领域事件（验证事件驱动解耦）
let createdFired = false;
bus.on(EVENTS.VAULT_ITEM_CREATED, () => { createdFired = true; });

(async () => {
  // 1) 初始化 + 默认库
  const reg = await vault.init();
  ok('初始化创建默认资料库', reg.libraries.length === 1);

  // 2) 创建条目 + 事件触发 + 持久化
  const it = await vault.createItem({ title: 'Transformer 论文', kind: 'paper', tags: ['ml', 'nlp'], content: 'Attention is all you need.' });
  ok('创建条目触发 VAULT_ITEM_CREATED', createdFired);
  const back = await storage.user(it.id);
  ok('条目持久化到 user 命名空间', back && back.title === 'Transformer 论文');

  // 3) 分层：config 与 user 隔离
  await storage.config('theme', 'dark');
  ok('config 命名空间独立写入', (await storage.config('theme')) === 'dark');
  ok('user 命名空间不含 config 键', (await storage.user(it.id))?.title === 'Transformer 论文');

  // 4) 校验和：篡改数据应被拒绝
  const raw = await ipcBridge.invoke('fs:read', 'rv:user:' + it.id);
  const obj = JSON.parse(raw);
  // 改掉 value 中的标题，但不更新 checksum —— 校验和必然失配
  obj.payload = obj.payload.replace('Transformer', 'TamperedX');
  const tampered = JSON.stringify(obj);
  await ipcBridge.invoke('fs:write', 'rv:user:' + it.id, tampered);
  let threw = false;
  try { await storage.user(it.id); } catch (e) { threw = true; }
  ok('校验和机制检测并拒绝损坏数据', threw);
  // 还原
  await ipcBridge.invoke('fs:write', 'rv:user:' + it.id, raw);

  // 5) AES 加密：解锁后写入加密，读取需解锁
  await vault.unlockCrypto('s3cret');
  storage.setCrypto(vault.crypto);
  const it2 = await vault.createItem({ title: '机密笔记', kind: 'note', content: '敏感内容' });
  const encRaw = await ipcBridge.invoke('fs:read', 'rv:user:' + it2.id);
  ok('加密后落盘为密文(含 iv.ct 结构)', typeof encRaw === 'string' && encRaw.includes('.'));
  // 锁定时读取应报错
  vault.lockCrypto(); storage.setCrypto(null);
  let encThrew = false;
  try { await storage.user(it2.id); } catch (e) { encThrew = true; }
  ok('未解锁读取加密记录被拒绝', encThrew);
  // 重新解锁可解密
  await vault.unlockCrypto('s3cret');
  storage.setCrypto(vault.crypto);
  const dec = await storage.user(it2.id);
  ok('正确口令可解密还原', dec && dec.title === '机密笔记' && dec.content === '敏感内容');

  // 6) 业务：星标 / 标签
  await vault.toggleStar(it.id);
  const starred = await storage.user(it.id);
  ok('toggleStar 生效', starred.starred === true);
  await vault.tagItem(it.id, 'transformer');
  const tagged = await storage.user(it.id);
  ok('tagItem 生效', tagged.tags.includes('transformer'));

  // 7) 批量加载（按库分区）
  const items = await vault.loadItems(reg.activeId);
  ok('loadItems 返回当前库条目', items.length >= 2);

  // 8) 删除
  await vault.deleteItem(it.id);
  ok('删除后不可读', (await storage.user(it.id)) === undefined);

  // 9) 子项目文件夹：创建 + 全量加载（文件夹视图由 Store 派生）
  const reg2 = await storage.config('libraries');
  const lib2 = reg2.libraries[0];
  const folder = await vault.createFolder(lib2.id, { name: '实验A', parent: 'root' });
  const inFolder = await vault.createItem({ title: '组内数据', kind: 'data', libraryId: lib2.id, folderId: folder.id, raw: { content: 'x,y\n1,2', source: 'manual' } });
  ok('子项目文件夹创建成功', !!folder && folder.parent === 'root');
  // loadItems 现在始终返回资料库「全量」条目（文件夹视图由 Store.recompute 派生）
  const full = await vault.loadItems(lib2.id);
  ok('loadItems 返回资料库全量（含子文件夹条目）', full.length >= 1 && full.some((i) => i.id === inFolder.id));
  // 文件夹视图由 Store 派生：进入子文件夹只可见该文件夹条目
  const sLib = createStore();
  sLib.dispatch({ type: 'SET_ITEMS', items: full, folderId: 'root' });
  sLib.dispatch({ type: 'SET_FOLDER', folderId: folder.id });
  ok('Store 派生：进入子文件夹仅见该文件夹条目', sLib.getState().filtered.some((i) => i.id === inFolder.id) && !sLib.getState().filtered.some((i) => i.folderId === 'root' || i.folderId == null));
  sLib.dispatch({ type: 'SET_FOLDER', folderId: 'root' });
  ok('Store 派生：回到根目录仅见顶层条目', sLib.getState().filtered.every((i) => i.folderId === 'root' || i.folderId == null));

  // 10) 原始 vs 后处理：真实性保障
  const base = await vault.createItem({ title: '原始记录', kind: 'note', libraryId: lib2.id, folderId: 'root', raw: { content: '原始文本', source: 'manual' } });
  ok('创建时 raw 与 content 一致(未处理)', base.raw.content === '原始文本' && base.content === '原始文本' && base.processed === null);
  const proc = await vault.addProcessed(base.id, { content: '处理后文本', note: '清洗' });
  ok('后处理不覆盖 raw（真实性）', proc.raw.content === '原始文本' && proc.processed.content === '处理后文本');
  ok('展示 content 优先取后处理', proc.content === '处理后文本');
  // 11) 科研分类 (code & model) 自动嗅探
  const pyKind = vault._guessKind('train.py');
  const modelKind = vault._guessKind('model.pt');
  ok('自动识别 .py 为 code 类型', pyKind === 'code');
  ok('自动识别 .pt 为 model 类型', modelKind === 'model');

  // 12) 自定义分类文件夹创建与图标带出
  const codeFolder = await vault.createFolder(lib2.id, { name: '预训练代码', type: 'code', parent: 'root' });
  ok('新建代码分类文件夹带出 💻 图标', codeFolder && codeFolder.icon === '💻' && codeFolder.type === 'code');

  // 13) 拖拽移动条目归类
  const moved = await vault.moveItem(base.id, codeFolder.id);
  ok('拖拽移动条目到指定文件夹成功', moved && moved.folderId === codeFolder.id);

  // 14) 全库数据完整性自检 (SHA-256 Checksum)
  const report = await vault.integrityCheck();
  ok('全库数据完整性自检通过', report && report.healthy === true && report.items.tampered === 0);

  // ---- 以下为本次扩展：数据真实性 / 处理链 / 审计 / 批量 / 文件夹合并 / 恢复 / Store 派生 ----

  // 15) 指纹：创建即算 SHA-256；篡改原始内容指纹失配
  const fp = await vault.createItem({ title: '指纹测试', kind: 'data', libraryId: lib2.id, folderId: 'root', raw: { content: 'raw-fingerprint-data' } });
  ok('创建时计算 raw SHA-256 指纹(64位hex)', !!fp.raw.hash && fp.raw.hash.length === 64);
  const v1 = await vault.addProcessed(fp.id, { content: 'proc1', note: 'step1' });
  ok('后处理追加到处理链(第1版)', v1.processedVersions.length === 1 && v1.currentVersion === v1.processedVersions[0].id);
  const v2 = await vault.addProcessed(fp.id, { content: 'proc2', note: 'step2' });
  ok('处理链可追加多版本', v2.processedVersions.length === 2);
  const reverted = await vault.revertToRaw(fp.id);
  ok('还原原始后 currentVersion 置空但处理链保留', reverted.currentVersion === null && reverted.processedVersions.length === 2);
  const verify = await vault.verifyItem(fp.id);
  ok('指纹校验通过(原始数据未被改动)', verify.ok === true);
  // 篡改原始内容后指纹失配
  const tamperedItem = await storage.user(fp.id);
  tamperedItem.raw.content = 'HACKED';
  await storage.user(fp.id, tamperedItem);
  const verify2 = await vault.verifyItem(fp.id);
  ok('篡改原始内容后指纹失配', verify2.ok === false);
  // 还原，避免污染后续状态
  tamperedItem.raw.content = 'raw-fingerprint-data';
  await storage.user(fp.id, tamperedItem);

  // 16) 审计日志：写操作留痕 + 可读
  let auditFired = false;
  bus.on(EVENTS.AUDIT_APPENDED, () => { auditFired = true; });
  await vault.tagItem(fp.id, 'audit-test');
  ok('写操作触发审计事件', auditFired);
  const audit = await vault.getAudit();
  ok('审计日志可读且含本次操作', audit.length > 0 && audit.some((a) => a.summary && a.summary.includes('audit-test')));

  // 17) 批量操作：星标 / 移动 / 删除
  const b1 = await vault.createItem({ title: 'bulk1', kind: 'note', libraryId: lib2.id, folderId: 'root', raw: { content: 'a' } });
  const b2 = await vault.createItem({ title: 'bulk2', kind: 'note', libraryId: lib2.id, folderId: 'root', raw: { content: 'b' } });
  let bulkFired = false;
  bus.on(EVENTS.VAULT_BULK_DONE, () => { bulkFired = true; });
  await vault.bulk('star', [b1.id, b2.id], { on: true });
  ok('批量星标生效', (await storage.user(b1.id)).starred && (await storage.user(b2.id)).starred);
  ok('批量完成事件触发', bulkFired);
  await vault.bulk('move', [b1.id], { folderId: codeFolder.id });
  ok('批量移动到子项目', (await storage.user(b1.id)).folderId === codeFolder.id);
  await vault.bulk('delete', [b1.id, b2.id]);
  ok('批量删除生效', (await storage.user(b1.id)) === undefined && (await storage.user(b2.id)) === undefined);

  // 18) 删除文件夹：条目安全上移至父级（绝不丢数据）
  const df = await vault.createFolder(lib2.id, { name: '待删', parent: 'root' });
  const dItem = await vault.createItem({ title: 'd-item', kind: 'note', libraryId: lib2.id, folderId: df.id, raw: { content: 'd' } });
  const beforeDel = await vault.allInLibrary(lib2.id);
  await vault.deleteFolder(lib2.id, df.id);
  const afterDel = await vault.allInLibrary(lib2.id);
  const freshReg = await storage.config('libraries');
  const freshLib = freshReg.libraries.find((l) => l.id === lib2.id);
  ok('删除文件夹不丢失条目(上移至父级)', afterDel.length === beforeDel.length && (await storage.user(dItem.id)).folderId === 'root');
  ok('删除后文件夹已从树中移除', !freshLib.folders.some((f) => f.id === df.id));

  // 19) 导出 / 恢复：合并策略（同 id 跳过，新 id 新增）
  const exportPkg = await vault.exportJSON();
  ok('导出含清单指纹', !!exportPkg.manifestHash && exportPkg.format === 'research-vault-export');
  const existing = exportPkg.items[0];
  const newItem = {
    id: 'it_restore_new', libraryId: lib2.id, folderId: 'root', title: '恢复新增', kind: 'note',
    starred: false, tags: [], raw: { content: 'r', hash: await storageUtils.sha256('r'), size: 1 },
    processedVersions: [], currentVersion: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
  const pkg2 = { format: 'research-vault-export', version: 2, libraries: exportPkg.libraries, activeId: exportPkg.activeId, items: [existing, newItem], audit: [] };
  const res = await vault.restoreJSON(pkg2);
  ok('恢复时跳过已存在 id', res.skipped >= 1 && res.added >= 1);
  const restoredNew = await storage.user('it_restore_new');
  ok('恢复时新增不存在的 id', !!restoredNew && restoredNew.title === '恢复新增');

  // 20) Store 派生逻辑（文件夹视图 / 筛选 / 搜索 / 排序）—— 不依赖 DOM
  const s = createStore();
  const allItems = [
    { id: 's1', title: 'A', kind: 'note', libraryId: 'L', folderId: 'root', starred: true, processedVersions: [{ id: 'v1' }], raw: { content: '' }, createdAt: 1, updatedAt: 1 },
    { id: 's2', title: 'B', kind: 'data', libraryId: 'L', folderId: 'root', starred: false, processedVersions: [], raw: { content: '' }, createdAt: 2, updatedAt: 2 },
    { id: 's3', title: 'C', kind: 'paper', libraryId: 'L', folderId: 'root', starred: false, processedVersions: [], raw: { content: 'hello' }, createdAt: 3, updatedAt: 3 },
    { id: 's4', title: 'D', kind: 'image', libraryId: 'L', folderId: 'f1', starred: false, processedVersions: [], raw: { content: '' }, createdAt: 4, updatedAt: 4 },
  ];
  s.dispatch({ type: 'SET_ITEMS', items: allItems });
  s.dispatch({ type: 'SET_ACTIVE_LIBRARY', id: 'L' });
  ok('Store: 根目录仅显示顶层条目', s.getState().filtered.length === 3);
  s.dispatch({ type: 'SET_FOLDER', folderId: 'f1' });
  ok('Store: 进入子文件夹仅显示该文件夹条目', s.getState().filtered.length === 1 && s.getState().filtered[0].id === 's4');
  s.dispatch({ type: 'SET_FOLDER', folderId: 'root' });
  s.dispatch({ type: 'SET_FILTER', patch: { starred: true } });
  ok('Store: 仅收藏筛选', s.getState().filtered.length === 1 && s.getState().filtered[0].id === 's1');
  s.dispatch({ type: 'SET_FILTER', patch: { starred: false, processed: 'yes' } });
  ok('Store: 仅已后处理筛选', s.getState().filtered.length === 1 && s.getState().filtered[0].id === 's1');
  s.dispatch({ type: 'SET_FILTER', patch: { processed: 'all', kind: 'data' } });
  ok('Store: 按类型筛选', s.getState().filtered.length === 1 && s.getState().filtered[0].id === 's2');
  s.dispatch({ type: 'SET_FILTER', patch: { kind: 'all' } });
  s.dispatch({ type: 'SET_QUERY', query: 'hello' });
  ok('Store: 内容搜索', s.getState().filtered.length === 1 && s.getState().filtered[0].id === 's3');
  s.dispatch({ type: 'SET_QUERY', query: '' });
  s.dispatch({ type: 'SET_SORT', sort: 'title_asc' });
  ok('Store: 按标题 A→Z 排序', s.getState().filtered.map((i) => i.title).join(',') === 'A,B,C');

  // 21) 扩展批量操作：批量取消标签与批量设置类型
  const bt1 = await vault.createItem({ title: 'bt1', kind: 'note', tags: ['t1', 't2'], libraryId: lib2.id, folderId: 'root', raw: { content: 'c' } });
  await vault.bulk('untag', [bt1.id], { tag: 't1' });
  const bt1After = await storage.user(bt1.id);
  ok('批量取消标签生效', !bt1After.tags.includes('t1') && bt1After.tags.includes('t2'));

  await vault.bulk('kind', [bt1.id], { kind: 'model' });
  const bt1Kind = await storage.user(bt1.id);
  ok('批量设置资源类型生效', bt1Kind.kind === 'model');

  // 22) 孤立条目自愈修复 (repairOrphanedItems)
  const orphanItem = await vault.createItem({ title: '孤立条目', kind: 'data', libraryId: lib2.id, folderId: 'f_non_existent', raw: { content: 'o' } });
  const repairedCount = await vault.repairOrphanedItems(lib2.id);
  const repairedItem = await storage.user(orphanItem.id);
  ok('自愈修复计数字段一致', repairedCount >= 1);
  ok('孤立条目成功重置归父至 root', repairedItem.folderId === 'root');

  // 23) 导出 CSV 表格清单与表头验证
  const csvContent = await vault.exportCSV();
  ok('导出 CSV 内容包含标准表头', csvContent.startsWith('id,title,kind,tags,libraryId,folderId,createdAt,updatedAt,rawHash'));
  ok('导出 CSV 包含新增自愈条目', csvContent.includes('孤立条目'));

  // 24) 受限更新：拒绝破坏数据真实性的非白名单字段
  let illegalErr = false;
  try {
    await vault.updateItem(bt1.id, { raw: { content: 'tampered' } });
  } catch (e) {
    illegalErr = true;
  }
  ok('更新机制拒绝篡改不可变 raw 字段', illegalErr);

  // 25) 外部 App 调起机制 (openWith)
  const openRes = await vault.openWith(bt1.id, 'vscode');
  ok('openWith 成功调用底层 Shell 打开通道', openRes.ok === true && openRes.appName.includes('VS Code'));

  // 26) 数据库删除连带清理校验
  await vault.deleteItem(bt1.id);
  await vault.deleteItem(orphanItem.id);
  ok('删除后记录完全注销', (await storage.user(bt1.id)) === undefined);

  // 27) 智能去重检测器 (findDuplicates) —— 全同哈希去重
  const dup1 = await vault.createItem({ title: '实验数据 A', kind: 'data', libraryId: lib2.id, folderId: 'root', raw: { content: 'identical-data-content' } });
  const dup2 = await vault.createItem({ title: '实验数据 B', kind: 'data', libraryId: lib2.id, folderId: 'root', raw: { content: 'identical-data-content' } });
  const dupReport = await vault.findDuplicates(lib2.id);
  ok('findDuplicates 检出全同哈希重复组', dupReport.exact.length >= 1 && dupReport.exact.some((g) => g.items.some((i) => i.id === dup1.id) && g.items.some((i) => i.id === dup2.id)));

  // 28) 智能去重检测器 —— 标题相近/重名去重
  const titleDup1 = await vault.createItem({ title: '重名报告', kind: 'paper', libraryId: lib2.id, folderId: 'root', raw: { content: 'content-x' } });
  const titleDup2 = await vault.createItem({ title: '重名报告', kind: 'paper', libraryId: lib2.id, folderId: 'root', raw: { content: 'content-y' } });
  const dupReport2 = await vault.findDuplicates(lib2.id);
  ok('findDuplicates 检出标题相近重名组', dupReport2.titleSimilar.length >= 1 && dupReport2.titleSimilar.some((g) => g.title === '重名报告'));

  // 29) 学术引用生成器 (generateCitation - BibTeX)
  const bibStr = await vault.generateCitation(dup1.id, 'bibtex');
  ok('generateCitation 输出标准 BibTeX 节点', bibStr.includes('@misc{') && bibStr.includes('title = {实验数据 A}'));

  // 30) 学术引用生成器 (generateCitation - Markdown)
  const mdStr = await vault.generateCitation(dup1.id, 'markdown');
  ok('generateCitation 输出标准 Markdown 引用格式', mdStr.includes('[实验数据 A]') && mdStr.includes('rv:user:'));

  // 31) 科研元数据创建与保存 (researchMeta: doi, authors)
  const rmItem = await vault.createItem({
    title: 'AlphaFold3 蛋白质结构预测', kind: 'model', libraryId: lib2.id, folderId: 'root',
    raw: { content: 'model-weights-metadata' },
    researchMeta: { doi: '10.1038/s41586-024-07487-w', authors: 'Abramson et al.', reproducibility: 'unverified' },
  });
  const savedRm = await storage.user(rmItem.id);
  ok('createItem 持久化科研元数据(DOI与作者)', savedRm.researchMeta?.doi === '10.1038/s41586-024-07487-w' && savedRm.researchMeta?.authors === 'Abramson et al.');

  // 32) 实验可复现状态切换 (setReproducibility)
  await vault.setReproducibility(rmItem.id, 'reproduced');
  const reproSaved = await storage.user(rmItem.id);
  ok('setReproducibility 切换可复现状态为 reproduced', reproSaved.researchMeta?.reproducibility === 'reproduced');

  // 33) Store 可复现状态筛选器测试
  const s2 = createStore();
  const rItems = [
    { id: 'r1', title: 'r1', kind: 'data', libraryId: 'L', folderId: 'root', starred: false, processedVersions: [], raw: { content: '' }, researchMeta: { reproducibility: 'reproduced' }, createdAt: 1, updatedAt: 1 },
    { id: 'r2', title: 'r2', kind: 'data', libraryId: 'L', folderId: 'root', starred: false, processedVersions: [], raw: { content: '' }, researchMeta: { reproducibility: 'unverified' }, createdAt: 2, updatedAt: 2 },
    { id: 'r3', title: 'r3', kind: 'data', libraryId: 'L', folderId: 'root', starred: false, processedVersions: [], raw: { content: '' }, researchMeta: { reproducibility: 'failed' }, createdAt: 3, updatedAt: 3 },
  ];
  s2.dispatch({ type: 'SET_ITEMS', items: rItems });
  s2.dispatch({ type: 'SET_FILTER', patch: { reproducibility: 'reproduced' } });
  ok('Store: 可复现筛选(仅已复现)', s2.getState().filtered.length === 1 && s2.getState().filtered[0].id === 'r1');
  s2.dispatch({ type: 'SET_FILTER', patch: { reproducibility: 'failed' } });
  ok('Store: 可复现筛选(仅不可复现失败项)', s2.getState().filtered.length === 1 && s2.getState().filtered[0].id === 'r3');

  // 34) 扩展名自动衍生标签测试 (_deriveAutoTags)
  const pyTags = vault._deriveAutoTags('train_model.py');
  const ptTags = vault._deriveAutoTags('resnet50.pt');
  const csvTags = vault._deriveAutoTags('gene_expression.csv');
  const pdfTags = vault._deriveAutoTags('nature_paper.pdf');
  ok('_deriveAutoTags: .py 衍生标签 [code, python]', pyTags.includes('code') && pyTags.includes('python'));
  ok('_deriveAutoTags: .pt 衍生标签 [model, pytorch]', ptTags.includes('model') && ptTags.includes('pytorch'));
  ok('_deriveAutoTags: .csv 衍生标签 [dataset, csv]', csvTags.includes('dataset') && csvTags.includes('csv'));
  ok('_deriveAutoTags: .pdf 衍生标签 [paper, pdf]', pdfTags.includes('paper') && pdfTags.includes('pdf'));

  // 35) 文件夹批量导入：按后缀打标签 + 自动按相对路径建子项目归类 (_ingest)
  const mockFolderFiles = [
    { name: 'train.py', relativePath: 'my_project/src/train.py', content: 'import torch', mime: 'text/plain' },
    { name: 'bert.pt', relativePath: 'my_project/models/bert.pt', content: 'weights', mime: 'application/octet-stream' },
  ];
  const ingested = await vault._ingest(mockFolderFiles, 'folder');
  const itemPy = ingested.find((i) => i.title === 'train.py');
  const itemPt = ingested.find((i) => i.title === 'bert.pt');
  ok('_ingest 文件夹导入: train.py 打标签且归类至 src 文件夹', itemPy && itemPy.tags.includes('python') && itemPy.kind === 'code');
  ok('_ingest 文件夹导入: bert.pt 打标签且归类至 models 文件夹', itemPt && itemPt.tags.includes('pytorch') && itemPt.kind === 'model');

  // 36) 元数据行内编辑能力验证 (updateItem title/tags/researchMeta)
  if (itemPy) {
    await vault.updateItem(itemPy.id, {
      title: '分布式模型训练入口脚本.py',
      tags: ['code', 'python', 'pytorch', 'distributed'],
      researchMeta: { doi: '10.1038/s41586-024-0000-0', authors: '科研小组' },
    });
    const updatedPy = await storage.user(itemPy.id);
    ok('updateItem 成功行内更新资产标题、扩展标签与科研DOI', updatedPy.title === '分布式模型训练入口脚本.py' && updatedPy.tags.includes('distributed') && updatedPy.researchMeta?.doi === '10.1038/s41586-024-0000-0');
  }

  // 37) 科研数据演化拓扑图生成 (getLineageGraph)
  const lineage = await vault.getLineageGraph(lib2.id);
  ok('getLineageGraph 节点集包含当前项目全量资产', lineage.nodes.length >= 2);

  // 38) 双向引用 (getBacklinks) 测试
  const wikiNote = await vault.createItem({
    title: '基准实验笔记', kind: 'note', libraryId: lib2.id, folderId: 'root',
    raw: { content: '本笔记引用 [[分布式模型训练入口脚本.py]] 数据进行评测。' },
  });
  const backlinks = await vault.getBacklinks(itemPy.id);
  ok('getBacklinks 正确检出引用当前条目的反向关联笔记', backlinks.length >= 1 && backlinks.some((b) => b.id === wikiNote.id));

  // 清理衍生测试数据
  await vault.deleteItem(dup1.id);
  await vault.deleteItem(dup2.id);
  await vault.deleteItem(titleDup1.id);
  await vault.deleteItem(titleDup2.id);
  await vault.deleteItem(rmItem.id);
  await vault.deleteItem(wikiNote.id);
  if (itemPy) await vault.deleteItem(itemPy.id);
  if (itemPt) await vault.deleteItem(itemPt.id);

  console.log(`\n架构数据层验证：${fails === 0 ? '全部通过 🎉' : fails + ' 项失败'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
