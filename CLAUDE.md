# LazyShell - AI Enhanced Server Management Terminal

## 技术栈

- **前端**: React 19 + TypeScript + Vite
- **后端**: Rust + Tauri 2.x
- **终端**: xterm.js ^5.3.0 + xterm-addon-fit + xterm-addon-web-links
- **SSH**: ssh2 crate
- **加密**: aes-gcm + pbkdf2 (100,000 iterations)
- **AI Provider**: 前端抽象层，支持 MiniMax / OpenAI / Anthropic

## 项目结构

```
LazyShell/
├── src/                          # 前端 (React 19 + TypeScript)
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 主组件，状态管理中枢
│   ├── components/               # React 组件
│   │   ├── AIChat.tsx           # AI 对话面板
│   │   ├── Terminal.tsx          # 主终端组件 (xterm.js 顺序轮询 + PersistentShell) ⭐
│   │   ├── PtyTerminal.tsx       # PTY 会话终端组件（未在 App.tsx 使用）
│   │   ├── InteractiveTerminal.tsx
│   │   ├── ServerList.tsx        # 服务器侧边栏
│   │   ├── ServerStatus.tsx      # 服务器监控
│   │   ├── TabBar.tsx            # 标签页管理
│   │   ├── ResizablePanels.tsx   # 可拖拽面板布局 ⭐
│   │   ├── Settings.tsx          # 设置弹窗
│   │   ├── ProviderSelector.tsx  # AI Provider 切换
│   │   ├── AddProviderModal.tsx  # 添加 Provider 弹窗
│   │   └── UnlockScreen.tsx      # Master Password 解锁
│   ├── providers/
│   │   └── aiProvider.ts         # AI Provider 抽象层
│   ├── hooks/
│   │   └── useCommandDatabase.ts # 命令数据库 Hook
│   └── types/
│       └── index.ts              # TypeScript 接口定义
├── src-tauri/                    # 后端 (Rust + Tauri 2.x)
│   └── src/
│       ├── main.rs               # Tauri 入口
│       ├── lib.rs                # 库入口，命令注册
│       ├── commands.rs           # Tauri IPC 命令
│       ├── ssh.rs                # SSH 连接和 PTY 管理
│       ├── ai.rs                 # AI API 代理
│       ├── crypto.rs             # AES-256-GCM 加密
│       ├── commands_db.rs        # 内置命令数据库
│       ├── learning.rs           # 命令学习功能
│       └── commands_db.json       # 命令数据库 JSON
├── docs/superpowers/             # superpowers 工作流文档
│   ├── specs/                   # 设计规格
│   └── plans/                   # 实施计划
└── package.json
```

### 状态管理

使用 React 原生 Hooks，无外部状态管理库：

| 状态类型 | 实现方式 |
|---------|---------|
| 组件本地状态 | useState |
| 回调缓存 | useCallback |
| 计算值 | useMemo |
| 跨组件共享 | 状态提升至 App.tsx，通过 props 传递 |

⚠️ **注意**: 避免深层 props drilling，复杂状态考虑 Context API

## 开发命令

### 前端
```bash
npm run dev          # Vite 开发服务器 (前端热重载)
npm run lint         # ESLint 检查
npm run lint:fix     # ESLint 自动修复
```

### 后端 (Rust)
```bash
cargo check          # 检查 Rust 代码编译
cargo build          # 编译 release 版本
cargo test           # 运行测试
cargo clippy         # Rust linter
```

### Tauri
```bash
npm run tauri:dev    # Tauri 开发模式 (前后端联调)
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

### 内置命令数据库
- [x] 50+ Linux 命令
- [x] 分类：file, text, system, network, process, archive, disk, package
- [x] 每个命令包含：描述、参数、示例、使用场景

## 待开发功能

### 高优先级
- [ ] SSH 会话保持 (已有 PersistentShell，仍为每命令新建连接) ⚠️ 部分实现
- [ ] 命令执行结果持久化（当前重启后丢失）
- [ ] 跨会话命令历史
- [ ] 服务器分组/标签管理
- [ ] 批量命令执行

### 中优先级
- [ ] PTY 会话复用 (当前每标签页新建 SSH 连接)
- [ ] 深色/浅色主题切换
- [ ] 命令输出搜索/过滤
- [ ] 快捷命令/命令别名
- [ ] 多主机同时执行
- [ ] 命令输出导出

### 低优先级
- [ ] SSH 密钥 passphrase 缓存
- [ ] 命令执行超时设置
- [ ] 自定义提示符格式
- [ ] 命令执行计划任务
- [ ] 服务器监控告警规则

## 关键文件

| 文件 | 描述 | 优先级 |
|------|------|--------|
| `src-tauri/src/ssh.rs` | SSH 连接和 PTY 管理 | ⭐⭐⭐ |
| `src-tauri/src/crypto.rs` | AES-256-GCM 加密存储 | ⭐⭐⭐ |
| `src-tauri/src/commands.rs` | Tauri IPC 命令，危险命令检测 | ⭐⭐⭐ |
| `src-tauri/src/ai.rs` | AI API 代理 | ⭐⭐ |
| `src-tauri/src/learning.rs` | 命令学习数据 | ⭐⭐ |
| `src-tauri/src/commands_db.rs` | 内置命令数据库 | ⭐ |
| `src/components/Terminal.tsx` | xterm.js 主终端组件（顺序轮询 + PersistentShell） | ⭐⭐⭐ |
| `src/components/PtyTerminal.tsx` | PTY 会话终端（未在 App.tsx 使用） | ⭐⭐ |
| `src/components/InteractiveTerminal.tsx` | 交互式终端 | ⭐⭐ |
| `src/components/AIChat.tsx` | AI 对话面板 | ⭐⭐ |
| `src/components/ServerList.tsx` | 服务器列表 | ⭐⭐ |
| `src/components/TabBar.tsx` | 标签页管理 | ⭐⭐ |
| `src/components/ResizablePanels.tsx` | 可拖拽面板布局 | ⭐⭐ |
| `src/providers/aiProvider.ts` | AI Provider 抽象层 | ⭐⭐ |
| `src/hooks/useCommandDatabase.ts` | 命令数据库 Hook | ⭐ |
| `src/types/index.ts` | TypeScript 类型定义 | ⭐⭐ |

## 安全实现

| 组件 | 文件 | 说明 |
|------|------|------|
| Master Password | App.tsx | 用户主密码，会话期间驻留内存 |
| 配置加密 | `src-tauri/src/crypto.rs` | AES-256-GCM 加密 |
| 密钥派生 | PBKDF2 | 100,000 iterations |
| 加密数据 | 服务器密码、私钥 | 存储于本地配置 |

### 危险命令检测
- 位置: `src-tauri/src/commands.rs`
- 触发: 执行 `rm -rf`, `shutdown`, `dd`, `mkfs` 等高危命令时二次确认

## 重要架构决策

### PTY vs 非 PTY 终端

| 方案 | 组件 | 适用场景 |
|------|------|---------|
| PersistentShell (顺序轮询) | Terminal.tsx | 主终端，支持 vim/nano 等交互式命令 |
| PTY (持久会话) | PtyTerminal.tsx | 独立 PTY 通道（当前未在 App.tsx 中使用） |

当前实现: App.tsx 使用 Terminal.tsx → `shell_input`/`shell_output` → `PersistentShell`
PtyTerminal.tsx 使用独立的 `pty_input`/`pty_output` → `SSHConnection` 交互式通道

### AI Provider 上下文注入

注入内容:
1. 当前工作目录
2. 最近 10 条命令及输出摘要
3. 当前会话状态 (已连接服务器信息)

### 服务器配置加密

- Master Password 用于派生 AES-256-GCM 密钥
- 每服务器配置使用随机 IV 加密
- 私钥文件内容整体加密存储

## 终端配置

### 终端尺寸同步 ⭐ 关键

Terminal.tsx 使用 `xterm.rows` / `xterm.cols`（FitAddon 计算的实际值）同步给后端 PTY。
**不要**使用手动计算的固定字符尺寸，必须以 xterm.js 的实际渲染尺寸为准。

后端 `ssh.rs` 中 `PersistentShell` 和 `SSHConnection` 使用 8x15 像素尺寸计算 PTY 像素参数（仅用于 `request_pty` 的像素维度参数，不影响行列数）。

### 终端轮询架构 ⭐ 关键

Terminal.tsx 使用**顺序 setTimeout 轮询**（非 setInterval）读取 `shell_output`：
- 前一个 poll 完成后才调度下一个，防止并发竞态
- 后端 `shell_output` 持有 `persistent_shells` Mutex 锁完成所有读取，保证原子性
- `has_complete_escape()` 检查缓冲区**末尾**是否有不完整的转义序列

⚠️ **警告**: 绝不要将轮询改回 `setInterval`，会导致 vim 等全屏应用的转义序列乱序，
   表现为向上滚动时行号变化但内容不更新

### xterm.js 组件说明

| 组件 | 用途 | 通信方式 |
|------|------|---------|
| Terminal.tsx | 主终端（vim/nano/交互式命令） | 顺序轮询 shell_output → PersistentShell |
| PtyTerminal.tsx | PTY 会话终端（未在 App.tsx 使用） | 轮询 pty_output → SSHConnection |
| InteractiveTerminal.tsx | 交互式终端 | 命令执行模式 |

### xterm.js 插件
- `xterm@^5.3.0` - 核心终端模拟器
- `xterm-addon-fit@^0.8.0` - 自动适应容器大小
- `xterm-addon-web-links@^0.9.0` - 可点击链接识别

## 编码规范

### TypeScript

**组件规范**:
```typescript
// 1. Props 接口定义在组件上方
interface ComponentProps {
  propA: string;
  propB?: number;
}

// 2. 函数式组件，使用明确的返回类型
export function Component({ propA, propB = 0 }: ComponentProps): JSX.Element {
  // ...
}

// 3. useEffect 必须声明依赖数组
useEffect(() => {
  // ...
}, [depA, depB]);

// 4. 事件处理函数使用 useCallback
const handleClick = useCallback(() => {
  // ...
}, []);
```

**状态管理规范**:
- 优先 useState，复杂状态考虑 useReducer
- 避免超过 3 层 props drilling
- Context 用于跨层级共享的全局状态

### Rust

**错误处理**:
```rust
// 使用 Result<T, Error> 模式
pub fn execute(&mut self, cmd: &str) -> Result<String, SSHError> {
    // ... 实现
}

// 错误转换使用 map_err
self.channel.write(data.as_bytes())
    .map_err(|e| SSHError::IoError(e.to_string()))?;
```

**并发模型**:
- 使用 tokio 异步运行时
- Arc<Mutex<T>> 用于共享可变状态
- 避免在锁内执行耗时操作

**代码组织**:
```
模块顺序:
1. use 声明 (标准库, 外部 crate, 本地模块)
2. 常量
3. 结构体/枚举定义
4. impl块 (方法)
5. Trait 实现
```

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
