# 贡献指南（Contributing Guide）

感谢你参与 **浮空网文翻译器**（Floating Web Novel Translator）的开发！请遵循以下约定，让协作更顺畅。

## 目录结构

```
src/
├── main/               # 主进程装配层（窗口、托盘、IPC、生命周期）
│   └── services/       # 主进程后台服务（数据库、更新、离线引擎、EPUB…）
├── renderer/           # 渲染进程 UI
│   ├── components/     # 组件（kebab-case 命名）
│   ├── contexts/       # 全局上下文
│   ├── hooks/          # 自定义 React Hooks
│   ├── services/       # API 服务封装
│   └── styles/         # 样式
└── shared/             # 主进程 / 渲染进程共享的类型与工具
    └── i18n/           # 中英文文案（主进程与渲染进程共用）
```

### 文件命名约定

- 所有组件、工具、服务文件统一使用 **kebab-case**（短横线小写），例如 `floating-bubble.tsx`、`ipc-handlers.ts`。
- 目录名同样使用 kebab-case。

### 其他约定

- 所有新的用户可见文案必须同时加入 `src/shared/i18n/zh.ts` 与 `en.ts`（键保持一致）。
  渲染进程用 `useI18n()`，主进程用 `src/main/i18n.ts` 的 `mt()`；两类前缀分别是
  `main.*`（原生菜单、托盘、对话框、主进程错误）与其余键（界面文案）。
- 错误处理统一使用 `electron-log` 记录到 `<userData>/logs/main.log`，不要在运行时使用 `console.log`。
- 提交前请确保 `npm run build` 通过。

---

## 提交信息规范（Conventional Commits）

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范。

### 格式

```
<type>(<scope>): <description>
```

### Type 类型

| type | 说明 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修复 Bug |
| `chore` | 构建、依赖、杂务等不涉及功能/修复的改动 |
| `docs` | 仅文档改动 |
| `style` | 不影响代码逻辑的格式调整（空格、分号等） |
| `refactor` | 重构（不改变外部行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |

### Scope（可选，但推荐）

用小写英文标明影响范围，例如：`translate`、`offline`、`glossary`、`history`、`settings`、`security`、`db`、`ipc`、`ui`、`i18n`、`packaging`、`update`。

### Description

简明扼要地描述改动，中文或英文均可，但请保持一致。

### 示例

```
feat(translator): 增加离线翻译支持
fix(hotkey): 修复划词取词在部分程序下失效的问题
chore: 升级 electron 至 30.x
docs: 补充 README 构建说明
perf(history): 优化历史列表分页查询
```

---

## 发布命名规范（GitHub Releases）

### Tag

使用语义化版本号 `vX.Y.Z`，例如 `v2.0.1`。

### Release 标题

```
vX.Y.Z - 简短中文描述
```

例如：`v2.0.1 - 修复退出残留进程并清理定时器`

### Release Notes 模板

发布说明请按 **新功能 / 修复 / 优化 / 已知问题** 四段编写，可直接套用仓库根目录的 [`RELEASE_TEMPLATE.md`](./RELEASE_TEMPLATE.md)。
