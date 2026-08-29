# services（渲染进程服务层）

本目录存放渲染进程中与主进程交互的服务封装：

- `api.ts` — 对 `window.electronAPI` 的薄封装，所有 IPC 调用统一经过这里。

> 说明：提示词构建（`src/shared/prompt-builder.ts`）同时被主进程与渲染进程复用，
> 因此保留在 `src/shared/` 下，不随渲染进程专用服务移动。

相关目录：
- `../hooks/` — 自定义 React Hooks
- `../contexts/` — 全局上下文
