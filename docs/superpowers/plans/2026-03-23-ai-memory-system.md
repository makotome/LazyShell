# AI Memory System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement persistent chat history and command cards with danger level colors for LazyShell AI features.

**Architecture:** Backend Rust module for file-based persistence with atomic writes, TypeScript types extension, React hooks for data access, and enhanced AIChat UI with tabs and expanded cards.

**Tech Stack:** React 19, TypeScript, Tauri 2.x, Rust, xterm.js

---

## File Structure

```
src-tauri/src/
├── memory.rs          # NEW: chat history and command card persistence
├── lib.rs             # MODIFY: register memory module
├── ssh.rs             # MODIFY: expose is_dangerous_command for reuse
└── main.rs            # (no change)

src/
├── components/
│   ├── AIChat.tsx     # MODIFY: add tabs, expanded cards, danger colors
│   └── CommandCard.tsx # NEW: standalone command card component
├── types/
│   └── index.ts       # MODIFY: add DangerLevel, CommandCategory, ChatHistoryEntry, CommandCard types
└── hooks/
    └── useMemory.ts   # NEW: memory system hook for chat/cards

docs/superpowers/plans/
└── 2026-03-23-ai-memory-system.md
```

---

## Chunk 1: Rust Backend - memory.rs Module

**Files:**
- Create: `src-tauri/src/memory.rs`
- Modify: `src-tauri/src/lib.rs:1-7`
- Modify: `src-tauri/src/ssh.rs:841-870`

### Step 1: Create memory.rs with enums and data structures

- [ ] **Create `src-tauri/src/memory.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Danger levels for command cards
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DangerLevel {
    Green,   // Safe: whitelisted commands, direct execution
    Yellow,  // Caution: non-whitelist/non-blacklist, preview before execute
    Red,     // Danger: blacklisted commands, preview + second confirmation
}

impl DangerLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            DangerLevel::Green => "green",
            DangerLevel::Yellow => "yellow",
            DangerLevel::Red => "red",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "green" => DangerLevel::Green,
            "yellow" => DangerLevel::Yellow,
            "red" => DangerLevel::Red,
            _ => DangerLevel::Yellow,
        }
    }
}

/// Command categories for organization
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

    pub fn from_str(s: &str) -> Self {
        match s {
            "file" => CommandCategory::File,
            "text" => CommandCategory::Text,
            "system" => CommandCategory::System,
            "network" => CommandCategory::Network,
            "process" => CommandCategory::Process,
            "archive" => CommandCategory::Archive,
            "disk" => CommandCategory::Disk,
            "package" => CommandCategory::Package,
            _ => CommandCategory::Other,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatHistoryEntry {
    pub id: String,
    pub server_id: String,
    pub role: String,
    pub content: String,
    pub command: Option<String>,
    pub explanation: Option<String>,
    pub danger_level: String,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatHistoryFile {
    pub server_id: String,
    pub entries: Vec<ChatHistoryEntry>,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandCard {
    pub id: String,
    pub server_id: String,
    pub natural_language: String,
    pub command: String,
    pub description: String,
    pub danger_level: String,
    pub category: String,
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

### Step 2: Add utility functions

- [ ] **Add to `src-tauri/src/memory.rs` - utility functions**

```rust
/// Storage limits
const MAX_CHAT_ENTRIES: usize = 1000;
const MAX_COMMAND_CARDS: usize = 500;
const MAX_FILE_SIZE_BYTES: usize = 5 * 1024 * 1024; // 5MB

/// Get memory directory path
fn get_memory_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell").join("memory");
    fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir)
}

/// Sanitize server_id for safe filename usage
fn sanitize_server_id(server_id: &str) -> String {
    server_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(200)
        .collect()
}

/// Get chat history file path
fn get_chat_history_path(server_id: &str) -> Result<PathBuf, String> {
    let sanitized = sanitize_server_id(server_id);
    let dir = get_memory_dir()?;
    Ok(dir.join(format!("{}_chats.json", sanitized)))
}

/// Get command cards file path
fn get_command_cards_path(server_id: &str) -> Result<PathBuf, String> {
    let sanitized = sanitize_server_id(server_id);
    let dir = get_memory_dir()?;
    Ok(dir.join(format!("{}_cards.json", sanitized)))
}

/// Atomic write JSON to file using temp file + rename
fn atomic_write_json<T: Serialize>(path: &PathBuf, data: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;

    // Check file size limit
    if json.len() > MAX_FILE_SIZE_BYTES {
        return Err("File size exceeds limit of 5MB".to_string());
    }

    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, json).map_err(|e| e.to_string())?;
    fs::rename(&temp_path, path).map_err(|e| e.to_string())?;

    Ok(())
}

/// Determine danger level for a command
/// Reuses ssh.rs::is_dangerous_command() for blacklist detection
pub fn determine_danger_level(command: &str) -> DangerLevel {
    // Check blacklist (dangerous commands)
    if ssh::is_dangerous_command_public(command) {
        return DangerLevel::Red;
    }

    // Check whitelist (safe commands)
    let base_cmd = command.split_whitespace().next().unwrap_or("").to_lowercase();
    if is_safe_command(&base_cmd) {
        return DangerLevel::Green;
    }

    DangerLevel::Yellow
}

/// Whitelist of safe read-only commands
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

### Step 3: Add Tauri commands for chat history

- [ ] **Add to `src-tauri/src/memory.rs` - chat history commands**

```rust
#[tauri::command]
pub fn load_chat_history(server_id: String, offset: u32, limit: u32) -> Result<ChatHistoryFile, String> {
    let path = get_chat_history_path(&server_id)?;

    if !path.exists() {
        return Ok(ChatHistoryFile {
            server_id,
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(ChatHistoryFile {
            server_id,
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let mut file: ChatHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Apply pagination
    let total = file.entries.len();
    let start = offset as usize;
    let end = (offset + limit) as usize;

    if start >= total {
        file.entries = Vec::new();
    } else {
        file.entries = file.entries[start..end.min(total)].to_vec();
    }

    Ok(file)
}

#[tauri::command]
pub fn save_chat_history(server_id: String, entries: Vec<ChatHistoryEntry>) -> Result<(), String> {
    let path = get_chat_history_path(&server_id)?;

    // Enforce storage limit - keep only last MAX_CHAT_ENTRIES
    let entries = if entries.len() > MAX_CHAT_ENTRIES {
        entries[entries.len() - MAX_CHAT_ENTRIES..].to_vec()
    } else {
        entries
    };

    let file = ChatHistoryFile {
        server_id,
        entries,
        version: "1.0".to_string(),
    };

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn append_chat_entry(server_id: String, entry: ChatHistoryEntry) -> Result<(), String> {
    let path = get_chat_history_path(&server_id)?;

    // Load existing or create new
    let mut file = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            ChatHistoryFile {
                server_id: server_id.clone(),
                entries: Vec::new(),
                version: "1.0".to_string(),
            }
        } else {
            serde_json::from_str(&content).map_err(|e| e.to_string())?
        }
    } else {
        ChatHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        }
    };

    // Check storage limit
    if file.entries.len() >= MAX_CHAT_ENTRIES {
        // Remove oldest entry
        file.entries.remove(0);
    }

    file.entries.push(entry);

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn cleanup_chat_history(server_id: String, keep_last: u32) -> Result<(), String> {
    let path = get_chat_history_path(&server_id)?;

    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut file: ChatHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let keep = keep_last as usize;
    if file.entries.len() > keep {
        file.entries = file.entries[file.entries.len() - keep..].to_vec();
        atomic_write_json(&path, &file)?;
    }

    Ok(())
}
```

### Step 4: Add Tauri commands for command cards

- [ ] **Add to `src-tauri/src/memory.rs` - command card commands**

```rust
#[tauri::command]
pub fn load_command_cards(server_id: String) -> Result<CommandCardFile, String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Ok(CommandCardFile {
            server_id,
            cards: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(CommandCardFile {
            server_id,
            cards: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_command_cards(server_id: String, cards: Vec<CommandCard>) -> Result<(), String> {
    let path = get_command_cards_path(&server_id)?;

    // Enforce storage limit
    let cards = if cards.len() > MAX_COMMAND_CARDS {
        cards[cards.len() - MAX_COMMAND_CARDS..].to_vec()
    } else {
        cards
    };

    let file = CommandCardFile {
        server_id,
        cards,
        version: "1.0".to_string(),
    };

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn add_command_card(card: CommandCard) -> Result<(), String> {
    let path = get_command_cards_path(&card.server_id)?;

    // Load existing or create new
    let mut file = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            CommandCardFile {
                server_id: card.server_id.clone(),
                cards: Vec::new(),
                version: "1.0".to_string(),
            }
        } else {
            serde_json::from_str(&content).map_err(|e| e.to_string())?
        }
    } else {
        CommandCardFile {
            server_id: card.server_id.clone(),
            cards: Vec::new(),
            version: "1.0".to_string(),
        }
    };

    // Check storage limit
    if file.cards.len() >= MAX_COMMAND_CARDS {
        return Err("Maximum command cards limit (500) reached".to_string());
    }

    // Check for duplicate (same server_id + command)
    let is_duplicate = file.cards.iter().any(|c| c.server_id == card.server_id && c.command == card.command);
    if is_duplicate {
        return Err("Command card already exists".to_string());
    }

    file.cards.push(card);

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn remove_command_card(card_id: String, server_id: String) -> Result<(), String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    file.cards.retain(|c| c.id != card_id);

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn update_card_usage(card_id: String, server_id: String) -> Result<(), String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    for card in &mut file.cards {
        if card.id == card_id {
            card.usage_count += 1;
            card.last_used = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            break;
        }
    }

    atomic_write_json(&path, &file)
}

#[tauri::command]
pub fn get_command_card(card_id: String, server_id: String) -> Result<Option<CommandCard>, String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(None);
    }

    let file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    Ok(file.cards.into_iter().find(|c| c.id == card_id))
}
```

### Step 5: Add cleanup command and expose is_dangerous_command

- [ ] **Add to `src-tauri/src/memory.rs` - cleanup and public API**

```rust
#[tauri::command]
pub fn cleanup_server_memory(server_id: String) -> Result<(), String> {
    let chat_path = get_chat_history_path(&server_id)?;
    let cards_path = get_command_cards_path(&server_id)?;

    if chat_path.exists() {
        fs::remove_file(&chat_path).map_err(|e| e.to_string())?;
    }

    if cards_path.exists() {
        fs::remove_file(&cards_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn determine_command_danger_level(command: String) -> Result<String, String> {
    let level = determine_danger_level(&command);
    Ok(level.as_str().to_string())
}
```

### Step 6: Modify ssh.rs to expose is_dangerous_command publicly

- [ ] **Modify `src-tauri/src/ssh.rs:841-870`**

Find the function `is_dangerous_command` (private, line 841) and rename it to `is_dangerous_command_public` and make it `pub fn`. Also rename the internal call sites.

Actually, looking at the code, `is_dangerous_command` is at line 841 and `check_dangerous_command` at line 868 is already public. Let me modify `check_dangerous_command` to be the public interface and update the internal calls.

```rust
// Change line 841 from:
fn is_dangerous_command(command: &str) -> bool {
// To:
pub fn is_dangerous_command_public(command: &str) -> bool {

// Change line 246 from:
let is_dangerous = is_dangerous_command(command);
// To:
let is_dangerous = is_dangerous_command_public(command);

// Change line 663 from:
is_dangerous: is_dangerous_command(command),
// To:
is_dangerous: is_dangerous_command_public(command),

// Change line 869 from:
pub fn check_dangerous_command(command: &str) -> bool {
    is_dangerous_command(command)
// To:
pub fn check_dangerous_command(command: &str) -> bool {
    is_dangerous_command_public(command)
```

### Step 7: Register memory module in lib.rs

- [ ] **Modify `src-tauri/src/lib.rs:1-7`**

Add `mod memory;` after `mod learning;`:

```rust
mod commands;
mod commands_db;
mod crypto;
mod ssh;
mod ai;
mod learning;
mod memory;  // NEW
```

Then add memory commands to the invoke_handler:

```rust
#[tauri::command]
fn memory_cleanup_server_memory(server_id: String) -> Result<(), String> {
    memory::cleanup_server_memory(server_id)
}
```

And in the `invoke_handler` closure, add:
```rust
memory::load_chat_history,
memory::save_chat_history,
memory::append_chat_entry,
memory::cleanup_chat_history,
memory::load_command_cards,
memory::save_command_cards,
memory::add_command_card,
memory::remove_command_card,
memory::update_card_usage,
memory::get_command_card,
memory::cleanup_server_memory,
memory::determine_command_danger_level,
```

### Step 8: Verify Rust compiles

- [ ] **Run `cargo check` in src-tauri**

Run: `cd /Users/xumx/Documents/ai-coding/LazyShell/src-tauri && cargo check`
Expected: No errors

### Step 9: Commit chunk 1

```bash
git add src-tauri/src/memory.rs src-tauri/src/lib.rs src-tauri/src/ssh.rs
git commit -m "feat(memory): add Rust backend for chat history and command cards

- Add memory.rs with DangerLevel, CommandCategory enums
- Add ChatHistoryEntry, CommandCard, ChatHistoryFile, CommandCardFile structs
- Add atomic_write_json for safe file operations
- Add Tauri commands: load/save/append chat, load/save/add/remove/update cards
- Add cleanup_server_memory for orphan file removal
- Add determine_command_danger_level for 3-level danger detection
- Expose is_dangerous_command_public in ssh.rs for reuse
- Register memory module and commands in lib.rs"
```

---

## Chunk 2: TypeScript Types

**Files:**
- Modify: `src/types/index.ts:1-184`

### Step 1: Add new types to index.ts

- [ ] **Modify `src/types/index.ts`**

Add after line 102 (after `LearningDataEntry`):

```typescript
// NEW: Danger level for command cards
export type DangerLevel = 'green' | 'yellow' | 'red';

// NEW: Command categories
export type CommandCategory = 'file' | 'text' | 'system' | 'network' | 'process' | 'archive' | 'disk' | 'package' | 'other';

// NEW: Chat history entry
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

// NEW: Command card
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

// MODIFY: Extend ChatMessage with dangerLevel
export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  command?: string;
  explanation?: string;
  isDangerous?: boolean;      // Keep for backward compatibility
  dangerLevel?: DangerLevel;  // NEW: 3-level danger
  timestamp: number;
}
```

### Step 2: Verify TypeScript compiles

- [ ] **Run `npm run lint` or TypeScript check**

Run: `cd /Users/xumx/Documents/ai-coding/LazyShell && npx tsc --noEmit`
Expected: No errors (or only existing errors)

### Step 3: Commit chunk 2

```bash
git add src/types/index.ts
git commit -m "feat(types): add TypeScript types for memory system

- Add DangerLevel, CommandCategory types
- Add ChatHistoryEntry, CommandCard interfaces
- Extend ChatMessage with dangerLevel field"
```

---

## Chunk 3: useMemory Hook

**Files:**
- Create: `src/hooks/useMemory.ts`

### Step 1: Create useMemory.ts hook

- [ ] **Create `src/hooks/useMemory.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatHistoryEntry, CommandCard, DangerLevel } from '../types';

interface UseMemoryOptions {
  serverId: string;
}

interface ChatHistoryFile {
  server_id: string;
  entries: ChatHistoryEntry[];
  version: string;
}

interface CommandCardFile {
  server_id: string;
  cards: CommandCard[];
  version: string;
}

export function useMemory({ serverId }: UseMemoryOptions) {
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [commandCards, setCommandCards] = useState<CommandCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load chat history
  const loadChatHistory = useCallback(async (offset = 0, limit = 50) => {
    try {
      const result = await invoke<ChatHistoryFile>('load_chat_history', {
        serverId,
        offset,
        limit,
      });
      setChatHistory(prev => offset === 0 ? result.entries : [...prev, ...result.entries]);
      return result;
    } catch (err) {
      console.error('Failed to load chat history:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Append chat entry
  const appendChatEntry = useCallback(async (entry: Omit<ChatHistoryEntry, 'id' | 'timestamp'>) => {
    const newEntry: ChatHistoryEntry = {
      ...entry,
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      timestamp: Date.now(),
    };

    try {
      await invoke('append_chat_entry', { serverId, entry: newEntry });
      setChatHistory(prev => [...prev, newEntry]);
      return newEntry;
    } catch (err) {
      console.error('Failed to append chat entry:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Load command cards
  const loadCommandCards = useCallback(async () => {
    try {
      const result = await invoke<CommandCardFile>('load_command_cards', { serverId });
      setCommandCards(result.cards);
      return result.cards;
    } catch (err) {
      console.error('Failed to load command cards:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Add command card
  const addCommandCard = useCallback(async (card: Omit<CommandCard, 'id' | 'usageCount' | 'createdAt' | 'lastUsed'>) => {
    const newCard: CommandCard = {
      ...card,
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };

    try {
      await invoke('add_command_card', { card: newCard });
      setCommandCards(prev => [...prev, newCard]);
      return newCard;
    } catch (err) {
      console.error('Failed to add command card:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Remove command card
  const removeCommandCard = useCallback(async (cardId: string) => {
    try {
      await invoke('remove_command_card', { cardId, serverId });
      setCommandCards(prev => prev.filter(c => c.id !== cardId));
    } catch (err) {
      console.error('Failed to remove command card:', err);
      setError(String(err));
      throw err;
    }
  }, [serverId]);

  // Update card usage
  const updateCardUsage = useCallback(async (cardId: string) => {
    try {
      await invoke('update_card_usage', { cardId, serverId });
      setCommandCards(prev => prev.map(c =>
        c.id === cardId
          ? { ...c, usageCount: c.usageCount + 1, lastUsed: Date.now() }
          : c
      ));
    } catch (err) {
      console.error('Failed to update card usage:', err);
      // Non-critical, don't throw
    }
  }, [serverId]);

  // Determine danger level
  const getDangerLevel = useCallback(async (command: string): Promise<DangerLevel> => {
    try {
      const level = await invoke<string>('determine_command_danger_level', { command });
      return level as DangerLevel;
    } catch (err) {
      console.error('Failed to determine danger level:', err);
      return 'yellow'; // Default to yellow on error
    }
  }, []);

  // Initial load
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        await Promise.all([loadChatHistory(0, 100), loadCommandCards()]);
      } catch {
        // Errors handled in individual functions
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [serverId, loadChatHistory, loadCommandCards]);

  return {
    chatHistory,
    commandCards,
    isLoading,
    error,
    loadChatHistory,
    appendChatEntry,
    loadCommandCards,
    addCommandCard,
    removeCommandCard,
    updateCardUsage,
    getDangerLevel,
  };
}
```

### Step 2: Verify TypeScript compiles

- [ ] **Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

### Step 3: Commit chunk 3

```bash
git add src/hooks/useMemory.ts
git commit -m "feat(hooks): add useMemory hook for chat history and command cards

- useMemory hook for loading/saving chat history
- Functions for adding/removing/updating command cards
- getDangerLevel for determining command danger level
- Automatic initial loading of chat and cards"
```

---

## Chunk 4: CommandCard Component

**Files:**
- Create: `src/components/CommandCard.tsx`

### Step 1: Create CommandCard.tsx component

- [ ] **Create `src/components/CommandCard.tsx`**

```typescript
import type { CommandCard as CommandCardType, DangerLevel } from '../types';

interface CommandCardProps {
  card: CommandCardType;
  onExecute?: (command: string) => void;
  onAddTo常用?: (card: CommandCardType) => void;
  onDelete?: (cardId: string) => void;
}

const dangerColors: Record<DangerLevel, string> = {
  green: '#0dbc79',
  yellow: '#e5e510',
  red: '#cd3131',
};

const dangerLabels: Record<DangerLevel, string> = {
  green: '安全',
  yellow: '谨慎',
  red: '危险',
};

const categoryIcons: Record<string, string> = {
  file: '📁',
  text: '📝',
  system: '⚙️',
  network: '🌐',
  process: '📊',
  archive: '📦',
  disk: '💾',
  package: '📦',
  other: '📋',
};

export function CommandCard({ card, onExecute, onAddTo常用, onDelete }: CommandCardProps) {
  const dangerLevel = card.dangerLevel as DangerLevel;
  const color = dangerColors[dangerLevel] || dangerColors.yellow;
  const label = dangerLabels[dangerLevel] || '谨慎';
  const icon = categoryIcons[card.category] || categoryIcons.other;

  return (
    <div className="command-card" style={{ borderLeftColor: color }}>
      <div className="command-card-header">
        <span className="command-card-icon">{icon}</span>
        <span className="command-card-category">{label}</span>
        <span className="command-card-description">{card.naturalLanguage}</span>
      </div>

      <div className="command-card-body">
        <code className="command-card-command">{card.command}</code>
        {card.description && (
          <p className="command-card-explanation">{card.description}</p>
        )}
      </div>

      <div className="command-card-actions">
        {onAddTo常用 && (
          <button
            className="btn btn-secondary"
            onClick={() => onAddTo常用(card)}
            title="添加到常用"
          >
            ⭐ 添加
          </button>
        )}
        {onExecute && (
          <button
            className={`btn ${dangerLevel === 'red' ? 'btn-danger' : dangerLevel === 'yellow' ? 'btn-warning' : 'btn-primary'}`}
            onClick={() => onExecute(card.command)}
          >
            ▶ 执行
          </button>
        )}
        {onDelete && (
          <button
            className="btn btn-danger"
            onClick={() => onDelete(card.id)}
            title="删除"
          >
            🗑️
          </button>
        )}
      </div>

      <div className="command-card-footer">
        <span className="command-card-stats">
          使用 {card.usageCount} 次
        </span>
      </div>
    </div>
  );
}
```

### Step 2: Add CSS styles

- [ ] **Add to existing CSS or create component styles**

```css
/* CommandCard styles */
.command-card {
  background: #252526;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
  border-left: 4px solid #0dbc79;
}

.command-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.command-card-icon {
  font-size: 16px;
}

.command-card-category {
  font-size: 12px;
  color: #e4e4e4;
  font-weight: 500;
}

.command-card-description {
  font-size: 13px;
  color: #cccccc;
  flex: 1;
}

.command-card-body {
  margin-bottom: 12px;
}

.command-card-command {
  display: block;
  background: #1e1e1e;
  padding: 8px 12px;
  border-radius: 4px;
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 13px;
  color: #e4e4e4;
  word-break: break-all;
}

.command-card-explanation {
  margin-top: 8px;
  font-size: 13px;
  color: #999;
}

.command-card-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.command-card-footer {
  margin-top: 8px;
  font-size: 11px;
  color: #666;
  text-align: right;
}

.command-card-stats {
  opacity: 0.7;
}
```

### Step 3: Commit chunk 4

```bash
git add src/components/CommandCard.tsx
git commit -m "feat(ui): add CommandCard component

- Display command card with danger level color indicator
- Show category icon, description, and command
- Action buttons: add to favorites, execute, delete
- Usage count display
- Styles with left border color based on danger level"
```

---

## Chunk 5: Enhanced AIChat Component

**Files:**
- Modify: `src/components/AIChat.tsx`
- Modify: `src/App.tsx` (to pass serverId)

### Step 1: Update AIChat props interface

- [ ] **Modify `src/components/AIChat.tsx:6-14`**

```typescript
interface AIChatProps {
  providerManager: AIProviderManager;
  context: TerminalContext;
  tabId: string;
  serverId: string;  // NEW: server identifier for persistence
  onCommandExecute: (command: string, naturalLanguage?: string) => void;
  commandDb?: {
    search: (keyword: string) => Promise<BuiltinCommand[]>;
  };
}
```

### Step 2: Add new state and useMemory hook

- [ ] **Modify `src/components/AIChat.tsx:16-31`**

Add new state and useMemory hook:

```typescript
export function AIChat({ providerManager, context, tabId, serverId, onCommandExecute, commandDb }: AIChatProps) {
  // ... existing state ...

  // NEW: Tab state for floating tabs
  const [activeTab, setActiveTab] = useState<'chat' | 'history' | 'commands'>('chat');
  const [historyPanelCollapsed, setHistoryPanelCollapsed] = useState(true);

  // NEW: Use memory hook for persistence
  const {
    chatHistory,
    commandCards,
    appendChatEntry,
    addCommandCard,
    removeCommandCard,
    updateCardUsage,
    getDangerLevel,
  } = useMemory({ serverId });
```

### Step 3: Add floating tabs UI

- [ ] **Add after chat-messages div (around line 251)**

```typescript
// NEW: Floating tabs
<div className="ai-chat-tabs">
  <button
    className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
    onClick={() => setActiveTab('chat')}
  >
    💬 聊天
  </button>
  <button
    className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
    onClick={() => setActiveTab('history')}
  >
    📜 历史
  </button>
  <button
    className={`tab-btn ${activeTab === 'commands' ? 'active' : ''}`}
    onClick={() => setActiveTab('commands')}
  >
    📋 常用
  </button>
  <button
    className="tab-btn collapse-btn"
    onClick={() => setHistoryPanelCollapsed(!historyPanelCollapsed)}
  >
    {historyPanelCollapsed ? '◀' : '▶'}
  </button>
</div>

// NEW: History panel (right side)
{!historyPanelCollapsed && (
  <div className="ai-chat-history-panel">
    <div className="history-header">
      <span>历史记录</span>
      <button onClick={() => setHistoryPanelCollapsed(true)}>✕</button>
    </div>
    <div className="history-list">
      {chatHistory.slice(-50).reverse().map((entry) => (
        <div key={entry.id} className="history-entry">
          <span className="history-role">{entry.role === 'user' ? '你' : 'AI'}</span>
          <span className="history-content">{entry.content.slice(0, 50)}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

### Step 4: Update message display with danger level

- [ ] **Modify message rendering (around line 252-264)**

Update to show danger level indicator on AI messages with commands:

```typescript
<div key={msg.id} className={`message message-${msg.role}`}>
  <div className="message-role">{msg.role === 'user' ? '你' : 'AI'}</div>
  <div className="message-content">
    {msg.content}
    {msg.command && (
      <div className={`command-preview danger-${msg.dangerLevel || 'yellow'}`}>
        <div className="command-preview-header">
          <span className={`danger-indicator ${msg.dangerLevel || 'yellow'}`} />
          <code>{msg.command}</code>
        </div>
        {msg.explanation && <p className="command-explanation">{msg.explanation}</p>}
      </div>
    )}
  </div>
</div>
```

### Step 5: Add "Add to 常用" button and enhance option cards

- [ ] **Modify command options rendering (around line 291-310)**

Replace with expanded card style:

```typescript
{commandOptions.length > 0 && (
  <div className="command-options">
    <div className="options-header">请选择要执行的命令：</div>
    {commandOptions.map((option, idx) => (
      <div key={idx} className={`command-option-card ${option.isDangerous ? 'danger' : 'safe'}`}>
        <div className="option-header">
          <span className={`danger-badge ${option.isDangerous ? 'red' : 'green'}`}>
            {option.isDangerous ? '🔴 危险' : '🟢 安全'}
          </span>
          <span className="option-description">{option.description}</span>
        </div>
        <code className="option-command">{option.command}</code>
        {option.reason && <p className="option-reason">{option.reason}</p>}
        <div className="option-actions">
          <button
            className="btn btn-secondary"
            onClick={() => addTo常用(option)}
          >
            ⭐ 添加
          </button>
          <button
            className={`btn ${option.isDangerous ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => handleOptionExecute(option)}
          >
            ▶ 执行
          </button>
        </div>
      </div>
    ))}
  </div>
)}
```

Add helper function:

```typescript
const addTo常用 = useCallback(async (option: AICommandOption) => {
  const dangerLevel = await getDangerLevel(option.command);
  const card: Omit<CommandCard, 'id' | 'usageCount' | 'createdAt' | 'lastUsed'> = {
    serverId,
    naturalLanguage: lastUserInput || option.description,
    command: option.command,
    description: option.description,
    dangerLevel,
    category: 'other',
  };
  await addCommandCard(card);
}, [serverId, lastUserInput, addCommandCard, getDangerLevel]);
```

### Step 6: Add tab content panels

- [ ] **Add before chat-input-form (around line 314)**

```typescript
{/* Tab content panels */}
{activeTab === 'commands' && (
  <div className="commands-panel">
    <div className="panel-header">常用命令</div>
    {commandCards.length === 0 ? (
      <div className="empty-state">
        <p>暂无常用命令</p>
        <p className="hint">执行 AI 命令后可点击"添加"收藏</p>
      </div>
    ) : (
      <div className="commands-list">
        {commandCards.map((card) => (
          <CommandCard
            key={card.id}
            card={card}
            onExecute={(cmd) => {
              invoke('shell_input', { tabId, data: cmd + '\r' });
              updateCardUsage(card.id);
            }}
            onDelete={removeCommandCard}
          />
        ))}
      </div>
    )}
  </div>
)}

{activeTab === 'history' && (
  <div className="history-panel">
    <div className="panel-header">聊天历史</div>
    {chatHistory.length === 0 ? (
      <div className="empty-state">
        <p>暂无历史记录</p>
      </div>
    ) : (
      <div className="history-list">
        {chatHistory.slice(-100).reverse().map((entry) => (
          <div key={entry.id} className="history-item">
            <div className="history-item-header">
              <span className="history-role">{entry.role === 'user' ? '你' : 'AI'}</span>
              <span className="history-time">
                {new Date(entry.timestamp).toLocaleString()}
              </span>
            </div>
            <div className="history-item-content">{entry.content}</div>
            {entry.command && (
              <code className="history-command">{entry.command}</code>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

### Step 7: Update App.tsx to pass serverId

- [ ] **Modify `src/App.tsx`** to pass serverId to AIChat

First, find where AIChat is rendered and add serverId prop:

```typescript
// Find the AIChat component usage and add serverId
<AIChat
  providerManager={providerManager}
  context={terminalContext}
  tabId={activeTab.id}
  serverId={activeTab.serverId}  // NEW
  onCommandExecute={handleCommandExecute}
  commandDb={commandDbProps}
/>
```

### Step 8: Add CSS styles for enhanced AIChat

- [ ] **Add to CSS file**

```css
/* AI Chat enhanced styles */
.ai-chat-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  background: #252526;
  border-bottom: 1px solid #3c3c3c;
}

.tab-btn {
  background: transparent;
  border: none;
  color: #888;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.tab-btn:hover {
  background: #3c3c3c;
  color: #e4e4e4;
}

.tab-btn.active {
  background: #3c3c3c;
  color: #fff;
}

.tab-btn.collapse-btn {
  margin-left: auto;
}

/* History panel */
.ai-chat-history-panel {
  width: 280px;
  background: #252526;
  border-left: 1px solid #3c3c3c;
  display: flex;
  flex-direction: column;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid #3c3c3c;
  font-weight: 500;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.history-entry {
  padding: 8px;
  border-bottom: 1px solid #3c3c3c;
  font-size: 12px;
}

.history-role {
  font-weight: 500;
  color: #888;
}

.history-content {
  color: #ccc;
  display: block;
  margin-top: 4px;
}

/* Command option card */
.command-option-card {
  background: #252526;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
  border-left: 4px solid #0dbc79;
}

.command-option-card.danger {
  border-left-color: #cd3131;
}

.option-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.danger-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
}

.danger-badge.red {
  background: rgba(205, 49, 49, 0.2);
  color: #f14c4c;
}

.danger-badge.green {
  background: rgba(13, 188, 121, 0.2);
  color: #23d18b;
}

.option-command {
  display: block;
  background: #1e1e1e;
  padding: 8px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  margin-bottom: 8px;
}

.option-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* Commands panel */
.commands-panel,
.history-panel {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.panel-header {
  font-weight: 500;
  margin-bottom: 12px;
  color: #e4e4e4;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #666;
}

.empty-state .hint {
  font-size: 12px;
  margin-top: 8px;
}

.commands-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* History panel items */
.history-item {
  background: #1e1e1e;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
}

.history-item-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.history-time {
  font-size: 11px;
  color: #666;
}

.history-command {
  display: block;
  background: #252526;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  margin-top: 8px;
}
```

### Step 9: Verify builds

- [ ] **Run cargo check and npm run lint**

Run: `cd /Users/xumx/Documents/ai-coding/LazyShell/src-tauri && cargo check`
Run: `cd /Users/xumx/Documents/ai-coding/LazyShell && npm run lint`

Expected: No errors

### Step 10: Commit chunk 5

```bash
git add src/components/AIChat.tsx src/components/CommandCard.tsx src/App.tsx
git commit -m "feat(ai-chat): enhance AIChat with tabs, command cards, history

- Add floating tabs: chat, history, commands
- Add collapsible history panel
- Update command options to expanded card style
- Add danger level indicators on messages
- Add 'add to favorites' functionality
- Integrate useMemory hook for persistence
- Add CommandCard component to commands panel
- Pass serverId to AIChat for memory persistence"
```

---

## Chunk 6: Integration with Server Deletion

**Files:**
- Modify: `src-tauri/src/commands.rs`

### Step 1: Add cleanup call to remove_server

- [ ] **Modify `src-tauri/src/commands.rs`**

Find the `remove_server` function and add memory cleanup:

```rust
// At the top of commands.rs, add:
use crate::memory;

// In remove_server function, after successful server removal:
let _ = memory::cleanup_server_memory(server_id.clone());
```

### Step 2: Commit chunk 6

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(integration): cleanup memory when server is deleted

- Call cleanup_server_memory in remove_server
- Prevent orphaned chat history and command card files"
```

---

## Verification

### Step 1: Build verification

- [ ] Run `cargo check` in src-tauri
- [ ] Run `npm run lint` in project root
- [ ] Run `npm run tauri:dev` to start the app

### Step 2: Manual testing checklist

- [ ] Connect to a server
- [ ] Open AI chat
- [ ] Enter "查看系统进程" and verify yellow command card appears
- [ ] Click "添加到常用" and verify card appears in 常用 tab
- [ ] Switch to 历史 tab and verify chat history shows
- [ ] Enter "rm -rf /tmp/test" and verify red danger indicator
- [ ] Restart app and verify history and cards persist
- [ ] Delete server and verify orphaned files are cleaned

---

## Summary

| Chunk | Description | Files |
|-------|-------------|-------|
| 1 | Rust memory.rs module | src-tauri/src/memory.rs, lib.rs, ssh.rs |
| 2 | TypeScript types | src/types/index.ts |
| 3 | useMemory hook | src/hooks/useMemory.ts |
| 4 | CommandCard component | src/components/CommandCard.tsx |
| 5 | Enhanced AIChat | src/components/AIChat.tsx, CommandCard.tsx, App.tsx |
| 6 | Server deletion integration | src-tauri/src/commands.rs |
