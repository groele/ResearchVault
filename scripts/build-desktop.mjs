/**
 * scripts/build-desktop.mjs — ResearchVault 一键桌面构建诊断与打包脚本
 * -------------------------------------------------------------------------
 * 用法：
 *   node scripts/build-desktop.mjs          # 环境诊断（不构建）
 *   node scripts/build-desktop.mjs --dist   # 构建 Windows NSIS 安装包
 *   node scripts/build-desktop.mjs --pack   # 构建 Portable 免安装绿色版
 *
 * 输出（--dist）：
 *   dist/ResearchVault Setup x.y.z.exe      # NSIS 标准安装包
 *   dist/ResearchVault x.y.z.exe            # Portable 免安装版
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';

const ok  = (msg) => console.log(`${GREEN}✅ ${msg}${RESET}`);
const err = (msg) => console.log(`${RED}❌ ${msg}${RESET}`);
const warn= (msg) => console.log(`${YELLOW}⚠️  ${msg}${RESET}`);
const info= (msg) => console.log(`${CYAN}ℹ️  ${msg}${RESET}`);

console.log('\n' + '═'.repeat(62));
console.log('  ResearchVault v5.0.0 — 桌面构建诊断工具 (Desktop Build Checker)');
console.log('═'.repeat(62) + '\n');

let hasError = false;

// ============ 1. 核心文件检查 ============
info('检查必需文件...');
const required = [
  'index.html',
  'app.js',
  'electron-main.mjs',
  'electron-preload.js',
  'package.json',
  'src/core/ipcBridge.js',
  'src/core/eventBus.js',
  'src/store/crypto.js',
  'src/store/storage.js',
  'src/state/store.js',
  'src/services/vaultService.js',
  'src/ui/preview.js',
  'src/ui/ui.js',
  'src/assets/styles.css',
  'docs/ARCHITECTURE.md',
];

for (const f of required) {
  if (existsSync(path.join(ROOT, f))) {
    ok(`文件存在: ${f}`);
  } else {
    err(`缺失文件: ${f}`);
    hasError = true;
  }
}

// ============ 2. package.json 配置检查 ============
console.log('');
info('检查 package.json 配置...');
try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.main === 'electron-main.mjs') ok(`package.json main: ${pkg.main}`);
  else { err(`package.json main 应为 "electron-main.mjs"，当前: ${pkg.main}`); hasError = true; }

  if (pkg.scripts?.start) ok(`npm start: ${pkg.scripts.start}`);
  else { err('package.json 缺少 scripts.start'); hasError = true; }

  if (pkg.build?.appId) ok(`appId: ${pkg.build.appId}`);
  else { err('package.json 缺少 build.appId'); hasError = true; }

  if (pkg.build?.win) ok(`Windows 构建目标已配置: ${JSON.stringify(pkg.build.win.target)}`);
  else { err('package.json 缺少 build.win'); hasError = true; }
} catch (e) {
  err(`package.json 解析失败: ${e.message}`);
  hasError = true;
}

// ============ 3. Node.js 版本检查 ============
console.log('');
info('检查运行时环境...');
const nodeVer = process.version;
const nodeMajor = parseInt(nodeVer.slice(1).split('.')[0]);
if (nodeMajor >= 18) ok(`Node.js ${nodeVer} ✓`);
else { warn(`Node.js ${nodeVer} 建议升级至 18+`); }

// ============ 4. Electron / electron-builder 安装检查 ============
console.log('');
info('检查 Electron 依赖（需要先 npm install）...');
const nodeModulesExists = existsSync(path.join(ROOT, 'node_modules'));
if (nodeModulesExists) {
  const electronExists = existsSync(path.join(ROOT, 'node_modules', 'electron'));
  const builderExists  = existsSync(path.join(ROOT, 'node_modules', 'electron-builder'));
  if (electronExists)  ok('electron 已安装');
  else { warn('electron 未安装，请运行: npm install electron --save-dev'); }
  if (builderExists)   ok('electron-builder 已安装');
  else { warn('electron-builder 未安装，请运行: npm install electron-builder --save-dev'); }
} else {
  warn('node_modules 不存在，请先运行: npm install');
  warn('依赖安装后即可使用: npm run dist 打包 Windows .exe');
}

// ============ 5. 自动化测试验证 ============
console.log('');
info('运行自动化测试验证数据层...');
const testResult = spawnSync('node', ['scripts/arch-test.mjs'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
if (testResult.status === 0) ok('自动化测试 100% 通过 — 数据层桌面迁移完全兼容');
else {
  err('自动化测试存在失败项：');
  console.log(testResult.stdout?.slice(-500));
  hasError = true;
}

// ============ 6. 构建总结 ============
console.log('\n' + '─'.repeat(62));
if (hasError) {
  err('存在问题需修复后才能构建，请参阅上方错误信息。');
} else {
  ok('所有检查通过！项目随时可以构建 Windows 桌面程序。');
  console.log('');
  console.log(`  ${CYAN}安装依赖：${RESET}  npm install`);
  console.log(`  ${CYAN}本地运行：${RESET}  npm start     (Electron 桌面窗口)`);
  console.log(`  ${CYAN}Web 开发：${RESET}  npm run serve (127.0.0.1:8080 浏览器)`);
  console.log(`  ${CYAN}运行测试：${RESET}  npm test`);
  console.log(`  ${CYAN}打 Portable：${RESET}npm run pack  → dist/*.exe 绿色版`);
  console.log(`  ${CYAN}打 NSIS 安装：${RESET}npm run dist  → dist/*Setup*.exe`);
}
console.log('─'.repeat(62) + '\n');

// ============ 7. --dist / --pack 实际构建 ============
const args = process.argv.slice(2);
if (args.includes('--dist') || args.includes('--pack')) {
  if (!nodeModulesExists) {
    err('请先运行 npm install 安装依赖后再构建。');
    process.exit(1);
  }
  const target = args.includes('--dist') ? 'dist' : 'pack';
  info(`启动 electron-builder 构建 (--${target})...`);
  execSync(`npm run ${target}`, { cwd: ROOT, stdio: 'inherit' });
}

process.exit(hasError ? 1 : 0);
