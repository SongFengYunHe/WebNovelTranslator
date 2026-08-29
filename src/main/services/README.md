# services（主进程服务层）

本目录存放主进程中的后台服务模块，与界面装配（`src/main/main.ts`）解耦：

- `db.ts` — SQLite 翻译历史持久化（better-sqlite3）
- `update.ts` — 自动更新检查（electron-updater）
- `offline.ts` — 离线翻译引擎（transformers.js，按需加载）
- `glossary.ts` — 术语表持久化（JSON 文件）
- `epub.ts` — EPUB 导出（epub-gen）

相关目录：
- `../` — 主进程装配层（main / ipc-handlers / preload / settings / state / logger 等）
