use serde::{Deserialize, Serialize};
use thiserror::Error;
use tauri::command;

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
pub struct AIRequest {
    pub prompt: String,
    pub context: TerminalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalContext {
    pub current_dir: String,
    pub recent_commands: Vec<CommandHistory>,
    pub session_state: SessionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandHistory {
    pub command: String,
    pub output: String,
    pub exit_code: i32,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub connected_server: Option<String>,
    pub is_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIResponse {
    pub command: String,
    pub explanation: String,
    pub is_dangerous: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AICallParams {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub prompt: String,
    pub context: TerminalContext,
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

pub async fn call_ai_provider(
    api_key: &str,
    base_url: &str,
    model: &str,
    prompt: &str,
    context: &TerminalContext,
) -> Result<AIResponse, AIError> {
    let system_prompt = build_system_prompt();
    let user_prompt = build_user_prompt(prompt, context);

    let client = reqwest::Client::new();

    // Determine endpoint based on base URL
    let (url, request_body) = if base_url.contains("anthropic") {
        // Anthropic-compatible API (MiniMax)
        let anthropic_request = AnthropicChatRequest {
            model: model.to_string(),
            messages: vec![
                AnthropicMessage {
                    role: "user".to_string(),
                    content: format!("{}\n\n{}", system_prompt, user_prompt),
                }
            ],
            max_tokens: 1024,
        };
        let body = serde_json::to_string(&anthropic_request).unwrap_or_default();
        (format!("{}/v1/messages", base_url.trim_end_matches('/')), body)
    } else {
        // OpenAI-compatible API
        let openai_request = ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_prompt,
                },
            ],
            max_tokens: 1024,
            temperature: 0.3,
        };
        (format!("{}/v1/chat/completions", base_url.trim_end_matches('/')),
         serde_json::to_string(&openai_request).unwrap_or_default())
    };

    log::info!("AI Request URL: {}", url);
    log::info!("AI Request Body: {}", request_body);

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
        return Err(AIError::ApiError(format!("{} - {}", status, error_text)));
    }

    let response_text = response.text().await.unwrap_or_default();
    log::info!("AI Response: {}", response_text);

    let content = if base_url.contains("anthropic") {
        // Anthropic response format
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

        if let Ok(anthropic_resp) = serde_json::from_str::<AnthropicResponse>(&response_text) {
            // Find the text block (not thinking block)
            anthropic_resp.content.iter()
                .find(|c| c.block_type == "text")
                .and_then(|c| c.text.clone())
                .unwrap_or_default()
        } else {
            response_text
        }
    } else {
        // OpenAI response format
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

        if let Ok(data) = serde_json::from_str::<ResponseData>(&response_text) {
            data.choices.first()
                .map(|c| c.message.content.clone())
                .unwrap_or_default()
        } else {
            response_text
        }
    };

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
- If the request is ambiguous, ask for clarification

Response format (JSON):
{
  "command": "the exact shell command to execute",
  "explanation": "brief explanation in user's language",
  "isDangerous": true/false
}"#
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
            context_info.push_str(&format!("$ {}\n{}\n", cmd.command, cmd.output));
        }
    }

    if let Some(ref server) = context.session_state.connected_server {
        context_info.push_str(&format!("\nConnected to: {}\n", server));
    }

    format!(
        "User request: {}\n\n{}\n\nGenerate the appropriate command:",
        user_input, context_info
    )
}

fn parse_ai_response(content: &str) -> Result<AIResponse, AIError> {
    // Try to extract JSON from the response
    if let Some(start) = content.find('{') {
        if let Some(end) = content.rfind('}') {
            let json_str = &content[start..=end];
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
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
                    command,
                    explanation,
                    is_dangerous,
                });
            }
        }
    }

    // Fallback: try to extract command from code blocks
    let command = content
        .lines()
        .find(|line| line.starts_with("`") && !line.contains("json"))
        .map(|line| line.trim_matches('`').to_string())
        .unwrap_or_else(|| content.trim().to_string());

    Ok(AIResponse {
        command: command.clone(),
        explanation: content.to_string(),
        is_dangerous: is_dangerous_command(&command),
    })
}

fn is_dangerous_command(command: &str) -> bool {
    let dangerous = [
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
        "chmod -R 777 /",
        "chown -R",
        "mv /*",
        "cp /dev/zero",
    ];

    let lower = command.to_lowercase();
    dangerous.iter().any(|d| lower.contains(d))
}
