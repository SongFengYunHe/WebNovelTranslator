# 浮空网文翻译器 (Floating Web Novel Translator)

一个常驻系统托盘的网文翻译小工具，基于 **Electron + React + TypeScript** 构建。

在浏览器里选中外文小说段落，按下全局快捷键 `Ctrl+Shift+Z`（或点击托盘图标），即可打开翻译窗口获得即时翻译；也可以整章提取、对照阅读、导出 EPUB 电子书。所有 API 密钥在主进程中加密存储，绝不暴露给界面。

> ⚠️ **未签名应用提示**：当前安装包未进行代码签名，Windows SmartScreen 可能弹出蓝色提示。请点击 **“更多信息” → “仍要运行”** 即可正常使用。介意的话可自行在本地对安装包签名。

---

## ✨ 功能特性

- **托盘 + 快捷键交互**：应用常驻系统托盘，托盘菜单提供“显示 / 隐藏面板”与“退出”；按全局快捷键即可唤起无边框翻译窗口。窗口**不会**因失焦自动隐藏，收起请点右上角 **✕** 或使用托盘菜单。
- **全局划词翻译**：在任意程序中选中文字，按 `Ctrl+Shift+Z`（可在设置中修改），自动复制、翻译并在弹出窗口中显示结果。
- **浏览器标签页**：内置网页浏览器，输入章节网址即可提取正文，一键发送到翻译器。
- **术语表（Glossary）**：管理自定义术语对，翻译时自动注入提示词，人名、设定词不再翻错。
- **翻译历史**：基于 SQLite 本地存储，支持全文搜索、分页浏览、查看原文/译文、重新翻译、导出 CSV / JSON、一键清空。
- **EPUB 导出**：把当前译文（原文+译文对照）导出为 EPUB 电子书。
- **离线翻译（仅开发版）**：启用后可下载约 870MB 的 `Xenova/nllb-200-distilled-600M` 多语言模型（transformers.js），下载完成后断网也能翻译（中/英/日/韩）。发行版为控制体积未打包推理引擎，设置页会直接禁用该开关并说明原因，不会引导下载。
- **国产 API 预设**：内置 DeepSeek、Kimi（Moonshot）一键配置，也支持任意 OpenAI 兼容接口（OpenAI、Azure、Groq、Ollama 等）。
- **自动更新检查**：启动时检查新版本（仅提示，不自动下载），托盘与设置页也可手动检查。
- **中文界面（默认）**：默认简体中文，可在设置中切换中/英文。
- **窗口记忆**：记住主窗口的位置、大小，下次启动自动还原。
- **干净退出**：退出时销毁所有窗口、关闭数据库、注销全局快捷键，不留后台进程。

---

## 📥 安装

从 [Releases 页面](https://github.com/SongFengYunHe/WebNovelTranslator/releases) 下载。每个版本提供 **两种安装形态 × 两个版本**，**任选一个文件**即可：

| 文件 | 版本 | 形态 | 体积 |
| --- | --- | --- | --- |
| `WebNovelTranslator-Setup-<版本号>.exe` | 标准版 | 安装版（可自定义目录、建桌面快捷方式） | 约 71 MB |
| `WebNovelTranslator-<版本号>-portable.exe` | 标准版 | 免安装便携版 | 约 71 MB |
| `WebNovelTranslator-Offline-Setup-<版本号>.exe` | **离线版** | 安装版 | 约 84 MB |
| `WebNovelTranslator-Offline-<版本号>-portable.exe` | **离线版** | 免安装便携版 | 约 84 MB |

1. 双击运行。若出现 SmartScreen 提示，点击 **更多信息 → 仍要运行**（安装包未做代码签名）。
2. 首次启动请在 **设置** 页配置 API 密钥，即可开始使用。

### 标准版 vs 离线版：该下哪个？

| 能力 | 标准版 | 离线版 |
| --- | --- | --- |
| 在线翻译（DeepSeek / Kimi / 任意 OpenAI 兼容接口） | ✅ | ✅ |
| 术语表 / 翻译历史 / EPUB 导出 / 划词翻译 / 浏览器提取 | ✅ | ✅ |
| **离线翻译** | ❌ 设置页会明确禁用该开关并说明原因 | ✅ 需先联网下载约 870 MB 模型，之后断网也能翻译 |

- **能用网络调 API 翻译，就下标准版**——更小，功能完全够用。
- **经常断网、或在无网络设备上使用，才下离线版**。注意离线版**仍然需要联网一次**下载模型本体。
- ⚠️ **两个版本二选一，不要同时安装。** 二者是同一个应用（相同 appId），共用同一套设置、术语表与历史记录：
  - 从标准版换成离线版（或反之）**直接覆盖安装即可，数据不会丢失**；
  - 同时装两个只会互相覆盖，没有意义。

> 不确定就先装标准版——之后想换离线版，下对应的安装包覆盖安装就行。

---

## 🚀 使用指南

| 操作 | 方法 |
| --- | --- |
| 翻译一段文字 | 把文字粘贴到“翻译”页，选择语言，点击 **翻译** |
| 翻译浏览器里的章节 | “浏览器”页输入网址 → 打开 → **提取文本** → **发送到翻译器** |
| 全局划词翻译 | 在任意程序中选中文字 → 按 `Ctrl+Shift+Z` |
| 打开 / 收起翻译窗口 | 按全局快捷键，或点击托盘图标 → **显示 / 隐藏面板**；点击窗口右上角 **✕** 收起 |
| 导出 EPUB | 翻译完成后点击 **导出 EPUB**，或到“历史”页查看详情后导出 |

### 设置项说明

- **服务商**：选择预设（DeepSeek / Kimi）自动填充接口地址与模型，或选“自定义”手动填写。
- **API 密钥**：在主进程中加密存储，界面永不回显。
- **基础地址 / 模型**：任意 OpenAI 兼容端点，例如 `https://api.openai.com/v1` + `gpt-4o`、`https://api.deepseek.com/v1` + `deepseek-chat`、`https://api.moonshot.cn/v1` + `moonshot-v1-8k`。
- **全局快捷键**：点击输入框后按下新的组合键即可录制，保存后立即生效。
- **离线翻译**：勾选“启用离线翻译”，按提示下载模型（约 870MB，仅一次）；下载完成后翻译工具栏会显示 📴 离线标识。该开关仅在包含推理引擎的开发版中可用。
- **界面语言**：中文 / English。

### 术语表

在“术语表”页新建术语表 → 添加 `源术语 → 目标术语` 条目 → 保存并设为当前术语表。之后每条翻译都会把术语表注入提示词；离线翻译则通过字符串替换应用术语表。术语表是核心功能：翻译页工具栏即可直接切换当前术语表，无需离开翻译界面。

### 翻译历史

每次成功的翻译都会自动存入历史。可在“历史”页搜索、分页、查看详情、重新翻译、导出 CSV / JSON，或清空全部记录。

---

## 🔧 从源码构建

环境要求：Node.js 20+，npm。

```bash
# 1. 安装依赖（本机若无法访问 GitHub，请先配置 npmmirror 镜像）
npm install

# 2. 开发运行
npm start

# 3. 仅构建（主进程 tsc + 渲染进程 esbuild）
npm run build

# 4. 打包「标准版」安装包 + 便携版（输出到 release/）
npm run dist

# 5. 打包「离线版」安装包 + 便携版（含本地推理引擎，输出到 release-offline/）
npm run dist:offline
```

> 两个版本**各自清理自己的输出目录**（`release/` 与 `release-offline/`），
> 因此可以在同一次会话里依次构建，互不覆盖。

> 国内网络提示：electron 二进制与 electron-builder 工具请使用 npmmirror 镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
> 离线模型默认从 `huggingface.co` 拉取；若该域名不可达，可用环境变量
> `WNT_HF_HOST=https://hf-mirror.com` 指定镜像站。

### 关于体积

| 产物 | 体积 | 说明 |
| --- | --- | --- |
| `WebNovelTranslator-Setup-*.exe` | 约 71 MB | 标准版，不含推理引擎 |
| `WebNovelTranslator-Offline-Setup-*.exe` | 约 84 MB | 离线版，含推理引擎 |

标准版为控制体积**不分发离线推理引擎**（`@xenova/transformers` 及其运行时），
所以安装包里的「离线翻译」开关会被明确禁用并说明原因，**不会引导用户下载 870 MB
模型**——下了也没法用。

离线版把引擎打进包里，代价只有 **约 13 MB**：打包时会裁掉引擎中与 Windows x64
运行无关的部分（浏览器端产物、非 Windows 平台二进制、浏览器 WASM 后端，合计约
163 MB，名单见 `scripts/packaging-shared.js`）。每一项裁减都经过实测——全部裁掉后
`import('@xenova/transformers')` 与 `onnxruntime-node` 的 `InferenceSession`
仍可正常加载。

模型本体（约 870 MB）在两个版本里都始终按需下载到用户数据目录，不占用安装包体积。

---

## 🤝 贡献

欢迎提交 Issue 与 Pull Request。完整的开发约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，目录结构、命名规范、提交信息与发布规范都在其中。

### 贡献指南（提交信息规范）

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- 格式：`<type>(<scope>): <description>`
- 常用 type：`feat` / `fix` / `chore` / `docs` / `style` / `refactor` / `perf` / `test`
- scope 可选但推荐（如 `bubble`、`settings`、`history`）
- 描述简明，中文或英文均可，保持统一

示例：`feat(translator): 增加离线翻译支持`、`fix(bubble): 修复悬浮球拖出屏幕的问题`

> 发布（GitHub Releases）请使用 Tag `vX.Y.Z` + 标题 `vX.Y.Z - 简短中文描述`，
> 发布说明按 **新功能 / 修复 / 优化 / 已知问题** 编写，模板见 [`RELEASE_TEMPLATE.md`](./RELEASE_TEMPLATE.md)。

### 开发约定

- 主进程逻辑全部放在 `src/main/`（后台服务在 `src/main/services/`），渲染进程 UI 在 `src/renderer/`，共享类型/提示词构建在 `src/shared/`。
- 所有新的用户可见文案必须同时加入 `src/renderer/i18n/zh.ts` 与 `en.ts`（键保持一致）。
- 错误处理统一使用 `electron-log` 记录到 `<userData>/logs/main.log`。

---

## English

**Floating Web Novel Translator** — a tray-driven web-novel translator built with Electron + React (v3.0.0).

Key features: system-tray + global-hotkey interaction (Ctrl+Shift+Z) that opens a stable frameless popup window, glossary as a first-class feature (switch the active glossary right from the translate toolbar), built-in chapter extractor, SQLite translation history (search / export CSV·JSON), EPUB export, optional offline translation via `transformers.js` (NLLB-200), presets for DeepSeek / Kimi (Moonshot), auto-update check, Chinese (default) / English UI, window-state persistence, and clean exit with no lingering processes.

- **Install**: download the `.exe` from the [Releases](https://github.com/SongFengYunHe/WebNovelTranslator/releases) page.
- **Unsigned-app note**: SmartScreen may warn; click **More info → Run anyway**.
- **Offline mode**: dev builds only (`npm start`) — release installers exclude the inference engine to stay under 80 MB, and the Settings page disables the toggle and says so rather than offering a download it cannot use. The ~870 MB model is always fetched on demand.
- **Build**: `npm install && npm start` / `npm run dist`.

---

## 📄 License

MIT
