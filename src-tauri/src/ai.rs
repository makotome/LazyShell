use crate::learning::{
    load_server_environment_profile_internal, retrieve_relevant_experiences, retrieve_relevant_memory_items,
    update_server_environment_profile_from_probe, ExecutionExperience, MemoryItem, ServerEnvironmentProfile,
};
use crate::memory;
use crate::memory::CommandCard;
use crate::commands::AppState;
use crate::ssh::SSHConnectionManager;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tauri::{command, State};

#[derive(Error, Debug)]
pub enum AIError {
    #[error("HTTP request failed: {0}")]
    RequestFailed(String),
    #[error("Invalid response: {0}")]
    InvalidResponse(String),
    #[error("API error: {0}")]
    ApiError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIRequest {
    pub prompt: String,
    pub context: TerminalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    pub current_dir: String,
    pub recent_commands: Vec<CommandHistory>,
    pub session_state: SessionState,
    pub memory_context: Option<MemoryContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContext {
    pub frequent_commands: Vec<FrequentCommand>,
    pub recent_chat_summary: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrequentCommand {
    pub command: String,
    pub description: String,
    pub usage_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistory {
    pub command: String,
    pub output: String,
    pub exit_code: i32,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub connected_server: Option<String>,
    pub is_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AICommandOption {
    pub command: String,
    pub description: String,
    pub is_dangerous: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIResponse {
    pub command: Option<String>,
    pub explanation: Option<String>,
    pub is_dangerous: bool,
    pub options: Option<Vec<AICommandOption>>,
    pub intent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDecision {
    pub mode: String,
    pub intent: String,
    pub response_text: String,
    pub command: Option<String>,
    pub options: Vec<AICommandOption>,
    pub risk_level: String,
    pub reasoning_summary: Option<String>,
    pub retrieved_memory_ids: Vec<String>,
    pub source_labels: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AICallParams {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub context: TerminalContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratedAICallParams {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub context: TerminalContext,
    pub server_id: String,
    pub input_mode: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AnthropicChatRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
}

#[derive(Debug)]
struct RetrievalContext {
    command_cards: Vec<CommandCard>,
    recent_chat_summary: Vec<String>,
    relevant_experiences: Vec<ExecutionExperience>,
    relevant_memory_items: Vec<MemoryItem>,
    server_environment_profile: Option<ServerEnvironmentProfile>,
    source_labels: Vec<String>,
    retrieved_memory_ids: Vec<String>,
}

async fn request_model_content(
    api_key: &str,
    base_url: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, AIError> {
    let client = reqwest::Client::new();

    let (url, request_body) = if base_url.contains("anthropic") {
        let anthropic_request = AnthropicChatRequest {
            model: model.to_string(),
            messages: vec![AnthropicMessage {
                role: "user".to_string(),
                content: format!("{system_prompt}\n\n{user_prompt}"),
            }],
            max_tokens: 1024,
        };
        let body = serde_json::to_string(&anthropic_request).unwrap_or_default();
        (format!("{}/v1/messages", base_url.trim_end_matches('/')), body)
    } else {
        let openai_request = ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_prompt.to_string(),
                },
            ],
            max_tokens: 1024,
            temperature: 0.2,
        };
        (
            format!("{}/v1/chat/completions", base_url.trim_end_matches('/')),
            serde_json::to_string(&openai_request).unwrap_or_default(),
        )
    };

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .body(request_body)
        .send()
        .await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(AIError::ApiError(format!("{status} - {error_text}")));
    }

    let response_text = response.text().await.unwrap_or_default();

    if base_url.contains("anthropic") {
        #[derive(Deserialize)]
        struct AnthropicResponse {
            content: Vec<AnthropicContentBlock>,
        }
        #[derive(Deserialize)]
        struct AnthropicContentBlock {
            #[serde(rename = "type")]
            block_type: String,
            text: Option<String>,
        }

        if let Ok(parsed) = serde_json::from_str::<AnthropicResponse>(&response_text) {
            Ok(parsed
                .content
                .iter()
                .find(|block| block.block_type == "text")
                .and_then(|block| block.text.clone())
                .unwrap_or_default())
        } else {
            Ok(response_text)
        }
    } else {
        #[derive(Deserialize)]
        struct ResponseData {
            choices: Vec<Choice>,
        }
        #[derive(Deserialize)]
        struct Choice {
            message: Message,
        }
        #[derive(Deserialize)]
        struct Message {
            content: String,
        }

        if let Ok(parsed) = serde_json::from_str::<ResponseData>(&response_text) {
            Ok(parsed
                .choices
                .first()
                .map(|choice| choice.message.content.clone())
                .unwrap_or_default())
        } else {
            Ok(response_text)
        }
    }
}

pub async fn call_ai_provider(
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    context: &TerminalContext,
) -> Result<AIResponse, AIError> {
    let content = request_model_content(
        api_key,
        base_url,
        model,
        &build_system_prompt(),
        &build_user_prompt(prompt, context),
    )
    .await?;

    parse_ai_response(&content)
}

#[command]
pub async fn call_ai(params: AICallParams) -> Result<AIResponse, String> {
    call_ai_provider(
        &params.api_key,
        &params.base_url,
        &params.model,
        &params.prompt,
        &params.context,
    )
    .await
    .map_err(|e| e.to_string())
}

#[command]
pub async fn call_ai_orchestrated(
    params: OrchestratedAICallParams,
    state: State<'_, AppState>,
) -> Result<AiDecision, String> {
    let retrieval = build_retrieval_context(&params.server_id, &params.prompt, &state)?;
    let default_mode = decide_mode(&params.prompt, &params.input_mode);
    let content = request_model_content(
        &params.api_key,
        &params.base_url,
        &params.model,
        &build_orchestrator_system_prompt(),
        &build_orchestrator_user_prompt(
            &params.prompt,
            &params.input_mode,
            &params.context,
            &retrieval,
            &default_mode,
        ),
    )
    .await
    .map_err(|e| e.to_string())?;

    parse_ai_decision_response(
        &content,
        &default_mode,
        retrieval.retrieved_memory_ids,
        retrieval.source_labels,
    )
    .map_err(|e| e.to_string())
}

fn build_retrieval_context(
    server_id: &str,
    prompt: &str,
    state: &State<'_, AppState>,
) -> Result<RetrievalContext, String> {
    let cards = memory::load_command_cards(server_id.to_string())?.cards;
    let chat_entries = memory::load_chat_history(server_id.to_string(), 0, 12)?.entries;
    let recent_chat_summary = chat_entries
        .iter()
        .rev()
        .take(6)
        .map(|entry| {
            if let Some(command) = &entry.command {
                format!("{} -> {}", truncate_inline(&entry.content, 80), truncate_inline(command, 80))
            } else {
                truncate_inline(&entry.content, 100)
            }
        })
        .collect::<Vec<_>>();
    let relevant_experiences = retrieve_relevant_experiences(server_id, prompt, 5)?;
    let relevant_memory_items = retrieve_relevant_memory_items(server_id, prompt, 5)?;
    let current_profile = load_server_environment_profile_internal(server_id)?;
    let server_environment_profile = maybe_probe_environment_profile(server_id, prompt, current_profile, state)?;

    let mut source_labels = Vec::new();
    if !cards.is_empty() {
        source_labels.push("命令卡片".to_string());
    }
    if !relevant_experiences.is_empty() {
        source_labels.push("执行经验".to_string());
    }
    if !relevant_memory_items.is_empty() {
        source_labels.push("长期记忆".to_string());
    }
    if server_environment_profile.is_some() {
        source_labels.push("环境画像".to_string());
    }
    if !recent_chat_summary.is_empty() {
        source_labels.push("聊天历史".to_string());
    }

    let mut retrieved_memory_ids = relevant_memory_items
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    retrieved_memory_ids.extend(relevant_experiences.iter().map(|item| item.id.clone()));

    Ok(RetrievalContext {
        command_cards: cards,
        recent_chat_summary,
        relevant_experiences,
        relevant_memory_items,
        server_environment_profile,
        source_labels,
        retrieved_memory_ids,
    })
}

fn maybe_probe_environment_profile(
    server_id: &str,
    prompt: &str,
    current_profile: Option<ServerEnvironmentProfile>,
    state: &State<'_, AppState>,
) -> Result<Option<ServerEnvironmentProfile>, String> {
    let lower = prompt.to_lowercase();
    let current = current_profile.unwrap_or_else(|| ServerEnvironmentProfile {
        server_id: server_id.to_string(),
        ..ServerEnvironmentProfile::default()
    });

    let has_capability = |capability: &str| current.capabilities.iter().any(|existing| existing == capability);
    let mut probes: Vec<(&str, &str)> = Vec::new();

    if lower.contains("openclaw") && !has_capability("openclaw") {
        probes.push(("openclaw", "command -v openclaw 2>/dev/null"));
    }
    if (lower.contains("docker") || lower.contains("容器") || lower.contains("compose")) && !has_capability("docker") {
        probes.push(("docker", "command -v docker 2>/dev/null"));
    }
    if (lower.contains("pm2") || lower.contains("node") || lower.contains("javascript")) && !has_capability("pm2") {
        probes.push(("pm2", "command -v pm2 2>/dev/null"));
    }
    if (lower.contains("服务") || lower.contains("status") || lower.contains("重启") || lower.contains("restart"))
        && !has_capability("systemd")
    {
        probes.push(("systemd", "command -v systemctl 2>/dev/null"));
    }
    if current.package_manager.is_none()
        && (lower.contains("安装") || lower.contains("install") || lower.contains("卸载") || lower.contains("remove"))
    {
        probes.push(("apt", "command -v apt-get 2>/dev/null"));
        probes.push(("dnf", "command -v dnf 2>/dev/null"));
        probes.push(("yum", "command -v yum 2>/dev/null"));
        probes.push(("apk", "command -v apk 2>/dev/null"));
        probes.push(("pacman", "command -v pacman 2>/dev/null"));
    }

    if probes.is_empty() {
        return Ok(if current.hostname.is_none()
            && current.os_name.is_none()
            && current.distro.is_none()
            && current.package_manager.is_none()
            && current.default_shell.is_none()
            && current.capabilities.is_empty()
        {
            None
        } else {
            Some(current)
        });
    }

    let session = match state.ssh_manager.get_session(server_id) {
        Ok(session) => session,
        Err(_) => {
            return Ok(Some(current));
        }
    };

    let mut found_capabilities = Vec::new();
    let mut package_manager = current.package_manager.clone();
    let mut default_shell = current.default_shell.clone();
    let mut shell_candidates = Vec::new();
    if let Some(shell) = current.default_shell.as_deref() {
        shell_candidates.push(shell.to_string());
    }
    shell_candidates.push("bash".to_string());
    shell_candidates.push("zsh".to_string());
    shell_candidates.push("sh".to_string());
    shell_candidates.sort();
    shell_candidates.dedup();

    for (kind, command) in probes {
        let output = run_probe_command(&session, command, &shell_candidates);
        let Some(output) = output else {
            continue;
        };

        match kind {
            "apt" | "dnf" | "yum" | "apk" | "pacman" => {
                if package_manager.is_none() {
                    package_manager = Some(kind.to_string());
                }
            }
            "shell" => {
                if default_shell.is_none() {
                    default_shell = Some(output.stdout.trim().to_string());
                }
            }
            capability => found_capabilities.push(capability.to_string()),
        }
    }

    if package_manager.is_none() && current.default_shell.is_none() {
        if let Some(output) = run_probe_command(&session, "printf '%s' \"$SHELL\" 2>/dev/null", &shell_candidates) {
            default_shell = Some(
                output
                    .stdout
                    .trim()
                    .trim_start_matches("/bin/")
                    .to_string(),
            );
        }
    }

    if found_capabilities.is_empty() && package_manager.is_none() && default_shell.is_none() {
        return Ok(Some(current));
    }

    let merged = update_server_environment_profile_from_probe(
        server_id,
        package_manager,
        default_shell,
        found_capabilities,
    )?;

    Ok(Some(merged))
}

fn run_probe_command(
    session: &std::sync::Arc<std::sync::Mutex<ssh2::Session>>,
    command: &str,
    shell_candidates: &[String],
) -> Option<crate::ssh::CommandOutput> {
    if let Ok(output) = SSHConnectionManager::execute_with_session(session, command) {
        if output.exit_code == 0 && !output.stdout.trim().is_empty() {
            return Some(output);
        }
    }

    for shell in shell_candidates {
        let wrapped = format!("{shell} -lc '{}'", command.replace('\'', "'\\''"));
        if let Ok(output) = SSHConnectionManager::execute_with_session(session, &wrapped) {
            if output.exit_code == 0 && !output.stdout.trim().is_empty() {
                return Some(output);
            }
        }
    }

    None
}

fn build_system_prompt() -> String {
    r#"You are an expert Linux server administrator assistant. Your role is to:
1. Convert natural language commands into precise Linux shell commands
2. Always prioritize safety - warn about destructive operations
3. Provide brief, clear explanations of what the command does

Rules:
- Only generate single commands, no chains unless necessary
- For dangerous operations (rm -rf, shutdown, reboot, dd, mkfs, etc.), set isDangerous: true
- Always explain the command in Chinese when user uses Chinese
- Keep explanations concise (1-2 sentences)
- When user instructions have multiple reasonable interpretations, proactively return intent:"multiple" with up to 3 options
- Use "intent": "single" ONLY when the request is clear and unambiguous
- Use "intent": "clarification" ONLY when the request is too vague to generate any useful commands

Response format for single command (JSON):
{
  "intent": "single",
  "command": "the exact shell command to execute",
  "explanation": "brief explanation in user's language",
  "isDangerous": true
}"#
        .to_string()
}

fn build_orchestrator_system_prompt() -> String {
    r#"You are the backend orchestrator for a Linux server assistant. Return strict JSON only.

Your goals:
1. Be conservative when context is incomplete.
2. Prefer inspect_then_command for risky or uncertain operations.
3. Keep responseText concise and in Chinese when the user writes in Chinese.
4. Use the retrieved history and experience context to avoid repeating failed approaches.

Valid JSON shape:
{
  "mode": "answer | command | inspect_then_command | clarification",
  "intent": "single | multiple | clarification",
  "responseText": "short answer shown to the user",
  "command": "single command or null",
  "options": [
    {
      "command": "shell command",
      "description": "what it does",
      "isDangerous": false,
      "reason": "when to use it"
    }
  ],
  "riskLevel": "green | yellow | red",
  "reasoningSummary": "one short sentence"
}

Rules:
- When inputMode is answer, do not output runnable commands unless the user explicitly asks for one.
- For diagnose, prefer inspect_then_command and non-destructive inspection commands first.
- If the request is vague, use clarification.
- If a recommended action matches a recorded failure case, avoid reusing it unless you explain why.
- Never return markdown fences, prose before JSON, or HTML."#
        .to_string()
}

fn build_user_prompt(user_input: &str, context: &TerminalContext) -> String {
    let mut context_info = String::new();

    if !context.current_dir.is_empty() {
        context_info.push_str(&format!("Current directory: {}\n", context.current_dir));
    }

    if !context.recent_commands.is_empty() {
        context_info.push_str("\nRecent commands:\n");
        for cmd in context.recent_commands.iter().rev().take(10) {
            context_info.push_str(&format!("$ {}\n{}\n", cmd.command, truncate_inline(&cmd.output, 240)));
        }
    }

    if let Some(ref server) = context.session_state.connected_server {
        context_info.push_str(&format!("\nConnected to: {}\n", server));
    }

    if let Some(ref memory) = context.memory_context {
        if !memory.frequent_commands.is_empty() {
            context_info.push_str("\nUser's frequently used commands:\n");
            for cmd in &memory.frequent_commands {
                context_info.push_str(&format!("- {} ({}x): {}\n", cmd.command, cmd.usage_count, cmd.description));
            }
        }
        if !memory.recent_chat_summary.is_empty() {
            context_info.push_str("\nRecent conversation context:\n");
            for summary in &memory.recent_chat_summary {
                context_info.push_str(&format!("- {}\n", truncate_inline(summary, 120)));
            }
        }
    }

    format!("User request: {user_input}\n\n{context_info}\n\nGenerate the appropriate command:")
}

fn build_orchestrator_user_prompt(
    user_input: &str,
    input_mode: &str,
    context: &TerminalContext,
    retrieval: &RetrievalContext,
    default_mode: &str,
) -> String {
    let mut sections = vec![
        format!("User input mode: {input_mode}"),
        format!("Suggested backend default mode: {default_mode}"),
        format!("Current directory: {}", context.current_dir),
        format!(
            "Connected server: {}",
            context
                .session_state
                .connected_server
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!("User request: {user_input}"),
    ];

    if !context.recent_commands.is_empty() {
        let recent = context
            .recent_commands
            .iter()
            .rev()
            .take(8)
            .map(|cmd| format!("$ {} | exit={} | {}", cmd.command, cmd.exit_code, truncate_inline(&cmd.output, 120)))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Recent command history:\n{recent}"));
    }

    if !retrieval.command_cards.is_empty() {
        let cards = retrieval
            .command_cards
            .iter()
            .take(5)
            .map(|card| format!("- {}: {}", card.command, truncate_inline(&card.description, 80)))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Saved command cards:\n{cards}"));
    }

    if !retrieval.recent_chat_summary.is_empty() {
        sections.push(format!(
            "Recent chat summary:\n{}",
            retrieval.recent_chat_summary.join("\n")
        ));
    }

    if let Some(profile) = &retrieval.server_environment_profile {
        let mut profile_lines = Vec::new();
        if let Some(hostname) = &profile.hostname {
            profile_lines.push(format!("hostname={hostname}"));
        }
        if let Some(os_name) = &profile.os_name {
            profile_lines.push(format!("os={os_name}"));
        }
        if let Some(distro) = &profile.distro {
            profile_lines.push(format!("distro={distro}"));
        }
        if let Some(package_manager) = &profile.package_manager {
            profile_lines.push(format!("package_manager={package_manager}"));
        }
        if let Some(default_shell) = &profile.default_shell {
            profile_lines.push(format!("shell={default_shell}"));
        }
        if !profile.capabilities.is_empty() {
            profile_lines.push(format!("capabilities={}", profile.capabilities.join(",")));
        }
        profile_lines.push(format!("confidence={:.2}", profile.confidence));
        sections.push(format!(
            "Server environment profile:\n{}",
            profile_lines.join("\n")
        ));

        let preference_rules = build_profile_preference_rules(user_input, profile);
        if !preference_rules.is_empty() {
            sections.push(format!(
                "Profile-driven command preferences:\n{}",
                preference_rules
                    .iter()
                    .map(|rule| format!("- {rule}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }

    if !retrieval.relevant_experiences.is_empty() {
        let experiences = retrieval
            .relevant_experiences
            .iter()
            .map(|item| {
                let reliability = if item.success && !item.user_modified {
                    "high"
                } else if item.success {
                    "medium"
                } else {
                    "low"
                };
                format!(
                    "- intent={} | cmd={} | reliability={} | modified={} | success={} | failure={} | stderr={}",
                    truncate_inline(&item.user_intent, 60),
                    truncate_inline(&item.final_command, 80),
                    reliability,
                    item.user_modified,
                    item.success,
                    item.failure_kind.clone().unwrap_or_else(|| "none".to_string()),
                    truncate_inline(&item.stderr_summary, 80)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Relevant execution experience:\n{experiences}"));
        sections.push(
            "Experience weighting rule: prefer reliability=high first, use reliability=medium only as fallback, and treat reliability=low mainly as a warning signal."
                .to_string(),
        );
    }

    if !retrieval.relevant_memory_items.is_empty() {
        let memory = retrieval
            .relevant_memory_items
            .iter()
            .map(|item| format!("- [{}] {}", item.kind, truncate_inline(&item.summary, 120)))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Relevant long-term memory:\n{memory}"));
    }

    sections.join("\n\n")
}

fn decide_mode(prompt: &str, input_mode: &str) -> String {
    let lower = prompt.to_lowercase();
    if input_mode == "answer" || input_mode == "explain" {
        return "answer".to_string();
    }
    if input_mode == "diagnose" {
        return "inspect_then_command".to_string();
    }
    if is_high_risk_request(&lower) {
        return "inspect_then_command".to_string();
    }
    if is_vague_request(&lower) {
        return "clarification".to_string();
    }
    "command".to_string()
}

fn build_profile_preference_rules(
    user_input: &str,
    profile: &ServerEnvironmentProfile,
) -> Vec<String> {
    let lower = user_input.to_lowercase();
    let capabilities = &profile.capabilities;
    let has = |capability: &str| capabilities.iter().any(|existing| existing == capability);
    let mentions_openclaw = lower.contains("openclaw");
    let mentions_service = lower.contains("服务")
        || lower.contains("service")
        || lower.contains("restart")
        || lower.contains("重启")
        || lower.contains("状态")
        || lower.contains("status")
        || lower.contains("日志")
        || lower.contains("log");
    let mentions_package = lower.contains("安装")
        || lower.contains("install")
        || lower.contains("update")
        || lower.contains("升级")
        || lower.contains("卸载")
        || lower.contains("remove");
    let mentions_node_runtime = lower.contains("node")
        || lower.contains("npm")
        || lower.contains("pm2")
        || lower.contains("前端")
        || lower.contains("博客")
        || lower.contains("javascript");
    let mentions_container = lower.contains("docker")
        || lower.contains("容器")
        || lower.contains("compose")
        || lower.contains("镜像");

    let mut rules = Vec::new();

    if mentions_openclaw && has("openclaw") {
        rules.push(
            "This server already shows OpenClaw usage. Prefer OpenClaw native commands such as `openclaw status`, `openclaw gateway status`, or `openclaw models status` over generic Linux guesses."
                .to_string(),
        );
    }

    if mentions_service && has("systemd") {
        rules.push(
            "For service lifecycle and status tasks, prefer `systemctl` command family instead of legacy `service` commands unless the request explicitly asks otherwise."
                .to_string(),
        );
    }

    if mentions_service && has("nginx") {
        rules.push(
            "Nginx appears to be part of this server environment. For nginx-related tasks, prefer commands like `nginx -t`, `systemctl status nginx`, and `systemctl reload nginx`."
                .to_string(),
        );
    }

    if mentions_node_runtime && has("pm2") {
        rules.push(
            "PM2 is available on this server. For Node service management, prefer `pm2 status`, `pm2 logs`, and `pm2 restart <name>` before suggesting raw process-kill workflows."
                .to_string(),
        );
    }

    if mentions_container && has("docker") {
        rules.push(
            "Docker is available on this server. For containerized workloads, prefer `docker ps`, `docker logs`, and `docker compose` workflows over host-level process guesses."
                .to_string(),
        );
    }

    if mentions_package {
        if let Some(package_manager) = &profile.package_manager {
            rules.push(format!(
                "Package management should prefer `{package_manager}` command family on this server and avoid suggesting package managers from other distributions."
            ));
        }
    }

    if let Some(default_shell) = &profile.default_shell {
        if default_shell == "zsh" || default_shell == "bash" {
            rules.push(format!(
                "Shell examples should stay compatible with `{default_shell}` syntax and common Linux shell conventions."
            ));
        }
    }

    rules
}

fn is_high_risk_request(lower: &str) -> bool {
    [
        "删除",
        "重启",
        "关机",
        "格式化",
        "清空",
        "drop database",
        "rm -rf",
        "reboot",
        "shutdown",
        "mkfs",
        "systemctl restart",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_vague_request(lower: &str) -> bool {
    let trimmed = lower.trim();
    trimmed.len() < 4
        || ["帮我处理", "看看", "搞一下", "弄一下", "处理一下"]
            .iter()
            .any(|needle| trimmed == *needle)
}

fn parse_ai_decision_response(
    content: &str,
    default_mode: &str,
    retrieved_memory_ids: Vec<String>,
    source_labels: Vec<String>,
) -> Result<AiDecision, AIError> {
    if let Some(parsed) = extract_json_payload(content)
        .and_then(|json_str| serde_json::from_str::<serde_json::Value>(&json_str).ok())
    {
        let options = parsed
            .get("options")
            .and_then(|value| value.as_array())
            .map(|items| {
                items.iter()
                    .filter_map(|opt| {
                        Some(AICommandOption {
                            command: opt.get("command")?.as_str()?.to_string(),
                            description: opt
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            is_dangerous: opt
                                .get("isDangerous")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            reason: opt.get("reason").and_then(|v| v.as_str()).map(String::from),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let response_text = parsed
            .get("responseText")
            .and_then(|v| v.as_str())
            .or_else(|| parsed.get("explanation").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let command = parsed.get("command").and_then(|v| v.as_str()).map(String::from);
        let mode = parsed
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or(default_mode)
            .to_string();
        let intent = parsed
            .get("intent")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                if !options.is_empty() {
                    "multiple".to_string()
                } else if mode == "clarification" {
                    "clarification".to_string()
                } else {
                    "single".to_string()
                }
            });

        return Ok(AiDecision {
            mode,
            intent,
            response_text,
            command,
            options,
            risk_level: parsed
                .get("riskLevel")
                .and_then(|v| v.as_str())
                .unwrap_or("yellow")
                .to_string(),
            reasoning_summary: parsed
                .get("reasoningSummary")
                .and_then(|v| v.as_str())
                .map(String::from),
            retrieved_memory_ids,
            source_labels,
        });
    }

    let fallback = parse_ai_response(content)?;
    Ok(AiDecision {
        mode: default_mode.to_string(),
        intent: fallback.intent.clone(),
        response_text: fallback.explanation.unwrap_or_default(),
        command: fallback.command,
        options: fallback.options.unwrap_or_default(),
        risk_level: if fallback.is_dangerous {
            "red".to_string()
        } else {
            "yellow".to_string()
        },
        reasoning_summary: Some("使用兼容解析回退旧响应格式".to_string()),
        retrieved_memory_ids,
        source_labels,
    })
}

fn parse_ai_response(content: &str) -> Result<AIResponse, AIError> {
    if let Some(parsed) = extract_json_payload(content)
        .and_then(|json_str| serde_json::from_str::<serde_json::Value>(&json_str).ok())
    {
        let intent_str = parsed.get("intent").and_then(|v| v.as_str()).unwrap_or("");

        if intent_str == "clarification" {
            let question = parsed.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let explanation = parsed.get("explanation").and_then(|v| v.as_str()).unwrap_or("");
            let display = if !question.is_empty() { question } else { explanation };
            return Ok(AIResponse {
                command: None,
                explanation: Some(display.to_string()),
                is_dangerous: false,
                options: None,
                intent: "clarification".to_string(),
            });
        }

        if let Some(options_array) = parsed.get("options").and_then(|v| v.as_array()) {
            let parsed_options: Vec<AICommandOption> = options_array
                .iter()
                .filter_map(|opt| {
                    Some(AICommandOption {
                        command: opt.get("command")?.as_str()?.to_string(),
                        description: opt
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        is_dangerous: opt.get("isDangerous").and_then(|v| v.as_bool()).unwrap_or(false),
                        reason: opt.get("reason").and_then(|v| v.as_str()).map(String::from),
                    })
                })
                .collect();

            if !parsed_options.is_empty() {
                return Ok(AIResponse {
                    command: None,
                    explanation: parsed.get("explanation").and_then(|v| v.as_str()).map(String::from),
                    is_dangerous: false,
                    options: Some(parsed_options),
                    intent: "multiple".to_string(),
                });
            }
        }

        let command = parsed
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let explanation = parsed
            .get("explanation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let is_dangerous = parsed
            .get("isDangerous")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        return Ok(AIResponse {
            command: Some(command),
            explanation: Some(explanation),
            is_dangerous,
            options: None,
            intent: "single".to_string(),
        });
    }

    let is_clarification = content.contains('?')
        || content.contains("请告诉我")
        || content.contains("请提供")
        || content.contains("能否")
        || content.contains("具体是");

    if is_clarification {
        return Ok(AIResponse {
            command: None,
            explanation: Some(content.to_string()),
            is_dangerous: false,
            options: None,
            intent: "clarification".to_string(),
        });
    }

    let command = content
        .lines()
        .find(|line| line.starts_with("`") && !line.contains("json"))
        .map(|line| line.trim_matches('`').to_string())
        .unwrap_or_else(|| content.trim().to_string());

    Ok(AIResponse {
        command: Some(command.clone()),
        explanation: Some(content.to_string()),
        is_dangerous: is_dangerous_command(&command),
        options: None,
        intent: "single".to_string(),
    })
}

fn extract_json_payload(content: &str) -> Option<String> {
    let trimmed = content.trim();

    if trimmed.starts_with("```") {
        let mut lines = trimmed.lines();
        let first = lines.next()?;
        if first.starts_with("```") {
            let inner = lines
                .take_while(|line| !line.trim_start().starts_with("```"))
                .collect::<Vec<_>>()
                .join("\n");
            let inner_trimmed = inner.trim();
            if !inner_trimmed.is_empty() {
                return Some(inner_trimmed.to_string());
            }
        }
    }

    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed.to_string());
    }

    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                return Some(trimmed[start..=end].to_string());
            }
        }
    }

    None
}

fn truncate_inline(value: &str, max_chars: usize) -> String {
    let compact = value.replace('\n', " ");
    let truncated: String = compact.chars().take(max_chars).collect();
    if compact.chars().count() > max_chars {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn is_dangerous_command(command: &str) -> bool {
    let lower = command.to_lowercase();
    [
        "rm -rf",
        "shutdown",
        "reboot",
        "dd if=",
        "mkfs",
        "> /dev/sda",
        "> /dev/sdb",
        "> /dev/nvme",
        "init 0",
        "init 6",
        "telinit",
        ":(){:|:&};:",
        "chmod -r 777 /",
        "chown -r",
        "mv /*",
        "cp /dev/zero",
    ]
    .iter()
    .any(|dangerous| lower.contains(dangerous))
}

#[cfg(test)]
mod tests {
    use super::{build_profile_preference_rules, decide_mode, parse_ai_decision_response};
    use crate::learning::ServerEnvironmentProfile;

    #[test]
    fn diagnose_defaults_to_inspection() {
        assert_eq!(decide_mode("帮我排查 nginx 为什么挂了", "diagnose"), "inspect_then_command");
    }

    #[test]
    fn parses_structured_decision() {
        let parsed = parse_ai_decision_response(
            r#"{"mode":"command","intent":"single","responseText":"test","command":"ls","riskLevel":"green"}"#,
            "command",
            vec!["m1".to_string()],
            vec!["执行经验".to_string()],
        )
        .unwrap();

        assert_eq!(parsed.mode, "command");
        assert_eq!(parsed.command.as_deref(), Some("ls"));
        assert_eq!(parsed.retrieved_memory_ids.len(), 1);
    }

    #[test]
    fn profile_rules_prefer_openclaw_and_systemd_when_available() {
        let profile = ServerEnvironmentProfile {
            server_id: "s1".to_string(),
            hostname: None,
            os_name: Some("Linux".to_string()),
            distro: Some("Ubuntu".to_string()),
            package_manager: Some("apt".to_string()),
            default_shell: Some("zsh".to_string()),
            capabilities: vec!["systemd".to_string(), "openclaw".to_string()],
            evidence_sources: vec!["execution_experience".to_string()],
            confidence: 0.8,
            updated_at: 1,
        };

        let rules = build_profile_preference_rules("查看 openclaw 的状态", &profile);
        assert!(rules.iter().any(|rule| rule.contains("OpenClaw native commands")));

        let service_rules = build_profile_preference_rules("查看服务状态", &profile);
        assert!(service_rules.iter().any(|rule| rule.contains("systemctl")));
    }
}
