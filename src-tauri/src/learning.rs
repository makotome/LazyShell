#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_EXECUTION_EXPERIENCES: usize = 2000;
const MAX_MEMORY_ITEMS: usize = 1200;
const MAX_SERVER_ENVIRONMENT_PROFILES: usize = 200;
const MAX_SUMMARY_CHARS: usize = 800;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LearningDataEntry {
    pub id: String,
    pub natural_language: String,
    pub command: String,
    pub server_os: String,
    pub usage_count: u32,
    pub last_used: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionExperience {
    pub id: String,
    pub server_id: String,
    pub user_intent: String,
    pub suggested_command: Option<String>,
    pub final_command: String,
    pub user_modified: bool,
    pub current_dir: Option<String>,
    pub stdout_summary: String,
    pub stderr_summary: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub failure_kind: Option<String>,
    pub risk_level: String,
    pub source: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub server_id: Option<String>,
    pub related_command: Option<String>,
    pub score: f32,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerEnvironmentProfile {
    pub server_id: String,
    pub hostname: Option<String>,
    pub os_name: Option<String>,
    pub distro: Option<String>,
    pub package_manager: Option<String>,
    pub default_shell: Option<String>,
    pub capabilities: Vec<String>,
    pub evidence_sources: Vec<String>,
    pub confidence: f32,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordExecutionFeedbackRequest {
    pub server_id: String,
    pub user_intent: String,
    pub suggested_command: Option<String>,
    pub final_command: String,
    pub current_dir: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub exit_code: Option<i32>,
    pub source: Option<String>,
    pub risk_level: Option<String>,
}

fn get_app_data_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_local_dir().ok_or("Failed to get data directory")?;
    let app_dir = data_dir.join("LazyShell");
    fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir)
}

fn get_learning_file_path() -> Result<PathBuf, String> {
    Ok(get_app_data_dir()?.join("learning_data.json"))
}

fn get_execution_experiences_path() -> Result<PathBuf, String> {
    Ok(get_app_data_dir()?.join("execution_experiences.json"))
}

fn get_memory_items_path() -> Result<PathBuf, String> {
    Ok(get_app_data_dir()?.join("memory_items.json"))
}

fn get_server_environment_profiles_path() -> Result<PathBuf, String> {
    Ok(get_app_data_dir()?.join("server_environment_profiles.json"))
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn truncate_summary(value: &str) -> String {
    let truncated: String = value.chars().take(MAX_SUMMARY_CHARS).collect();
    if value.chars().count() > MAX_SUMMARY_CHARS {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

fn tokenize(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-' && c != '/')
        .filter_map(|token| {
            let normalized = token.trim().to_lowercase();
            if normalized.len() < 2 || !seen.insert(normalized.clone()) {
                None
            } else {
                Some(normalized)
            }
        })
        .collect()
}

fn atomic_write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, json).map_err(|e| e.to_string())?;
    fs::rename(&temp_path, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_json_vec<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Result<Vec<T>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn load_execution_experiences_internal() -> Result<Vec<ExecutionExperience>, String> {
    load_json_vec(&get_execution_experiences_path()?)
}

fn save_execution_experiences_internal(entries: &[ExecutionExperience]) -> Result<(), String> {
    atomic_write_json(&get_execution_experiences_path()?, &entries)
}

pub fn load_memory_items_internal() -> Result<Vec<MemoryItem>, String> {
    load_json_vec(&get_memory_items_path()?)
}

fn save_memory_items_internal(items: &[MemoryItem]) -> Result<(), String> {
    atomic_write_json(&get_memory_items_path()?, &items)
}

fn load_server_environment_profiles_internal() -> Result<Vec<ServerEnvironmentProfile>, String> {
    load_json_vec(&get_server_environment_profiles_path()?)
}

fn save_server_environment_profiles_internal(items: &[ServerEnvironmentProfile]) -> Result<(), String> {
    atomic_write_json(&get_server_environment_profiles_path()?, &items)
}

fn classify_failure_kind(stderr: &str, stdout: &str, exit_code: Option<i32>) -> Option<String> {
    let combined = format!("{}\n{}", stderr.to_lowercase(), stdout.to_lowercase());
    if exit_code == Some(0) && combined.trim().is_empty() {
        return None;
    }
    if combined.contains("permission denied") {
        return Some("permission_denied".to_string());
    }
    if combined.contains("command not found") || combined.contains("not recognized as an internal or external command") {
        return Some("command_not_found".to_string());
    }
    if combined.contains("no such file or directory") || combined.contains("cannot access") {
        return Some("path_not_found".to_string());
    }
    if combined.contains("timed out") || combined.contains("timeout") {
        return Some("timeout".to_string());
    }
    if combined.contains("temporary failure")
        || combined.contains("name or service not known")
        || combined.contains("connection refused")
        || combined.contains("network is unreachable")
    {
        return Some("network_error".to_string());
    }
    if exit_code == Some(0) {
        None
    } else {
        Some("unknown".to_string())
    }
}

fn add_evidence(profile: &mut ServerEnvironmentProfile, source: &str) {
    if !profile.evidence_sources.iter().any(|existing| existing == source) {
        profile.evidence_sources.push(source.to_string());
        profile.evidence_sources.sort();
    }
}

fn merge_optional_field(target: &mut Option<String>, candidate: Option<String>) {
    if target.is_none() {
        *target = candidate;
    }
}

fn merge_capabilities(target: &mut Vec<String>, capabilities: Vec<String>) {
    for capability in capabilities {
        if !target.iter().any(|existing| existing == &capability) {
            target.push(capability);
        }
    }
    target.sort();
}

fn parse_os_release_value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some(value) = trimmed.strip_prefix(&format!("{key}=")) {
                Some(value.trim_matches('"').to_string())
            } else {
                None
            }
        })
        .filter(|value| !value.trim().is_empty())
}

fn infer_package_manager(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if lower.contains(" apt ") || lower.starts_with("apt ") || lower.contains("apt-get") || lower.contains("dpkg") {
        Some("apt".to_string())
    } else if lower.contains(" dnf ") || lower.starts_with("dnf ") {
        Some("dnf".to_string())
    } else if lower.contains(" yum ") || lower.starts_with("yum ") || lower.contains("rpm ") {
        Some("yum".to_string())
    } else if lower.contains(" apk ") || lower.starts_with("apk ") {
        Some("apk".to_string())
    } else if lower.contains(" pacman ") || lower.starts_with("pacman ") {
        Some("pacman".to_string())
    } else {
        None
    }
}

fn infer_shell(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    ["/bin/zsh", "zsh", "/bin/bash", "bash", "/bin/sh", "sh", "fish"]
        .iter()
        .find(|candidate| lower.contains(**candidate))
        .map(|candidate| candidate.trim_start_matches("/bin/").to_string())
}

fn infer_capabilities(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut capabilities = Vec::new();
    let checks = [
        ("systemctl", "systemd"),
        ("docker compose", "docker"),
        ("docker", "docker"),
        ("pm2", "pm2"),
        ("nginx", "nginx"),
        ("python3", "python"),
        ("python", "python"),
        ("pip", "python"),
        ("node", "node"),
        ("npm", "node"),
        ("pnpm", "node"),
        ("yarn", "node"),
        ("git", "git"),
        ("openclaw", "openclaw"),
    ];

    for (needle, capability) in checks {
        if lower.contains(needle) && !capabilities.iter().any(|existing| existing == capability) {
            capabilities.push(capability.to_string());
        }
    }

    capabilities
}

fn infer_os_name_from_text(text: &str) -> Option<String> {
    parse_os_release_value(text, "NAME").or_else(|| {
        let lower = text.to_lowercase();
        if lower.contains("ubuntu") {
            Some("Ubuntu".to_string())
        } else if lower.contains("debian") {
            Some("Debian".to_string())
        } else if lower.contains("centos") {
            Some("CentOS".to_string())
        } else if lower.contains("rocky") {
            Some("Rocky Linux".to_string())
        } else if lower.contains("almalinux") {
            Some("AlmaLinux".to_string())
        } else if lower.contains("amazon linux") {
            Some("Amazon Linux".to_string())
        } else if lower.contains("suse") {
            Some("SUSE".to_string())
        } else if lower.contains("linux") {
            Some("Linux".to_string())
        } else {
            None
        }
    })
}

fn infer_distro_from_text(text: &str) -> Option<String> {
    parse_os_release_value(text, "PRETTY_NAME")
        .or_else(|| parse_os_release_value(text, "VERSION"))
        .or_else(|| infer_os_name_from_text(text))
}

fn detect_profile_from_banner(server_id: &str, hostname: &str, os_info: &str, distro_info: &str) -> ServerEnvironmentProfile {
    let combined = format!("{os_info}\n{distro_info}");
    let now = current_timestamp();

    ServerEnvironmentProfile {
        server_id: server_id.to_string(),
        hostname: if hostname.trim().is_empty() { None } else { Some(hostname.trim().to_string()) },
        os_name: infer_os_name_from_text(&combined),
        distro: infer_distro_from_text(&combined),
        package_manager: infer_package_manager(&combined),
        default_shell: infer_shell(&combined),
        capabilities: infer_capabilities(&combined),
        evidence_sources: vec!["banner".to_string()],
        confidence: if combined.trim().is_empty() { 0.25 } else { 0.55 },
        updated_at: now,
    }
}

fn detect_profile_from_status(server_id: &str, disk_stdout: &str, memory_stdout: &str, network_stdout: &str) -> ServerEnvironmentProfile {
    let combined = format!("{disk_stdout}\n{memory_stdout}\n{network_stdout}");
    let now = current_timestamp();
    let lower = combined.to_lowercase();
    let mut capabilities = infer_capabilities(&combined);
    if lower.contains("/dev/") || lower.contains("filesystem") {
        capabilities.push("linux".to_string());
    }
    capabilities.sort();
    capabilities.dedup();

    ServerEnvironmentProfile {
        server_id: server_id.to_string(),
        hostname: None,
        os_name: if lower.contains("filesystem") { Some("Linux".to_string()) } else { None },
        distro: None,
        package_manager: None,
        default_shell: None,
        capabilities,
        evidence_sources: vec!["status".to_string()],
        confidence: if combined.trim().is_empty() { 0.15 } else { 0.3 },
        updated_at: now,
    }
}

fn detect_profile_from_experience(experience: &ExecutionExperience) -> ServerEnvironmentProfile {
    let combined = format!(
        "{}\n{}\n{}\n{}",
        experience.user_intent,
        experience
            .suggested_command
            .clone()
            .unwrap_or_default(),
        experience.final_command,
        experience.stderr_summary
    );
    let now = current_timestamp();

    ServerEnvironmentProfile {
        server_id: experience.server_id.clone(),
        hostname: None,
        os_name: None,
        distro: None,
        package_manager: infer_package_manager(&combined),
        default_shell: infer_shell(&combined),
        capabilities: infer_capabilities(&combined),
        evidence_sources: vec!["execution_experience".to_string()],
        confidence: if experience.success { 0.7 } else { 0.45 },
        updated_at: now,
    }
}

fn merge_server_environment_profile(
    existing: Option<ServerEnvironmentProfile>,
    candidate: ServerEnvironmentProfile,
) -> ServerEnvironmentProfile {
    let mut profile = existing.unwrap_or_else(|| ServerEnvironmentProfile {
        server_id: candidate.server_id.clone(),
        ..ServerEnvironmentProfile::default()
    });

    profile.server_id = candidate.server_id.clone();
    merge_optional_field(&mut profile.hostname, candidate.hostname);
    merge_optional_field(&mut profile.os_name, candidate.os_name);
    merge_optional_field(&mut profile.distro, candidate.distro);
    merge_optional_field(&mut profile.package_manager, candidate.package_manager);
    merge_optional_field(&mut profile.default_shell, candidate.default_shell);
    merge_capabilities(&mut profile.capabilities, candidate.capabilities);
    for source in candidate.evidence_sources {
        add_evidence(&mut profile, &source);
    }
    profile.confidence = profile.confidence.max(candidate.confidence);
    profile.updated_at = current_timestamp();
    profile
}

fn merge_profile_into_store(candidate: ServerEnvironmentProfile) -> Result<ServerEnvironmentProfile, String> {
    let mut profiles = load_server_environment_profiles_internal()?;
    let index = profiles
        .iter()
        .position(|profile| profile.server_id == candidate.server_id);

    let merged = if let Some(index) = index {
        let existing = profiles.remove(index);
        merge_server_environment_profile(Some(existing), candidate)
    } else {
        merge_server_environment_profile(None, candidate)
    };

    profiles.push(merged.clone());
    profiles.sort_by(|a, b| a.server_id.cmp(&b.server_id));
    if profiles.len() > MAX_SERVER_ENVIRONMENT_PROFILES {
        let excess = profiles.len() - MAX_SERVER_ENVIRONMENT_PROFILES;
        profiles.drain(0..excess);
    }
    save_server_environment_profiles_internal(&profiles)?;
    Ok(merged)
}

pub fn update_server_environment_profile_from_banner(
    server_id: &str,
    hostname: &str,
    os_info: &str,
    distro_info: &str,
) -> Result<ServerEnvironmentProfile, String> {
    merge_profile_into_store(detect_profile_from_banner(server_id, hostname, os_info, distro_info))
}

pub fn update_server_environment_profile_from_status(
    server_id: &str,
    disk_stdout: &str,
    memory_stdout: &str,
    network_stdout: &str,
) -> Result<ServerEnvironmentProfile, String> {
    merge_profile_into_store(detect_profile_from_status(
        server_id,
        disk_stdout,
        memory_stdout,
        network_stdout,
    ))
}

pub fn update_server_environment_profile_from_experience(
    experience: &ExecutionExperience,
) -> Result<ServerEnvironmentProfile, String> {
    merge_profile_into_store(detect_profile_from_experience(experience))
}

pub fn update_server_environment_profile_from_probe(
    server_id: &str,
    package_manager: Option<String>,
    default_shell: Option<String>,
    capabilities: Vec<String>,
) -> Result<ServerEnvironmentProfile, String> {
    let now = current_timestamp();
    merge_profile_into_store(ServerEnvironmentProfile {
        server_id: server_id.to_string(),
        hostname: None,
        os_name: None,
        distro: None,
        package_manager,
        default_shell,
        capabilities,
        evidence_sources: vec!["probe".to_string()],
        confidence: 0.9,
        updated_at: now,
    })
}

pub fn load_server_environment_profile_internal(server_id: &str) -> Result<Option<ServerEnvironmentProfile>, String> {
    let profiles = load_server_environment_profiles_internal()?;
    Ok(profiles.into_iter().find(|profile| profile.server_id == server_id))
}

fn experience_reliability_score(item: &ExecutionExperience) -> f32 {
    match (item.success, item.user_modified) {
        (true, false) => 3.6,
        (true, true) => 1.4,
        (false, false) => 0.35,
        (false, true) => 0.2,
    }
}

fn build_memory_item_from_experience(experience: &ExecutionExperience) -> MemoryItem {
    let now = current_timestamp();
    let kind = if experience.success { "success_case" } else { "failure_case" };
    let outcome = if experience.success {
        if experience.user_modified {
            format!("执行 `{}` 成功（用户修改过 AI 原命令）", experience.final_command)
        } else {
            format!("执行 `{}` 成功", experience.final_command)
        }
    } else {
        format!(
            "执行 `{}` 失败{}，原因：{}",
            experience.final_command,
            if experience.user_modified { "（用户修改过 AI 原命令）" } else { "" },
            experience
                .failure_kind
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        )
    };
    let summary = if experience.user_intent.trim().is_empty() {
        outcome
    } else {
        format!("用户意图：{}。{}", truncate_summary(&experience.user_intent), outcome)
    };

    let mut tags = tokenize(&experience.user_intent);
    tags.extend(tokenize(&experience.final_command));
    if let Some(failure_kind) = &experience.failure_kind {
        tags.push(failure_kind.clone());
    }
    if experience.user_modified {
        tags.push("user_modified".to_string());
    }
    tags.sort();
    tags.dedup();

    MemoryItem {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        summary,
        tags,
        server_id: Some(experience.server_id.clone()),
        related_command: Some(experience.final_command.clone()),
        score: experience_reliability_score(experience),
        created_at: now,
        updated_at: now,
    }
}

pub fn retrieve_relevant_experiences(
    server_id: &str,
    prompt: &str,
    limit: usize,
) -> Result<Vec<ExecutionExperience>, String> {
    let tokens = tokenize(prompt);
    let items = load_execution_experiences_internal()?;
    let mut scored = items
        .into_iter()
        .map(|item| {
            let mut score = experience_reliability_score(&item);
            if item.server_id == server_id {
                score += 5.0;
            }
            if item.success && !item.user_modified {
                score += 1.6;
            } else if item.success && item.user_modified {
                score -= 0.3;
            } else if !item.success {
                score -= 0.6;
            }
            let mut haystack = format!(
                "{} {} {}",
                item.user_intent,
                item.final_command,
                item.suggested_command.clone().unwrap_or_default()
            )
            .to_lowercase();
            if let Some(kind) = &item.failure_kind {
                haystack.push(' ');
                haystack.push_str(kind);
            }
            for token in &tokens {
                if haystack.contains(token) {
                    score += 1.2;
                }
            }
            if item.user_modified {
                score -= 0.9;
            }
            let age_days = ((current_timestamp().saturating_sub(item.created_at)) / 86_400) as f32;
            score -= age_days.min(30.0) * 0.03;
            (score, item)
        })
        .filter(|(score, _)| *score > 0.5)
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored.into_iter().take(limit).map(|(_, item)| item).collect())
}

pub fn retrieve_relevant_memory_items(
    server_id: &str,
    prompt: &str,
    limit: usize,
) -> Result<Vec<MemoryItem>, String> {
    let tokens = tokenize(prompt);
    let items = load_memory_items_internal()?;
    let mut scored = items
        .into_iter()
        .map(|item| {
            let mut score = item.score;
            if item.server_id.as_deref() == Some(server_id) {
                score += 3.0;
            }
            let mut haystack = format!("{} {}", item.summary, item.tags.join(" ")).to_lowercase();
            if let Some(command) = &item.related_command {
                haystack.push(' ');
                haystack.push_str(&command.to_lowercase());
            }
            for token in &tokens {
                if haystack.contains(token) {
                    score += 0.8;
                }
            }
            (score, item)
        })
        .filter(|(score, _)| *score > 0.5)
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored.into_iter().take(limit).map(|(_, item)| item).collect())
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

#[tauri::command]
pub fn record_execution_feedback(
    request: RecordExecutionFeedbackRequest,
) -> Result<ExecutionExperience, String> {
    let stdout = request.stdout.unwrap_or_default();
    let stderr = request.stderr.unwrap_or_default();
    let exit_code = request.exit_code;
    let failure_kind = classify_failure_kind(&stderr, &stdout, exit_code);
    let success = exit_code.unwrap_or(1) == 0 && failure_kind.is_none();
    let suggested_command = request.suggested_command.filter(|v| !v.trim().is_empty());
    let final_command = request.final_command.trim().to_string();
    let user_modified = suggested_command
        .as_ref()
        .map(|command| command.trim() != final_command)
        .unwrap_or(false);

    let experience = ExecutionExperience {
        id: Uuid::new_v4().to_string(),
        server_id: request.server_id,
        user_intent: request.user_intent.trim().to_string(),
        suggested_command,
        final_command,
        user_modified,
        current_dir: request.current_dir.filter(|v| !v.trim().is_empty()),
        stdout_summary: truncate_summary(&stdout),
        stderr_summary: truncate_summary(&stderr),
        exit_code,
        success,
        failure_kind,
        risk_level: request.risk_level.unwrap_or_else(|| "yellow".to_string()),
        source: request.source.unwrap_or_else(|| "direct".to_string()),
        created_at: current_timestamp(),
    };

    let mut experiences = load_execution_experiences_internal()?;
    experiences.push(experience.clone());
    if experiences.len() > MAX_EXECUTION_EXPERIENCES {
        let excess = experiences.len() - MAX_EXECUTION_EXPERIENCES;
        experiences.drain(0..excess);
    }
    save_execution_experiences_internal(&experiences)?;

    let mut memory_items = load_memory_items_internal()?;
    memory_items.push(build_memory_item_from_experience(&experience));
    if memory_items.len() > MAX_MEMORY_ITEMS {
        let excess = memory_items.len() - MAX_MEMORY_ITEMS;
        memory_items.drain(0..excess);
    }
    save_memory_items_internal(&memory_items)?;
    let _ = update_server_environment_profile_from_experience(&experience);

    Ok(experience)
}

#[tauri::command]
pub fn load_execution_experiences(
    server_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ExecutionExperience>, String> {
    let mut items = load_execution_experiences_internal()?;
    if let Some(server_id) = server_id {
        items.retain(|item| item.server_id == server_id);
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if let Some(limit) = limit {
        items.truncate(limit as usize);
    }
    Ok(items)
}

#[tauri::command]
pub fn load_memory_items(
    server_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<MemoryItem>, String> {
    let mut items = load_memory_items_internal()?;
    if let Some(server_id) = server_id {
        items.retain(|item| item.server_id.as_deref() == Some(server_id.as_str()));
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Some(limit) = limit {
        items.truncate(limit as usize);
    }
    Ok(items)
}

#[tauri::command]
pub fn load_server_environment_profile(
    server_id: String,
) -> Result<Option<ServerEnvironmentProfile>, String> {
    load_server_environment_profile_internal(&server_id)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_failure_kind, experience_reliability_score, infer_capabilities, infer_package_manager,
        merge_server_environment_profile, ExecutionExperience, ServerEnvironmentProfile,
    };

    #[test]
    fn classifies_permission_denied() {
        assert_eq!(
            classify_failure_kind("Permission denied", "", Some(1)).as_deref(),
            Some("permission_denied")
        );
    }

    #[test]
    fn classifies_path_not_found() {
        assert_eq!(
            classify_failure_kind("No such file or directory", "", Some(1)).as_deref(),
            Some("path_not_found")
        );
    }

    #[test]
    fn treats_zero_exit_without_errors_as_success() {
        assert_eq!(classify_failure_kind("", "", Some(0)), None);
    }

    #[test]
    fn unmodified_success_scores_higher_than_modified_success() {
        let direct_success = ExecutionExperience {
            id: "1".to_string(),
            server_id: "s1".to_string(),
            user_intent: "查看日志".to_string(),
            suggested_command: Some("journalctl -u nginx".to_string()),
            final_command: "journalctl -u nginx".to_string(),
            user_modified: false,
            current_dir: Some("/".to_string()),
            stdout_summary: String::new(),
            stderr_summary: String::new(),
            exit_code: Some(0),
            success: true,
            failure_kind: None,
            risk_level: "green".to_string(),
            source: "terminal".to_string(),
            created_at: 1,
        };
        let modified_success = ExecutionExperience {
            user_modified: true,
            final_command: "sudo journalctl -u nginx".to_string(),
            ..direct_success.clone()
        };

        assert!(experience_reliability_score(&direct_success) > experience_reliability_score(&modified_success));
    }

    #[test]
    fn infers_package_manager_and_capabilities() {
        assert_eq!(infer_package_manager("apt-get install nginx").as_deref(), Some("apt"));
        let capabilities = infer_capabilities("systemctl restart nginx && docker ps && openclaw status");
        assert!(capabilities.contains(&"systemd".to_string()));
        assert!(capabilities.contains(&"docker".to_string()));
        assert!(capabilities.contains(&"nginx".to_string()));
        assert!(capabilities.contains(&"openclaw".to_string()));
    }

    #[test]
    fn merges_profile_capabilities_without_overwriting_existing_fields() {
        let existing = ServerEnvironmentProfile {
            server_id: "s1".to_string(),
            hostname: Some("host-a".to_string()),
            os_name: Some("Ubuntu".to_string()),
            distro: Some("Ubuntu 24.04".to_string()),
            package_manager: Some("apt".to_string()),
            default_shell: None,
            capabilities: vec!["systemd".to_string()],
            evidence_sources: vec!["banner".to_string()],
            confidence: 0.55,
            updated_at: 1,
        };
        let candidate = ServerEnvironmentProfile {
            server_id: "s1".to_string(),
            hostname: None,
            os_name: None,
            distro: None,
            package_manager: None,
            default_shell: Some("zsh".to_string()),
            capabilities: vec!["docker".to_string()],
            evidence_sources: vec!["execution_experience".to_string()],
            confidence: 0.7,
            updated_at: 2,
        };

        let merged = merge_server_environment_profile(Some(existing), candidate);
        assert_eq!(merged.hostname.as_deref(), Some("host-a"));
        assert_eq!(merged.default_shell.as_deref(), Some("zsh"));
        assert!(merged.capabilities.contains(&"systemd".to_string()));
        assert!(merged.capabilities.contains(&"docker".to_string()));
        assert!(merged.confidence >= 0.7);
    }
}
