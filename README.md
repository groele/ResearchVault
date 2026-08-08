# ResearchVault · 前端架构演示（HTML/CSS/JS）

一套**模块化、低耦合、可演进为桌面应用**的科研资料库前端架构原型。
纯原生 HTML/CSS/JS，**无构建步骤** —— 直接用浏览器打开 `index.html` 即可运行
（数据存储走 Web 模拟文件系统；启用 IndexedDB / Electron 只需改一行配置）。

---

## 1. 模块划分与职责

| 模块 | 文件 | 职责 | 依赖 |
|------|------|------|------|
| **事件总线** | `core/eventBus.js` | 全局发布/订阅中枢，所有模块间通信的唯一通道 | 无 |
| **IPC 桥接层** | `core/ipcBridge.js` | 原生能力统一接口（预留）。现 Web 模拟；未来换 `ElectronIpcBridge` | 无 |
| **加密** | `store/crypto.js` | AES-GCM 256 加密（PBKDF2 派生密钥，Web Crypto） | 浏览器 Crypto |
| **存储抽象** | `store/storage.js` | 分层命名空间 + 原子写 + 校验和 + 加密；适配器可切换 | crypto / ipcBridge |
| **状态管理** | `state/store.js` | 中心化 reducer 状态机，纯逻辑、可订阅 | 无 |
| **业务逻辑层** | `services/vaultService.js` | 资料库/条目 CRUD、导入、检索、标签、导出等业务规则 | storage / ipc / bus |
| **UI 渲染层** | `ui/ui.js` + `assets/styles.css` | 订阅状态渲染 DOM、发出用户意图；不碰 Node/fs | store / bus |
| **装配入口** | `app.js` | 实例化模块并用事件总线接线（仅此处"知道"所有模块） | 全部 |

---

## 2. 通信方式：事件驱动 + 发布/订阅

模块之间**互不持有对方实例引用**，全部通过 `bus.emit / bus.on` 解耦：

```
UI ──(意图 ui:*)──▶ bus ──▶ VaultService(业务层)
                            │
              ┌─────────────┼─────────────────────┐
              ▼             ▼                     ▼
         StorageManager   ipcBridge            vault:* 事件
         (数据持久化)     (原生能力)                │
                                                   ▼
                                              bus ──▶ Store(dispatch) ──▶ UI(订阅重渲染)
```

- **UI → 业务**：UI 只发"意图"（`EVENTS.UI_CREATE_ITEM` 等），不知道业务如何实现。
- **业务 → 状态**：业务完成操作后发领域事件（`vault:item:created` 等），Store 监听后更新状态。
- **状态 → UI**：UI 订阅 Store，状态变则重渲。**单向数据流**。

事件名集中在 `core/eventBus.js` 的 `EVENTS` 常量，避免字符串漂移。

---

## 3. 桌面化预留（Electron 无缝切换）

边界原则：**渲染进程（UI/状态/业务/存储）永不直接调用 Node.js / Electron API**，
所有原生能力经 `ipcBridge` 请求。

```js
// 现：Web 模拟（浏览器 <input type=file>、localStorage 模拟磁盘）
const storage = new StorageManager(new adapters.FileSystemAdapter(ipcBridge)); // ipcBridge = MockIpcBridge

// 未来：仅换两行，其余代码零改动
const ipcBridge = new ElectronIpcBridge(window.electronAPI);  // preload 暴露
// 主进程 ipcMain 处理 fs:* 通道；存储适配器、UI、业务逻辑全部不动
```

`ElectronIpcBridge` 模板已在 `core/ipcBridge.js` 内给出，配合 preload 的 `contextBridge.exposeInMainWorld('electronAPI', {...})` 即可。
启用 Electron 时把 `store/storage.js` 的适配器切到真实文件系统实现（同一 `StorageAdapter` 契约），
或保留 `IndexedDBAdapter`（渲染进程内持久，无需主进程）。

---

## 4. 文件存储架构

### 4.1 分层存储
底层键以命名空间前缀隔离，互不污染：

| 命名空间 | 前缀 | 内容 | 可丢失？ |
|----------|------|------|----------|
| **user** | `rv:user:` | 用户条目、导入资料、元数据 | 否（核心数据） |
| **config** | `rv:config:` | 应用配置、主题、库注册表、加密 salt | 否（配置） |
| **cache** | `rv:cache:` | 预览缩略图、临时解析结果 | 是（可重建） |

门面 `StorageManager` 提供 `user() / config() / cache()` 三组等价 API，对上层透明。

### 4.2 原子化写入（防损坏）
```
写 temp 键 → 覆盖正式键 → 删除 temp 键
```
写 temp 成功后再"提交"覆盖正式键；任意一步崩溃，正式键仍为旧值，不会留下半截文件。

### 4.3 校验和机制
每条记录携带 `SHA-256(JSON(value) + ts)`。读取时重新计算并与存储值比对，
**不匹配则拒绝加载并跳过**（见 `arch-test.mjs` 第 4 项验证），杜绝静默损坏。

### 4.4 AES 加密存储
`CryptoBox`（AES-GCM 256，PBKDF2 派生密钥，每条约 12 字节随机 IV）：
- 解锁后写入的 blob 自动加密，落盘为 `ivB64.ctB64`；
- 未解锁时读取加密记录会**明确报错**（不泄漏明文）；
- 密钥仅在内存中，锁定即丢弃。

### 4.5 统一抽象 + 可切换底层
- `StorageAdapter` 定义契约：`put / get / delete / keys / all`。
- 已实现两种实现：`FileSystemAdapter`（经 ipcBridge，Web 模拟 / 未来真文件系统）、
  `IndexedDBAdapter`（浏览器原生持久，适合大数据）。
- 切换：`storage.use(new adapters.IndexedDBAdapter())` —— 业务层与 UI **无感知**。

---

## 5. 运行与验证

```bash
# 直接用浏览器打开（无需服务器）：
open index.html          # macOS
# 或任意静态服务器（推荐：file:// 下 Web Crypto 可能不可用，指纹/加密会失效）：
node scripts/serve.mjs          # → http://localhost:8099

# 数据层自动化验证（Node 环境，polyfill 浏览器全局）：
node scripts/arch-test.mjs      # 48 项：分层/原子+校验和/AES/业务/真实性/审计/批量/恢复/Store 全通过
```

### 功能清单（界面可操作）
- 新建 / 导入（走 ipcBridge，未来即系统文件对话框）/ 拖放导入 / 删除条目
- 全文标题+标签+原始内容搜索（实时过滤）
- 星标收藏、标签管理、批量操作（星标/标签/移动/删除，复选框或 `Space` 多选）
- 多资料库（项目制）切换与新建（带主题色）
- 子项目文件夹树（新建/重命名/删除，删除时条目安全上移至父级）
- 密度切换（舒适/紧凑）、明暗主题（持久化）
- AES 加密开关（解锁后写入自动加密）
- 原始数据 **SHA-256 指纹徽章**（实时校验，篡改即报警）
- **处理链**：后处理版本管理、版本切换、还原原始（历史不丢）
- **完整性自检**：存储层校验和 + 条目级指纹双重复核
- **操作审计日志**抽屉（所有写操作留痕，可追溯）
- JSON 导出 / 从 JSON 恢复（合并策略 + 清单指纹校验）
- 键盘流：`/` 搜索、`j/k` 移动聚焦、`Enter` 打开、`x` 星标、`Space` 多选、`Del` 删除、`Esc` 关闭

---

## 6. 目录结构
```
research-vault-arch/
├─ index.html              # 入口（三栏布局），按依赖顺序加载脚本
├─ assets/styles.css       # 现代主题（CSS 变量，易定制），三栏 + 预览 + 对比
├─ core/
│  ├─ eventBus.js          # 事件总线（发布/订阅）
│  └─ ipcBridge.js         # IPC 桥接层（Mock + Electron 模板）
├─ store/
│  ├─ crypto.js            # AES-GCM 加密
│  └─ storage.js           # 分层存储 + 原子写 + 校验和 + 适配器
├─ state/store.js          # 状态管理（reducer）
├─ services/vaultService.js# 业务逻辑层（含 raw/processed、文件夹）
├─ ui/
│  ├─ ui.js                # UI 渲染层（三栏：库树 / 列表 / 预览）
│  └─ preview.js           # 内置预览渲染器（文本/MD/CSV/JSON/图片）
├─ app.js                  # 装配（事件接线）
└─ scripts/
   ├─ arch-test.mjs        # 数据层端到端验证（48 项）
   └─ serve.mjs            # 本地静态服务器
```

---

## 7. v2 功能增强（本次迭代）

### 7.1 UI 详细优化（三栏布局）
- 左栏：资料库列表 + **子项目文件夹树**（可展开/折叠、显示每文件夹条目数）。
- 中栏：条目卡片网格（舒适/紧凑密度）+ 面包屑导航 + 统计卡 + 原始/后处理视图切换段控件。
- 右栏：**内置预览面板**，原始↔后处理并排或单独对比，含来源/处理时间溯源信息。
- 现代视觉：CSS 变量主题，明暗切换，卡片悬停、骨架屏、徽章（已后处理/来源），信息层级更清晰。

### 7.2 数据真实性保障（raw vs processed）
- 每个条目区分为**原始数据 `raw`**（不可变，记录 `source`/`sourceTime`/`mime`）与**后处理数据 `processed`**（可衍生，记录 `note`/`method`/`processedAt`）。
- `createItem` 写入只落 `raw`；`addProcessed` 单独存衍生版本，**绝不覆盖原始**。
- 预览支持 `原始 / 对比 / 后处理` 三种视图，可直观对比两者差异，确保科研数据可追溯、可靠。
- 验证项：创建时 raw=content 一致、后处理不覆盖 raw、还原后回到 raw（见 `arch-test.mjs` 第 17–20 项）。

### 7.3 子项目文件夹管理
- 每个资料库含 `folders` 树（`{id,name,parent,type,icon}`），支持新建子文件夹（任意层级）、重命名、删除。
- 左侧树形浏览，点击进入对应文件夹；**文件夹视图由 `Store.recompute` 派生**（根目录仅显示顶层，进入子项目才显示其内容），侧栏每个文件夹实时显示条目计数。
- 删除文件夹**不删除任何条目**：其条目与子文件夹一律安全上移至父级，避免数据意外丢失。
- 条目归属 `folderId`，便于按项目/实验分类管理文档。

### 7.4 文件内置预览（无需下载）
`ui/preview.js` 在渲染进程内解析并呈现常见文档：
- 文本 / Markdown / 代码：轻量 Markdown 渲染 + 等宽排版。
- CSV / TSV：表格渲染（预览前 50 行）。
- JSON：格式化 + 树形折叠。
- 图片：直接 `<img>` 显示（base64 data URL）。
- 所有输出经 HTML 转义，杜绝注入。

### 7.5 整体完善
- 验证：`9` 个前端文件 `node --check` 全部通过；`arch-test.mjs` **48/48** 全通过（含数据真实性/审计/批量/恢复/Store 派生）。
- 稳定性：事件总线统一解耦、单向数据流、存储原子写+校验和+加密，边界清晰。
- 易用性：键盘流、密度/主题/视图切换、拖放导入、批量操作、JSON 导入导出。

### 7.6 可追溯性与数据自检（科研可信赖）
- **SHA-256 指纹**：`raw` 落库时即计算指纹并持久化；预览区实时复算并比对，一致显示 `✔ 指纹` 徽章，被改动则 `⚠ 指纹异常`。
- **处理链**：每次后处理追加独立版本（`parent` 指向父版本），可切换回看任意历史版本；"还原原始"仅置空指针，**历史版本全部保留**。
- **操作审计**：所有写操作（增删改、移动、处理、导入、导出、恢复、自检）追加写入 `audit` 命名空间（追加写、不可改），可在抽屉中按时间倒序查看。
- **完整性自检**：`vault.integrityCheck()` 同时校验存储层校验和与每一条 `raw` 指纹，输出健康报告（损坏数/失配项），结果在设置抽屉展示。
- **导出/恢复**：导出含库结构+全量条目(完整处理链)+审计日志+清单指纹；恢复采用合并策略（同 id 跳过、新 id 新增），并校验清单指纹。

### 7.7 全面细致优化（性能 / 健壮性 / 交互）
- **渲染性能**：`ui.js` 为每个渲染小节（侧栏 / 顶栏 / 工具栏 / 统计 / 列表 / 批量栏 / 预览 / 抽屉 / Toast）引入**脏检查签名**。无关状态变化时整段跳过 DOM 重建，避免输入搜索、切换选择时的全量重绘与闪烁；列表仅在"数据签名"变化时才全量重建卡片，**仅选中/聚焦变化则就地打补丁**（改 class 与复选框），大列表下响应稳定。
- **崩溃韧性**：`render()` 按小节容错，单段异常被隔离并记录，不会拖垮整体 UI；预览渲染（`Preview.render` / `renderDiff`）额外包裹 `try/catch`，单条异常文件（坏 JSON / 超长内容）降级为提示而非白屏。
- **模态交互**：打开模态自动聚焦首个输入控件；单行输入内 `Enter` 直接提交主操作；模态内 `Esc` 可关闭（修正了此前输入框聚焦时 `Esc` 被吞的问题）；模态打开时背景快捷键让位。
- **Toast 去重**：相同文案不再重复重建，避免动画重启闪烁。
- **空状态区分**：搜索/筛选无果显示"未找到匹配的条目"，真无条目显示"当前视图暂无条目"，提示更精准。
- **组件样式补全**：修正卡片 `grid` 布局与 `.card-ico` 图标芯片（此前 HTML 已加、CSS 未配套导致图标错位）；补齐抽屉固定右滑面板定位、设置面板、审计行、徽章（指纹/处理/当前/异常）、`.muted`、`.star-i`、`.hash` 等此前缺失的样式；新增骨架屏微光、模态/抽屉/Toast 入场动画与键盘焦点环。
- **契约校验**：逐项核对 `ui.js` 发出的事件、`dispatch` 的动作、`qs()` 的 DOM id，均与 `app.js` / `store.js` / `index.html` 一致（已用脚本自动化交叉验证）。

