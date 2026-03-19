use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LearningDataEntry {
    pub id: String,
    pub natural_language: String,
    pub command: String,
    pub server_os: String,
    pub usage_count: u32,
    pub last_used: u64,
}

fn get_learning_file_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell");
    fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join("learning_data.json"))
}

#[tauri::command]
pub fn save_learning_data(entries: Vec<LearningDataEntry>) -> Result<(), String> {
    let path = get_learning_file_path()?;
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_learning_data() -> Result<Vec<LearningDataEntry>, String> {
    let path = get_learning_file_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<LearningDataEntry> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(entries)
}
