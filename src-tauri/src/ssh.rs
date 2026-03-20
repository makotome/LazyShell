use serde::{Deserialize, Serialize};
use ssh2::{Session, DisconnectCode, Channel};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;
use thiserror::Error;
use chrono::Local;

/// Convert literal escape sequences like \n and \r to actual characters
fn convert_escapes(s: String) -> String {
    s.replace("\\n", "\n")
     .replace("\\r", "\r")
     .replace("\\l", "\n")
     .replace("\\t", "\t")
}

#[derive(Error, Debug)]
pub enum SSHError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[error("Command execution failed: {0}")]
    ExecutionFailed(String),
    #[error("Not connected")]
    NotConnected,
    #[error("Invalid private key: {0}")]
    InvalidKey(String),
    #[error("IO error: {0}")]
    IoError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password { password: String },
    PrivateKey { key_data: String, passphrase: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub is_dangerous: bool,
}

#[derive(Debug, Serialize)]
pub struct ServerBanner {
    pub hostname: String,
    pub os_info: String,
    pub distro_info: String,
    pub disk_usage: String,
    pub memory_usage: String,
    pub uptime_info: String,
    pub last_login: String,
    pub timestamp: String,
}

pub struct SSHConnection {
    session: Option<Session>,
    server_config: ServerConfig,
    interactive_channel: Option<Channel>,
    is_pty_active: bool,
}

impl SSHConnection {
    pub fn new(server_config: ServerConfig) -> Self {
        Self {
            session: None,
            server_config,
            interactive_channel: None,
            is_pty_active: false,
        }
    }

    pub fn connect(&mut self) -> Result<(), SSHError> {
        let tcp = TcpStream::connect(format!("{}:{}", self.server_config.host, self.server_config.port))
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        match &self.server_config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&self.server_config.username, password)
                    .map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                // Write key to a temporary file since ssh2 requires file path
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

        if !session.authenticated() {
            return Err(SSHError::AuthFailed("Authentication failed".to_string()));
        }

        self.session = Some(session);
        Ok(())
    }

    pub fn get_banner(&mut self) -> Result<ServerBanner, SSHError> {
        self.connect()?;

        let hostname = self.get_hostname()?;
        let motd = self.get_motd()?;
        let last_login = self.get_last_login()?;

        let timestamp = Local::now().format("%a %b %d %r %Y").to_string();

        self.disconnect();

        Ok(ServerBanner {
            hostname,
            os_info: convert_escapes(motd),
            distro_info: String::new(),
            disk_usage: String::new(),
            memory_usage: String::new(),
            uptime_info: String::new(),
            last_login: convert_escapes(last_login),
            timestamp,
        })
    }

    fn get_motd(&self) -> Result<String, SSHError> {
        // 1. Ubuntu/Debian: 动态 MOTD
        let output = self.execute_ignore(
            "if [ -d /etc/update-motd.d/ ]; then run-parts /etc/update-motd.d/ 2>/dev/null; fi"
        )?;
        if !output.trim().is_empty() {
            return Ok(output);
        }

        // 2. CentOS/RHEL/Amazon/SUSE: 静态 /etc/motd
        let motd = self.execute_ignore("cat /etc/motd 2>/dev/null || true")?;
        if !motd.trim().is_empty() {
            return Ok(motd);
        }

        // 3. Pre-login banner: /etc/issue (通用，几乎所有发行版支持)
        let issue = self.execute_ignore("cat /etc/issue 2>/dev/null || true")?;
        if !issue.trim().is_empty() {
            return Ok(issue);
        }

        // 4. 尝试获取发行版特定信息 (腾讯云、阿里云、Amazon、RHEL等)
        let distro_info = self.execute_ignore(
            "cat /etc/os-release 2>/dev/null | head -5 || cat /etc/*-release 2>/dev/null | head -5 || true"
        )?;
        if !distro_info.trim().is_empty() {
            // 清理 os-release 内容，保留关键信息
            let cleaned = distro_info
                .lines()
                .filter(|l| l.starts_with("PRETTY_NAME=") || l.starts_with("NAME=") || l.starts_with("VERSION="))
                .collect::<Vec<_>>()
                .join("\n");
            if !cleaned.trim().is_empty() {
                return Ok(cleaned);
            }
            if !distro_info.trim().is_empty() {
                return Ok(distro_info);
            }
        }

        // 5. 最终降级: uname 信息
        Ok(self.execute_ignore("uname -snrvm")?)
    }

    fn get_hostname(&self) -> Result<String, SSHError> {
        let session = self.session.as_ref().ok_or(SSHError::NotConnected)?;
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        channel.exec("hostname")
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        let mut output = String::new();
        channel.read_to_string(&mut output).map_err(|e: std::io::Error| SSHError::ExecutionFailed(e.to_string()))?;
        Ok(output.trim().to_string())
    }

    fn get_last_login(&self) -> Result<String, SSHError> {
        let session = self.session.as_ref().ok_or(SSHError::NotConnected)?;
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        channel.exec("last -1 | head -1")
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        let mut output = String::new();
        channel.read_to_string(&mut output).map_err(|e: std::io::Error| SSHError::ExecutionFailed(e.to_string()))?;
        Ok(output.trim().to_string())
    }

    fn execute_ignore(&self, command: &str) -> Result<String, SSHError> {
        let session = self.session.as_ref().ok_or(SSHError::NotConnected)?;
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        channel.exec(command)
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        let mut output = String::new();
        channel.read_to_string(&mut output).map_err(|e: std::io::Error| SSHError::ExecutionFailed(e.to_string()))?;
        Ok(output)
    }

    pub fn execute(&self, command: &str) -> Result<CommandOutput, SSHError> {
        let session = self.session.as_ref().ok_or(SSHError::NotConnected)?;

        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.exec(command)
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        let mut stdout = String::new();
        channel.read_to_string(&mut stdout).map_err(|e: std::io::Error| SSHError::ExecutionFailed(e.to_string()))?;

        let mut stderr = String::new();
        channel.stderr().read_to_string(&mut stderr).ok();

        let exit_code = channel.exit_status().map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        let is_dangerous = is_dangerous_command(command);

        Ok(CommandOutput {
            stdout: convert_escapes(stdout),
            stderr: convert_escapes(stderr),
            exit_code,
            is_dangerous,
        })
    }

    /// Check if a command is interactive (requires PTY)
    fn is_interactive_command(command: &str) -> bool {
        let interactive = [
            "vim", "vi", "nano", "emacs", "less", "more", "top", "htop",
            "mysql", "psql", "mongosh", "redis-cli", "python", "python3",
            "irb", "node", "ruby", "man", "info", "ssh", "scp", "ftp",
            "telnet", "screen", "tmux", "w3m", "lynx", "links", "midnight",
        ];
        let first = command.split_whitespace().next().unwrap_or("").to_lowercase();
        interactive.iter().any(|&cmd| first == cmd)
    }

    /// Start an interactive PTY session
    pub fn start_pty(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        let session = self.session.as_ref().ok_or(SSHError::NotConnected)?;

        let term_env = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());

        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.request_pty(
            term_env.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.shell()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        self.interactive_channel = Some(channel);
        self.is_pty_active = true;
        Ok(())
    }

    /// Write data to PTY input
    pub fn write_pty(&mut self, data: &str) -> Result<(), SSHError> {
        if let Some(ref mut channel) = self.interactive_channel {
            channel.write(data.as_bytes())
                .map_err(|e: std::io::Error| SSHError::IoError(e.to_string()))?;
            Ok(())
        } else {
            Err(SSHError::NotConnected)
        }
    }

    /// Read PTY output
    pub fn read_pty(&mut self, buf: &mut [u8]) -> Result<usize, SSHError> {
        if let Some(ref mut channel) = self.interactive_channel {
            channel.read(buf).map_err(|e: std::io::Error| SSHError::IoError(e.to_string()))
        } else {
            Ok(0)
        }
    }

    /// Resize PTY terminal
    pub fn resize_pty(&mut self, _rows: u16, _cols: u16) -> Result<(), SSHError> {
        // PTY resize is not directly supported via ssh2 Channel API
        // This would require sending a window change signal through the session
        // For now, we just acknowledge the request
        Ok(())
    }

    /// Check if PTY is active
    pub fn is_pty_active(&self) -> bool {
        self.is_pty_active
    }

    /// Close PTY session
    pub fn close_pty(&mut self) -> Result<(), SSHError> {
        if let Some(mut channel) = self.interactive_channel.take() {
            channel.close().map_err(|e| SSHError::IoError(e.to_string()))?;
        }
        self.is_pty_active = false;
        Ok(())
    }

    pub fn disconnect(&mut self) {
        // Close PTY if active
        if self.is_pty_active {
            let _ = self.close_pty();
        }
        if let Some(mut session) = self.session.take() {
            let _: Result<(), _> = session.disconnect(Some(DisconnectCode::ByApplication), "User disconnected", None);
        }
    }

    pub fn is_connected(&self) -> bool {
        self.session.as_ref().map(|s| s.authenticated()).unwrap_or(false)
    }

    pub fn server_info(&self) -> &ServerConfig {
        &self.server_config
    }
}

pub struct SSHConnectionManager {
    connections: Mutex<Vec<SSHConnection>>,
    interactive_connections: Mutex<Vec<SSHConnection>>,
    persistent_shells: Arc<Mutex<HashMap<String, PersistentShell>>>,
}

impl SSHConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(Vec::new()),
            interactive_connections: Mutex::new(Vec::new()),
            persistent_shells: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn add_connection(&self, config: ServerConfig) -> Result<String, SSHError> {
        let id = config.id.clone();
        let mut conn = SSHConnection::new(config);
        conn.connect()?;
        conn.disconnect();

        let mut connections = self.connections.lock().unwrap();
        connections.push(conn);
        Ok(id)
    }

    pub fn remove_connection(&self, id: &str) -> Option<ServerConfig> {
        let mut connections = self.connections.lock().unwrap();
        if let Some(pos) = connections.iter().position(|c| c.server_config.id == id) {
            let conn = connections.remove(pos);
            Some(conn.server_config)
        } else {
            None
        }
    }

    pub fn list_connections(&self) -> Vec<ServerConfig> {
        let connections = self.connections.lock().unwrap();
        connections.iter().map(|c| c.server_config.clone()).collect()
    }

    pub fn store_interactive_connection(&self, id: String, mut conn: SSHConnection) -> Result<(), SSHError> {
        conn.connect()?;
        let mut interactive = self.interactive_connections.lock().unwrap();
        // Remove existing if any
        interactive.retain(|c| c.server_config.id != id);
        interactive.push(conn);
        Ok(())
    }

    pub fn get_interactive_connection(&self, id: &str) -> Option<std::sync::MutexGuard<'_, Vec<SSHConnection>>> {
        let interactive = self.interactive_connections.lock().ok()?;
        if interactive.iter().any(|c| c.server_config.id == id) {
            Some(interactive)
        } else {
            None
        }
    }

    pub fn interactive_connections_mut(&self) -> std::sync::MutexGuard<'_, Vec<SSHConnection>> {
        self.interactive_connections.lock().unwrap()
    }

    pub fn remove_interactive_connection(&self, id: &str) -> Option<SSHConnection> {
        let mut interactive = self.interactive_connections.lock().unwrap();
        if let Some(pos) = interactive.iter().position(|c| c.server_config.id == id) {
            Some(interactive.remove(pos))
        } else {
            None
        }
    }

    pub fn get_config(&self, id: &str) -> Option<ServerConfig> {
        let connections = self.connections.lock().unwrap();
        connections.iter().find(|c| c.server_config.id == id).map(|c| c.server_config.clone())
    }

    /// Add a new persistent shell for a server
    pub fn add_persistent_shell(&self, id: String, shell: PersistentShell) -> Result<(), SSHError> {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.insert(id, shell);
        Ok(())
    }

    /// Get a mutable reference to a persistent shell by ID
    pub fn get_persistent_shell(&self, id: &str) -> Option<std::sync::MutexGuard<'_, HashMap<String, PersistentShell>>> {
        let shells = self.persistent_shells.lock().ok()?;
        if shells.contains_key(id) {
            drop(shells);
            Some(self.persistent_shells.lock().unwrap())
        } else {
            None
        }
    }

    /// Remove and return a persistent shell by ID
    pub fn remove_persistent_shell(&self, id: &str) -> Option<PersistentShell> {
        let mut shells = self.persistent_shells.lock().unwrap();
        shells.remove(id)
    }

    /// Check if a persistent shell exists for a server
    pub fn has_persistent_shell(&self, id: &str) -> bool {
        let shells = self.persistent_shells.lock().unwrap();
        shells.contains_key(id)
    }

    /// List all persistent shell IDs
    pub fn list_persistent_shells(&self) -> Vec<String> {
        let shells = self.persistent_shells.lock().unwrap();
        shells.keys().cloned().collect()
    }
}

/// Persistent shell session that maintains a PTY connection
pub struct PersistentShell {
    session: Session,
    channel: Channel,
    server_config: ServerConfig,
    pty_active: bool,
}

impl PersistentShell {
    /// Create a new persistent shell session
    pub fn new(server_config: ServerConfig, rows: u16, cols: u16) -> Result<Self, SSHError> {
        let tcp = TcpStream::connect(format!("{}:{}", server_config.host, server_config.port))
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        match &server_config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&server_config.username, password)
                    .map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                let mut temp_file = NamedTempFile::new()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                temp_file.write_all(key_data.as_bytes())
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
                temp_file.flush()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;

                session.userauth_pubkey_file(
                    &server_config.username,
                    None,
                    temp_file.path(),
                    passphrase.as_deref(),
                ).map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
        }

        if !session.authenticated() {
            return Err(SSHError::AuthFailed("Authentication failed".to_string()));
        }

        let term_env = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.request_pty(
            term_env.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.shell()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        Ok(Self {
            session,
            channel,
            server_config,
            pty_active: true,
        })
    }

    /// Write data to the PTY shell
    pub fn write(&mut self, data: &str) -> Result<(), SSHError> {
        if !self.pty_active {
            return Err(SSHError::NotConnected);
        }
        self.channel.write(data.as_bytes())
            .map_err(|e| SSHError::IoError(e.to_string()))?;
        Ok(())
    }

    /// Read data from the PTY shell (non-blocking, returns empty if no data)
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, SSHError> {
        if !self.pty_active {
            return Err(SSHError::NotConnected);
        }
        self.channel.read(buf).map_err(|e| SSHError::IoError(e.to_string()))
    }

    /// Check if the shell session is still alive
    pub fn is_alive(&self) -> bool {
        self.pty_active && self.session.authenticated()
    }

    /// Resize the PTY terminal
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        if !self.pty_active {
            return Err(SSHError::NotConnected);
        }
        // PTY resize via ssh2 Channel API requires sending window change signal
        // The channel can be resized by requesting a new pty with updated dimensions
        // For now, we use the channel's ability to handle resize requests
        let term_env = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        self.channel.request_pty(
            term_env.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;
        Ok(())
    }

    /// Close the PTY shell session
    pub fn close(&mut self) -> Result<(), SSHError> {
        if let Err(e) = self.channel.close() {
            return Err(SSHError::IoError(e.to_string()));
        }
        self.pty_active = false;
        Ok(())
    }

    /// Disconnect the session
    pub fn disconnect(&mut self) {
        let _ = self.channel.close();
        let _: Result<(), _> = self.session.disconnect(Some(DisconnectCode::ByApplication), "User disconnected", None);
        self.pty_active = false;
    }

    /// Reconnect the session with the same config
    pub fn reconnect(&mut self, rows: u16, cols: u16) -> Result<(), SSHError> {
        // Disconnect first if still connected
        if self.session.authenticated() {
            let _: Result<(), _> = self.session.disconnect(Some(DisconnectCode::ByApplication), "Reconnecting", None);
        }

        let tcp = TcpStream::connect(format!("{}:{}", self.server_config.host, self.server_config.port))
            .map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session.handshake().map_err(|e| SSHError::ConnectionFailed(e.to_string()))?;

        match &self.server_config.auth_method {
            AuthMethod::Password { password } => {
                session.userauth_password(&self.server_config.username, password)
                    .map_err(|e: ssh2::Error| SSHError::AuthFailed(e.to_string()))?;
            }
            AuthMethod::PrivateKey { key_data, passphrase } => {
                let mut temp_file = NamedTempFile::new()
                    .map_err(|e| SSHError::IoError(e.to_string()))?;
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

        if !session.authenticated() {
            return Err(SSHError::AuthFailed("Authentication failed".to_string()));
        }

        let term_env = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string());
        let mut channel = session.channel_session()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.request_pty(
            term_env.as_str(),
            Some(ssh2::PtyModes::new()),
            Some((cols as u32, rows as u32, 0, 0)),
        ).map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        channel.shell()
            .map_err(|e: ssh2::Error| SSHError::ExecutionFailed(e.to_string()))?;

        self.session = session;
        self.channel = channel;
        self.pty_active = true;
        Ok(())
    }

    /// Get the server config for this shell
    pub fn server_info(&self) -> &ServerConfig {
        &self.server_config
    }
}

fn is_dangerous_command(command: &str) -> bool {
    let dangerous_patterns = [
        "rm -rf",
        "rm -rf /",
        "rm -rf /*",
        "shutdown",
        "reboot",
        "init 0",
        "init 6",
        "telinit 0",
        "telinit 6",
        "dd if=",
        "mkfs",
        "> /dev/sda",
        "> /dev/sdb",
        "> /dev/nvme",
        ":(){:|:&};:",
        "chmod -R 777 /",
        "chown -R",
        "mv /*",
        "cp /dev/zero",
    ];

    let cmd_lower = command.to_lowercase();
    dangerous_patterns.iter().any(|pattern| cmd_lower.contains(&pattern.to_lowercase()))
}

pub fn check_dangerous_command(command: &str) -> bool {
    is_dangerous_command(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dangerous_detection() {
        assert!(is_dangerous_command("rm -rf /tmp/test"));
        assert!(is_dangerous_command("rm -rf /*"));
        assert!(is_dangerous_command("shutdown -h now"));
        assert!(is_dangerous_command("reboot"));
        assert!(is_dangerous_command("dd if=/dev/zero of=/dev/sda"));
        assert!(is_dangerous_command("mkfs.ext4 /dev/sdb1"));

        assert!(!is_dangerous_command("ls -la"));
        assert!(!is_dangerous_command("cat /etc/passwd"));
        assert!(!is_dangerous_command("ps aux"));
    }
}
