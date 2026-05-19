use crate::commands::AppState;
use crate::ssh::{CommandOutput, SSHConnection, SSHConnectionManager};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerInfo {
    pub id: String,
    pub name: Option<String>,
    pub image: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProcessRecord {
    pub pid: i32,
    pub ppid: i32,
    pub user: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub rss_kb: i64,
    pub command_name: String,
    pub command: String,
    pub working_directory: Option<String>,
    pub executable: Option<String>,
    pub docker: Option<DockerContainerInfo>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortServiceRecord {
    pub id: String,
    pub protocol: String,
    pub address: String,
    pub port: u16,
    pub pid: Option<i32>,
    pub program: Option<String>,
    pub user: Option<String>,
    pub command: Option<String>,
    pub working_directory: Option<String>,
    pub executable: Option<String>,
    pub docker: Option<DockerContainerInfo>,
    pub raw_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetailsSnapshot {
    pub server_id: String,
    pub scanned_at: i64,
    pub memory_top: Vec<ServiceProcessRecord>,
    pub cpu_top: Vec<ServiceProcessRecord>,
    pub ports: Vec<PortServiceRecord>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ProcessDetail {
    user: Option<String>,
    command: Option<String>,
    working_directory: Option<String>,
    executable: Option<String>,
    docker: Option<DockerContainerInfo>,
    last_error: Option<String>,
}

fn run_remote_command(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    command: &str,
) -> Result<CommandOutput, String> {
    let execute_with_fresh_connection = || -> Result<CommandOutput, String> {
        let config = ssh_manager
            .list_connections()
            .into_iter()
            .find(|config| config.id == server_id)
            .ok_or_else(|| "Server not found".to_string())?;

        let mut conn = SSHConnection::new(config);
        conn.connect().map_err(|e| e.to_string())?;
        let output = conn.execute(command).map_err(|e| e.to_string())?;
        conn.disconnect();
        Ok(output)
    };

    match ssh_manager.get_session(server_id) {
        Ok(session) => match SSHConnectionManager::execute_with_session(&session, command) {
            Ok(output) => Ok(output),
            Err(_) => {
                let _ = ssh_manager.close_session(server_id);
                execute_with_fresh_connection()
            }
        },
        Err(_) => execute_with_fresh_connection(),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn scan_script() -> String {
    r#"
set +e
emit_processes() {
  ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=,args= "$@" 2>/dev/null | head -n 10
}

printf '__LS_SECTION_MEM__\n'
emit_processes --sort=-%mem
printf '__LS_SECTION_CPU__\n'
emit_processes --sort=-%cpu
printf '__LS_SECTION_PORTS__\n'
(ss -H -ltnup 2>/dev/null || sudo -n ss -H -ltnup 2>/dev/null || netstat -tulpen 2>/dev/null || sudo -n netstat -tulpen 2>/dev/null || true) | head -n 160
printf '__LS_SECTION_DETAILS__\n'
{
  ps -eo pid= --sort=-%mem 2>/dev/null | head -n 10
  ps -eo pid= --sort=-%cpu 2>/dev/null | head -n 10
  (ss -H -ltnup 2>/dev/null || sudo -n ss -H -ltnup 2>/dev/null || true) | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p'
} | awk '{print $1}' | grep -E '^[0-9]+$' | sort -n | uniq | while read -r pid; do
  [ -d "/proc/$pid" ] || continue
  user="$(ps -o user= -p "$pid" 2>/dev/null | awk '{$1=$1;print}')"
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/[[:space:]]*$//')"
  [ -n "$cmd" ] || cmd="$(ps -o args= -p "$pid" 2>/dev/null | sed 's/[[:space:]]*$//')"
  cwd="$(readlink "/proc/$pid/cwd" 2>&1)"
  exe="$(readlink "/proc/$pid/exe" 2>&1)"
  cgroup="$(cat "/proc/$pid/cgroup" 2>/dev/null)"
  docker_id="$(printf '%s\n' "$cgroup" | sed -n 's#.*docker[-/]\([0-9a-f]\{12,64\}\).*#\1#p; s#.*cri-containerd-\([0-9a-f]\{12,64\}\).*#\1#p' | head -n 1)"
  docker_info=""
  if [ -n "$docker_id" ] && command -v docker >/dev/null 2>&1; then
    docker_info="$(docker ps --no-trunc --filter "id=$docker_id" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | head -n 1)"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$user" "$cwd" "$exe" "$docker_info" "$cmd" | tr '\r\n' '  '
  printf '\n'
done
"#
    .to_string()
}

fn split_sections(stdout: &str) -> BTreeMap<String, Vec<String>> {
    let mut sections: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut current = String::new();
    for line in stdout.lines() {
        if line.starts_with("__LS_SECTION_") && line.ends_with("__") {
            current = line
                .trim_start_matches("__LS_SECTION_")
                .trim_end_matches("__")
                .to_string();
            sections.entry(current.clone()).or_default();
            continue;
        }
        if !current.is_empty() {
            sections
                .entry(current.clone())
                .or_default()
                .push(line.to_string());
        }
    }
    sections
}

fn parse_process_line(
    line: &str,
    details: &BTreeMap<i32, ProcessDetail>,
) -> Option<ServiceProcessRecord> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<i32>().ok()?;
    let ppid = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    let user = parts.next().unwrap_or("").to_string();
    let cpu_percent = parts
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let memory_percent = parts
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let rss_kb = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let command_name = parts.next().unwrap_or("").to_string();
    let command = parts.collect::<Vec<_>>().join(" ");
    let detail = details.get(&pid);

    Some(ServiceProcessRecord {
        pid,
        ppid,
        user: detail.and_then(|item| item.user.clone()).unwrap_or(user),
        cpu_percent,
        memory_percent,
        rss_kb,
        command_name,
        command: detail
            .and_then(|item| item.command.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or(command),
        working_directory: detail.and_then(|item| item.working_directory.clone()),
        executable: detail.and_then(|item| item.executable.clone()),
        docker: detail.and_then(|item| item.docker.clone()),
        last_error: detail.and_then(|item| item.last_error.clone()),
    })
}

fn parse_process_details(lines: &[String]) -> BTreeMap<i32, ProcessDetail> {
    let mut details = BTreeMap::new();
    for line in lines {
        let fields: Vec<&str> = line.splitn(6, '\t').collect();
        if fields.len() < 6 {
            continue;
        }
        let Some(pid) = fields[0].trim().parse::<i32>().ok() else {
            continue;
        };
        let docker = parse_docker_info(fields[4]);
        let cwd = clean_proc_value(fields[2]);
        let exe = clean_proc_value(fields[3]);
        let mut last_error = None;
        if cwd.is_none() && fields[2].contains("Permission denied") {
            last_error = Some("无法读取进程目录，可能需要更高权限".to_string());
        }
        details.insert(
            pid,
            ProcessDetail {
                user: clean_text(fields[1]),
                command: clean_text(fields[5]),
                working_directory: cwd,
                executable: exe,
                docker,
                last_error,
            },
        );
    }
    details
}

fn clean_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn clean_proc_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.contains("Permission denied")
        || trimmed.contains("No such file")
        || trimmed.contains("cannot read")
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_docker_info(value: &str) -> Option<DockerContainerInfo> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('|').collect();
    Some(DockerContainerInfo {
        id: parts.first().copied().unwrap_or("").to_string(),
        name: parts.get(1).and_then(|value| clean_text(value)),
        image: parts.get(2).and_then(|value| clean_text(value)),
        status: parts.get(3).and_then(|value| clean_text(value)),
    })
}

fn parse_ports(lines: &[String], details: &BTreeMap<i32, ProcessDetail>) -> Vec<PortServiceRecord> {
    let mut records = Vec::new();
    for line in lines {
        let Some((protocol, address, port)) = parse_socket_address(line) else {
            continue;
        };
        if is_loopback_address(&address) {
            continue;
        }
        let pid = parse_pid(line);
        let program = parse_program(line);
        let detail = pid.and_then(|value| details.get(&value));
        records.push(PortServiceRecord {
            id: format!("{}:{}:{}", protocol, address, port),
            protocol,
            address,
            port,
            pid,
            program,
            user: detail.and_then(|item| item.user.clone()),
            command: detail.and_then(|item| item.command.clone()),
            working_directory: detail.and_then(|item| item.working_directory.clone()),
            executable: detail.and_then(|item| item.executable.clone()),
            docker: detail.and_then(|item| item.docker.clone()),
            raw_line: line.to_string(),
        });
    }
    records.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.protocol.cmp(&b.protocol))
    });
    records
}

fn parse_socket_address(line: &str) -> Option<(String, String, u16)> {
    let columns: Vec<&str> = line.split_whitespace().collect();
    if columns.len() < 5 {
        return None;
    }
    let protocol = columns[0].to_lowercase();
    let address_column = columns
        .iter()
        .find(|value| value.contains(':') && !value.contains("users:"))?;
    parse_address_port(address_column).map(|(address, port)| (protocol, address, port))
}

fn parse_address_port(value: &str) -> Option<(String, u16)> {
    let cleaned = value.trim().trim_matches('[').trim_matches(']');
    let index = cleaned.rfind(':')?;
    let address = cleaned[..index]
        .trim_matches('[')
        .trim_matches(']')
        .to_string();
    let port = cleaned[index + 1..].parse::<u16>().ok()?;
    Some((
        if address.is_empty() {
            "*".to_string()
        } else {
            address
        },
        port,
    ))
}

fn parse_pid(line: &str) -> Option<i32> {
    let marker = "pid=";
    if let Some(index) = line.find(marker).map(|value| value + marker.len()) {
        let pid = line[index..]
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .collect::<String>();
        return pid.parse::<i32>().ok();
    }

    line.split_whitespace().rev().find_map(|column| {
        let index = column.find('/')?;
        column[..index].parse::<i32>().ok()
    })
}

fn parse_program(line: &str) -> Option<String> {
    if let Some(start) = line.find("((\"").map(|value| value + 3) {
        let rest = &line[start..];
        let end = rest.find('"')?;
        return clean_text(&rest[..end]);
    }

    line.split_whitespace().rev().find_map(|column| {
        let index = column.find('/')?;
        clean_text(&column[index + 1..])
    })
}

fn is_loopback_address(address: &str) -> bool {
    address == "127.0.0.1" || address == "::1" || address == "localhost"
}

#[tauri::command]
pub fn get_service_details(
    server_id: String,
    state: State<AppState>,
) -> Result<ServiceDetailsSnapshot, String> {
    let ssh_manager = state.ssh_manager.clone();
    let command = format!("bash -lc {}", shell_quote(&scan_script()));
    let output = run_remote_command(&ssh_manager, &server_id, &command)?;
    let sections = split_sections(&output.stdout);
    let details = parse_process_details(sections.get("DETAILS").map(Vec::as_slice).unwrap_or(&[]));
    let memory_top = sections
        .get("MEM")
        .map(|lines| {
            lines
                .iter()
                .filter_map(|line| parse_process_line(line, &details))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cpu_top = sections
        .get("CPU")
        .map(|lines| {
            lines
                .iter()
                .filter_map(|line| parse_process_line(line, &details))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ports = parse_ports(
        sections.get("PORTS").map(Vec::as_slice).unwrap_or(&[]),
        &details,
    );
    let last_error = if output.exit_code == 0 {
        None
    } else {
        Some(output.stderr.trim().to_string())
    };

    Ok(ServiceDetailsSnapshot {
        server_id,
        scanned_at: Utc::now().timestamp(),
        memory_top,
        cpu_top,
        ports,
        last_error,
    })
}
