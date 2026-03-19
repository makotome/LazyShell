use serde::{Deserialize, Serialize};
use ssh2::{Session, DisconnectCode};
use std::io::Read;
use std::net::TcpStream;
use std::sync::Mutex;
use tempfile::NamedTempFile;
use thiserror::Error;
use chrono::Local;

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
}

impl SSHConnection {
    pub fn new(server_config: ServerConfig) -> Self {
        Self {
            session: None,
            server_config,
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
        let os_info = self.execute_ignore("uname -a")?;
        let distro_info = self.execute_ignore("cat /etc/issue")?;
        let disk_usage = self.execute_ignore("df -h")?;
        let memory_usage = self.execute_ignore("free -h")?;
        let uptime_info = self.execute_ignore("uptime")?;
        let last_login = self.get_last_login()?;

        let timestamp = Local::now().format("%a %b %d %r %Y").to_string();

        self.disconnect();

        Ok(ServerBanner {
            hostname,
            os_info,
            distro_info,
            disk_usage,
            memory_usage,
            uptime_info,
            last_login,
            timestamp,
        })
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
            stdout,
            stderr,
            exit_code,
            is_dangerous,
        })
    }

    pub fn disconnect(&mut self) {
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
}

impl SSHConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(Vec::new()),
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
