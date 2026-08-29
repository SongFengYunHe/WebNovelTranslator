# 浮空网文翻译器 (Floating Web Novel Translator)

### 写在最前面：由于我脑抽，错误的删除了之前账号（0000110000）的2FA回复密码，只得重新注册...

一个常驻系统托盘的网文翻译小工具，基于 **Electron + React + TypeScript** 构建。

在浏览器里选中外文小说段落，按下全局快捷键 `Ctrl+Shift+Z`（或点击托盘图标），即可打开翻译窗口获得即时翻译；也可以整章提取、对照阅读、导出 EPUB 电子书。所有 API 密钥在主进程中加密存储，绝不暴露给界面。

> ⚠️ **未签名应用提示**：当前安装包未进行代码签名，Windows SmartScreen 可能弹出蓝色提示。请点击 **“更多信息” → “仍要运行”** 即可正常使用。介意的话可自行在本地对安装包签名。

---

## ✨ 功能特性

- **托盘 + 快捷键交互**（v3.0.1）：应用常驻系统托盘，托盘菜单提供“显示 / 隐藏面板”与“退出”；按全局快捷键即可唤起无边框翻译窗口（非置顶悬浮，点击窗口外部自动收起）。
- **全局划词翻译**：在任意程序中选中文字，按 `Ctrl+Shift+Z`（可在设置中修改），自动复制、翻译并在弹出窗口中显示结果。
- **浏览器标签页**：内置网页浏览器，输入章节网址即可提取正文，一键发送到翻译器。
- **术语表（Glossary）**：管理自定义术语对，翻译时自动注入提示词，人名、设定词不再翻错。
- **翻译历史**：基于 SQLite 本地存储，支持全文搜索、分页浏览、查看原文/译文、重新翻译、导出 CSV / JSON、一键清空。
- **EPUB 导出**：把当前译文（原文+译文对照）导出为 EPUB 电子书。
- **离线翻译（可选）**：启用后可下载约 600MB 的 `Xenova/nllb-200-distilled-600M` 多语言模型（transformers.js），下载完成后断网也能翻译（中/英/日/韩）。
- **国产 API 预设**：内置 DeepSeek、Kimi（Moonshot）一键配置，也支持任意 OpenAI 兼容接口（OpenAI、Azure、Groq、Ollama 等）。
- **自动更新检查**：启动时检查新版本（仅提示，不自动下载），托盘与设置页也可手动检查。
- **中文界面（默认）**：默认简体中文，可在设置中切换中/英文。
- **窗口记忆**：记住主窗口的位置、大小，下次启动自动还原。
- **干净退出**：退出时销毁所有窗口、关闭数据库、注销全局快捷键，不留后台进程。

---

## 📥 安装

1. 从 [Releases 页面]下载最新版：
   - `WebNovelTranslator-Setup-<版本号>.exe` —— 安装版（推荐，可自定义安装目录、创建桌面快捷方式）
   - `WebNovelTranslator-<版本号>-portable.exe` —— 免安装便携版
2. 双击运行。若出现 SmartScreen 提示，点击 **更多信息 → 仍要运行**。
3. 首次启动请在 **设置** 页配置 API 密钥（或开启离线翻译），即可开始使用。

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
- **离线翻译**：勾选“启用离线翻译”，按提示下载模型（约 600MB，仅一次）；下载完成后翻译工具栏会显示 📴 离线标识。
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

# 4. 打包安装版 + 便携版（输出到 release/）
npm run dist
```

> 国内网络提示：electron 二进制与 electron-builder 工具请使用 npmmirror 镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

### 关于体积

为将安装包控制在 **80 MB 以内**，打包时**未包含离线翻译引擎**（`@xenova/transformers` 及其运行时，约 130MB）。因此发行版中“离线翻译”功能会提示引擎未包含；如需在开发版中体验离线翻译，请使用 `npm start` 直接运行（此时引擎位于 `node_modules`，功能完整可用）。模型本体始终按需下载到用户数据目录，不占用安装包体积。

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

- **Install**: download the `.exe` from the [Releases](https://github.com/0000110000/floating_translator/releases) page.
- **Unsigned-app note**: SmartScreen may warn; click **More info → Run anyway**.
- **Offline mode**: only bundled in dev builds (`npm start`) to keep the installer under 80 MB; the ~600 MB model is always downloaded on demand.
- **Build**: `npm install && npm start` / `npm run dist`.

---

## 📄 License

MIT
