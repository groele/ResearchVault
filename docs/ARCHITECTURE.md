# ResearchVault 顶层架构与文件治理设计规范 (Top-Level Architecture Guide)

本文档阐述 `ResearchVault` 系统的**顶层设计思维 (Top-Level Architectural Thinking)**、分层代码目录规范、科研数据证据治理模型与分布式文件空间管理规范。

---

## 1. 软件工程分层代码结构 (`src/`)

```
research-vault-arch/
├── src/                          # 核心源码分层架构
│   ├── core/                     # 1. 基础设施层 (Infrastructure & IPC)
│   │   ├── eventBus.js           # 响应式 Publish-Subscribe 全局事件总线
│   │   └── ipcBridge.js          # Electron / Web Shell 外部文件与 Shell 唤起桥接通道
│   ├── store/                    # 2. 持久化存储与安全层 (Storage & Security)
│   │   ├── crypto.js             # AES-GCM 密码学加密引擎与密钥推导
│   │   └── storage.js            # 抽象存储适配器 (FileSystemAdapter / IndexedDB)
│   ├── services/                 # 3. 科研业务逻辑层 (Scientific Business Domain)
│   │   └── vaultService.js       # SHA-256 哈希计算、衍生版本链、演化拓扑图、引用生成与空间分析
│   ├── state/                    # 4. 状态驱动层 (State Management)
│   │   └── store.js              # 单向数据流Predictable Store
│   ├── ui/                       # 5. UI 与视图渲染层 (UI & Inspector Panels)
│   │   ├── preview.js            # Markdown / CSV / JSON / LCS Diff / Wiki Link 渲染器
│   │   └── ui.js                 # DOM 渲染、侧栏 Inspector、拖拽调宽与模态控制
│   └── assets/                   # 6. 统一设计系统 (Design System)
│       └── styles.css            # 高品质现代化 CSS Token 规范
├── scripts/                      # 运维、测试与服务构建脚本
│   ├── serve.mjs                 # 本地开发 HTTP 开发服务器
│   └── arch-test.mjs             # 数据层 75+ 自动化测试脚本
├── docs/                         # 顶层架构设计规范文档
│   └── ARCHITECTURE.md
├── index.html                    # SPA 主入口
├── app.js                        # 全局 Bootstrapper 引导启动脚本
└── package.json
```

---

## 2. 顶层科研文件治理模型 (Top-Level Data Governance)

```
[原始科研数据 (Immutable Raw)]
       │ (SHA-256 密码学哈希计算)
       ▼
[不可变证据链 (Provenance Record)] ──► [校验和只读保护]
       │
       ├──────────────────────────┐
       ▼                          ▼
[后处理衍生版本 (v1, v2...)]     [学术元数据 (ResearchMeta)]
 (LCS 差异对比 & 差异渲染)         (DOI, 作者团队, 可复现性矩阵)
       │                          │
       └──────────────┬───────────┘
                      ▼
            [演化拓扑图 (DAG Flow)]
```

---

## 3. 5 大顶层文件管理思维要素

1. **分级项目树与下钻导航 (Directory Hierarchy Navigation)**：按资料库与子文件夹无限层级树管理科研文件，面包屑精确定位；
2. **六大科研文件分类 (Smart Taxonomies)**：`💻 代码`, `🤖 模型`, `📊 数据`, `📄 论文`, `📝 笔记`, `🖼️ 图片`；
3. **真实性证据锁 (Immutable Raw Hashing)**：确保原始数据不被篡改，只追加版本链；
4. **双向 Wiki 链接网 (`[[Title]]`)**：打破孤立节点，通过关联建立知识网与反向链接；
5. **存储空间与健康分析 (Storage Space Analytics)**：随时评估数据字节分配、未打标签资产与可复现验证进度。
