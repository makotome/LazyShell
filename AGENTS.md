# Repository Guidelines

## 工作前必读
- 每次开始新任务前，先读 `README.md`。
- 再读 `docs/` 下所有文件名包含 `plan` 的文档；当前必须读 `docs/plan.md`。
- 读完上述文档后，再按任务范围补读相关代码，不要跳过文档直接修改实现。
- 如果任务只涉及局部模块，后续阅读聚焦该模块相关文件，不要求每次通读全仓库。

## 项目用途
LazyShell 是一个桌面端运维工作台。用户通过 AI、SSH 终端、命令卡片和远程文件浏览器管理服务器。仓库当前体现的是单一桌面应用，不是 Web 公共站点，也不是独立管理后台。

## 当前技术栈
- 前端：React 19、TypeScript、Vite
- 桌面壳：Tauri 2
- 后端：Rust
- 终端：xterm.js
- 远程连接：`ssh2`
- 编辑器：CodeMirror 6
- 前端校验：ESLint

## 重要目录说明
- `src/`：前端主代码。
- `src/components/`：界面组件，包括 `AIChat.tsx`、`Terminal.tsx`、`RemoteFileManager.tsx`、`FileEditorWindow.tsx`。
- `src/hooks/`：前端复用逻辑，如命令库、聊天记忆。
- `src/utils/`：窗口路由、多窗口辅助逻辑。
- `src/types/index.ts`：前端共享类型。
- `src-tauri/src/commands.rs`：Tauri 命令入口，含 SSH、文件操作、状态查询。
- `src-tauri/src/ssh.rs`：SSH / PTY / shell 底层实现。
- `src-tauri/src/ai.rs`：AI orchestrator 与探测逻辑。
- `src-tauri/src/learning.rs`：执行反馈、长期记忆、服务器环境画像。
- `src-tauri/src/memory.rs`：聊天历史、命令历史、命令卡片持久化。
- `src-tauri/capabilities/`、`src-tauri/tauri.conf.json`：窗口和权限配置。

## 仓库中已体现的编码规范
- React 组件文件用 PascalCase，如 `AIChat.tsx`。
- hooks / 工具函数文件用 camelCase，如 `useMemory.ts`、`remoteWindows.ts`。
- Rust 模块、函数用 `snake_case`，结构体用 `CamelCase`。
- 前端已启用 ESLint；提交前至少跑 `npm run lint`。
- 共享类型优先收敛到 `src/types/index.ts`，不要在组件内重复定义相同结构。
- 前端负责展示和交互；AI 学习、记忆、环境画像、SSH 相关逻辑优先放 Rust 后端。

## 验证运行方法
- 安装依赖：`npm install`
- 前端构建：`npm run build`
- 前端校验：`npm run lint`
- 本地桌面开发：`npm run tauri:dev`
- Rust 测试：`cargo test --manifest-path src-tauri/Cargo.toml`
- 打包应用：`npm run tauri:build`

修改 `src-tauri/capabilities/` 或 `src-tauri/tauri.conf.json` 后，必须重启 `tauri dev`，热更新不够。

做代码修改前，先判断改动范围：
- 只改前端：至少跑 `npm run build`，必要时再跑 `npm run lint`
- 只改 Rust / Tauri：至少跑 `cargo test --manifest-path src-tauri/Cargo.toml`
- 同时改前后端：两者都跑
- 只改文档：可以不跑构建，但需要在说明里明确未执行验证

## 无明确指令不得修改的内容
- `src-tauri/capabilities/default.json` 中已有权限项。
- `src-tauri/tauri.conf.json` 中窗口与应用配置。
- `src-tauri/src/crypto.rs` 的加密/解锁逻辑。
- `src-tauri/src/memory.rs`、`src-tauri/src/learning.rs` 的持久化数据结构字段名，除非同时做兼容迁移。
- 已有 SSH / PTY 交互行为，除非问题已复现并确认修复方案不会污染终端体验。
- `README.md`、`docs/plan.md`、`AGENTS.md` 的职责边界，除非本次任务明确要求调整文档分工。
- 不要把 roadmap、架构分析或阶段计划重新堆回 `README.md`。

## 边界划分
- 本仓库当前没有独立“公共端 / 管理端”划分，只有一个桌面应用。
- 前端边界：窗口、面板、输入、展示，不承担核心 AI 学习决策。
- 后端边界：SSH、AI orchestration、执行反馈、记忆、环境画像、本地持久化。
- 远端服务器边界：探测和执行只应通过现有 SSH/Tauri 命令链路进入，不要在前端伪造服务器状态。
- 文档边界：`README.md` 负责简介、安装、使用；`docs/plan.md` 负责分析、计划、演进记录；`AGENTS.md` 负责协作者执行规则。

## 文档优先级与冲突处理
- 使用说明以 `README.md` 为准。
- 演进方向、架构判断和阶段计划以 `docs/plan.md` 为准。
- 协作和修改规则以 `AGENTS.md` 为准。
- 如果文档与代码现状不一致，先以代码为事实来源，再在工作说明中指出差异。
- 无明确指令，不要顺手改写 `docs/plan.md` 中的产品判断和路线结论。

## 提交约定
- 现有提交信息以简短中文动词句为主，例如 `修改说明文档`、`增加可视化浏览器和编辑器功能`。
- 保持单次提交聚焦一个主题；UI 改动在说明里写清受影响区域和验证命令。
