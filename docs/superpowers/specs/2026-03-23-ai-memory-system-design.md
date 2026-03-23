# 智能终端 AI 功能增强设计文档

**版本**: 1.0
**日期**: 2026-03-23
**状态**: 设计完成，待实现

---

## 1. Context

### 1.1 背景

LazyShell 需要增强 AI 功能，实现：
- 指令卡片化（带危险等级颜色）
- 服务器聊天记录持久化
- 常用命令快速访问
- 多指令自动生成选项
- 本地记忆系统

### 1.2 现有架构

- **聊天记录**：内存状态（`messages` in AIChat.tsx），仅会话内有效
- **学习数据**：`~/.local/share/LazyShell/learning_data.json`
- **指令卡片**：无
- **存储方式**：Rust 后端文件系统存储

### 1.3 设计决策

| 功能 | 选择 |
|------|------|
| 卡片交互 | 🟢 直接执行 / 🟡 预览执行 / 🔴 二次确认 |
| 卡片布局 | 展开卡片（描述 + 命令 + 操作按钮） |
| 常用命令入口 | 悬浮标签页（常用/历史/学习分页） |
| 数据存储 | 分离存储（聊天记录 / 指令卡片独立文件） |
| 多指令生成 | 一次性生成（不自动追问） |
| 历史记录显示 | 独立侧边面板（可折叠） |
| 危险等级判断 | 混合模式（白名单+黑名单+AI） |

---

## 2. 数据模型

### 2.1 聊天记录 (ChatHistory)

文件路径：`~/.local/share/LazyShell/memory/{server_id}_chats.json`

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatHistoryEntry {
    pub id: String,           // "chat-{timestamp}"
    pub server_id: String,
    pub role: String,         // "user" | "ai"
    pub content: String,
    pub command: Option<String>,
    pub explanation: Option<String>,
    pub danger_level: String, // "green" | "yellow" | "red"
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatHistoryFile {
    pub server_id: String,
    pub entries: Vec<ChatHistoryEntry>,
    pub version: String,      // "1.0"
}
```

### 2.2 指令卡片 (CommandCard)

文件路径：`~/.local/share/LazyShell/memory/{server_id}_cards.json`

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandCard {
    pub id: String,           // "card-{timestamp}"
    pub server_id: String,
    pub natural_language: String,  // 用户输入的原始描述
    pub command: String,
    pub description: String,
    pub danger_level: String, // "green" | "yellow" | "red"
    pub category: String,     // "file" | "system" | "network" | "process" | "archive" | "disk" | "package"
    pub usage_count: u32,
    pub created_at: u64,
    pub last_used: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandCardFile {
    pub server_id: String,
    pub cards: Vec<CommandCard>,
    pub version: String,
}
```

### 2.3 TypeScript 类型

```typescript
// src/types/index.ts 新增

export type DangerLevel = 'green' | 'yellow' | 'red';

export interface ChatHistoryEntry {
  id: string;
  serverId: string;
  role: 'user' | 'ai';
  content: string;
  command?: string;
  explanation?: string;
  dangerLevel: DangerLevel;
  timestamp: number;
}

export interface CommandCard {
  id: string;
  serverId: string;
  naturalLanguage: string;
  command: string;
  description: string;
  dangerLevel: DangerLevel;
  category: string;
  usageCount: number;
  createdAt: number;
  lastUsed: number;
}
```

---

## 3. 组件设计

### 3.1 AIChat 增强

**文件**: `src/components/AIChat.tsx`

新增状态：
- `chatHistory: ChatHistoryEntry[]` - 持久化的聊天记录
- `commandCards: CommandCard[]` - 常用命令卡片
- `activeTab: 'chat' | 'history' | 'commands'` - 悬浮标签页当前 tab

UI 变化：
1. 聊天输入区域上方增加悬浮标签页
2. 输入区域右侧增加"添加到常用"按钮
3. AI 回复增加危险等级颜色指示器
4. 卡片布局改为展开卡片样式

### 3.2 展开卡片 UI

```
┌─────────────────────────────────────┐
│ 🟡 系统管理                          │
│ 查看当前系统进程和资源占用            │
│                                     │
│ $ ps aux | head -20                 │
│                                     │
│ [添加到常用] [执行] [删除]          │
└─────────────────────────────────────┘
```

### 3.3 悬浮标签页

```
┌─────────────────────────────────────┐
│ [💬 聊天] [📜 历史] [📋 常用命令]  │
├─────────────────────────────────────┤
│                                     │
│ 聊天内容 / 历史记录 / 常用命令列表   │
│                                     │
└─────────────────────────────────────┘
```

### 3.4 危险等级颜色

| 等级 | 颜色 | 触发条件 | 执行方式 |
|------|------|----------|----------|
| 🟢 绿色 | `#0dbc79` | 白名单命令（只读） | 直接执行 |
| 🟡 黄色 | `#e5e510` | 非白名单/非黑名单 | 预览后执行 |
| 🔴 红色 | `#cd3131` | 黑名单命令 | 预览 + 二次确认 |

---

## 4. 后端命令

### 4.1 聊天记录

```rust
// src-tauri/src/memory.rs (新文件)

#[tauri::command]
pub fn load_chat_history(server_id: String) -> Result<ChatHistoryFile, String>;

#[tauri::command]
pub fn save_chat_history(server_id: String, entries: Vec<ChatHistoryEntry>) -> Result<(), String>;

#[tauri::command]
pub fn append_chat_entry(server_id: String, entry: ChatHistoryEntry) -> Result<(), String>;
```

### 4.2 指令卡片

```rust
#[tauri::command]
pub fn load_command_cards(server_id: String) -> Result<CommandCardFile, String>;

#[tauri::command]
pub fn save_command_cards(server_id: String, cards: Vec<CommandCard>) -> Result<(), String>;

#[tauri::command]
pub fn add_command_card(card: CommandCard) -> Result<(), String>;

#[tauri::command]
pub fn remove_command_card(card_id: String) -> Result<(), String>;

#[tauri::command]
pub fn update_card_usage(card_id: String) -> Result<(), String>;
```

### 4.3 危险等级判断

```rust
// src-tauri/src/commands.rs 新增

const SAFE_WHITELIST: &[&str] = &[
    "ls", "cd", "pwd", "cat", "grep", "find", "echo", "printf",
    "head", "tail", "less", "more", "sort", "uniq", "wc", "cut",
    "awk", "sed", "tr", "dirname", "basename", "stat", "file",
    "df", "du", "free", "top", "ps", "pidof", "pgrep",
    "netstat", "ss", "ping", "traceroute", "nslookup", "dig",
    "curl", "wget", "ssh", "scp", "rsync",
    "tar", "gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz",
    "zip", "unzip", "git", "svn",
];

const DANGER_BLACKLIST: &[&str] = &[
    "rm -rf", "rm -rf /", "mkfs", "mke2fs",
    "> /dev/sd", "dd if=/dev/zero of=/dev/sd",
    "shutdown", "reboot", "init 0", "init 6",
    "fork", ":(){ :|:& };:",  // fork bomb
    " shred ", "wipe", "secure-delete",
];

pub fn determine_danger_level(command: &str) -> DangerLevel {
    let cmd_lower = command.to_lowercase();

    // Check blacklist first
    for pattern in DANGER_BLACKLIST {
        if cmd_lower.contains(&pattern.to_lowercase()) {
            return "red";
        }
    }

    // Check whitelist
    let base_cmd = cmd_lower.split_whitespace().next().unwrap_or("");
    if SAFE_WHITELIST.contains(&base_cmd) {
        return "green";
    }

    // Check for dangerous patterns
    if cmd_lower.contains("rm -")
        || cmd_lower.contains("> /")
        || cmd_lower.contains("| sh")
        || cmd_lower.contains("curl |") && cmd_lower.contains("sh") {
        return "yellow";
    }

    "yellow"  // Default to yellow (needs confirmation)
}
```

---

## 5. 文件结构

```
src-tauri/src/
├── memory.rs          # 新增：聊天记录和指令卡片持久化
├── lib.rs            # 注册 memory 模块
└── main.rs           # (无需修改)

src/
├── components/
│   └── AIChat.tsx    # 增强：标签页、展开卡片、危险等级
├── types/
│   └── index.ts      # 新增类型定义
└── hooks/
    └── useMemory.ts  # 新增：记忆系统 Hook

docs/superpowers/specs/
└── 2026-03-23-ai-memory-system-design.md
```

---

## 6. 实现步骤

### Phase 1: 数据层
1. 创建 `src-tauri/src/memory.rs` - 聊天记录和卡片持久化
2. 创建 `src/types/index.ts` - TypeScript 类型扩展
3. 创建 `src/hooks/useMemory.ts` - 记忆系统 Hook

### Phase 2: UI 组件
1. 增强 `AIChat.tsx` - 悬浮标签页
2. 创建展开卡片组件
3. 创建历史记录面板
4. 创建常用命令列表

### Phase 3: 集成
1. 集成危险等级判断
2. 实现"添加到常用"功能
3. 实现去重逻辑
4. 实现执行统计更新

---

## 7. 验证方案

1. **cargo check** - Rust 编译检查
2. **npm run lint** - 前端 lint 检查
3. **手动测试**:
   - 连接服务器，打开 AI 聊天
   - 输入"查看系统进程"，验证生成黄色卡片
   - 点击"添加到常用"，验证卡片出现在常用列表
   - 切换到历史 tab，验证聊天记录显示
   - 输入危险命令，验证红色卡片 + 二次确认
   - 重启应用，验证聊天记录和卡片持久化

---

## 8. 附录

### A. 存储目录结构

```
~/.local/share/LazyShell/
├── learning_data.json      # 现有：学习数据
├── memory/
│   ├── {server_id}_chats.json   # 聊天记录
│   └── {server_id}_cards.json   # 指令卡片
└── ...
```

### B. 与现有系统的关系

- `learning_data.json` 保持不变，继续存储自然语言→命令映射
- 新的 `CommandCard` 存储用户"添加到常用"的命令
- 聊天记录独立存储，支持按服务器查看历史
