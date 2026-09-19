/**
 * electron-builder 的 `afterPack` 钩子。
 *
 * 当 `win.signAndEditExecutable` 被禁用时（见 electron-builder.config.js——
 * 在无法获得 Windows 符号链接权限的机器上，内置的 winCodeSign 归档无法解压），
 * electron-builder 通常会跳过嵌入图标/版本元数据。此钩子用我们解压到 tools/ 中的
 * 独立 `rcedit-x64.exe` 来完成它。
 *
 * 在应用被打包进 `appOutDir` 之后、安装包被组装之前运行，因此自定义图标也会进入
 * 已安装的 exe。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const APP_NAME = 'WebNovelTranslator';
// 版本号直接从 package.json 读取，避免手工维护的旧值漂移。
const VERSION = require('../package.json').version;

function main(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const appOutDir = context.appOutDir;
  const exe = path.join(appOutDir, `${APP_NAME}.exe`);
  const icon = path.resolve(__dirname, '../resources/icon.ico');
  const rcedit = path.resolve(__dirname, '../tools/rcedit-x64.exe');

  if (!fs.existsSync(exe)) {
    console.warn('afterPack: exe not found, skipping icon edit:', exe);
    return;
  }
  if (!fs.existsSync(rcedit)) {
    console.warn('afterPack: rcedit not found, skipping icon edit:', rcedit);
    return;
  }
  if (!fs.existsSync(icon)) {
    console.warn('afterPack: icon not found, skipping icon edit:', icon);
    return;
  }

  const args = [
    exe,
    '--set-icon', icon,
    '--set-version-string', 'FileDescription', 'Web Novel Translator',
    '--set-version-string', 'ProductName', APP_NAME,
    '--set-version-string', 'CompanyName', 'Web Novel Translator',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026',
    '--set-file-version', VERSION,
    '--set-product-version', VERSION,
  ];

  execFileSync(rcedit, args, { stdio: 'inherit' });
  console.log(`afterPack: applied icon + version info to ${exe}`);
}

exports.default = main;
