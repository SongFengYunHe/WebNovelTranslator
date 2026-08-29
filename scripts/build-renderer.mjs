/**
 * Bundles the React renderer with esbuild.
 * Outputs:
 *   dist/renderer/renderer.js  - main panel app (the only renderer since the
 *                                floating bubble was removed in v3.0.0)
 */
import { build } from 'esbuild';

const common = {
  bundle: true,
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
  minify: true,
  // Dead-code elimination (tree-shaking) for unused imports/exports.
  treeShaking: true,
  // Only minified output in the bundle — no source/legal comments.
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
