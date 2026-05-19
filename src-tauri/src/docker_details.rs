use crate::commands::AppState;
use crate::ssh::{CommandOutput, SSHConnection, SSHConnectionManager};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeInfo {
    pub project: Option<String>,
    pub service: Option<String>,
    pub container_number: Option<String>,
    pub working_dir: Option<String>,
    pub config_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPortBinding {
    pub private_port: String,
    pub public_host: Option<String>,
    pub public_port: Option<String>,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerMountInfo {
    pub source: Option<String>,
    pub destination: String,
    pub mode: Option<String>,
    pub mount_type: String,
    pub rw: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkInfo {
    pub name: String,
    pub ip_address: Option<String>,
    pub gateway: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerRelation {
    pub target_id: String,
    pub target_name: String,
    pub relation_type: String,
    pub source: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerRecord {
    pub id: String,
    pub short_id: String,
    pub name: String,
    pub image: String,
    pub image_id: Option<String>,
    pub state: String,
    pub status: String,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub uptime_seconds: Option<i64>,
    pub restart_count: i64,
    pub command: String,
    pub entrypoint: Vec<String>,
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub working_dir: Option<String>,
    pub restart_policy: Option<String>,
    pub network_mode: Option<String>,
    pub externally_exposed: bool,
    pub ports: Vec<DockerPortBinding>,
    pub mounts: Vec<DockerMountInfo>,
    pub networks: Vec<DockerNetworkInfo>,
    pub compose: Option<DockerComposeInfo>,
    pub related_containers: Vec<DockerContainerRelation>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerDetailsSnapshot {
    pub server_id: String,
    pub scanned_at: i64,
    pub docker_version: Option<String>,
    pub containers: Vec<DockerContainerRecord>,
    pub last_error: Option<String>,
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
if docker info >/dev/null 2>&1; then
  DC="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DC="sudo -n docker"
else
  printf '__LS_DOCKER_ERROR__\n'
  docker info 2>&1 || sudo -n docker info 2>&1 || true
  exit 0
fi

printf '__LS_DOCKER_VERSION__\n'
$DC version --format '{{.Server.Version}}' 2>/dev/null || $DC --version 2>/dev/null || true
printf '__LS_DOCKER_INSPECT__\n'
ids="$($DC ps -a --no-trunc --format '{{.ID}}' 2>/dev/null)"
if [ -n "$ids" ]; then
  $DC inspect $ids 2>/dev/null || printf '[]'
else
  printf '[]'
fi
"#
    .to_string()
}

fn split_output(stdout: &str) -> (Option<String>, String, Option<String>) {
    let mut version_lines = Vec::new();
    let mut inspect_lines = Vec::new();
    let mut error_lines = Vec::new();
    let mut section = "";

    for line in stdout.lines() {
        match line {
            "__LS_DOCKER_VERSION__" => {
                section = "version";
                continue;
            }
            "__LS_DOCKER_INSPECT__" => {
                section = "inspect";
                continue;
            }
            "__LS_DOCKER_ERROR__" => {
                section = "error";
                continue;
            }
            _ => {}
        }

        match section {
            "version" => version_lines.push(line.to_string()),
            "inspect" => inspect_lines.push(line.to_string()),
            "error" => error_lines.push(line.to_string()),
            _ => {}
        }
    }

    let version = version_lines
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string());
    let inspect = inspect_lines.join("\n");
    let error = if error_lines.is_empty() {
        None
    } else {
        Some(error_lines.join("\n").trim().to_string())
    };
    (version, inspect, error)
}

fn strip_json_control_chars(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_control()).collect()
}

fn value_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

fn value_i64(value: &Value, path: &[&str]) -> i64 {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return 0;
        };
        current = next;
    }
    current.as_i64().unwrap_or(0)
}

fn value_string_array(value: &Value, path: &[&str]) -> Vec<String> {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return Vec::new();
        };
        current = next;
    }
    match current {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Value::String(item) if !item.trim().is_empty() => vec![item.to_string()],
        _ => Vec::new(),
    }
}

fn parse_labels(value: &Value) -> BTreeMap<String, String> {
    let mut labels = BTreeMap::new();
    if let Some(map) = value
        .get("Config")
        .and_then(|item| item.get("Labels"))
        .and_then(Value::as_object)
    {
        for (key, value) in map {
            if let Some(label_value) = value.as_str() {
                labels.insert(key.to_string(), label_value.to_string());
            }
        }
    }
    labels
}

fn parse_compose(labels: &BTreeMap<String, String>) -> Option<DockerComposeInfo> {
    let project = labels.get("com.docker.compose.project").cloned();
    let service = labels.get("com.docker.compose.service").cloned();
    let working_dir = labels
        .get("com.docker.compose.project.working_dir")
        .cloned();
    let config_files: Vec<String> = labels
        .get("com.docker.compose.project.config_files")
        .map(|value| value.split(':').map(str::to_string).collect())
        .unwrap_or_default();

    if project.is_none() && service.is_none() && working_dir.is_none() && config_files.is_empty() {
        return None;
    }

    Some(DockerComposeInfo {
        project,
        service,
        container_number: labels.get("com.docker.compose.container-number").cloned(),
        working_dir,
        config_files,
    })
}

fn parse_ports(value: &Value) -> Vec<DockerPortBinding> {
    let Some(ports) = value
        .get("NetworkSettings")
        .and_then(|item| item.get("Ports"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (private, bindings) in ports {
        let mut parts = private.split('/');
        let private_port = parts.next().unwrap_or(private).to_string();
        let protocol = parts.next().unwrap_or("tcp").to_string();
        match bindings {
            Value::Array(items) if !items.is_empty() => {
                for item in items {
                    result.push(DockerPortBinding {
                        private_port: private_port.clone(),
                        public_host: value_string(item, &["HostIp"]),
                        public_port: value_string(item, &["HostPort"]),
                        protocol: protocol.clone(),
                    });
                }
            }
            _ => result.push(DockerPortBinding {
                private_port,
                public_host: None,
                public_port: None,
                protocol,
            }),
        }
    }
    result.sort_by(|a, b| a.private_port.cmp(&b.private_port));
    result
}

fn parse_mounts(value: &Value) -> Vec<DockerMountInfo> {
    value
        .get("Mounts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let destination = value_string(item, &["Destination"])?;
                    Some(DockerMountInfo {
                        source: value_string(item, &["Source"]),
                        destination,
                        mode: value_string(item, &["Mode"]),
                        mount_type: value_string(item, &["Type"])
                            .unwrap_or_else(|| "unknown".to_string()),
                        rw: item.get("RW").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_networks(value: &Value) -> Vec<DockerNetworkInfo> {
    let Some(networks) = value
        .get("NetworkSettings")
        .and_then(|item| item.get("Networks"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    networks
        .iter()
        .map(|(name, item)| DockerNetworkInfo {
            name: name.to_string(),
            ip_address: value_string(item, &["IPAddress"]),
            gateway: value_string(item, &["Gateway"]),
            aliases: value_string_array(item, &["Aliases"]),
        })
        .collect()
}

fn parse_time(value: Option<String>) -> Option<String> {
    value.filter(|item| !item.starts_with("0001-01-01") && !item.trim().is_empty())
}

fn parse_uptime_seconds(started_at: &Option<String>, state: &str) -> Option<i64> {
    if state != "running" {
        return None;
    }
    let started = started_at.as_ref()?;
    DateTime::parse_from_rfc3339(started).ok().map(|value| {
        Utc::now()
            .signed_duration_since(value.with_timezone(&Utc))
            .num_seconds()
    })
}

fn container_reference_tokens(container: &DockerContainerRecord) -> Vec<String> {
    let mut tokens = vec![container.name.clone(), container.short_id.clone()];
    if let Some(compose) = &container.compose {
        if let Some(service) = &compose.service {
            tokens.push(service.clone());
        }
    }
    for network in &container.networks {
        tokens.extend(network.aliases.clone());
    }
    tokens
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| value.len() >= 3)
        .collect()
}

fn infer_container_relations(containers: &mut [DockerContainerRecord]) {
    let snapshot = containers.to_vec();
    for container in containers {
        let mut relations: Vec<DockerContainerRelation> = Vec::new();
        let mut seen = BTreeMap::new();

        for target in &snapshot {
            if target.id == container.id {
                continue;
            }

            if let (Some(source_compose), Some(target_compose)) =
                (&container.compose, &target.compose)
            {
                if source_compose.project.is_some()
                    && source_compose.project == target_compose.project
                {
                    push_relation(
                        &mut relations,
                        &mut seen,
                        target,
                        "compose",
                        "Compose 项目",
                        source_compose.project.as_deref().unwrap_or("同一项目"),
                    );
                }
            }

            for source_network in &container.networks {
                if target
                    .networks
                    .iter()
                    .any(|target_network| target_network.name == source_network.name)
                {
                    push_relation(
                        &mut relations,
                        &mut seen,
                        target,
                        "network",
                        "Docker 网络",
                        &source_network.name,
                    );
                }
            }

            let haystack = container
                .env
                .iter()
                .chain(container.args.iter())
                .chain(container.entrypoint.iter())
                .cloned()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if !haystack.is_empty() {
                for token in container_reference_tokens(target) {
                    if haystack.contains(&token) {
                        push_relation(
                            &mut relations,
                            &mut seen,
                            target,
                            "envReference",
                            "环境变量/启动参数引用",
                            &token,
                        );
                    }
                }
            }
        }

        container.related_containers = relations;
    }
}

fn push_relation(
    relations: &mut Vec<DockerContainerRelation>,
    seen: &mut BTreeMap<String, bool>,
    target: &DockerContainerRecord,
    relation_type: &str,
    source: &str,
    detail: &str,
) {
    let key = format!("{}:{}:{}", target.id, relation_type, detail);
    if seen.contains_key(&key) {
        return;
    }
    seen.insert(key, true);
    relations.push(DockerContainerRelation {
        target_id: target.id.clone(),
        target_name: target.name.clone(),
        relation_type: relation_type.to_string(),
        source: source.to_string(),
        detail: detail.to_string(),
    });
}

fn container_from_value(value: &Value) -> Option<DockerContainerRecord> {
    let id = value_string(value, &["Id"])?;
    let labels = parse_labels(value);
    let name = value_string(value, &["Name"])
        .map(|item| item.trim_start_matches('/').to_string())
        .unwrap_or_else(|| id.chars().take(12).collect());
    let image = value_string(value, &["Config", "Image"]).unwrap_or_else(|| "unknown".to_string());
    let state = value_string(value, &["State", "Status"]).unwrap_or_else(|| "unknown".to_string());
    let started_at = parse_time(value_string(value, &["State", "StartedAt"]));
    let finished_at = parse_time(value_string(value, &["State", "FinishedAt"]));
    let command = value_string(value, &["Path"]).unwrap_or_default();

    Some(DockerContainerRecord {
        short_id: id.chars().take(12).collect(),
        id,
        name,
        image,
        image_id: value_string(value, &["Image"]),
        state: state.clone(),
        status: value_string(value, &["State", "Status"]).unwrap_or(state.clone()),
        created_at: parse_time(value_string(value, &["Created"])),
        started_at: started_at.clone(),
        finished_at,
        uptime_seconds: parse_uptime_seconds(&started_at, &state),
        restart_count: value_i64(value, &["RestartCount"]),
        command,
        entrypoint: value_string_array(value, &["Config", "Entrypoint"]),
        args: value_string_array(value, &["Args"]),
        env: value_string_array(value, &["Config", "Env"]),
        working_dir: value_string(value, &["Config", "WorkingDir"]),
        restart_policy: value_string(value, &["HostConfig", "RestartPolicy", "Name"]),
        network_mode: value_string(value, &["HostConfig", "NetworkMode"]),
        externally_exposed: parse_ports(value)
            .iter()
            .any(|port| port.public_port.is_some()),
        ports: parse_ports(value),
        mounts: parse_mounts(value),
        networks: parse_networks(value),
        compose: parse_compose(&labels),
        related_containers: Vec::new(),
        labels,
    })
}

#[tauri::command]
pub fn get_docker_details(
    server_id: String,
    state: State<AppState>,
) -> Result<DockerDetailsSnapshot, String> {
    let ssh_manager = state.ssh_manager.clone();
    let command = format!("bash -lc {}", shell_quote(&scan_script()));
    let output = run_remote_command(&ssh_manager, &server_id, &command)?;
    let (docker_version, inspect_json, docker_error) = split_output(&output.stdout);
    let sanitized_inspect_json = strip_json_control_chars(&inspect_json);
    let mut parse_error = None;
    let mut containers = if sanitized_inspect_json.trim().is_empty() {
        Vec::new()
    } else {
        match serde_json::from_str::<Value>(&sanitized_inspect_json) {
            Ok(Value::Array(items)) => items.iter().filter_map(container_from_value).collect(),
            Ok(_) => {
                parse_error = Some("Docker inspect 输出不是预期的 JSON 数组。".to_string());
                Vec::new()
            }
            Err(err) => {
                let preview = sanitized_inspect_json.chars().take(240).collect::<String>();
                parse_error = Some(format!(
                    "无法解析 Docker inspect 输出：{err}；输出开头：{preview}"
                ));
                Vec::new()
            }
        }
    };
    infer_container_relations(&mut containers);

    let last_error = docker_error.or(parse_error).or_else(|| {
        if output.exit_code == 0 {
            None
        } else {
            Some(output.stderr.trim().to_string())
        }
    });

    Ok(DockerDetailsSnapshot {
        server_id,
        scanned_at: Utc::now().timestamp(),
        docker_version,
        containers,
        last_error,
    })
}
