# LazyShell 终端 PTY 改造设计方案

## 1. 概述

**目标：** 将 LazyShell 终端改造为真正的持久 PTY 会话，实现与 macOS Terminal 一致的用户体验。

**核心需求：**
- 持久 PTY 会话（`cd` 保持、vim/nano 正常工作）
- 所有交互式命令支持
- 每个标签页独立 Shell 会话
- 使用 xterm.js 做终端渲染
- 连接断开自动重连
- 保留现有 AI 功能

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        App.tsx                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ TabBar      │  │ Terminal   │  │ AI Chat             │ │
│  │             │  │ (xterm.js) │  │                     │ │
│  └─────────────┘  └──────┬──────┘  └─────────────────────┘ │
│                          │                                 │
│  Shell Sessions: Map<tabId, PersistentShell>             │
│                          │                                 │
│              ┌───────────┴───────────┐                     │
│              │   Tauri Commands    │                      │
│              └───────────┬───────────┘                     │
└──────────────────────────┼────────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────────┐
│                   Rust Backend                             │
│              ┌───────────┴───────────┐                     │
│              │ SSHConnectionManager  │                     │
│              │  persistent_shells   │ ← HashMap<tabId, Shell>
│              └───────────┬───────────┘                     │
│                          │                                 │
│              ┌───────────┴───────────┐                     │
│              │  PersistentShell     │                      │
│              │  - Session          │                      │
│              │  - Channel (PTY)    │                      │
│              └─────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 当前问题

| 问题 | 原因 |
|------|------|
| `cd` 无效 | 每次命令新建 Channel，执行完关闭，状态不保留 |
| vim 无法使用 | exec() 模式不支持交互式程序 |
| top 无法使用 | 同上 |
| 命令历史不共享 | 每个命令独立执行 |

---

## 3. 后端设计

### 3.1 PersistentShell 结构体

```rust
/// 持久化的 Shell 会话 - 整个标签页生命周期内保持
pub struct PersistentShell {
    session: Session,              // SSH session
    server_config: ServerConfig,   // 服务器配置
    channel: Channel,             // PTY channel
    is_alive: bool,              // 连接是否存活
}

impl PersistentShell {
    /// 创建持久化 Shell 会话
    pub fn new(config: ServerConfig, rows: u16, cols: u16) -> Result<Self, SSHError> {
        // 1. 建立 TCP 连接
        let tcp = TcpStream::connect(format!("{}:{}", config.host, config.port))?;
        let mut session = Session::new()?;
        session.set_tcp_stream(tcp);
        session.handshake()?;

        // 2. 认证（密码或私钥）
        match &config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&config.username, password)?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                // 私钥认证逻辑
            }
        }

        if !session.authenticated() {
            return Err(SSHError::AuthFailed("Authentication failed".to_string()));
        }

        // 3. 请求 PTY
        let term = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()?;
        channel.request_pty(
            term.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        )?;

        // 4. 启动 shell
        channel.shell()?;

        Ok(Self {
            session,
            server_config: config,
            channel,
            is_alive: true,
        })
    }

    /// 发送输入到 shell
    pub fn write(&mut self, data: &str) -> Result<(), SSHError> {
        self.channel.write(data.as_bytes())
            .map_err(|e| SSHError::IoError(e.to_string()))?;
        Ok(())
    }

    /// 读取 shell 输出（非阻塞）
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, SSHError> {
        match self.channel.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
            Err(e) => Err(SSHError::IoError(e.to_string())),
        }
    }

    /// 检查 shell 是否存活
    pub fn is_alive(&self) -> bool {
        self.is_alive && !self.channel.eof()
    }

    /// 调整 PTY 大小
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        self.channel.resize_pty(rows as u32, cols as u32)
            .map_err(|e| SSHError::ExecutionFailed(e.to_string()))
    }

    /// 关闭 shell
    pub fn close(&mut self) -> Result<(), SSHError> {
        self.channel.close()
            .map_err(|e| SSHError::IoError(e.to_string()))?;
        self.is_alive = false;
        Ok(())
    }

    /// 断开连接
    pub fn disconnect(&mut self) {
        let _: Result<(), _> = self.session.disconnect(
            Some(ssh2::DisconnectCode::ByApplication),
            "User disconnected",
            None
        );
        self.is_alive = false;
    }
}
```

### 3.2 SSHConnectionManager 变更

```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

pub struct SSHConnectionManager {
    // 普通命令连接（保留用于非 PTY 操作）
    connections: Mutex<Vec<SSHConnection>>,

    // 持久化 Shell 会话（每个标签页一个）
    // 使用 Arc 允许在持有锁的情况下内部可变性
    persistent_shells: Arc<Mutex<HashMap<String, PersistentShell>>>,
}

impl SSHConnectionManager {
    /// 添加持久化 Shell
    pub fn add_persistent_shell(&self, tab_id: String, shell: PersistentShell) {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.insert(tab_id, shell);
    }

    /// 获取可变的 Shell 引用
    pub fn get_persistent_shell_mut(&self, tab_id: &str) -> Option<PersistentShellMutGuard> {
        // 返回一个可以让我们修改内部 HashMap 的 guard
        // 通过 Arc<Mutex<HashMap>> 实现
        None // 简化，后续详细实现
    }

    /// 移除并关闭 Shell
    pub fn remove_persistent_shell(&self, tab_id: &str) -> Option<PersistentShell> {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.remove(tab_id)
    }

    /// 获取服务器配置
    pub fn get_config(&self, server_id: &str) -> Option<ServerConfig> {
        let connections = self.connections.lock().unwrap();
        connections.iter()
            .find(|c| c.server_config.id == server_id)
            .map(|c| c.server_config.clone())
    }
}
```

### 3.3 Tauri IPC 命令

| 命令 | 描述 |
|------|------|
| `create_shell_session` | 为标签页创建新的 PTY 会话 |
| `shell_input` | 发送按键到 Shell |
| `shell_output` | 读取 Shell 输出 |
| `shell_resize` | 调整终端窗口大小 |
| `close_shell_session` | 关闭 Shell 会话 |
| `reconnect_shell` | 重新连接断开的 Shell |

---

## 4. 前端设计

### 4.1 Terminal 组件 (xterm.js)

```tsx
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
  onExit?: () => void;
}

export function Terminal({ tabId, onExit }: TerminalProps) {
  const terminalRef = useRef<Terminal>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 初始化 xterm
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', Monaco, 'Cascadia Code'",
      theme: {
        background: '#1e1e1e',
        foreground: '#e4e4e4',
      },
      rows: 24,
      cols: 80,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current!);
    fitAddon.fit();

    // 处理输入
    terminal.onData((data) => {
      invoke('shell_input', { tabId, data });
    });

    // 处理 resize
    terminal.onResize(({ rows, cols }) => {
      invoke('shell_resize', { tabId, rows, cols });
    });

    terminalRef.current = terminal;

    // 轮询输出
    let animationFrame: number;
    const poll = async () => {
      if (!terminalRef.current) return;
      const output = await invoke<string>('shell_output', { tabId });
      if (output) {
        terminalRef.current.write(output);
      }
      animationFrame = requestAnimationFrame(poll);
    };
    poll();

    return () => {
      cancelAnimationFrame(animationFrame);
      terminal.dispose();
    };
  }, [tabId]);

  return <div ref={containerRef} className="terminal-container" />;
}
```

### 4.2 App.tsx 变更

```tsx
// 新增状态
const [shellSessions, setShellSessions] = useState<Record<string, boolean>>({});

// 标签页打开时创建 Shell
const handleTabOpen = async (serverId: string, tabId: string) => {
  const rows = 24, cols = 80;
  await invoke('create_shell_session', { serverId, tabId, rows, cols });
  setShellSessions(prev => ({ ...prev, [tabId]: true }));
};

// 标签页关闭时销毁 Shell
const handleTabClose = async (tabId: string) => {
  await invoke('close_shell_session', { tabId });
  setShellSessions(prev => {
    const { [tabId]: _, ...rest } = prev;
    return rest;
  });
};

// 渲染终端
{tabId && <Terminal tabId={tabId} />}
```

---

## 5. 重连机制

### 5.1 重连策略

```rust
impl PersistentShell {
    /// 尝试重连
    pub fn reconnect(&mut self) -> Result<(), SSHError> {
        // 1. 关闭旧连接
        self.disconnect();

        // 2. 重新建立 TCP 连接
        let tcp = TcpStream::connect(format!("{}:{}",
            self.server_config.host,
            self.server_config.port
        ))?;

        let mut session = Session::new()?;
        session.set_tcp_stream(tcp);
        session.handshake()?;

        // 3. 重新认证
        match &self.server_config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&self.server_config.username, password)?;
            }
            // 私钥重连...
        }

        // 4. 重建 PTY channel
        let term = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()?;
        channel.request_pty(
            term.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((80, 24, 0, 0)),
        )?;
        channel.shell()?;

        self.session = session;
        self.channel = channel;
        self.is_alive = true;

        Ok(())
    }
}
```

### 5.2 前端重连处理

```tsx
// 轮询时检测连接状态
const poll = async () => {
  const isAlive = await invoke<boolean>('shell_is_alive', { tabId });
  if (!isAlive && shellSessions[tabId]) {
    // 尝试重连
    await invoke('reconnect_shell', { tabId });
  }

  const output = await invoke<string>('shell_output', { tabId });
  if (output) {
    terminal.write(output);
  }
  animationFrame = requestAnimationFrame(poll);
};
```

---

## 6. 文件修改清单

| 文件 | 修改内容 |
|------|---------|
| `src-tauri/src/ssh.rs` | 新增 `PersistentShell` 结构体，重构连接管理 |
| `src-tauri/src/commands.rs` | 新增 Shell 会话管理命令 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/App.tsx` | Shell 会话生命周期管理 |
| `src/components/Terminal.tsx` | **新建** - xterm.js 终端组件 |
| `src/components/TabBar.tsx` | 标签页打开/关闭集成 Shell 生命周期 |
| `src/components/InteractiveTerminal.tsx` | 保留或逐步替换 |
| `package.json` | 添加 xterm.js 依赖 |

---

## 7. 依赖清单

```json
{
  "dependencies": {
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0",
    "xterm-addon-web-links": "^0.9.0"
  }
}
```

---

## 8. 验证步骤

1. **基本功能测试：**
   - [ ] 打开标签页连接服务器
   - [ ] `pwd` 显示当前目录
   - [ ] `cd /tmp` 改变目录
   - [ ] `pwd` 确认目录已改变

2. **交互式命令测试：**
   - [ ] `vim test.txt` 正常启动
   - [ ] 输入文字后 `:wq` 保存退出
   - [ ] `cat test.txt` 确认文件内容

3. **其他交互式程序：**
   - [ ] `top` 正常显示
   - [ ] `nano` 正常编辑
   - [ ] `less file.txt` 正常分页

4. **文本选择复制：**
   - [ ] 鼠标选择文字
   - [ ] Cmd+C 复制

5. **粘贴测试：**
   - [ ] Cmd+V 粘贴

6. **多标签页：**
   - [ ] 打开多个服务器标签页
   - [ ] 每个标签页独立 Shell 会话

7. **连接断开重连：**
   - [ ] 模拟断开，验证重连机制

---

## 9. 风险和备选方案

| 风险 | 缓解措施 |
|------|----------|
| xterm.js 集成复杂度 | 使用官方文档和示例，逐步集成 |
| SSH2 crate PTY 支持限制 | 先实现核心功能，resize 后续优化 |
| 内存泄漏（xterm.js 实例） | 严格管理组件生命周期，及时 dispose |
| 重连状态恢复 | 简化处理，重连后提示用户重新执行 |

---

## 10. 后续优化

- PTY resize 支持完善
- 鼠標支持
- 多个 PTY 会话池化优化
- 命令历史持久化
- 会话录制/回放
