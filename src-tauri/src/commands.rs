use crate::crypto::{auth_file_exists, decrypt_server_config, encrypt_server_config, verify_password, setup_password};
use crate::ssh::{check_dangerous_command, AuthMethod, CommandOutput, ServerBanner, ServerConfig, SSHConnection, SSHConnectionManager};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

pub struct AppState {
    pub ssh_manager: SSHConnectionManager,
    pub master_password: Mutex<Option<String>>,
    pub encrypted_servers: Mutex<Vec<u8>>,
    pub is_unlocked: Mutex<bool>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            ssh_manager: SSHConnectionManager::new(),
            master_password: Mutex::new(None),
            encrypted_servers: Mutex::new(Vec::new()),
            is_unlocked: Mutex::new(false),
        }
    }
}

fn get_servers_file_path() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join("servers.enc"))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AddServerRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethodInput,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethodInput {
    Password { password: String },
    PrivateKey { key_data: String, passphrase: Option<String> },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
}

impl From<&ServerConfig> for ServerInfo {
    fn from(config: &ServerConfig) -> Self {
        let auth_type = match &config.auth_method {
            AuthMethod::Password { .. } => "password".to_string(),
            AuthMethod::PrivateKey { .. } => "private_key".to_string(),
        };
        Self {
            id: config.id.clone(),
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            auth_type,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecuteCommandRequest {
    pub server_id: String,
    pub command: String,
    pub force_dangerous: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub output: Option<CommandOutput>,
    pub error: Option<String>,
    pub requires_confirmation: bool,
}

#[tauri::command]
pub fn set_master_password(
    password: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut mp = state.master_password.lock().map_err(|e| e.to_string())?;
    *mp = Some(password);
    Ok(())
}

#[tauri::command]
pub fn verify_master_password(
    password: String,
    state: State<AppState>,
) -> Result<bool, String> {
    let mp = state.master_password.lock().map_err(|e| e.to_string())?;
    Ok(mp.as_ref() == Some(&password))
}

#[tauri::command]
pub fn has_master_password() -> Result<bool, String> {
    Ok(auth_file_exists())
}

#[tauri::command]
pub fn setup_master_password(
    password: String,
    state: State<AppState>,
) -> Result<(), String> {
    // Setup the auth file with verification hash
    setup_password(&password).map_err(|e| e.to_string())?;

    // Store password in memory for later use
    let mut mp = state.master_password.lock().map_err(|e| e.to_string())?;
    *mp = Some(password);

    // Mark as unlocked
    let mut unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
    *unlocked = true;

    Ok(())
}

#[tauri::command]
pub fn unlock_with_password(
    password: String,
    state: State<AppState>,
) -> Result<bool, String> {
    // Verify password against stored auth data
    match verify_password(&password) {
        Ok(true) => {
            // Password correct - store in memory
            let mut mp = state.master_password.lock().map_err(|e| e.to_string())?;
            *mp = Some(password);

            // Mark as unlocked
            let mut unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
            *unlocked = true;

            Ok(true)
        }
        Ok(false) => {
            // Password incorrect
            Ok(false)
        }
        Err(e) => {
            Err(format!("Failed to verify password: {}", e))
        }
    }
}

#[tauri::command]
pub fn add_server(
    request: AddServerRequest,
    state: State<AppState>,
) -> Result<ServerInfo, String> {
    // Check if unlocked
    let is_unlocked = {
        let unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
        *unlocked
    };

    if !is_unlocked {
        return Err("App is locked. Please unlock first.".to_string());
    }

    let mp = state.master_password.lock().map_err(|e| e.to_string())?;
    let password = mp.as_ref().ok_or("Master password not set")?;

    let auth_method = match request.auth_method {
        AuthMethodInput::Password { password: p } => AuthMethod::Password { password: p },
        AuthMethodInput::PrivateKey { key_data, passphrase } => {
            AuthMethod::PrivateKey { key_data, passphrase }
        }
    };

    let config = ServerConfig {
        id: Uuid::new_v4().to_string(),
        name: request.name,
        host: request.host,
        port: request.port,
        username: request.username,
        auth_method,
    };

    let server_info = ServerInfo::from(&config);

    // Load existing servers, add new one, then save all
    let mut all_configs = load_servers_from_disk(password)?;
    all_configs.push(config.clone());

    // Encrypt and save to disk
    let encrypted = encrypt_server_config(&all_configs, password)
        .map_err(|e| e.to_string())?;

    let mut servers = state.encrypted_servers.lock().map_err(|e| e.to_string())?;
    *servers = encrypted.clone();

    // Save to disk
    std::fs::write(get_servers_file_path()?, &encrypted)
        .map_err(|e| e.to_string())?;

    state.ssh_manager.add_connection(config).map_err(|e| e.to_string())?;

    Ok(server_info)
}

fn load_servers_from_disk(password: &str) -> Result<Vec<ServerConfig>, String> {
    let path = get_servers_file_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(Vec::new());
    }
    decrypt_server_config::<Vec<ServerConfig>>(&data, password)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_server(
    server_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    // Check if unlocked
    let is_unlocked = {
        let unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
        *unlocked
    };

    if !is_unlocked {
        return Err("App is locked. Please unlock first.".to_string());
    }

    let mp = state.master_password.lock().map_err(|e| e.to_string())?;
    let password = mp.as_ref().ok_or("Master password not set")?;

    let _removed = state.ssh_manager.remove_connection(&server_id)
        .ok_or("Server not found")?;

    // Update local state and persist
    let remaining: Vec<ServerConfig> = state.ssh_manager.list_connections();
    let encrypted = encrypt_server_config(&remaining, password)
        .map_err(|e| e.to_string())?;

    let mut servers = state.encrypted_servers.lock().map_err(|e| e.to_string())?;
    *servers = encrypted.clone();

    std::fs::write(get_servers_file_path()?, &encrypted)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn list_servers(
    state: State<AppState>,
) -> Result<Vec<ServerInfo>, String> {
    let configs = state.ssh_manager.list_connections();
    Ok(configs.iter().map(ServerInfo::from).collect())
}

#[tauri::command]
pub fn execute_command(
    request: ExecuteCommandRequest,
    state: State<AppState>,
) -> Result<CommandResult, String> {
    let is_dangerous = check_dangerous_command(&request.command);

    if is_dangerous && !request.force_dangerous {
        return Ok(CommandResult {
            success: false,
            output: None,
            error: Some("Dangerous command requires confirmation".to_string()),
            requires_confirmation: true,
        });
    }

    let connections = state.ssh_manager.list_connections();
    let config = connections.iter()
        .find(|c| c.id == request.server_id)
        .ok_or("Server not found")?
        .clone();

    let mut conn = SSHConnection::new(config);
    conn.connect().map_err(|e| e.to_string())?;

    let output = conn.execute(&request.command).map_err(|e| e.to_string())?;
    conn.disconnect();

    Ok(CommandResult {
        success: true,
        output: Some(output),
        error: None,
        requires_confirmation: false,
    })
}

#[tauri::command]
pub fn test_connection(
    server_id: String,
    state: State<AppState>,
) -> Result<bool, String> {
    let connections = state.ssh_manager.list_connections();
    let config = connections.iter()
        .find(|c| c.id == server_id)
        .ok_or("Server not found")?
        .clone();

    let mut conn = SSHConnection::new(config);
    match conn.connect() {
        Ok(_) => {
            conn.disconnect();
            Ok(true)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn check_command_dangerous(command: String) -> bool {
    check_dangerous_command(&command)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub name: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

fn get_provider_config_path() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join("providers.json"))
}

#[tauri::command]
pub fn save_provider_config(
    providers: Vec<ProviderConfig>,
) -> Result<(), String> {
    let path = get_provider_config_path()?;
    let json = serde_json::to_string_pretty(&providers).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_provider_config() -> Result<Vec<ProviderConfig>, String> {
    let path = get_provider_config_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let providers: Vec<ProviderConfig> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(providers)
}

#[tauri::command]
pub fn save_servers(state: State<AppState>) -> Result<(), String> {
    // Check if unlocked
    let is_unlocked = {
        let unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
        *unlocked
    };

    if !is_unlocked {
        return Err("App is locked. Please unlock first.".to_string());
    }

    let mp = state.master_password.lock().map_err(|e| e.to_string())?;
    let password = mp.as_ref().ok_or("Master password not set")?;

    let configs = state.ssh_manager.list_connections();
    let encrypted = encrypt_server_config(&configs, password)
        .map_err(|e| e.to_string())?;

    let mut servers = state.encrypted_servers.lock().map_err(|e| e.to_string())?;
    *servers = encrypted.clone();

    std::fs::write(get_servers_file_path()?, &encrypted)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn load_servers(state: State<AppState>) -> Result<Vec<ServerInfo>, String> {
    // Check if unlocked
    let is_unlocked = {
        let unlocked = state.is_unlocked.lock().map_err(|e| e.to_string())?;
        *unlocked
    };

    if !is_unlocked {
        return Err("App is locked. Please unlock first.".to_string());
    }

    let mp = state.master_password.lock().map_err(|e| e.to_string())?;
    let password = mp.as_ref().ok_or("Master password not set")?;

    let path = get_servers_file_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(Vec::new());
    }

    let configs = decrypt_server_config::<Vec<ServerConfig>>(&data, password)
        .map_err(|e| format!("Failed to decrypt servers: {}. If you forgot your password, delete auth.bin to reset.", e))?;

    // Store encrypted data
    let mut servers = state.encrypted_servers.lock().map_err(|e| e.to_string())?;
    *servers = data;

    // Add connections to manager
    for config in &configs {
        if let Err(e) = state.ssh_manager.add_connection(config.clone()) {
            eprintln!("Failed to add connection for {}: {}", config.name, e);
        }
    }

    Ok(configs.iter().map(ServerInfo::from).collect())
}

#[tauri::command]
pub fn get_server_banner(
    server_id: String,
    state: State<AppState>,
) -> Result<ServerBanner, String> {
    let connections = state.ssh_manager.list_connections();
    let config = connections.iter()
        .find(|c| c.id == server_id)
        .ok_or("Server not found")?
        .clone();

    let mut conn = SSHConnection::new(config);
    conn.get_banner().map_err(|e| e.to_string())
}
