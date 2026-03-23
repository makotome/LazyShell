# LazyShell

AI Enhanced Server Management Terminal - 使用自然语言管理远程服务器。

## 简介

LazyShell 是一个基于 Tauri + React 的桌面应用，将自然语言转换为 Linux 命令，通过 SSH 管理远程服务器。支持密码和私钥认证，配置加密存储，命令预览确认保障安全。

**核心特性**：AI 智能转换、多服务器管理、交互式终端、安全加密

## 技术栈

- **前端**: React 19 + TypeScript + Vite
- **后端**: Rust + Tauri 2.x
- **SSH**: ssh2 crate
- **加密**: AES-256-GCM + PBKDF2
- **AI**: 支持 MiniMax / OpenAI / Anthropic

## 已实现功能

### AI 智能助手
- 自然语言转 Linux 命令（3层查询：本地命令库 → 学习数据 → AI Provider）
- 多 AI Provider 支持，运行时可切换
- 上下文感知（注入当前目录、最近命令、会话状态）
- 命令学习：自然语言与命令映射持久化

### 服务器管理
- SSH 连接管理（密码/私钥认证）
- 多标签页服务器管理
- 服务器状态监控（磁盘、内存、网络）
- 欢迎横幅显示系统信息

### 终端体验
- 交互式终端，样式化提示符 `username@hostname:path$`
- 命令历史导航（上下箭头）
- Tab 命令补全
- Ctrl+C/V 支持
- macOS Terminal 颜色风格

### 安全
- Master Password 保护
- 服务器配置 AES-256-GCM + PBKDF2 加密存储
- 命令预览确认
- 危险命令二次确认（rm -rf, shutdown, dd, mkfs 等）

### 内置命令数据库
- 50+ Linux 命令
- 分类：file, text, system, network, process, archive, disk, package
- 每个命令包含描述、参数、示例、使用场景

## 开发中功能

### 高优先级
- [ ] 命令执行结果持久化
- [ ] 跨会话命令历史
- [ ] 服务器分组/标签管理
- [ ] 批量命令执行
- [ ] SSH 会话保持

### 中优先级
- [ ] 命令输出搜索/过滤
- [ ] 快捷命令/命令别名
- [ ] 多主机同时执行
- [ ] 命令输出导出
- [ ] 深色/浅色主题切换

### 低优先级
- [ ] 命令执行超时设置
- [ ] 自定义提示符格式
- [ ] 命令执行计划任务
- [ ] 服务器监控告警规则

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri:dev

# 生产构建
npm run tauri:build
```

## 项目结构

```
LazyShell
├── src/                      # React 前端
│   ├── components/           # UI 组件
│   ├── providers/            # AI Provider 抽象
│   └── ...
├── src-tauri/                # Rust 后端
│   └── src/
│       ├── ssh.rs            # SSH 连接和命令执行
│       ├── crypto.rs         # 加密存储
│       ├── ai.rs             # AI API 代理
│       ├── learning.rs       # 命令学习数据
│       ├── commands_db.rs    # 内置命令数据库
│       └── commands.rs       # Tauri IPC 命令
└── ...
```