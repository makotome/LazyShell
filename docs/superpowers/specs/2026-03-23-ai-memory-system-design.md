# 智能终端 AI 功能增强设计文档

**版本**: 1.1
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
- **危险命令检测**：`ssh.rs::is_dangerous_command()` 返回 bool

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

### 2.1 枚举定义

```rust
// src-tauri/src/memory.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DangerLevel {
    Green,  // 安全：白名单命令，直接执行
    Yellow, // 谨慎：非白名单/非黑名单，预览后执行
    Red,    // 危险：黑名单命令，预览 + 二次确认
}

impl DangerLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            DangerLevel::Green => "green",
            DangerLevel::Yellow => "yellow",
            DangerLevel::Red => "red",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandCategory {
    File,
    Text,
    System,
    Network,
    Process,
    Archive,
    Disk,
    Package,
    Other,
}

impl CommandCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            CommandCategory::File => "file",
            CommandCategory::Text => "text",
            CommandCategory::System => "system",
            CommandCategory::Network => "network",
            CommandCategory::Process => "process",
            CommandCategory::Archive => "archive",
            CommandCategory::Disk => "disk",
            CommandCategory::Package => "package",
            CommandCategory::Other => "other",
        }
    }
}
```

### 2.2 聊天记录 (ChatHistory)

文件路径：`~/.local/share/LazyShell/memory/{sanitized_server_id}_chats.json`

**安全措施**：
- `server_id` 中的非法字符替换为 `_`
- 文件名长度限制在 200 字符以内

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatHistoryEntry {
    pub id: String,           // UUID v4
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

### 2.3 指令卡片 (CommandCard)

文件路径：`~/.local/share/LazyShell/memory/{sanitized_server_id}_cards.json`

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandCard {
    pub id: String,           // UUID v4
    pub server_id: String,
    pub natural_language: String,  // 用户输入的原始描述
    pub command: String,
    pub description: String,
    pub danger_level: String, // "green" | "yellow" | "red"
    pub category: String,     // "file" | "text" | "system" | "network" | "process" | "archive" | "disk" | "package" | "other"
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

### 2.4 TypeScript 类型

```typescript
// src/types/index.ts 扩展

export type DangerLevel = 'green' | 'yellow' | 'red';

export type CommandCategory = 'file' | 'text' | 'system' | 'network' | 'process' | 'archive' | 'disk' | 'package' | 'other';

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
  category: CommandCategory;
  usageCount: number;
  createdAt: number;
  lastUsed: number;
}

// 兼容现有 ChatMessage，新增 dangerLevel 字段
export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  command?: string;
  explanation?: string;
  isDangerous?: boolean;      // 保持兼容
  dangerLevel?: DangerLevel;  // 新增：3级判断
  timestamp: number;
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
- `historyPanelCollapsed: boolean` - 历史面板是否折叠

UI 变化：
1. 聊天输入区域上方增加悬浮标签页
2. 输入区域右侧增加"添加到常用"按钮
3. AI 回复增加危险等级颜色指示器
4. 卡片布局改为展开卡片样式
5. 右侧增加可折叠的历史记录面板

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
// src-tauri/src/memory.rs

#[tauri::command]
pub fn load_chat_history(server_id: String, offset: u32, limit: u32) -> Result<ChatHistoryFile, String>;

#[tauri::command]
pub fn save_chat_history(server_id: String, entries: Vec<ChatHistoryEntry>) -> Result<(), String>;

#[tauri::command]
pub fn append_chat_entry(server_id: String, entry: ChatHistoryEntry) -> Result<(), String>;

#[tauri::command]
pub fn cleanup_chat_history(server_id: String, keep_last: u32) -> Result<(), String>;
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
pub fn remove_command_card(card_id: String, server_id: String) -> Result<(), String>;

#[tauri::command]
pub fn update_card_usage(card_id: String, server_id: String) -> Result<(), String>;

#[tauri::command]
pub fn get_command_card(card_id: String, server_id: String) -> Result<Option<CommandCard>, String>;
```

### 4.3 危险等级判断

**重要**：复用 `ssh.rs::is_dangerous_command()` 的白名单/黑名单逻辑，统一危险等级判断。

```rust
// src-tauri/src/memory.rs

/// 扩展现有危险命令检测为3级判断
pub fn determine_danger_level(command: &str) -> DangerLevel {
    // 复用 ssh.rs 的 is_dangerous_command() 黑名单检测
    if is_dangerous_command(command) {
        return DangerLevel::Red;
    }

    // 白名单检测
    let base_cmd = command.split_whitespace().next().unwrap_or("").to_lowercase();
    if is_safe_command(&base_cmd) {
        return DangerLevel::Green;
    }

    DangerLevel::Yellow
}

/// 白名单命令（只读/查询操作）
fn is_safe_command(cmd: &str) -> bool {
    matches!(cmd,
        "ls" | "cd" | "pwd" | "cat" | "grep" | "find" | "echo" | "printf" |
        "head" | "tail" | "less" | "more" | "sort" | "uniq" | "wc" | "cut" |
        "awk" | "sed" | "tr" | "dirname" | "basename" | "stat" | "file" |
        "df" | "du" | "free" | "top" | "ps" | "pidof" | "pgrep" |
        "netstat" | "ss" | "ping" | "traceroute" | "nslookup" | "dig" |
        "curl" | "wget" | "ssh" | "scp" | "rsync" |
        "tar" | "gzip" | "gunzip" | "bzip2" | "bunzip2" | "xz" | "unxz" |
        "zip" | "unzip" | "git" | "svn" | "history"
    )
}
```

---

## 5. 文件操作安全措施

### 5.1 原子写入

所有文件写入使用原子操作防止数据损坏：

```rust
fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;

    // 写入临时文件
    fs::write(&temp_path, json).map_err(|e| e.to_string())?;

    // 原子替换
    fs::rename(&temp_path, path).map_err(|e| e.to_string())?;

    Ok(())
}
```

### 5.2 文件名安全

```rust
fn sanitize_server_id(server_id: &str) -> String {
    server_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(200)  // 长度限制
        .collect()
}
```

### 5.3 存储限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 聊天记录最大条数 | 1000 | 超出时自动清理最旧记录 |
| 卡片最大数量 | 500 | 超出时阻止添加 |
| 单文件最大大小 | 5MB | 超出时拒绝写入并返回错误 |

### 5.4 孤儿文件清理

服务器删除时，调用 `cleanup_server_memory(server_id)` 清理相关文件。

---

## 6. 文件结构

```
src-tauri/src/
├── memory.rs          # 新增：聊天记录和指令卡片持久化
├── lib.rs             # 注册 memory 模块
├── ssh.rs             # 复用 is_dangerous_command()
└── main.rs            # (无需修改)

src/
├── components/
│   ├── AIChat.tsx     # 增强：标签页、展开卡片、危险等级
│   └── CommandCard.tsx # 新增：独立卡片组件
├── types/
│   └── index.ts       # 扩展类型定义
└── hooks/
    └── useMemory.ts   # 新增：记忆系统 Hook

docs/superpowers/specs/
└── 2026-03-23-ai-memory-system-design.md
```

---

## 7. 实现步骤

### Phase 1: 数据层
1. 创建 `src-tauri/src/memory.rs` - 聊天记录和卡片持久化
   - 包含 `atomic_write_json`、`sanitize_server_id` 等工具函数
   - 实现所有 Tauri 命令
2. 更新 `src-tauri/src/lib.rs` - 注册 memory 模块
3. 更新 `src/types/index.ts` - TypeScript 类型扩展
4. 创建 `src/hooks/useMemory.ts` - 记忆系统 Hook

### Phase 2: UI 组件
1. 创建 `src/components/CommandCard.tsx` - 独立卡片组件
2. 增强 `src/components/AIChat.tsx` - 悬浮标签页 + 展开卡片
3. 创建历史记录面板组件

### Phase 3: 集成
1. 集成危险等级判断（复用 ssh.rs 逻辑）
2. 实现"添加到常用"功能 + 去重
3. 实现执行统计更新
4. 实现服务器删除时的孤儿文件清理

---

## 8. 验证方案

1. **cargo check** - Rust 编译检查
2. **npm run lint** - 前端 lint 检查
3. **手动测试**:
   - 连接服务器，打开 AI 聊天
   - 输入"查看系统进程"，验证生成黄色卡片
   - 点击"添加到常用"，验证卡片出现在常用列表
   - 切换到历史 tab，验证聊天记录显示
   - 输入危险命令，验证红色卡片 + 二次确认
   - 重启应用，验证聊天记录和卡片持久化
   - 删除服务器，验证孤儿文件被清理

---

## 9. 附录

### A. 存储目录结构

```
~/.local/share/LazyShell/
├── learning_data.json         # 现有：学习数据
├── memory/
│   ├── {sanitized_id}_chats.json  # 聊天记录
│   └── {sanitized_id}_cards.json  # 指令卡片
└── ...
```

### B. 与现有系统的关系

- `learning_data.json` 保持不变，继续存储自然语言→命令映射
- 新的 `CommandCard` 存储用户"添加到常用"的命令
- 聊天记录独立存储，支持按服务器查看历史
- 危险等级判断复用 `ssh.rs::is_dangerous_command()`

### C. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-03-23 | 初始设计 |
| 1.1 | 2026-03-23 | 修复审查问题：原子写入、UUID ID、sanitized filename、pagination、API 签名修复、存储限制、孤儿清理 |
