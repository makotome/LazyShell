use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ssh::is_dangerous_command_public;

// ============================================================================
// Constants
// ============================================================================

pub const MAX_CHAT_ENTRIES: usize = 1000;
pub const MAX_COMMAND_CARDS: usize = 500;
pub const MAX_COMMAND_HISTORY_ENTRIES: usize = 1000;
pub const MAX_FILE_SIZE_BYTES: usize = 5 * 1024 * 1024; // 5MB
pub const MAX_COMMAND_OUTPUT_CHARS: usize = 4000;

// ============================================================================
// Enums
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DangerLevel {
    Green,
    Yellow,
    Red,
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
        match s.to_lowercase().as_str() {
            "green" => DangerLevel::Green,
            "red" => DangerLevel::Red,
            _ => DangerLevel::Yellow,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
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
        match s.to_lowercase().as_str() {
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

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryOption {
    pub command: String,
    pub description: String,
    pub is_dangerous: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryEntry {
    pub id: String,
    pub server_id: String,
    pub role: String,
    pub content: String,
    pub command: Option<String>,
    pub explanation: Option<String>,
    pub danger_level: Option<String>,
    pub options: Option<Vec<ChatHistoryOption>>,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryFile {
    pub server_id: String,
    pub entries: Vec<ChatHistoryEntry>,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub command: String,
    pub output: String,
    pub exit_code: i32,
    pub timestamp: u64,
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryFile {
    pub server_id: String,
    pub entries: Vec<CommandHistoryEntry>,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct CommandCardFile {
    pub server_id: String,
    pub cards: Vec<CommandCard>,
    pub version: String,
}

// ============================================================================
// Utility Functions
// ============================================================================

pub fn get_memory_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let memory_dir = data_dir.join("LazyShell").join("memory");
    fs::create_dir_all(&memory_dir).map_err(|e| e.to_string())?;
    Ok(memory_dir)
}

pub fn sanitize_server_id(server_id: &str) -> String {
    server_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(200)
        .collect()
}

pub fn get_chat_history_path(server_id: &str) -> Result<PathBuf, String> {
    let memory_dir = get_memory_dir()?;
    let sanitized = sanitize_server_id(server_id);
    Ok(memory_dir.join(format!("{}_chats.json", sanitized)))
}

pub fn get_command_cards_path(server_id: &str) -> Result<PathBuf, String> {
    let memory_dir = get_memory_dir()?;
    let sanitized = sanitize_server_id(server_id);
    Ok(memory_dir.join(format!("{}_cards.json", sanitized)))
}

pub fn get_command_history_path(server_id: &str) -> Result<PathBuf, String> {
    let memory_dir = get_memory_dir()?;
    let sanitized = sanitize_server_id(server_id);
    Ok(memory_dir.join(format!("{}_commands.json", sanitized)))
}

pub fn atomic_write_json<T: Serialize>(path: &PathBuf, data: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;

    // Check file size limit
    if json.len() > MAX_FILE_SIZE_BYTES {
        return Err(format!(
            "Data size {} exceeds maximum allowed size {}",
            json.len(),
            MAX_FILE_SIZE_BYTES
        ));
    }

    // Write to temp file first
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, json).map_err(|e| e.to_string())?;

    // Atomically rename to target path
    fs::rename(&temp_path, path).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn determine_danger_level(command: &str) -> DangerLevel {
    // Use the blacklist check from ssh.rs
    if is_dangerous_command_public(command) {
        return DangerLevel::Red;
    }

    // Whitelist check for safe commands
    if is_safe_command(command) {
        return DangerLevel::Green;
    }

    // Default to Yellow (unknown/ potentially unsafe)
    DangerLevel::Yellow
}

pub fn is_safe_command(cmd: &str) -> bool {
    matches!(
        cmd.trim().split_whitespace().next().unwrap_or("").to_lowercase().as_str(),
        "ls" | "pwd" | "date" | "whoami" | "echo" | "cat" | "head" | "tail"
            | "grep" | "find" | "sort" | "uniq" | "wc" | "cut" | "tr"
            | "mkdir" | "touch" | "cp" | "mv" | "cd" | "history" | "man"
    )
}

fn get_current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn truncate_text(input: &str, max_chars: usize) -> String {
    let truncated: String = input.chars().take(max_chars).collect();
    if input.chars().count() > max_chars {
        format!("{}\n\n[output truncated]", truncated)
    } else {
        truncated
    }
}

fn normalize_command_history_entry(mut entry: CommandHistoryEntry) -> CommandHistoryEntry {
    entry.output = truncate_text(&entry.output, MAX_COMMAND_OUTPUT_CHARS);
    entry
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn load_chat_history(server_id: String, offset: u32, limit: u32) -> Result<ChatHistoryFile, String> {
    let path = get_chat_history_path(&server_id)?;

    if !path.exists() {
        return Ok(ChatHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(ChatHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let history_file: ChatHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Apply pagination
    let entries = history_file.entries;
    let _total = entries.len() as u32;
    let start = offset as usize;
    let end = (offset + limit) as usize;

    let paginated_entries = if start >= entries.len() {
        Vec::new()
    } else {
        entries[start..end.min(entries.len())].to_vec()
    };

    Ok(ChatHistoryFile {
        server_id,
        entries: paginated_entries,
        version: history_file.version,
    })
}

#[tauri::command]
pub fn save_chat_history(server_id: String, entries: Vec<ChatHistoryEntry>) -> Result<(), String> {
    // Enforce limit
    let entries_to_save = if entries.len() > MAX_CHAT_ENTRIES {
        entries.into_iter().rev().take(MAX_CHAT_ENTRIES).rev().collect()
    } else {
        entries
    };

    let history_file = ChatHistoryFile {
        server_id: server_id.clone(),
        entries: entries_to_save,
        version: "1.0".to_string(),
    };

    let path = get_chat_history_path(&server_id)?;
    atomic_write_json(&path, &history_file)
}

#[tauri::command]
pub fn append_chat_entry(server_id: String, entry: ChatHistoryEntry) -> Result<(), String> {
    let path = get_chat_history_path(&server_id)?;

    let mut history_file = if path.exists() {
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

    // Add new entry
    history_file.entries.push(entry);

    // Enforce limit
    if history_file.entries.len() > MAX_CHAT_ENTRIES {
        let excess = history_file.entries.len() - MAX_CHAT_ENTRIES;
        history_file.entries.drain(0..excess);
    }

    atomic_write_json(&path, &history_file)
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

    let mut history_file: ChatHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let keep = keep_last as usize;
    if history_file.entries.len() > keep {
        let excess = history_file.entries.len() - keep;
        history_file.entries.drain(0..excess);
    }

    atomic_write_json(&path, &history_file)
}

#[tauri::command]
pub fn load_command_history(server_id: String) -> Result<CommandHistoryFile, String> {
    let path = get_command_history_path(&server_id)?;

    if !path.exists() {
        return Ok(CommandHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(CommandHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let history_file: CommandHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(history_file)
}

#[tauri::command]
pub fn save_command_history(server_id: String, entries: Vec<CommandHistoryEntry>) -> Result<(), String> {
    let normalized_entries = entries.into_iter().map(normalize_command_history_entry).collect::<Vec<_>>();

    let entries_to_save = if normalized_entries.len() > MAX_COMMAND_HISTORY_ENTRIES {
        normalized_entries.into_iter().rev().take(MAX_COMMAND_HISTORY_ENTRIES).rev().collect()
    } else {
        normalized_entries
    };

    let history_file = CommandHistoryFile {
        server_id: server_id.clone(),
        entries: entries_to_save,
        version: "1.0".to_string(),
    };

    let path = get_command_history_path(&server_id)?;
    atomic_write_json(&path, &history_file)
}

#[tauri::command]
pub fn append_command_history(server_id: String, entry: CommandHistoryEntry) -> Result<(), String> {
    let path = get_command_history_path(&server_id)?;

    let mut history_file = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            CommandHistoryFile {
                server_id: server_id.clone(),
                entries: Vec::new(),
                version: "1.0".to_string(),
            }
        } else {
            serde_json::from_str(&content).map_err(|e| e.to_string())?
        }
    } else {
        CommandHistoryFile {
            server_id: server_id.clone(),
            entries: Vec::new(),
            version: "1.0".to_string(),
        }
    };

    history_file.entries.push(normalize_command_history_entry(entry));

    if history_file.entries.len() > MAX_COMMAND_HISTORY_ENTRIES {
        let excess = history_file.entries.len() - MAX_COMMAND_HISTORY_ENTRIES;
        history_file.entries.drain(0..excess);
    }

    atomic_write_json(&path, &history_file)
}

#[tauri::command]
pub fn cleanup_command_history(server_id: String, keep_last: u32) -> Result<(), String> {
    let path = get_command_history_path(&server_id)?;

    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut history_file: CommandHistoryFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let keep = keep_last as usize;
    if history_file.entries.len() > keep {
        let excess = history_file.entries.len() - keep;
        history_file.entries.drain(0..excess);
    }

    atomic_write_json(&path, &history_file)
}

#[tauri::command]
pub fn load_command_cards(server_id: String) -> Result<CommandCardFile, String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Ok(CommandCardFile {
            server_id: server_id.clone(),
            cards: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(CommandCardFile {
            server_id: server_id.clone(),
            cards: Vec::new(),
            version: "1.0".to_string(),
        });
    }

    let cards_file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(cards_file)
}

#[tauri::command]
pub fn save_command_cards(server_id: String, cards: Vec<CommandCard>) -> Result<(), String> {
    // Enforce limit
    let cards_to_save = if cards.len() > MAX_COMMAND_CARDS {
        cards.into_iter().rev().take(MAX_COMMAND_CARDS).rev().collect()
    } else {
        cards
    };

    let cards_file = CommandCardFile {
        server_id: server_id.clone(),
        cards: cards_to_save,
        version: "1.0".to_string(),
    };

    let path = get_command_cards_path(&server_id)?;
    atomic_write_json(&path, &cards_file)
}

#[tauri::command]
pub fn add_command_card(card: CommandCard) -> Result<(), String> {
    let path = get_command_cards_path(&card.server_id)?;

    let mut cards_file = if path.exists() {
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

    // Check if card with same id or same command already exists
    if let Some(existing) = cards_file.cards.iter_mut().find(|c| c.id == card.id || c.command.trim() == card.command.trim()) {
        // Update existing card's usage and timestamp
        existing.usage_count += 1;
        existing.last_used = get_current_timestamp();
    } else {
        // Enforce limit
        if cards_file.cards.len() >= MAX_COMMAND_CARDS {
            let excess = cards_file.cards.len() - MAX_COMMAND_CARDS + 1;
            cards_file.cards.drain(0..excess);
        }
        cards_file.cards.push(card);
    }

    atomic_write_json(&path, &cards_file)
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

    let mut cards_file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    cards_file.cards.retain(|c| c.id != card_id);

    atomic_write_json(&path, &cards_file)
}

#[tauri::command]
pub fn update_command_card(card: CommandCard) -> Result<(), String> {
    let path = get_command_cards_path(&card.server_id)?;

    if !path.exists() {
        return Err("Command cards file not found".to_string());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Err("Command cards file is empty".to_string());
    }

    let mut cards_file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let existing = cards_file
        .cards
        .iter_mut()
        .find(|existing_card| existing_card.id == card.id)
        .ok_or("Command card not found".to_string())?;

    existing.natural_language = card.natural_language;
    existing.command = card.command;
    existing.description = card.description;
    existing.danger_level = card.danger_level;
    existing.category = card.category;
    existing.last_used = get_current_timestamp();

    atomic_write_json(&path, &cards_file)
}

#[tauri::command]
pub fn update_card_usage(card_id: String, server_id: String) -> Result<(), String> {
    let path = get_command_cards_path(&server_id)?;

    if !path.exists() {
        return Err("Command cards file not found".to_string());
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Err("Command cards file is empty".to_string());
    }

    let mut cards_file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let timestamp = get_current_timestamp();

    for card in &mut cards_file.cards {
        if card.id == card_id {
            card.usage_count += 1;
            card.last_used = timestamp;
            break;
        }
    }

    atomic_write_json(&path, &cards_file)
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

    let cards_file: CommandCardFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    Ok(cards_file.cards.into_iter().find(|c| c.id == card_id))
}

#[tauri::command]
pub fn cleanup_server_memory(server_id: String) -> Result<(), String> {
    let chat_path = get_chat_history_path(&server_id)?;
    let cards_path = get_command_cards_path(&server_id)?;
    let command_history_path = get_command_history_path(&server_id)?;

    if chat_path.exists() {
        fs::remove_file(&chat_path).map_err(|e| e.to_string())?;
    }

    if cards_path.exists() {
        fs::remove_file(&cards_path).map_err(|e| e.to_string())?;
    }

    if command_history_path.exists() {
        fs::remove_file(&command_history_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn determine_command_danger_level(command: String) -> Result<String, String> {
    let level = determine_danger_level(&command);
    Ok(level.as_str().to_string())
}
