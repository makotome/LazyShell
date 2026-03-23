# Terminal PTY Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-command exec() pattern with persistent PTY shell sessions so that cd, vim, and all interactive commands work like macOS Terminal.

**Architecture:** Create a PersistentShell struct that maintains a real SSH PTY channel per tab. Frontend uses xterm.js to render terminal output including ANSI escape sequences. Shell sessions are managed in a HashMap keyed by tabId.

**Tech Stack:** Rust (ssh2 crate), Tauri 2.x, React 19, xterm.js 5.x

---

## Chunk 1: Rust Backend - PersistentShell Structure

**Files:**
- Modify: `src-tauri/src/ssh.rs`

### 1.1: Add PersistentShell struct and impl

- [ ] **Step 1: Read current ssh.rs to understand existing SSHConnection structure**

```bash
cat src-tauri/src/ssh.rs | head -100
```

- [ ] **Step 2: Add PersistentShell struct after SSHConnectionManager (around line 350)**

```rust
/// Persistent shell session - maintained for the entire tab lifecycle
pub struct PersistentShell {
    session: Session,
    server_config: ServerConfig,
    channel: Channel,
    is_alive: bool,
}

impl PersistentShell {
    /// Create a new persistent shell session
    pub fn new(config: ServerConfig, rows: u16, cols: u16) -> Result<Self, SSHError> {
        // 1. Establish TCP connection
        let tcp = TcpStream::connect(format!("{}:{}", config.host, config.port))
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new()
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session.handshake()
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        // 2. Authenticate
        match &config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&config.username, password)
                    .map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                let mut temp_file = NamedTempFile::new()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                use std::io::Write;
                temp_file.write_all(key_data.as_bytes())
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                temp_file.flush()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;

                session.userauth_pubkey_file(
                    &config.username,
                    None,
                    temp_file.path(),
                    passphrase.as_deref(),
                ).map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
        }

        if !session.authenticated() {
            return Err(SSHError::AuthFailed("Authentication failed".to_string()));
        }

        // 3. Request PTY
        let term = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.request_pty(
            term.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        // 4. Start shell
        channel.shell()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        Ok(Self {
            session,
            server_config: config,
            channel,
            is_alive: true,
        })
    }

    /// Write input to shell
    pub fn write(&mut self, data: &str) -> Result<(), SSHError> {
        self.channel.write(data.as_bytes())
            .map_err(|e| SSHError::IoError(e.to_string()))?;
        Ok(())
    }

    /// Read shell output (non-blocking)
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, SSHError> {
        match self.channel.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
            Err(e) => Err(SSHError::IoError(e.to_string())),
        }
    }

    /// Check if shell is alive
    pub fn is_alive(&self) -> bool {
        self.is_alive && !self.channel.eof()
    }

    /// Resize PTY terminal
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        self.channel.resize_pty(rows as u32, cols as u32)
            .map_err(|e| SSHError::ExecutionFailed(e.to_string()))
    }

    /// Close shell
    pub fn close(&mut self) -> Result<(), SSHError> {
        self.channel.close()
            .map_err(|e| SSHError::IoError(e.to_string()))?;
        self.is_alive = false;
        Ok(())
    }

    /// Disconnect session
    pub fn disconnect(&mut self) {
        let _: Result<(), _> = self.session.disconnect(
            Some(DisconnectCode::ByApplication),
            "User disconnected",
            None,
        );
        self.is_alive = false;
    }

    /// Attempt reconnection
    pub fn reconnect(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        self.disconnect();

        let tcp = TcpStream::connect(format!("{}:{}",
            self.server_config.host,
            self.server_config.port
        )).map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new()
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session.handshake()
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        match &self.server_config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&self.server_config.username, password)
                    .map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                let mut temp_file = NamedTempFile::new()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                use std::io::Write;
                temp_file.write_all(key_data.as_bytes())
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                temp_file.flush()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;

                session.userauth_pubkey_file(
                    &self.server_config.username,
                    None,
                    temp_file.path(),
                    passphrase.as_deref(),
                ).map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
        }

        let term = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.request_pty(
            term.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.shell()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        self.session = session;
        self.channel = channel;
        self.is_alive = true;

        Ok(())
    }
}
```

- [ ] **Step 3: Add persistent_shells to SSHConnectionManager (around line 352)**

```rust
use std::collections::HashMap;

pub struct SSHConnectionManager {
    connections: Mutex<Vec<SSHConnection>>,
    persistent_shells: Arc<Mutex<HashMap<String, PersistentShell>>>,
}

impl SSHConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(Vec::new()),
            persistent_shells: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // ... existing methods ...

    pub fn add_persistent_shell(&self, tab_id: String, shell: PersistentShell) {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.insert(tab_id, shell);
    }

    pub fn get_persistent_shell(&self, tab_id: &str) -> Option<std::sync::MutexGuard<'_, HashMap<String, PersistentShell>>> {
        let shells = self.persistent_shells.lock().ok()?;
        if shells.contains_key(tab_id) {
            Some(shells)
        } else {
            None
        }
    }

    pub fn remove_persistent_shell(&self, tab_id: &str) -> Option<PersistentShell> {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.remove(tab_id)
    }

    pub fn get_config(&self, server_id: &str) -> Option<ServerConfig> {
        let connections = self.connections.lock().unwrap();
        connections.iter()
            .find(|c| c.server_config.id == server_id)
            .map(|c| c.server_config.clone())
    }
}
```

- [ ] **Step 4: Run cargo check to verify compilation**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: Should compile (may have warnings about unused code)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ssh.rs
git commit -m "feat(ssh): add PersistentShell struct for PTY sessions"
```

---

## Chunk 2: Rust Backend - Tauri Commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### 2.1: Add Shell Session Tauri Commands

- [ ] **Step 1: Read current commands.rs structure (last 50 lines)**

```bash
tail -50 src-tauri/src/commands.rs
```

- [ ] **Step 2: Add shell session commands at the end of commands.rs**

```rust
/// Create a persistent shell session for a tab
#[tauri::command]
pub fn create_shell_session(
    server_id: String,
    tab_id: String,
    rows: u16,
    cols: u16,
    state: State<AppState>,
) -> Result<(), String> {
    let config = state.ssh_manager.get_config(&server_id)
        .ok_or("Server not found")?;

    let shell = PersistentShell::new(config, rows, cols)
        .map_err(|e| e.to_string())?;

    state.ssh_manager.add_persistent_shell(tab_id, shell);
    Ok(())
}

/// Send input to shell
#[tauri::command]
pub fn shell_input(
    tab_id: String,
    data: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut shells = state.ssh_manager.persistent_shells.lock()
        .map_err(|e| e.to_string())?;

    let shell = shells.get_mut(&tab_id)
        .ok_or("Shell session not found")?;

    shell.write(&data).map_err(|e| e.to_string())
}

/// Read shell output
#[tauri::command]
pub fn shell_output(
    tab_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    let mut shells = state.ssh_manager.persistent_shells.lock()
        .map_err(|e| e.to_string())?;

    let shell = shells.get_mut(&tab_id)
        .ok_or("Shell session not found")?;

    let mut buf = [0u8; 8192];
    match shell.read(&mut buf) {
        Ok(n) if n > 0 => Ok(String::from_utf8_lossy(&buf[..n]).to_string()),
        _ => Ok(String::new()),
    }
}

/// Check if shell is alive
#[tauri::command]
pub fn shell_is_alive(
    tab_id: String,
    state: State<AppState>,
) -> Result<bool, String> {
    let shells = state.ssh_manager.persistent_shells.lock()
        .map_err(|e| e.to_string())?;

    match shells.get(&tab_id) {
        Some(shell) => Ok(shell.is_alive()),
        None => Ok(false),
    }
}

/// Resize shell terminal
#[tauri::command]
pub fn shell_resize(
    tab_id: String,
    rows: u16,
    cols: u16,
    state: State<AppState>,
) -> Result<(), String> {
    let mut shells = state.ssh_manager.persistent_shells.lock()
        .map_err(|e| e.to_string())?;

    let shell = shells.get_mut(&tab_id)
        .ok_or("Shell session not found")?;

    shell.resize(rows, cols).map_err(|e| e.to_string())
}

/// Reconnect shell session
#[tauri::command]
pub fn reconnect_shell(
    tab_id: String,
    rows: u16,
    cols: u16,
    state: State<AppState>,
) -> Result<(), String> {
    let mut shells = state.ssh_manager.persistent_shells.lock()
        .map_err(|e| e.to_string())?;

    let shell = shells.get_mut(&tab_id)
        .ok_or("Shell session not found")?;

    shell.reconnect(rows, cols).map_err(|e| e.to_string())
}

/// Close shell session
#[tauri::command]
pub fn close_shell_session(
    tab_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if let Some(mut shell) = state.ssh_manager.remove_persistent_shell(&tab_id) {
        shell.close().ok();
        shell.disconnect();
    }
    Ok(())
}
```

- [ ] **Step 3: Register new commands in lib.rs**

```bash
# Find the invoke_handler section in lib.rs
grep -n "generate_handler" src-tauri/src/lib.rs
```

- [ ] **Step 4: Add new commands to invoke_handler in lib.rs**

Add these to the generate_handler list:
```rust
commands::create_shell_session,
commands::shell_input,
commands::shell_output,
commands::shell_is_alive,
commands::shell_resize,
commands::reconnect_shell,
commands::close_shell_session,
```

- [ ] **Step 5: Run cargo check to verify compilation**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: Should compile. May need to add PersistentShell import to commands.rs.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): add shell session Tauri commands"
```

---

## Chunk 3: Frontend - xterm.js Setup

**Files:**
- Modify: `package.json`
- Create: `src/components/Terminal.tsx`

### 3.1: Install xterm.js Dependencies

- [ ] **Step 1: Install xterm.js packages**

```bash
cd /Users/xumx/Documents/ai-coding/LazyShell && npm install xterm@^5.3.0 xterm-addon-fit@^0.8.0 xterm-addon-web-links@^0.9.0
```

- [ ] **Step 2: Verify installation in package.json**

```bash
grep -A2 "xterm" package.json
```

Expected output should include xterm, xterm-addon-fit, xterm-addon-web-links versions

### 3.2: Create Terminal Component

- [ ] **Step 1: Create Terminal.tsx**

```tsx
import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import 'xterm/css/xterm.css';

interface TerminalProps {
  tabId: string;
  onExit?: () => void;
}

export function Terminal({ tabId, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pollRef = useRef<number | null>(null);

  const handleResize = useCallback(() => {
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims && terminalRef.current) {
        invoke('shell_resize', {
          tabId,
          rows: dims.rows,
          cols: dims.cols,
        }).catch(console.error);
      }
    }
  }, [tabId]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm
    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#e4e4e4',
        cursor: '#ffffff',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#4d4d4d',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
      allowTransparency: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle user input
    terminal.onData((data) => {
      invoke('shell_input', { tabId, data }).catch(console.error);
    });

    // Handle resize
    terminal.onResize(({ rows, cols }) => {
      invoke('shell_resize', { tabId, rows, cols }).catch(console.error);
    });

    // Handle window resize
    window.addEventListener('resize', handleResize);

    // Poll for output
    const poll = async () => {
      if (!terminalRef.current) return;

      try {
        const isAlive = await invoke<boolean>('shell_is_alive', { tabId });
        if (!isAlive) {
          // Try to reconnect
          await invoke('reconnect_shell', { tabId, rows: terminal.rows, cols: terminal.cols });
        }

        const output = await invoke<string>('shell_output', { tabId });
        if (output && terminalRef.current) {
          terminalRef.current.write(output);
        }
      } catch (err) {
        console.error('Shell poll error:', err);
      }

      pollRef.current = requestAnimationFrame(poll);
    };

    pollRef.current = requestAnimationFrame(poll);

    return () => {
      if (pollRef.current) {
        cancelAnimationFrame(pollRef.current);
      }
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tabId, handleResize]);

  return <div ref={containerRef} className="terminal-xterm-container" />;
}
```

- [ ] **Step 3: Add CSS for terminal container**

Add to `src/App.css`:

```css
.terminal-xterm-container {
  width: 100%;
  height: 100%;
  background: #1e1e1e;
}

.terminal-xterm-container .xterm {
  padding: 8px;
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/components/Terminal.tsx src/App.css
git commit -m "feat(terminal): add xterm.js Terminal component"
```

---

## Chunk 4: Frontend - App.tsx Integration

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/TabBar.tsx`

### 4.1: Integrate Terminal into App.tsx

- [ ] **Step 1: Read current App.tsx to understand structure**

```bash
head -100 src/App.tsx
```

Focus on understanding: tabs state, how tabs are rendered, where InteractiveTerminal is used

- [ ] **Step 2: Modify App.tsx to use Terminal component**

Replace the InteractiveTerminal usage with Terminal for each tab:

```tsx
// Add new state for shell sessions
const [activeTabId, setActiveTabId] = useState<string | null>(null);

// Modify handleServerSelect to create shell session
const handleServerSelect = async (server: ServerInfo) => {
  // ... existing tab creation logic ...

  // Create shell session for new tab
  const tabId = newTab.id;
  try {
    await invoke('create_shell_session', {
      serverId: server.id,
      tabId,
      rows: 24,
      cols: 80,
    });
    setShellSessions(prev => ({ ...prev, [tabId]: true }));
  } catch (err) {
    console.error('Failed to create shell session:', err);
  }
};

// Modify handleTabClose to close shell session
const handleTabClose = async (tabId: string) => {
  // Close shell session
  try {
    await invoke('close_shell_session', { tabId });
  } catch (err) {
    console.error('Failed to close shell session:', err);
  }
  // ... existing tab closing logic ...
};

// In the render, replace InteractiveTerminal with Terminal
{
  activeTabId && (
    <Terminal tabId={activeTabId} />
  )
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: May have errors about missing types or unused imports. Fix as needed.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): integrate Terminal component with shell sessions"
```

---

## Chunk 5: Integration and Testing

### 5.1: Test Basic PTY Functionality

- [ ] **Step 1: Run the app in dev mode**

```bash
npm run tauri:dev
```

- [ ] **Step 2: Test basic commands**

- [ ] `pwd` - should show current directory
- [ ] `cd /tmp` - should change directory
- [ ] `pwd` - should show /tmp

- [ ] **Step 3: Test interactive commands**

- [ ] `vim test.txt` - should open vim
- [ ] Type some text
- [ ] `:wq` to save and quit
- [ ] `cat test.txt` - should show typed text

- [ ] **Step 4: Test other interactive commands**

- [ ] `nano test2.txt` - should open nano
- [ ] `less /etc/passwd` - should show file with pager

### 5.2: Test Text Selection and Copy

- [ ] **Step 1: Select text with mouse**

Click and drag to select text in terminal output

- [ ] **Step 2: Copy selected text**

Cmd+C or Ctrl+C should copy selected text

- [ ] **Step 3: Paste text**

Cmd+V or Ctrl+Shift+V should paste at cursor

### 5.3: Test Multiple Tabs

- [ ] **Step 1: Open two tabs to same server**

- [ ] **Step 2: Run different commands in each tab**

Verify they have independent shell states

- [ ] **Step 3: Close one tab**

Verify the other tab remains connected

### 5.4: Final Verification

- [ ] **Step 1: Test cd persistence**

```bash
cd /var/log
pwd  # should show /var/log
ls   # should list /var/log contents
```

- [ ] **Step 2: Test command history navigation**

Up arrow should show previous commands

- [ ] **Step 3: Test tab completion**

Tab should complete file/command names

---

## Chunk 6: Cleanup and Documentation

### 6.1: Remove or Deprecate Old Code

- [ ] **Step 1: Mark old execute_command as deprecated**

Add a comment to `execute_command` in commands.rs indicating it's superseded by shell sessions

- [ ] **Step 2: Keep InteractiveTerminal for reference**

Don't delete it yet - may need for fallback or migration

### 6.2: Update Documentation

- [ ] **Step 1: Update CLAUDE.md with new architecture**

Document the persistent PTY session architecture

---

## File Summary

| File | Action |
|------|--------|
| `src-tauri/src/ssh.rs` | Add PersistentShell struct, update SSHConnectionManager |
| `src-tauri/src/commands.rs` | Add shell session commands |
| `src-tauri/src/lib.rs` | Register new commands |
| `package.json` | Add xterm.js dependencies |
| `src/components/Terminal.tsx` | Create xterm.js wrapper component |
| `src/App.tsx` | Integrate Terminal, manage shell sessions |
| `src/App.css` | Add terminal container styles |

---

## Verification Commands

```bash
# Rust compilation
cd src-tauri && cargo check

# TypeScript compilation
npx tsc --noEmit

# Run dev server
npm run tauri:dev
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| xterm.js not loading | Check browser console for errors, verify CSS import |
| SSH disconnect not detected | Poll shell_is_alive, auto-reconnect |
| Memory leak in polling | Clean up requestAnimationFrame on unmount |
| Window resize handling | Use ResizeObserver for responsive terminal |
