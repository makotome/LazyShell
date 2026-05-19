use crate::commands::AppState;
use crate::memory::{atomic_write_json, get_memory_dir, sanitize_server_id};
use crate::ssh::{CommandOutput, SSHConnection, SSHConnectionManager};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use tauri::State;

const CERTIFICATE_CACHE_VERSION: &str = "1.0";
const NGINX_ROOT: &str = "/etc/nginx";
const EXPIRING_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SslCertificateStatus {
    Missing,
    Valid,
    Expiring,
    Expired,
    Unreadable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SslCertificateSource {
    Nginx,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NginxCertificateBinding {
    pub config_path: String,
    pub server_names: Vec<String>,
    pub listen: Vec<String>,
    pub certificate_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslCertificateRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub source: SslCertificateSource,
    pub status: SslCertificateStatus,
    pub exists: bool,
    pub issued_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub days_until_expiry: Option<i64>,
    pub subject: Option<String>,
    pub issuer: Option<String>,
    pub domains: Vec<String>,
    pub bindings: Vec<NginxCertificateBinding>,
    pub last_checked_at: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslCertificateScanResult {
    pub server_id: String,
    pub records: Vec<SslCertificateRecord>,
    pub scanned_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SslCertificateCacheFile {
    server_id: String,
    records: Vec<SslCertificateRecord>,
    scanned_at: Option<i64>,
    last_error: Option<String>,
    version: String,
}

#[derive(Debug, Clone)]
struct ParsedServerBlock {
    config_path: String,
    server_names: Vec<String>,
    listen: Vec<String>,
    certificate_path: String,
    certificate_key_path: Option<String>,
}

fn now_timestamp() -> i64 {
    Utc::now().timestamp()
}

fn certificate_cache_path(server_id: &str) -> Result<PathBuf, String> {
    let memory_dir = get_memory_dir()?;
    let sanitized = sanitize_server_id(server_id);
    Ok(memory_dir.join(format!("{}_ssl_certificates.json", sanitized)))
}

fn load_cache(server_id: &str) -> Result<SslCertificateCacheFile, String> {
    let path = certificate_cache_path(server_id)?;
    if !path.exists() {
        return Ok(SslCertificateCacheFile {
            server_id: server_id.to_string(),
            records: Vec::new(),
            scanned_at: None,
            last_error: None,
            version: CERTIFICATE_CACHE_VERSION.to_string(),
        });
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn save_cache(cache: &SslCertificateCacheFile) -> Result<(), String> {
    let path = certificate_cache_path(&cache.server_id)?;
    atomic_write_json(&path, cache)
}

fn cache_to_result(cache: SslCertificateCacheFile) -> SslCertificateScanResult {
    SslCertificateScanResult {
        server_id: cache.server_id,
        records: cache.records,
        scanned_at: cache.scanned_at,
        last_error: cache.last_error,
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    if trimmed.starts_with('/') {
        format!("/{}", parts.join("/"))
    } else {
        parts.join("/")
    }
}

fn file_name_from_path(path: &str) -> String {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn certificate_id(path: &str) -> String {
    let mut hash: u64 = 5381;
    for byte in path.as_bytes() {
        hash = ((hash << 5).wrapping_add(hash)).wrapping_add(*byte as u64);
    }
    format!("{:x}", hash)
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

fn strip_nginx_comment(line: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    let mut previous = '\0';
    let mut output = String::new();

    for ch in line.chars() {
        if ch == '\'' && !in_double && previous != '\\' {
            in_single = !in_single;
        } else if ch == '"' && !in_single && previous != '\\' {
            in_double = !in_double;
        } else if ch == '#' && !in_single && !in_double {
            break;
        }
        output.push(ch);
        previous = ch;
    }

    output
}

fn split_directive_values(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_end_matches(';')
        .split_whitespace()
        .map(|part| part.trim_matches('"').trim_matches('\'').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn extract_server_blocks(config_path: &str, content: &str) -> Vec<(String, String)> {
    let cleaned = content
        .lines()
        .map(strip_nginx_comment)
        .collect::<Vec<_>>()
        .join("\n");
    let chars: Vec<char> = cleaned.chars().collect();
    let mut blocks = Vec::new();
    let mut index = 0usize;

    while index < chars.len() {
        if chars[index..].starts_with(&['s', 'e', 'r', 'v', 'e', 'r']) {
            let before_ok =
                index == 0 || !chars[index - 1].is_alphanumeric() && chars[index - 1] != '_';
            let after_index = index + 6;
            let after_ok = after_index >= chars.len()
                || chars[after_index].is_whitespace()
                || chars[after_index] == '{';

            if before_ok && after_ok {
                let mut cursor = after_index;
                while cursor < chars.len() && chars[cursor].is_whitespace() {
                    cursor += 1;
                }
                if cursor < chars.len() && chars[cursor] == '{' {
                    let block_start = cursor + 1;
                    let mut depth = 1i32;
                    cursor += 1;
                    while cursor < chars.len() {
                        match chars[cursor] {
                            '{' => depth += 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 {
                                    let block =
                                        chars[block_start..cursor].iter().collect::<String>();
                                    blocks.push((config_path.to_string(), block));
                                    break;
                                }
                            }
                            _ => {}
                        }
                        cursor += 1;
                    }
                    index = cursor;
                }
            }
        }
        index += 1;
    }

    blocks
}

fn parse_server_block(config_path: String, block: String) -> Option<ParsedServerBlock> {
    let mut server_names = Vec::new();
    let mut listen = Vec::new();
    let mut certificate_path = None;
    let mut certificate_key_path = None;

    for raw_directive in block.split(';') {
        let directive = raw_directive.trim();
        if directive.is_empty() || directive.contains('{') || directive.contains('}') {
            continue;
        }

        if let Some(rest) = directive.strip_prefix("server_name") {
            server_names.extend(split_directive_values(rest));
        } else if let Some(rest) = directive.strip_prefix("listen") {
            let value = rest.trim();
            if !value.is_empty() {
                listen.push(value.to_string());
            }
        } else if let Some(rest) = directive.strip_prefix("ssl_certificate_key") {
            certificate_key_path = split_directive_values(rest).first().cloned();
        } else if let Some(rest) = directive.strip_prefix("ssl_certificate") {
            certificate_path = split_directive_values(rest).first().cloned();
        }
    }

    let certificate_path = certificate_path?;
    Some(ParsedServerBlock {
        config_path,
        server_names: sorted_unique(server_names),
        listen: sorted_unique(listen),
        certificate_path: normalize_remote_path(&certificate_path),
        certificate_key_path: certificate_key_path.map(|path| normalize_remote_path(&path)),
    })
}

fn sorted_unique(values: Vec<String>) -> Vec<String> {
    let mut set = BTreeSet::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && trimmed != "_" {
            set.insert(trimmed.to_string());
        }
    }
    set.into_iter().collect()
}

fn find_nginx_config_paths(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
) -> Result<Vec<String>, String> {
    let command = format!(
        "if [ -d {root} ]; then find {root} -type f \\( -name '*.conf' -o -name 'nginx.conf' \\) 2>/dev/null | sort; else exit 12; fi",
        root = shell_quote(NGINX_ROOT)
    );
    let output = run_remote_command(ssh_manager, server_id, &command)?;

    if output.exit_code == 12 {
        return Err("/etc/nginx 不存在，无法扫描 Nginx 配置。".to_string());
    }
    if output.exit_code != 0 {
        return Err(non_empty_or(output.stderr, "读取 Nginx 配置列表失败。"));
    }

    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn read_remote_text_file(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    path: &str,
) -> Result<String, String> {
    let command = format!("sed -n '1,4000p' {} 2>/dev/null", shell_quote(path));
    let output = run_remote_command(ssh_manager, server_id, &command)?;
    if output.exit_code != 0 {
        return Err(non_empty_or(
            output.stderr,
            format!("读取配置失败: {}", path),
        ));
    }
    Ok(output.stdout)
}

fn discover_nginx_bindings(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
) -> Result<Vec<ParsedServerBlock>, String> {
    let config_paths = find_nginx_config_paths(ssh_manager, server_id)?;
    let mut blocks = Vec::new();

    for config_path in config_paths {
        if let Ok(content) = read_remote_text_file(ssh_manager, server_id, &config_path) {
            for (path, block) in extract_server_blocks(&config_path, &content) {
                if let Some(parsed) = parse_server_block(path, block) {
                    blocks.push(parsed);
                }
            }
        }
    }

    Ok(blocks)
}

fn non_empty_or(value: String, fallback: impl Into<String>) -> String {
    if value.trim().is_empty() {
        fallback.into()
    } else {
        value.trim().to_string()
    }
}

fn parse_openssl_date(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc2822(trimmed) {
        return Some(parsed.timestamp());
    }
    let without_zone = trimmed
        .strip_suffix(" GMT")
        .or_else(|| trimmed.strip_suffix(" UTC"))
        .unwrap_or(trimmed);
    if let Ok(parsed) = NaiveDateTime::parse_from_str(without_zone, "%b %e %H:%M:%S %Y") {
        return Some(Utc.from_utc_datetime(&parsed).timestamp());
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(without_zone, "%b %d %H:%M:%S %Y") {
        return Some(Utc.from_utc_datetime(&parsed).timestamp());
    }
    None
}

fn parse_subject_alt_names(lines: &[&str]) -> Vec<String> {
    let mut domains = Vec::new();
    let mut capture_next = false;

    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with("X509v3 Subject Alternative Name") {
            capture_next = true;
            continue;
        }
        if capture_next {
            for part in trimmed.split(',') {
                let value = part.trim();
                if let Some(domain) = value.strip_prefix("DNS:") {
                    domains.push(domain.trim().to_string());
                }
            }
            capture_next = false;
        }
    }

    sorted_unique(domains)
}

fn calculate_status(
    exists: bool,
    expires_at: Option<i64>,
    error: Option<&str>,
) -> (SslCertificateStatus, Option<i64>) {
    if !exists {
        return (SslCertificateStatus::Missing, None);
    }
    if error.is_some() {
        return (SslCertificateStatus::Unreadable, None);
    }

    let expires_at = match expires_at {
        Some(value) => value,
        None => return (SslCertificateStatus::Unreadable, None),
    };
    let days = (expires_at - now_timestamp()) / 86_400;
    let status = if days < 0 {
        SslCertificateStatus::Expired
    } else if days <= EXPIRING_DAYS {
        SslCertificateStatus::Expiring
    } else {
        SslCertificateStatus::Valid
    };
    (status, Some(days))
}

fn inspect_certificate_path(
    ssh_manager: &SSHConnectionManager,
    server_id: &str,
    certificate_path: &str,
    source: SslCertificateSource,
    bindings: Vec<NginxCertificateBinding>,
) -> SslCertificateRecord {
    let normalized_path = normalize_remote_path(certificate_path);
    let checked_at = now_timestamp();
    let name = file_name_from_path(&normalized_path);
    let mut record = SslCertificateRecord {
        id: certificate_id(&normalized_path),
        name,
        path: normalized_path.clone(),
        source,
        status: SslCertificateStatus::Unreadable,
        exists: false,
        issued_at: None,
        expires_at: None,
        days_until_expiry: None,
        subject: None,
        issuer: None,
        domains: Vec::new(),
        bindings,
        last_checked_at: checked_at,
        last_error: None,
    };

    let command = format!(
        "if [ ! -e {path} ]; then echo '__LAZYSHELL_CERT_MISSING__'; exit 0; fi; openssl x509 -in {path} -noout -dates -subject -issuer -ext subjectAltName 2>&1",
        path = shell_quote(&normalized_path)
    );

    match run_remote_command(ssh_manager, server_id, &command) {
        Ok(output) => {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            if combined.contains("__LAZYSHELL_CERT_MISSING__") {
                let (status, days) = calculate_status(false, None, None);
                record.status = status;
                record.days_until_expiry = days;
                record.exists = false;
                record.last_error = Some("证书文件不存在。".to_string());
                return record;
            }

            record.exists = true;
            if output.exit_code != 0 {
                let error = non_empty_or(combined, "证书存在，但 openssl 无法解析。");
                let (status, days) = calculate_status(true, None, Some(&error));
                record.status = status;
                record.days_until_expiry = days;
                record.last_error = Some(error);
                return record;
            }

            let lines: Vec<&str> = combined.lines().collect();
            for line in &lines {
                let trimmed = line.trim();
                if let Some(value) = trimmed.strip_prefix("notBefore=") {
                    record.issued_at = parse_openssl_date(value);
                } else if let Some(value) = trimmed.strip_prefix("notAfter=") {
                    record.expires_at = parse_openssl_date(value);
                } else if let Some(value) = trimmed.strip_prefix("subject=") {
                    record.subject = Some(value.trim().to_string());
                } else if let Some(value) = trimmed.strip_prefix("issuer=") {
                    record.issuer = Some(value.trim().to_string());
                }
            }

            record.domains = parse_subject_alt_names(&lines);
            if record.domains.is_empty() {
                record.domains = domains_from_bindings(&record.bindings);
            }
            let (status, days) = calculate_status(true, record.expires_at, None);
            record.status = status;
            record.days_until_expiry = days;
        }
        Err(err) => {
            let (status, days) = calculate_status(true, None, Some(&err));
            record.status = status;
            record.days_until_expiry = days;
            record.last_error = Some(err);
        }
    }

    record
}

fn domains_from_bindings(bindings: &[NginxCertificateBinding]) -> Vec<String> {
    sorted_unique(
        bindings
            .iter()
            .flat_map(|binding| binding.server_names.clone())
            .collect(),
    )
}

fn bindings_by_certificate(
    blocks: Vec<ParsedServerBlock>,
) -> BTreeMap<String, Vec<NginxCertificateBinding>> {
    let mut grouped: BTreeMap<String, Vec<NginxCertificateBinding>> = BTreeMap::new();
    for block in blocks {
        grouped
            .entry(block.certificate_path.clone())
            .or_default()
            .push(NginxCertificateBinding {
                config_path: block.config_path,
                server_names: block.server_names,
                listen: block.listen,
                certificate_key_path: block.certificate_key_path,
            });
    }
    grouped
}

fn merge_records(mut records: Vec<SslCertificateRecord>) -> Vec<SslCertificateRecord> {
    records.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    records
}

#[tauri::command]
pub async fn load_ssl_certificates(
    server_id: String,
    state: State<'_, AppState>,
) -> Result<SslCertificateScanResult, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = load_cache(&server_id)?;
        if !cache.records.is_empty() {
            let refreshed = cache
                .records
                .iter()
                .map(|record| {
                    inspect_certificate_path(
                        &ssh_manager,
                        &server_id,
                        &record.path,
                        record.source.clone(),
                        record.bindings.clone(),
                    )
                })
                .collect();
            cache.records = merge_records(refreshed);
            cache.last_error = None;
            save_cache(&cache)?;
        }
        Ok(cache_to_result(cache))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_nginx_ssl_certificates(
    server_id: String,
    state: State<'_, AppState>,
) -> Result<SslCertificateScanResult, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = load_cache(&server_id)?;
        let scanned_at = now_timestamp();

        match discover_nginx_bindings(&ssh_manager, &server_id) {
            Ok(blocks) => {
                let grouped = bindings_by_certificate(blocks);
                let mut records = Vec::new();

                for (certificate_path, bindings) in grouped {
                    records.push(inspect_certificate_path(
                        &ssh_manager,
                        &server_id,
                        &certificate_path,
                        SslCertificateSource::Nginx,
                        bindings,
                    ));
                }

                for cached in cache.records.into_iter() {
                    if cached.source == SslCertificateSource::Manual
                        && !records.iter().any(|record| record.path == cached.path)
                    {
                        records.push(inspect_certificate_path(
                            &ssh_manager,
                            &server_id,
                            &cached.path,
                            SslCertificateSource::Manual,
                            cached.bindings,
                        ));
                    }
                }

                cache.records = merge_records(records);
                cache.scanned_at = Some(scanned_at);
                cache.last_error = None;
            }
            Err(err) => {
                cache.scanned_at = Some(scanned_at);
                cache.last_error = Some(err);
            }
        }

        save_cache(&cache)?;
        Ok(cache_to_result(cache))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_ssl_certificate(
    server_id: String,
    certificate_path: String,
    state: State<'_, AppState>,
) -> Result<SslCertificateScanResult, String> {
    let ssh_manager = state.ssh_manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = load_cache(&server_id)?;
        let normalized_path = normalize_remote_path(&certificate_path);
        if normalized_path.is_empty() {
            return Err("请输入证书路径。".to_string());
        }

        let existing_bindings = cache
            .records
            .iter()
            .find(|record| record.path == normalized_path)
            .map(|record| record.bindings.clone())
            .unwrap_or_default();
        let record = inspect_certificate_path(
            &ssh_manager,
            &server_id,
            &normalized_path,
            SslCertificateSource::Manual,
            existing_bindings,
        );

        cache
            .records
            .retain(|cached| cached.path != normalized_path);
        cache.records.push(record);
        cache.records = merge_records(cache.records);
        cache.last_error = None;
        save_cache(&cache)?;
        Ok(cache_to_result(cache))
    })
    .await
    .map_err(|e| e.to_string())?
}
