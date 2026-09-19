/**
 * 构建前清理脚本。
 *
 * 默认只清理编译产物（dist / .cache）。也可以显式传入目录，例如
 * `node scripts/clean.mjs release-offline`，让两种安装包各自清理自己的输出
 * 目录——否则构建离线版时会把标准版的产物一并删掉，一次会话里就无法同时
 * 产出两个版本的安装包。
 */
import fs from 'fs';

const args = process.argv.slice(2);
const targets = args.length > 0 ? args : ['dist', '.cache'];

for (const dir of targets) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] removed ${dir}`);
}