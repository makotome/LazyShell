use crate::commands::AppState;
use crate::ssh::{CommandOutput, SSHConnection, SSHConnectionManager};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

const DISABLED_PREFIX: &str = "# lazyshell:disabled ";
const SCRIPT_PREVIEW_BYTES: usize = 20 * 1024;
const SCRIPT_PREVIEW_LINES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CronTaskSource {
    UserCrontab,
    SystemCrontab,
    CronD,
    PeriodicDirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CronTaskStatus {
    Active,
    Disabled,
    Invalid,
    Unreadable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskRecord {
    pub id: String,
    pub source: CronTaskSource,
    pub source_path: Option<String>,
    pub line_number: Option<usize>,
    pub schedule: String,
    pub schedule_description: String,
    pub user: Option<String>,
    pub command: String,
    pub status: CronTaskStatus,
    pub env: Vec<String>,
    pub raw_line: String,
    pub script_path: Option<String>,
    pub script_preview: Option<String>,
    pub source_hash: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskListResult {
    pub server_id: String,
    pub records: Vec<CronTaskRecord>,
    pub scanned_at: i64,
    pub timezone: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CronTaskChangeAction {
    Create,
    Update,
    Disable,
    Enable,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskChangeRequest {
    pub action: CronTaskChangeAction,
    pub task_id: Option<String>,
    pub source: Option<CronTaskSource>,
    pub source_path: Option<String>,
    pub schedule: Option<String>,
    pub user: Option<String>,
    pub command: Option<String>,
    pub raw_line: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskChangePreview {
    pub summary: String,
    pub affected_source: String,
    pub before_text: String,
    pub after_text: String,
    pub commands: Vec<String>,
    pub requires_sudo: bool,
    pub expected_hash: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct CronSourceContent {
    source: CronTaskSource,
    path: Option<String>,
    content: String,
    hash: String,
    readable: bool,
    error: Option<String>,
}

fn now_timestamp() -> i64 {
    Utc::now().timestamp()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn hash_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn task_id(
    source: &CronTaskSource,
    path: Option<&str>,
    line_number: Option<usize>,
    raw_line: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "{:?}|{}|{}|{}",
            source,
            path.unwrap_or(""),
            line_number.unwrap_or(0),
            raw_line
        )
        .as_bytes(),
    );
    format!("{:x}", hasher.finalize())[..16].to_string()
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

fn non_empty_or(value: String, fallback: impl Into<String>) -> String {
    if value.trim().is_empty() {
        fallback.into()
    } else {
        value.trim().to_string()
    }
}

fn read_user_crontab(ssh_manager: &SSHConnectionManager, server_id: &str) -> CronSourceContent {
    let output = run_remote_command(ssh_manager, server_id, "crontab -l 2>/dev/null || true");
    let content = output.map(|value| value.stdout).unwrap_or_default();
    CronSourceContent {
        source: CronTaskSource::UserCrontab,
        path: None,
        hash: hash_text(&content),
        content,
        readable: true,
        error: None,
    }
}

fn read_remote_file(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    path: &str,
    source: CronTaskSource,
) -> CronSourceContent {
    let command = format!(
        "cat {path} 2>/dev/null || sudo -n cat {path} 2>/dev/null",
        path = shell_quote(path)
    );
    match run_remote_command(ssh_manager, server_id, &command) {
        Ok(output) if output.exit_code == 0 => {
            let content = output.stdout;
            CronSourceContent {
                source,
                path: Some(path.to_string()),
                hash: hash_text(&content),
                content,
                readable: true,
                error: None,
            }
        }
        Ok(output) => CronSourceContent {
            source,
            path: Some(path.to_string()),
            content: String::new(),
            hash: hash_text(""),
            readable: false,
            error: Some(non_empty_or(output.stderr, format!("无法读取 {}", path))),
        },
        Err(err) => CronSourceContent {
            source,
            path: Some(path.to_string()),
            content: String::new(),
            hash: hash_text(""),
            readable: false,
            error: Some(err),
        },
    }
}

fn list_cron_d_paths(ssh_manager: &SSHConnectionManager, server_id: &str) -> Vec<String> {
    let command = "if [ -d /etc/cron.d ]; then find /etc/cron.d -type f ! -name '*.bak*' 2>/dev/null | sort; fi";
    run_remote_command(ssh_manager, server_id, command)
        .ok()
        .map(|output| {
            output
                .stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn list_periodic_paths(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
) -> Vec<(String, String)> {
    let command = "for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do [ -d \"$d\" ] && find \"$d\" -maxdepth 1 -type f 2>/dev/null | sed \"s#^#$d|#\"; done";
    run_remote_command(ssh_manager, server_id, command)
        .ok()
        .map(|output| {
            output
                .stdout
                .lines()
                .filter_map(|line| {
                    let (dir, path) = line.split_once('|')?;
                    let schedule = match dir {
                        "/etc/cron.hourly" => "@hourly",
                        "/etc/cron.daily" => "@daily",
                        "/etc/cron.weekly" => "@weekly",
                        "/etc/cron.monthly" => "@monthly",
                        _ => "@periodic",
                    };
                    Some((schedule.to_string(), path.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn remote_path_exists(ssh_manager: &SSHConnectionManager, server_id: &str, path: &str) -> bool {
    let command = format!(
        "test -e {path} || sudo -n test -e {path}",
        path = shell_quote(path)
    );
    run_remote_command(ssh_manager, server_id, &command)
        .map(|output| output.exit_code == 0)
        .unwrap_or(false)
}

fn get_timezone(ssh_manager: &SSHConnectionManager, server_id: &str) -> Option<String> {
    run_remote_command(ssh_manager, server_id, "date +%Z 2>/dev/null")
        .ok()
        .and_then(|output| {
            let value = output.stdout.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
}

fn collect_sources(ssh_manager: &SSHConnectionManager, server_id: &str) -> Vec<CronSourceContent> {
    let mut sources = vec![read_user_crontab(ssh_manager, server_id)];
    sources.push(read_remote_file(
        ssh_manager,
        server_id,
        "/etc/crontab",
        CronTaskSource::SystemCrontab,
    ));
    for path in list_cron_d_paths(ssh_manager, server_id) {
        sources.push(read_remote_file(
            ssh_manager,
            server_id,
            &path,
            CronTaskSource::CronD,
        ));
    }
    sources
}

fn is_env_line(trimmed: &str) -> bool {
    if trimmed.starts_with('@') || trimmed.contains(' ') || trimmed.contains('\t') {
        return false;
    }
    trimmed
        .split_once('=')
        .map(|(key, _)| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
        .unwrap_or(false)
}

fn schedule_description(schedule: &str) -> String {
    match schedule {
        "@reboot" => "系统启动时运行".to_string(),
        "@hourly" => "每小时运行".to_string(),
        "@daily" => "每天运行".to_string(),
        "@weekly" => "每周运行".to_string(),
        "@monthly" => "每月运行".to_string(),
        "@yearly" | "@annually" => "每年运行".to_string(),
        value => format!("Cron: {}", value),
    }
}

fn split_cron_line(line: &str, has_user_field: bool) -> Option<(String, Option<String>, String)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    if parts[0].starts_with('@') {
        let command_start = if has_user_field { 2 } else { 1 };
        if parts.len() <= command_start {
            return None;
        }
        let user = has_user_field.then(|| parts[1].to_string());
        return Some((parts[0].to_string(), user, parts[command_start..].join(" ")));
    }

    let command_start = if has_user_field { 6 } else { 5 };
    if parts.len() <= command_start {
        return None;
    }
    let schedule = parts[..5].join(" ");
    let user = has_user_field.then(|| parts[5].to_string());
    Some((schedule, user, parts[command_start..].join(" ")))
}

fn detect_script_path(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.starts_with('/') {
        return trimmed.split_whitespace().next().map(ToOwned::to_owned);
    }
    for prefix in [
        "bash ",
        "sh ",
        "/bin/bash ",
        "/bin/sh ",
        "python ",
        "python3 ",
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest
                .split_whitespace()
                .next()
                .filter(|value| value.starts_with('/'))
                .map(ToOwned::to_owned);
        }
    }
    None
}

fn parse_source(source: &CronSourceContent) -> Vec<CronTaskRecord> {
    if !source.readable {
        return vec![CronTaskRecord {
            id: task_id(
                &source.source,
                source.path.as_deref(),
                Some(0),
                source.error.as_deref().unwrap_or("unreadable"),
            ),
            source: source.source.clone(),
            source_path: source.path.clone(),
            line_number: None,
            schedule: String::new(),
            schedule_description: "无法读取".to_string(),
            user: None,
            command: String::new(),
            status: CronTaskStatus::Unreadable,
            env: Vec::new(),
            raw_line: String::new(),
            script_path: None,
            script_preview: None,
            source_hash: source.hash.clone(),
            last_error: source.error.clone(),
        }];
    }

    let mut env = Vec::new();
    let mut records = Vec::new();
    let has_user_field = matches!(
        source.source,
        CronTaskSource::SystemCrontab | CronTaskSource::CronD
    );

    for (index, raw_line) in source.content.lines().enumerate() {
        let line_number = index + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if is_env_line(trimmed) {
            env.push(trimmed.to_string());
            continue;
        }

        let (status, active_line) = if let Some(rest) = trimmed.strip_prefix(DISABLED_PREFIX) {
            (CronTaskStatus::Disabled, rest.trim())
        } else if trimmed.starts_with('#') {
            continue;
        } else {
            (CronTaskStatus::Active, trimmed)
        };

        match split_cron_line(active_line, has_user_field) {
            Some((schedule, user, command)) => records.push(CronTaskRecord {
                id: task_id(
                    &source.source,
                    source.path.as_deref(),
                    Some(line_number),
                    raw_line,
                ),
                source: source.source.clone(),
                source_path: source.path.clone(),
                line_number: Some(line_number),
                schedule_description: schedule_description(&schedule),
                schedule,
                user,
                script_path: detect_script_path(&command),
                command,
                status,
                env: env.clone(),
                raw_line: raw_line.to_string(),
                script_preview: None,
                source_hash: source.hash.clone(),
                last_error: None,
            }),
            None => records.push(CronTaskRecord {
                id: task_id(
                    &source.source,
                    source.path.as_deref(),
                    Some(line_number),
                    raw_line,
                ),
                source: source.source.clone(),
                source_path: source.path.clone(),
                line_number: Some(line_number),
                schedule: String::new(),
                schedule_description: "无法解析".to_string(),
                user: None,
                command: trimmed.to_string(),
                status: CronTaskStatus::Invalid,
                env: env.clone(),
                raw_line: raw_line.to_string(),
                script_path: None,
                script_preview: None,
                source_hash: source.hash.clone(),
                last_error: Some("无法解析这行 cron 表达式。".to_string()),
            }),
        }
    }

    records
}

fn periodic_record(schedule: String, path: String) -> CronTaskRecord {
    let raw_line = format!("{} root {}", schedule, path);
    CronTaskRecord {
        id: task_id(
            &CronTaskSource::PeriodicDirectory,
            Some(&path),
            None,
            &raw_line,
        ),
        source: CronTaskSource::PeriodicDirectory,
        source_path: Some(path.clone()),
        line_number: None,
        schedule_description: schedule_description(&schedule),
        schedule,
        user: Some("root".to_string()),
        command: path.clone(),
        status: CronTaskStatus::Active,
        env: Vec::new(),
        raw_line,
        script_path: Some(path),
        script_preview: None,
        source_hash: hash_text("periodic-directory"),
        last_error: None,
    }
}

fn dangerous_warnings(command: &str) -> Vec<String> {
    let lower = command.to_lowercase();
    let mut warnings = Vec::new();
    if lower.contains("rm -rf") || lower.contains("mkfs") || lower.contains("dd ") {
        warnings.push("命令包含高风险文件/磁盘操作。".to_string());
    }
    if lower.contains("reboot") || lower.contains("shutdown") || lower.contains("systemctl restart")
    {
        warnings.push("命令可能重启服务或服务器。".to_string());
    }
    if (lower.contains("curl ") || lower.contains("wget ")) && lower.contains('|') {
        warnings.push("命令包含网络下载并管道执行，请确认来源可信。".to_string());
    }
    warnings
}

fn preview_script(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    record: &mut CronTaskRecord,
) {
    let Some(path) = record.script_path.clone() else {
        return;
    };
    let command = format!(
        "if [ -r {path} ]; then head -n {lines} {path} | head -c {bytes}; else sudo -n head -n {lines} {path} 2>/dev/null | head -c {bytes}; fi",
        path = shell_quote(&path),
        lines = SCRIPT_PREVIEW_LINES,
        bytes = SCRIPT_PREVIEW_BYTES,
    );
    match run_remote_command(ssh_manager, server_id, &command) {
        Ok(output) if output.exit_code == 0 && !output.stdout.trim().is_empty() => {
            record.script_preview = Some(output.stdout);
        }
        Ok(output) if output.exit_code != 0 => {
            record.last_error = Some(non_empty_or(
                output.stderr,
                format!("无法读取脚本 {}", path),
            ));
        }
        Err(err) => {
            record.last_error = Some(err);
        }
        _ => {}
    }
}

fn scan_records(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    with_script_previews: bool,
) -> CronTaskListResult {
    let mut records = Vec::new();
    let sources = collect_sources(ssh_manager, server_id);
    for source in &sources {
        records.extend(parse_source(source));
    }
    for (schedule, path) in list_periodic_paths(ssh_manager, server_id) {
        records.push(periodic_record(schedule, path));
    }

    if with_script_previews {
        for record in &mut records {
            preview_script(ssh_manager, server_id, record);
        }
    }

    records.sort_by(|a, b| {
        format!("{:?}", a.source)
            .cmp(&format!("{:?}", b.source))
            .then_with(|| a.source_path.cmp(&b.source_path))
            .then_with(|| a.line_number.cmp(&b.line_number))
    });

    CronTaskListResult {
        server_id: server_id.to_string(),
        records,
        scanned_at: now_timestamp(),
        timezone: get_timezone(ssh_manager, server_id),
        last_error: None,
    }
}

fn source_label(source: &CronTaskSource, path: Option<&str>) -> String {
    match source {
        CronTaskSource::UserCrontab => "当前用户 crontab".to_string(),
        CronTaskSource::SystemCrontab => "/etc/crontab".to_string(),
        CronTaskSource::CronD => path.unwrap_or("/etc/cron.d").to_string(),
        CronTaskSource::PeriodicDirectory => path.unwrap_or("周期目录任务").to_string(),
    }
}

fn read_source_for_change(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    source: &CronTaskSource,
    source_path: Option<&str>,
) -> Result<CronSourceContent, String> {
    Ok(match source {
        CronTaskSource::UserCrontab => read_user_crontab(ssh_manager, server_id),
        CronTaskSource::SystemCrontab => read_remote_file(
            ssh_manager,
            server_id,
            "/etc/crontab",
            CronTaskSource::SystemCrontab,
        ),
        CronTaskSource::CronD => {
            let path = source_path.ok_or_else(|| "缺少 cron.d 文件路径。".to_string())?;
            read_remote_file(ssh_manager, server_id, path, CronTaskSource::CronD)
        }
        CronTaskSource::PeriodicDirectory => {
            let path = source_path.ok_or_else(|| "缺少周期目录脚本路径。".to_string())?;
            CronSourceContent {
                source: CronTaskSource::PeriodicDirectory,
                path: Some(path.to_string()),
                content: String::new(),
                hash: hash_text("periodic-directory"),
                readable: true,
                error: None,
            }
        }
    })
}

fn build_cron_line(
    request: &CronTaskChangeRequest,
    source: &CronTaskSource,
) -> Result<String, String> {
    if let Some(raw) = &request.raw_line {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let schedule = request
        .schedule
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少计划表达式。".to_string())?;
    let command = request
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少任务命令。".to_string())?;

    if matches!(
        source,
        CronTaskSource::SystemCrontab | CronTaskSource::CronD
    ) {
        let user = request
            .user
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("root");
        Ok(format!("{} {} {}", schedule, user, command))
    } else {
        Ok(format!("{} {}", schedule, command))
    }
}

fn find_record<'a>(
    records: &'a [CronTaskRecord],
    task_id: &str,
) -> Result<&'a CronTaskRecord, String> {
    records
        .iter()
        .find(|record| record.id == task_id)
        .ok_or_else(|| "任务不存在，请刷新后重试。".to_string())
}

fn replace_line(
    content: &str,
    line_number: usize,
    replacement: Option<String>,
) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(ToOwned::to_owned).collect();
    if line_number == 0 || line_number > lines.len() {
        return Err("目标行不存在，请刷新后重试。".to_string());
    }
    match replacement {
        Some(value) => lines[line_number - 1] = value,
        None => {
            lines.remove(line_number - 1);
        }
    }
    let mut updated = lines.join("\n");
    if !updated.is_empty() {
        updated.push('\n');
    }
    Ok(updated)
}

fn build_preview(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    request: CronTaskChangeRequest,
) -> Result<CronTaskChangePreview, String> {
    let list = scan_records(ssh_manager, server_id, false);
    let mut warnings = Vec::new();

    let (source, source_path, before_text, after_text, summary, affected_source, requires_sudo) =
        match request.action {
            CronTaskChangeAction::Create => {
                let source = request
                    .source
                    .clone()
                    .unwrap_or(CronTaskSource::UserCrontab);
                let source_path = request.source_path.clone();
                if matches!(source, CronTaskSource::CronD)
                    && source_path
                        .as_deref()
                        .map(str::trim)
                        .unwrap_or("")
                        .is_empty()
                {
                    return Err("新增 /etc/cron.d 任务需要填写文件路径。".to_string());
                }
                let mut source_content = read_source_for_change(
                    ssh_manager,
                    server_id,
                    &source,
                    source_path.as_deref(),
                )?;
                if matches!(source, CronTaskSource::CronD) && !source_content.readable {
                    if let Some(path) = source_path.as_deref() {
                        if remote_path_exists(ssh_manager, server_id, path) {
                            return Err(source_content.error.unwrap_or_else(|| {
                                "目标 cron.d 文件已存在但无法读取，拒绝覆盖。".to_string()
                            }));
                        }
                    }
                    source_content.content = String::new();
                    source_content.hash = hash_text("");
                    source_content.readable = true;
                    source_content.error = None;
                }
                if !source_content.readable {
                    return Err(source_content
                        .error
                        .unwrap_or_else(|| "无法读取目标 cron 来源。".to_string()));
                }
                let line = build_cron_line(&request, &source)?;
                warnings.extend(dangerous_warnings(&line));
                let mut updated = source_content.content.trim_end_matches('\n').to_string();
                if !updated.is_empty() {
                    updated.push('\n');
                }
                updated.push_str(&line);
                updated.push('\n');
                let label = source_label(&source, source_path.as_deref());
                let requires_sudo = !matches!(source, CronTaskSource::UserCrontab);
                (
                    source.clone(),
                    source_path,
                    source_content.content,
                    updated,
                    "新增定时任务".to_string(),
                    label,
                    requires_sudo,
                )
            }
            CronTaskChangeAction::Disable
            | CronTaskChangeAction::Enable
            | CronTaskChangeAction::Delete
            | CronTaskChangeAction::Update => {
                let task_id = request
                    .task_id
                    .as_deref()
                    .ok_or_else(|| "缺少任务 ID。".to_string())?;
                let record = find_record(&list.records, task_id)?;
                let source = record.source.clone();
                let source_path = record.source_path.clone();
                let source_content = read_source_for_change(
                    ssh_manager,
                    server_id,
                    &source,
                    source_path.as_deref(),
                )?;
                if matches!(source, CronTaskSource::PeriodicDirectory) {
                    if !matches!(request.action, CronTaskChangeAction::Delete) {
                        return Err("周期目录任务只支持删除脚本，不支持停用或编辑。".to_string());
                    }
                    warnings.push(
                        "删除周期目录脚本会移除该文件，请确认脚本没有被其它地方使用。".to_string(),
                    );
                    let label = source_label(&source, source_path.as_deref());
                    (
                        source,
                        source_path,
                        record.raw_line.clone(),
                        String::new(),
                        "删除周期目录任务脚本".to_string(),
                        label,
                        true,
                    )
                } else {
                    if !source_content.readable {
                        return Err(source_content
                            .error
                            .unwrap_or_else(|| "无法读取目标 cron 来源。".to_string()));
                    }
                    let line_number = record
                        .line_number
                        .ok_or_else(|| "目标任务缺少行号。".to_string())?;
                    let replacement = match request.action {
                        CronTaskChangeAction::Disable => {
                            if record.status == CronTaskStatus::Disabled {
                                Some(record.raw_line.clone())
                            } else {
                                Some(format!("{}{}", DISABLED_PREFIX, record.raw_line.trim()))
                            }
                        }
                        CronTaskChangeAction::Enable => Some(
                            record
                                .raw_line
                                .trim()
                                .strip_prefix(DISABLED_PREFIX)
                                .unwrap_or(record.raw_line.trim())
                                .to_string(),
                        ),
                        CronTaskChangeAction::Delete => None,
                        CronTaskChangeAction::Update => {
                            let line = build_cron_line(&request, &source)?;
                            warnings.extend(dangerous_warnings(&line));
                            Some(line)
                        }
                        CronTaskChangeAction::Create => unreachable!(),
                    };
                    if matches!(request.action, CronTaskChangeAction::Delete) {
                        warnings.push("删除后该任务不会再自动运行。".to_string());
                    }
                    let updated = replace_line(&source_content.content, line_number, replacement)?;
                    let label = source_label(&source, source_path.as_deref());
                    let requires_sudo = !matches!(source, CronTaskSource::UserCrontab);
                    (
                        source.clone(),
                        source_path,
                        source_content.content,
                        updated,
                        match request.action {
                            CronTaskChangeAction::Disable => "停用定时任务".to_string(),
                            CronTaskChangeAction::Enable => "启用定时任务".to_string(),
                            CronTaskChangeAction::Delete => "删除定时任务".to_string(),
                            CronTaskChangeAction::Update => "编辑定时任务".to_string(),
                            CronTaskChangeAction::Create => unreachable!(),
                        },
                        label,
                        requires_sudo,
                    )
                }
            }
        };

    if requires_sudo {
        warnings.push(
            "系统级任务需要 sudo -n 权限；如果远端未配置免密 sudo，应用不会修改远端。".to_string(),
        );
    }

    let commands = preview_commands(&source, source_path.as_deref(), &after_text);
    Ok(CronTaskChangePreview {
        summary,
        affected_source,
        before_text: before_text.clone(),
        after_text,
        commands,
        requires_sudo,
        expected_hash: hash_text(&before_text),
        warnings,
    })
}

fn preview_commands(source: &CronTaskSource, path: Option<&str>, after_text: &str) -> Vec<String> {
    match source {
        CronTaskSource::UserCrontab => vec!["crontab <generated-temp-file>".to_string()],
        CronTaskSource::SystemCrontab | CronTaskSource::CronD => vec![
            format!(
                "sudo -n cp {path} {path}.lazyshell.bak.<timestamp>",
                path = path.unwrap_or("/etc/crontab")
            ),
            format!("sudo -n tee {} >/dev/null", path.unwrap_or("/etc/crontab")),
        ],
        CronTaskSource::PeriodicDirectory => vec![format!("sudo -n rm -f {}", path.unwrap_or(""))],
    }
    .into_iter()
    .filter(|value| !value.trim().is_empty() || !after_text.is_empty())
    .collect()
}

fn write_user_crontab(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    content: &str,
) -> Result<(), String> {
    let encoded = general_purpose::STANDARD.encode(content.as_bytes());
    let command = format!(
        "tmp=$(mktemp) && printf %s {payload} | base64 -d > \"$tmp\" && crontab \"$tmp\"; rc=$?; rm -f \"$tmp\"; exit $rc",
        payload = shell_quote(&encoded)
    );
    let output = run_remote_command(ssh_manager, server_id, &command)?;
    if output.exit_code != 0 {
        return Err(non_empty_or(output.stderr, "写入用户 crontab 失败。"));
    }
    Ok(())
}

fn write_system_file(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    let encoded = general_purpose::STANDARD.encode(content.as_bytes());
    let timestamp = now_timestamp();
    let command = format!(
        "if sudo -n test -e {path}; then sudo -n cp {path} {backup}; fi && printf %s {payload} | base64 -d | sudo -n tee {path} >/dev/null",
        path = shell_quote(path),
        backup = shell_quote(&format!("{}.lazyshell.bak.{}", path, timestamp)),
        payload = shell_quote(&encoded)
    );
    let output = run_remote_command(ssh_manager, server_id, &command)?;
    if output.exit_code != 0 {
        return Err(non_empty_or(output.stderr, "写入系统 cron 文件失败。"));
    }
    Ok(())
}

fn remove_periodic_file(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    path: &str,
) -> Result<(), String> {
    let command = format!("sudo -n rm -f {}", shell_quote(path));
    let output = run_remote_command(ssh_manager, server_id, &command)?;
    if output.exit_code != 0 {
        return Err(non_empty_or(output.stderr, "删除周期目录脚本失败。"));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_cron_tasks(
    server_id: String,
    state: State<'_, AppState>,
) -> Result<CronTaskListResult, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(scan_records(&ssh_manager, &server_id, false)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_cron_task(
    server_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> Result<CronTaskRecord, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = scan_records(&ssh_manager, &server_id, false);
        let position = list
            .records
            .iter()
            .position(|record| record.id == task_id)
            .ok_or_else(|| "任务不存在，请刷新后重试。".to_string())?;
        let mut record = list.records.remove(position);
        preview_script(&ssh_manager, &server_id, &mut record);
        Ok(record)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_cron_task_change(
    server_id: String,
    request: CronTaskChangeRequest,
    state: State<'_, AppState>,
) -> Result<CronTaskChangePreview, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || build_preview(&ssh_manager, &server_id, request))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_cron_task_change(
    server_id: String,
    request: CronTaskChangeRequest,
    expected_hash: String,
    state: State<'_, AppState>,
) -> Result<CronTaskListResult, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preview = build_preview(&ssh_manager, &server_id, request)?;
        if preview.expected_hash != expected_hash {
            return Err("远端 cron 内容已变化，请刷新后重试。".to_string());
        }

        let source = preview.affected_source.clone();
        if preview
            .commands
            .iter()
            .any(|command| command.starts_with("sudo -n rm -f "))
        {
            let path = source.as_str();
            remove_periodic_file(&ssh_manager, &server_id, path)?;
        } else if preview.requires_sudo {
            write_system_file(
                &ssh_manager,
                &server_id,
                &preview.affected_source,
                &preview.after_text,
            )?;
        } else {
            write_user_crontab(&ssh_manager, &server_id, &preview.after_text)?;
        }

        Ok(scan_records(&ssh_manager, &server_id, false))
    })
    .await
    .map_err(|e| e.to_string())?
}
