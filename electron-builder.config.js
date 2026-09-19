/**
 * electron-builder 配置（用 JS 编写，以便能感知机器环境）。
 *
 * v3.0.0 签名策略：
 *   - 代码签名完全禁用。`signAndEditExecutable: false` 使 electron-builder 在所有
 *     位置跳过内置的 rcedit/签名步骤（主 exe、NSIS 提权/卸载程序以及每个 transformer），
 *     因此 winCodeSign 归档——它包含 macOS 符号链接，在没有
 *     SeCreateSymbolicLinkPrivilege 的机器上解压失败——永远不会被下载。
 *   - `win.sign: null`（必须为 `null`，不是 `false`）：electron-builder 的
 *     `winPackager.sign()` 在 `sign != null` 时会进入签名路径，而 `false != null`，
 *     因此在没有证书时 `sign: false` 会带着未定义的 `cscInfo` 进入 `doSign()` 并抛出
 *     "Cannot use 'in' operator to search for 'file' in undefined"。设为 `null` 会让
 *     `winPackager.sign()` 立即返回 `false`（无内容可签），这正是我们在没有证书时
 *     想要的效果。
 *   - 应用图标 + 版本元数据仍通过 `scripts/afterPack.js` 使用独立的
 *     `tools/rcedit-x64.exe` 应用，该文件已提交到仓库，因此本地与 GitHub Actions 上
 *     的路径一致。
 *   - CI 工作流环境中还设置了 `CSC_IDENTITY_AUTO_DISCOVERY=false`，作为第二道独立
 *     防线。（未设置空的 CSC_LINK/WIN_CSC_LINK 变量：electron-builder 会把空值解析为
 *     证书文件路径并失败。）
 *
 * 第 1 部分（体积）：
 *   - `asar: true`  —— 把应用打包进单个归档。
 *   - `files`       —— 只分发 dist/public/resources/package.json（+ 生产环境
 *                      node_modules，由 electron-builder 自动加入）。
 *   - NSIS + portable 使用 `compression: 'maximum'`。
 *   - `electronLanguages: ['en-US', 'zh-CN']` —— 从打包后的应用中移除约 37 MB
 *     未使用的 Chromium 语言包（55 个文件）。
 */
// 发布/更新 URL 派生自 package.json 的 `repository` 字段，因此绝不会与
// src/shared/constants.ts 漂移。这是 CommonJS 构建文件，无法导入那个 TypeScript
// 模块，所以 package.json 充当共享的事实来源。
const pkg = require('./package.json');
const REPO_URL = (
  typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url
).replace(/\.git$/, '');
const UPDATE_FEED_URL = `${REPO_URL}/releases/latest/download/`;

const { RUNTIME_ENGINE_PACKAGES } = require('./scripts/packaging-shared.js');

module.exports = {
  appId: 'com.webnoveltranslator.app',
  productName: 'WebNovelTranslator',
  copyright: 'Copyright © 2026 Web Novel Translator',

  directories: {
    output: 'release',
    buildResources: 'resources',
  },

  // 只分发应用真正需要的内容。生产环境 node_modules 会自动包含；
  // 开发/测试文件绝不进入安装包。
  // 显式排除 sourcemap / 源码 / 测试文件等开发产物。
  files: [
    'dist/**/*',
    'public/**/*',
    'resources/**/*',
    'package.json',
    '!**/*.map',
    '!**/*.ts',
    '!**/*.tsx',
    '!**/*.test.*',
    '!**/__tests__/**',
    '!**/*.md',
    // 标准版不分发离线推理引擎（约 50MB）。引擎包在 package.json 中登记为
    // dependencies（打包器一律剔除 devDependencies，放那边就永远打不进去），
    // 所以必须在这里显式排除。需要离线能力的用户请用 `npm run dist:offline`。
    ...RUNTIME_ENGINE_PACKAGES.map((p) => `!${p}/**`),
  ],

  asar: true,
  compression: 'maximum',
  // 只保留界面使用的语言（移除约 37 MB 的 Chromium 语言包）。
  electronLanguages: ['en-US', 'zh-CN'],

  // 打包后应用图标 + 版本元数据（签名已禁用）。
  afterPack: 'scripts/afterPack.js',

  // electron-updater 的发布源（A1 部分）。electron-builder 在此写入
  // `latest.yml`，使 generic provider 的检查能在下载页找到它。
  publish: {
    provider: 'generic',
    url: UPDATE_FEED_URL,
  },

  // 原生 `.node` 二进制会被自动智能解包；这里显式声明，使
  // better-sqlite3 绝不会从 asar 内部被加载。
  asarUnpack: ['node_modules/better-sqlite3/build/**'],

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'resources/icon.ico',
    executableName: 'WebNovelTranslator',
    requestedExecutionLevel: 'asInvoker',
    // 禁用内置的 rcedit/签名步骤 → 绕过 winCodeSign 错误。
    // 图标 + 版本改由 scripts/afterPack.js 应用。
    // NOTE: 必须为 `null`，不是 `false`——见上面的策略说明。
    sign: null,
    signAndEditExecutable: false,
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Web Novel Translator',
    artifactName: '${productName}-Setup-${version}.${ext}',
  },

  portable: {
    artifactName: '${productName}-${version}-portable.${ext}',
  },

  npmRebuild: false,

  // Electron 二进制镜像（部分国内网络无法访问 GitHub）。
  electronDownload: {
    mirror: 'https://npmmirror.com/mirrors/electron/',
  },
};
