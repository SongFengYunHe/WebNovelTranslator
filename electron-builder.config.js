/**
 * electron-builder configuration (JS so it can be machine-aware).
 *
 * v3.0.0 signing policy:
 *   - Code signing is fully disabled. `signAndEditExecutable: false` makes
 *     electron-builder skip its built-in rcedit/sign step everywhere (the
 *     main exe, the NSIS elevate/uninstaller binary and every transformer),
 *     so the winCodeSign archive — which contains macOS symlinks and fails to
 *     extract on machines without the SeCreateSymbolicLinkPrivilege — is never
 *     downloaded.
 *   - `win.sign: null` (must be `null`, NOT `false`): electron-builder's
 *     `winPackager.sign()` routes into the sign path whenever `sign != null`,
 *     and `false != null`, so `sign: false` with no certificate reaches
 *     `doSign()` with an undefined `cscInfo` and throws
 *     "Cannot use 'in' operator to search for 'file' in undefined". Setting it
 *     to `null` makes `winPackager.sign()` return `false` (nothing to sign)
 *     immediately, which is exactly what we want without a certificate.
 *   - The app icon + version metadata are still applied via `scripts/afterPack.js`
 *     with the standalone `tools/rcedit-x64.exe`, which is committed to the repo
 *     so the same path works locally and on GitHub Actions.
 *   - `CSC_IDENTITY_AUTO_DISCOVERY=false` is also set in the CI workflow env as
 *     a second, independent guard. (Empty CSC_LINK/WIN_CSC_LINK vars are NOT set:
 *     electron-builder resolves an empty value as a cert file path and fails.)
 *
 * Part 1 (size):
 *   - `asar: true`  — pack the app into a single archive.
 *   - `files`       — ship only dist/public/resources/package.json (+ prod
 *                     node_modules, which electron-builder adds automatically).
 *   - `compression: 'maximum'` for NSIS + portable.
 *   - `electronLanguages: ['en-US', 'zh-CN']` — drops ~37 MB of unused
 *     Chromium locale packs (55 files) from the packaged app.
 */
module.exports = {
  appId: 'com.webnoveltranslator.app',
  productName: 'WebNovelTranslator',
  copyright: 'Copyright © 2026 Web Novel Translator',

  directories: {
    output: 'release',
    buildResources: 'resources',
  },

  // Only ship what the app actually needs. Production node_modules are
  // included automatically; dev/test files never enter the package.
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
  ],

  asar: true,
  compression: 'maximum',
  // Keep only the locales the UI uses (removes ~37 MB of Chromium packs).
  electronLanguages: ['en-US', 'zh-CN'],

  // Apply the icon + version metadata after packing (signing disabled).
  afterPack: 'scripts/afterPack.js',

  // electron-updater feed (Part A1). electron-builder writes `latest.yml`
  // here so a generic provider check can find it on the download page.
  publish: {
    provider: 'generic',
    url: 'https://github.com/0000110000/floating_translator/releases/latest/download/',
  },

  // Native `.node` binaries are smart-unpacked automatically; be explicit so
  // better-sqlite3 can never be loaded from inside the asar.
  asarUnpack: ['node_modules/better-sqlite3/build/**'],

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'resources/icon.ico',
    executableName: 'WebNovelTranslator',
    requestedExecutionLevel: 'asInvoker',
    // Disable the built-in rcedit/sign step → bypasses the winCodeSign error.
    // The icon + version are applied by scripts/afterPack.js instead.
    // NOTE: must be `null`, not `false` — see the policy comment above.
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

  // Electron binary mirror (GitHub is unreachable from some CN networks).
  electronDownload: {
    mirror: 'https://npmmirror.com/mirrors/electron/',
  },
};
