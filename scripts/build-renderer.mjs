/**
 * 使用 esbuild 打包 React 渲染进程。
 * 输出：
 *   dist/renderer/renderer.js  - 主面板应用（自 v3.0.0 移除浮动气泡后
 *                                唯一的渲染进程入口）
 */
import { build } from 'esbuild';

const common = {
  bundle: true,
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
  minify: true,
  // 对未使用的导入/导出做死代码消除（tree-shaking）。
  treeShaking: true,
  // 打包产物中只保留压缩后的输出——不含源码/法律注释。
  legalComments: 'none',
  drop: ['debugger'],
  target: ['chrome120'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/renderer/index.tsx'],
  outfile: 'dist/renderer/renderer.js',
});

console.log('Renderer bundles written to dist/renderer/.');
