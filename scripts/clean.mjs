/**
 * 构建前清理脚本（等效 rimraf dist release .cache）。
 * 使用 Node 内置的 fs.rmSync，避免为清理功能引入额外依赖。
 */
import fs from 'fs';

const targets = ['dist', 'release', '.cache'];

for (const dir of targets) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] removed ${dir}`);
}
