/**
 * 打包配置的共用常量。
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

module.exports = { RUNTIME_ENGINE_PACKAGES, RUNTIME_ENGINE_EXCLUDES };