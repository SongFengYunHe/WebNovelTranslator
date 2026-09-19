/**
 * 打包配置的共用常量与组装函数。
 *
 * 标准版与离线版的唯一差别，就是是否随包分发离线推理引擎。把「引擎包名单」
 * 与「可裁减项名单」集中在这里，两个配置各取所需，避免出现标准版漏排除
 * （安装包白胖 200MB）或离线版漏包含（装上跑不起来）这类不对称错误。
 */

/**
 * 离线推理引擎本体及其加载期必需的传递依赖。
 *
 * 这些不是可选项：`@xenova/transformers` 的入口 `src/transformers.js` 顶层
 * `export * from './utils/image.js'`，而 `image.js` 硬 import `sharp`；
 * `onnx.js` 又同时顶层 import `onnxruntime-node` 与 `onnxruntime-web`。
 * 少任何一个，ESM import 都会直接失败。
 */
const RUNTIME_ENGINE_PACKAGES = [
  'node_modules/@xenova/transformers',
  'node_modules/onnxruntime-node',
  'node_modules/onnxruntime-web',
  'node_modules/onnxruntime-common',
  'node_modules/@huggingface/jinja',
  'node_modules/sharp',
  'node_modules/@img',
];

/**
 * 引擎包内与 Windows x64 运行无关的部分，可在离线版中裁掉。
 *
 * 每一项都经过实测：全部移除后 `import('@xenova/transformers')` 仍可加载，
 * `onnxruntime-node` 的 `InferenceSession` 依然可用。合计约 163MB。
 */
const RUNTIME_ENGINE_EXCLUDES = [
  // 浏览器端打包产物：package.json 的 main 指向 src/transformers.js，用不到
  '!node_modules/@xenova/transformers/dist/**',
  // TypeScript 声明，运行期无用
  '!node_modules/@xenova/transformers/types/**',
  // 只分发 Windows x64，其它平台二进制（darwin 43.3MB / linux 30.4MB / arm64 9.2MB）用不到
  '!node_modules/onnxruntime-node/bin/napi-v3/darwin/**',
  '!node_modules/onnxruntime-node/bin/napi-v3/linux/**',
  '!node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/**',
  // 浏览器 WASM 后端（36.6MB）：Node 下走 onnxruntime-node
  '!node_modules/onnxruntime-web/dist/*.wasm',
];

/**
 * 只被离线引擎用到、标准版可以整包剔除的旁支依赖。
 *
 * 名单不是凭感觉列的，而是从 package-lock.json 的依赖闭包推出来的：
 * 以标准版真正需要的 5 个生产依赖为根
 * （better-sqlite3 / electron-log / electron-store / electron-updater / epub-gen）
 * 求可达集合，凡是「不可达、却落在 @xenova/transformers 闭包里」的顶层包，
 * 就只可能被引擎使用。
 *
 * 注意：`detect-libc` 同时落在两边，因此不在这里。
 */
const ENGINE_SIDE_PACKAGES = [
  'node_modules/@emnapi/runtime',
  'node_modules/@huggingface/jinja',
  'node_modules/@protobufjs',
  'node_modules/color',
  'node_modules/color-convert',
  'node_modules/color-name',
  'node_modules/color-string',
  'node_modules/flatbuffers',
  'node_modules/guid-typescript',
  'node_modules/is-arrayish',
  'node_modules/long',
  'node_modules/onnx-proto',
  'node_modules/platform',
  'node_modules/protobufjs',
  'node_modules/simple-swizzle',
  'node_modules/tslib',
];

/** 两个版本都只需要的运行时内容（不包括 node_modules，它由打包器自行加入）。 */
const BASE_FILES = [
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
];

/**
 * 两个版本都可以裁掉的编译期 / 文档 / 测试产物。
 *
 * 判定标准只有一个：运行时永远不可能被 require/import 到。
 *  - `.coffee` 不能被 Node 直接加载，任何包都不会把它作为入口；
 *  - `deps/`、`src/` 是 better-sqlite3 的编译输入，运行期只加载
 *    `build/Release/better_sqlite3.node`；
 *  - `test/`、`example(s)/`、`benchmark/` 与演示图从不参与运行。
 */
const COMMON_EXCLUDES = [
  // better-sqlite3：9.3MB 的 sqlite3.c/.h 与 C++ 源码只用于编译
  '!node_modules/better-sqlite3/deps/**',
  '!node_modules/better-sqlite3/src/**',
  // epub-gen 根目录的演示图与 CoffeeScript 源码（main 指向 index.js）
  '!node_modules/epub-gen/*.coffee',
  '!node_modules/epub-gen/test.*',
  '!node_modules/epub-gen/demo_preview.png',
  // 通用：测试、示例、基准与 CoffeeScript 源文件
  '!node_modules/**/test/**',
  '!node_modules/**/tests/**',
  '!node_modules/**/__tests__/**',
  '!node_modules/**/example/**',
  '!node_modules/**/examples/**',
  '!node_modules/**/benchmark/**',
  '!node_modules/**/docs/**',
  '!node_modules/**/*.coffee',
];

/**
 * 组装 electron-builder 的 `files` 列表。
 *
 * 由本函数统一产出，两个配置不再各自拼数组——之前靠 `Set` 过滤掉基类里的排除项
 * 再追加引擎包，漏filter一个模式就会让离线版缺文件或标准版带上 200MB。
 */
function buildFiles({ includeEngine }) {
  const files = [...BASE_FILES, ...COMMON_EXCLUDES];
  if (includeEngine) {
    files.push(...RUNTIME_ENGINE_PACKAGES.map((p) => `${p}/**`), ...RUNTIME_ENGINE_EXCLUDES);
  } else {
    files.push(
      ...RUNTIME_ENGINE_PACKAGES.map((p) => `!${p}/**`),
      ...ENGINE_SIDE_PACKAGES.map((p) => `!${p}/**`)
    );
  }
  return files;
}

module.exports = {
  RUNTIME_ENGINE_PACKAGES,
  RUNTIME_ENGINE_EXCLUDES,
  ENGINE_SIDE_PACKAGES,
  COMMON_EXCLUDES,
  buildFiles,
};