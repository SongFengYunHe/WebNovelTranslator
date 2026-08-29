/**
 * electron-builder `afterPack` hook.
 *
 * When `win.signAndEditExecutable` is disabled (see electron-builder.config.js —
 * the bundled winCodeSign archive cannot be extracted on machines where the
 * Windows symlink privilege is unavailable), electron-builder would normally
 * skip embedding the icon/version metadata. This hook does it with the
 * standalone `rcedit-x64.exe` we extracted into tools/.
 *
 * Runs after the app is packed into `appOutDir` and before the installers
 * are assembled, so the custom icon ends up in the installed exe too.
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
