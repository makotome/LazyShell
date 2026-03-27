use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Parameter {
    pub flag: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Example {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BuiltinCommand {
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub surface: Option<String>,
    pub parameters: Vec<Parameter>,
    pub examples: Vec<Example>,
    pub scenarios: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandDatabase {
    pub version: String,
    pub commands: Vec<BuiltinCommand>,
}

// Embedded command database JSON
const COMMANDS_DB_JSON: &str = include_str!("commands_db.json");

fn parse_commands_db() -> Result<CommandDatabase, String> {
    serde_json::from_str(COMMANDS_DB_JSON).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_commands_db() -> Result<CommandDatabase, String> {
    parse_commands_db()
}

#[tauri::command]
pub fn search_commands(keyword: String) -> Result<Vec<BuiltinCommand>, String> {
    let db = parse_commands_db()?;
    let keyword_lower = keyword.to_lowercase();

    let results: Vec<BuiltinCommand> = db.commands
        .into_iter()
        .filter(|cmd| {
            // Match command name
            if cmd.name.to_lowercase().contains(&keyword_lower) {
                return true;
            }
            // Match description
            if cmd.description.to_lowercase().contains(&keyword_lower) {
                return true;
            }
            // Match scenarios
            for scenario in &cmd.scenarios {
                if scenario.to_lowercase().contains(&keyword_lower) {
                    return true;
                }
            }
            false
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn get_command_suggestions(partial: String) -> Result<Vec<String>, String> {
    let db = parse_commands_db()?;
    let partial_lower = partial.to_lowercase();

    let suggestions: Vec<String> = db.commands
        .iter()
        .filter(|cmd| cmd.name.to_lowercase().starts_with(&partial_lower))
        .map(|cmd| cmd.name.clone())
        .take(10)
        .collect();

    Ok(suggestions)
}

#[tauri::command]
pub fn get_command_by_name(name: String) -> Result<Option<BuiltinCommand>, String> {
    let db = parse_commands_db()?;
    let name_lower = name.to_lowercase();

    let cmd = db.commands
        .into_iter()
        .find(|c| c.name.to_lowercase() == name_lower);

    Ok(cmd)
}
