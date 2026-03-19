# LazyShell - AI Enhanced Server Management Terminal

## 技术栈

- **前端**: React 19 + TypeScript + Vite
- **后端**: Rust + Tauri 2.x
- **SSH**: ssh2 crate
- **加密**: aes-gcm + pbkdf2
- **AI Provider**: 前端抽象层，支持 MiniMax / OpenAI / Anthropic

## 开发命令

```bash
npm run tauri:dev    # 开发模式
npm run tauri:build  # 生产构建
```

## 已实现功能

### 核心功能
- [x] 自然语言转 Linux 命令（AIChat 3层查询：本地DB -> 学习数据 -> AI Provider）
- [x] SSH 连接管理（密码/私钥认证）
- [x] 服务器配置加密存储（AES-256-GCM + PBKDF2）
- [x] 命令预览确认 + 危险命令二次确认
- [x] 多标签页服务器管理
- [x] 服务器状态监控（磁盘、内存、网络）
- [x] 欢迎横幅（服务器系统信息）
- [x] 命令历史提示符显示

### 终端体验
- [x] 交互式终端（InteractiveTerminal）
- [x] 样式化提示符 `username@hostname:path$`
- [x] 命令历史导航（上下箭头）
- [x] Tab 命令补全
- [x] Ctrl+C/V 支持
- [x] macOS Terminal 颜色风格

### AI 功能
- [x] 多 Provider 支持（MiniMax / OpenAI / Anthropic）
- [x] Provider 运行时切换
- [x] 上下文注入（当前目录 + 最近10条命令 + 会话状态）
- [x] 命令学习功能（自然语言 -> 命令映射持久化）

### 安全
- [x] Master Password 保护
- [x] 服务器配置加密存储
- [x] 危险命令检测（rm -rf, shutdown, dd, mkfs 等）

### 内置命令数据库
- [x] 50+ Linux 命令
- [x] 分类：file, text, system, network, process, archive, disk, package
- [x] 每个命令包含：描述、参数、示例、使用场景

## 待开发功能

### 高优先级
- [ ] 命令执行结果持久化（当前重启后丢失）
- [ ] 跨会话命令历史
- [ ] 服务器分组/标签管理
- [ ] 批量命令执行
- [ ] SSH 会话保持（当前每命令新建连接）

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

## 关键文件

| 文件 | 描述 |
|------|------|
| `src-tauri/src/ssh.rs` | SSH 连接和命令执行 |
| `src-tauri/src/crypto.rs` | AES-GCM 加密存储 |
| `src-tauri/src/commands.rs` | Tauri IPC 命令 |
| `src-tauri/src/ai.rs` | AI API 代理 |
| `src-tauri/src/learning.rs` | 命令学习数据 |
| `src-tauri/src/commands_db.rs` | 内置命令数据库 |
| `src/providers/aiProvider.ts` | AI Provider 抽象层 |
| `src/components/AIChat.tsx` | AI 对话面板 |
| `src/components/InteractiveTerminal.tsx` | 交互式终端 |
| `src/components/ServerList.tsx` | 服务器列表 |
| `src/components/ServerStatus.tsx` | 服务器状态监控 |
| `src/components/TabBar.tsx` | 标签页管理 |
| `src/components/Settings.tsx` | 设置面板 |
| `src/components/UnlockScreen.tsx` | 解锁屏幕 |

## 命令预览确认机制

所有命令执行前必须用户确认。危险命令列表：
- `rm -rf`
- `shutdown` / `reboot`
- `dd` / `mkfs`
- `> /dev/sda*`
- Fork bomb 等

## AI Provider 配置

支持配置多个 Provider，运行时可切换。上下文注入：
- 当前工作目录
- 最近 10 条命令及输出
- 当前会话状态
