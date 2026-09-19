/**
 * 「离线版」打包配置：在标准版基础上额外分发离线推理引擎。
 *
 * 与标准版的差异只有三处：
 *   1. 不再排除引擎包，一并打入 app.asar；
 *   2. 裁掉引擎包中与 Windows x64 运行无关的部分（名单见 scripts/packaging-shared.js）；
 *   3. 产物名带 -Offline，输出到 release-offline/，可与标准版同时构建、对比体积。
 *
 * appId 与 productName 刻意与标准版保持一致，因此：
 *   - 两个版本共用同一份设置、术语表与历史记录（userData 目录相同）；
 *   - 先装标准版再装离线版等于覆盖升级，反之亦然。
 * 也就是说：**两个安装包二选一，不要同时安装。** 这是有意为之——分成两个
 * appId 会让用户换版本时丢掉全部数据。
 */
const base = require('./electron-builder.config.js');
const {
  RUNTIME_ENGINE_PACKAGES,
  RUNTIME_ENGINE_EXCLUDES,
} = require('./scripts/packaging-shared.js');

/** 标准版 files 中针对引擎包的排除项，离线版要把它们换成包含项。 */
const engineExclusions = new Set(RUNTIME_ENGINE_PACKAGES.map((p) => `!${p}/**`));

module.exports = {
  ...base,

  // 独立输出目录，便于与标准版并存，也便于对比两者体积。
  directories: { ...base.directories, output: 'release-offline' },

  // 顺序有意义：先继承标准版的通用规则与包含项，再补上引擎包，最后叠加裁减项。
  files: [
    ...base.files.filter((p) => !engineExclusions.has(p)),
    ...RUNTIME_ENGINE_PACKAGES.map((p) => `${p}/**`),
    ...RUNTIME_ENGINE_EXCLUDES,
  ],

  asarUnpack: [
    ...base.asarUnpack,
    // 原生 .node / .dll 无法从 asar 内加载，必须解包。
    'node_modules/onnxruntime-node/bin/**',
    // sharp 的预编译二进制同理。
    'node_modules/@img/**',
    // `@xenova/transformers` 是 ESM 包（type: module，main 指向 src/transformers.js），
    // 而 Node 的 ESM 加载器不经过 Electron 的 asar 补丁——留在 asar 内会导致
    // `import('@xenova/transformers')` 直接失败。必须解包成真实文件。
    // `@huggingface/jinja` 同为 type: module，一并解包（体积可忽略）。
    'node_modules/@xenova/transformers/**',
    'node_modules/@huggingface/jinja/**',
  ],

  nsis: {
    ...base.nsis,
    artifactName: '${productName}-Offline-Setup-${version}.${ext}',
  },

  portable: {
    ...base.portable,
    artifactName: '${productName}-Offline-${version}-portable.${ext}',
  },
};