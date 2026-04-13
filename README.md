# LazyShell

AI Enhanced Server Management Terminal。它是一个本地桌面运维工作台，用 AI、SSH 终端和远程文件浏览器管理服务器。

详细的实现分析、架构判断和后续计划已移到 [docs/plan.md](./docs/plan.md)。贡献约定见 [AGENTS.md](./AGENTS.md)。

## 项目简介

LazyShell 不是 Web 管理面板，而是基于 Tauri 的本地客户端：

- AI 负责理解意图、生成命令和给出解释
- Rust 后端负责 SSH、加密、本地持久化和 AI orchestration
- React 前端负责多标签终端、AI 面板和文件浏览器窗口

当前主要能力：

- 多服务器 SSH 管理
- AI 生成 Linux 命令与解释
- 命令执行前确认与危险命令识别
- 交互式终端
- 独立远程文件浏览器与文本编辑器
- 本地加密保存服务器配置
- 自动执行反馈、长期记忆、服务器环境画像
- OpenClaw 指令速查与相关命令辅助

## 技术栈

- Frontend: React 19, TypeScript, Vite
- Desktop: Tauri 2
- Backend: Rust
- Terminal: xterm.js
- SSH: `ssh2`
- Editor: CodeMirror 6
- Markdown: `react-markdown` + `rehype-sanitize`

## 安装与开发

### 前置要求

- Node.js
- npm
- Rust toolchain
- Tauri 2 本地开发依赖

Rust `Cargo.toml` 当前声明 `rust-version = "1.77.2"`，本地建议使用不低于该版本的稳定版 Rust。

### 安装依赖

```bash
npm install
```

### 本地启动

```bash
npm run tauri:dev
```

### 常用命令

```bash
# 前端构建
npm run build

# 前端校验
npm run lint

# Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml

# 打包桌面应用
npm run tauri:build
```

如果修改了 `src-tauri/capabilities/` 或 `src-tauri/tauri.conf.json`，需要重启 `tauri dev`。

### macOS 自编译应用首次打开

如果是开发者自己本地编译，或从 GitHub Actions 下载未签名的 macOS 构建产物，首次打开时可能被 Gatekeeper 拦截，并提示“已损坏”或无法验证开发者。

可先把 `LazyShell.app` 放到“应用程序”目录，再执行：

```bash
xattr -dr com.apple.quarantine "/Applications/LazyShell.app"
```

执行后再通过 Finder 右键 `LazyShell.app`，选择“打开”。

这只适用于本机开发和测试放行，不等同于正式签名或 notarization 发布。

## 首次使用

1. 启动应用。
2. 首次进入时设置 Master Password。
3. 在设置中添加 AI Provider。
4. 添加服务器并测试 SSH 连接。
5. 打开服务器标签页，开始使用终端、AI 和文件浏览器。

## 使用说明

### 终端

- 每个服务器在主界面以标签页方式打开。
- 终端支持交互输入、历史导航、Tab 补全和链接识别。
- 标题栏可直接打开独立文件浏览器窗口。

### AI 面板

- 支持“只回答”和命令生成类使用方式。
- AI 回复支持安全子集 Markdown。
- 命令卡片可直接执行、复制或继续编辑。
- 后端会自动沉淀执行经验、长期记忆和服务器环境画像，不需要手工上传学习数据。

### 文件浏览器与编辑器

- 文件浏览器为独立窗口。
- 支持目录树、进入目录、返回上一级、刷新、上传、下载。
- 支持右键新建文本文件、新建文件夹、复制文件、重命名、删除。
- 双击文本文件可打开独立编辑器窗口。
- 编辑器当前重点支持 JSON、Shell、YAML 高亮。

## 目录结构

```text
src/                    React 前端
  components/           终端、AI、文件浏览器、编辑器等组件
  hooks/                前端复用逻辑
  utils/                多窗口与路由辅助
  types/                前端共享类型
src-tauri/src/          Rust 后端
  commands.rs           Tauri 命令入口
  ssh.rs                SSH / PTY / shell 实现
  ai.rs                 AI orchestrator 与环境探测
  learning.rs           执行反馈、长期记忆、环境画像
  memory.rs             聊天历史、命令历史、命令卡片
docs/plan.md            项目计划、架构分析、演进记录
```

## 安全说明

- 服务器配置保存在本地并加密存储。
- 应用通过 Master Password 解锁。
- 高危命令会做额外确认。
- 不要把真实 API Key、服务器账号或私钥提交到仓库。

## 当前限制

- PTY 终端的“不可见执行反馈采集”还没有完全打通，当前主学习链以直连执行、状态采集和按需环境探测为主。
- 环境画像中的某些能力识别依赖服务器实际 PATH 和 shell 初始化，探测结果可能与交互终端存在差异。

## 相关文档

- [docs/plan.md](./docs/plan.md): 实现分析、roadmap、架构判断
- [AGENTS.md](./AGENTS.md): 仓库贡献规范
