use crate::config::{APP_VERSION, DEFAULT_LMSTUDIO_URL, DEFAULT_OLLAMA_URL, ProviderId};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const ASKII_CLOUD_URL: &str = "https://api.askii.dev/v1";
pub const OPENAI_DEFAULT_URL: &str = "https://api.openai.com/v1";
pub const ANTHROPIC_DEFAULT_URL: &str = "https://api.anthropic.com";
pub const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";
pub const OPENCODE_GO_URL: &str = "https://opencode.ai/zen/go/v1";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 8192;
pub const DISCOVERY_TIMEOUT_SECS: u64 = 10;

static OPENCODE_SESSION_ID: OnceLock<String> = OnceLock::new();

fn opencode_session_id() -> &'static str {
    OPENCODE_SESSION_ID.get_or_init(|| Uuid::new_v4().to_string())
}

fn askii_user_agent() -> String {
    format!("askii/{APP_VERSION}")
}

pub fn is_opencode_go_anthropic_model(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.starts_with("qwen") || lower.starts_with("minimax")
}

pub fn normalize_lmstudio_http_base(raw: &str) -> String {
    let trimmed = raw.trim();
    let base = if trimmed.is_empty() {
        DEFAULT_LMSTUDIO_URL
    } else {
        trimmed
    };
    let http = if let Some(rest) = base.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = base.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        base.to_string()
    };
    let no_slash = http.trim_end_matches('/');
    no_slash
        .strip_suffix("/v1")
        .unwrap_or(no_slash)
        .trim_end_matches('/')
        .to_string()
}

pub fn normalize_base_url(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    let chosen = if trimmed.is_empty() { fallback } else { trimmed };
    chosen.trim_end_matches('/').to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct StreamTurnOutcome {
    pub text: String,
    pub tool_calls: Vec<ToolCallRequest>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRequest>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn serialize_openai_messages(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(messages.len());
    let mut pending_tool_images: Vec<(String, ImageAttachment)> = Vec::new();

    let flush_tool_images =
        |out: &mut Vec<Value>, pending: &mut Vec<(String, ImageAttachment)>| {
            if pending.is_empty() {
                return;
            }
            let labels: Vec<String> = pending.iter().map(|(n, _)| n.clone()).collect();
            let mut parts: Vec<Value> = Vec::with_capacity(pending.len() + 1);
            parts.push(json!({
                "type": "text",
                "text": format!("Visual screenshot(s) returned by tool(s): {}", labels.join(", ")),
            }));
            for (_, img) in pending.drain(..) {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.data_base64),
                    }
                }));
            }
            out.push(json!({
                "role": "user",
                "content": parts,
            }));
        };

    for m in messages {
        if m.role == "tool" {
            out.push(json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            }));
            if !m.images.is_empty() {
                let label = m.name.clone().unwrap_or_else(|| "tool".to_string());
                for img in &m.images {
                    pending_tool_images.push((label.clone(), img.clone()));
                }
            }
            continue;
        }

        flush_tool_images(&mut out, &mut pending_tool_images);

        if m.role == "assistant" && !m.tool_calls.is_empty() {
            let tc: Vec<Value> = m
                .tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": c.arguments.to_string(),
                        }
                    })
                })
                .collect();
            let mut obj = json!({
                "role": "assistant",
                "tool_calls": tc,
            });
            if !m.content.is_empty() {
                obj["content"] = json!(m.content);
            } else {
                obj["content"] = Value::Null;
            }
            out.push(obj);
            continue;
        }

        if m.images.is_empty() {
            out.push(json!({
                "role": m.role,
                "content": m.content,
            }));
        } else {
            let mut parts: Vec<Value> = Vec::with_capacity(m.images.len() + 1);
            if !m.content.is_empty() {
                parts.push(json!({
                    "type": "text",
                    "text": m.content,
                }));
            }
            for img in &m.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.data_base64),
                    }
                }));
            }
            out.push(json!({
                "role": m.role,
                "content": parts,
            }));
        }
    }

    flush_tool_images(&mut out, &mut pending_tool_images);
    out
}

pub fn serialize_anthropic_messages(messages: &[&ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            if m.role == "tool" {
                let tool_content = if m.images.is_empty() {
                    json!(m.content)
                } else {
                    let mut blocks: Vec<Value> = Vec::with_capacity(m.images.len() + 1);
                    if !m.content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": m.content }));
                    }
                    for img in &m.images {
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime_type,
                                "data": img.data_base64,
                            }
                        }));
                    }
                    json!(blocks)
                };
                return json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": tool_content,
                    }]
                });
            }
            if m.role == "assistant" && !m.tool_calls.is_empty() {
                let mut blocks = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for c in &m.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": c.id,
                        "name": c.name,
                        "input": c.arguments,
                    }));
                }
                return json!({
                    "role": "assistant",
                    "content": blocks,
                });
            }
            if m.images.is_empty() {
                json!({
                    "role": m.role,
                    "content": m.content,
                })
            } else {
                let mut blocks: Vec<Value> = Vec::with_capacity(m.images.len() + 1);
                for img in &m.images {
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.mime_type,
                            "data": img.data_base64,
                        }
                    }));
                }
                if !m.content.is_empty() {
                    blocks.push(json!({
                        "type": "text",
                        "text": m.content,
                    }));
                }
                json!({
                    "role": m.role,
                    "content": blocks,
                })
            }
        })
        .collect()
}

pub fn serialize_ollama_messages(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            if m.role == "tool" {
                if m.images.is_empty() {
                    return json!({
                        "role": "tool",
                        "content": m.content,
                    });
                } else {
                    let imgs: Vec<&str> = m.images.iter().map(|i| i.data_base64.as_str()).collect();
                    return json!({
                        "role": "tool",
                        "content": m.content,
                        "images": imgs,
                    });
                }
            }
            if m.role == "assistant" && !m.tool_calls.is_empty() {
                let tc: Vec<Value> = m
                    .tool_calls
                    .iter()
                    .map(|c| {
                        json!({
                            "function": {
                                "name": c.name,
                                "arguments": c.arguments,
                            }
                        })
                    })
                    .collect();
                return json!({
                    "role": "assistant",
                    "content": m.content,
                    "tool_calls": tc,
                });
            }
            if m.images.is_empty() {
                json!({
                    "role": m.role,
                    "content": m.content,
                })
            } else {
                let imgs: Vec<&str> = m.images.iter().map(|i| i.data_base64.as_str()).collect();
                json!({
                    "role": m.role,
                    "content": m.content,
                    "images": imgs,
                })
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverModelsRequest {
    pub provider: ProviderId,
    pub api_key: Option<String>,
    pub server_url: Option<String>,
    pub openai_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub mode: String, // "models" | "manual"
    pub models: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Chunk {
        text: String,
    },
    ToolProposed {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        tier: u8,
        summary: String,
        arguments: Value,
        #[serde(rename = "needsApproval")]
        needs_approval: bool,
        #[serde(rename = "dangerWarning")]
        danger_warning: Option<String>,
    },
    ToolRunning {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        success: bool,
        output: String,
        #[serde(rename = "backupId")]
        backup_id: Option<String>,
    },
    ToolDenied {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        reason: String,
    },
    Done {
        truncated: bool,
    },
    Error {
        message: String,
    },
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct ProviderConnection {
    pub provider: ProviderId,
    pub model: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

fn build_http_client(timeout_secs: Option<u64>) -> Result<Client, String> {
    let mut builder = Client::builder().connect_timeout(Duration::from_secs(10));
    if let Some(secs) = timeout_secs {
        builder = builder.timeout(Duration::from_secs(secs));
    }
    builder
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {e}"))
}

fn default_headers(extra_opencode: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(ua) = HeaderValue::from_str(&askii_user_agent()) {
        headers.insert(USER_AGENT, ua);
    }
    if extra_opencode {
        if let Ok(val) = HeaderValue::from_str(opencode_session_id()) {
            headers.insert(HeaderName::from_static("x-opencode-session"), val);
        }
    }
    headers
}

fn normalize_model_ids(raw: Vec<String>) -> Vec<String> {
    let set: BTreeSet<String> = raw
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    set.into_iter().collect()
}

fn manual_result(provider: ProviderId, detail: &str) -> ModelDiscoveryResult {
    ModelDiscoveryResult {
        mode: "manual".to_string(),
        models: Vec::new(),
        warning: Some(format!(
            "{} is reachable, but its model list is unavailable ({detail}). Enter a model ID manually.",
            provider.label()
        )),
    }
}

fn handle_http_discovery_status(
    provider: ProviderId,
    status: StatusCode,
    body: &str,
) -> Result<Option<ModelDiscoveryResult>, String> {
    if status.is_success() {
        return Ok(None);
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(format!(
            "{} rejected the API key ({}). Check your credential and try again.",
            provider.label(),
            status.as_u16()
        ));
    }
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
    ) {
        return Ok(Some(manual_result(
            provider,
            "the model-list endpoint is not supported",
        )));
    }
    let snippet: String = body.chars().take(180).collect();
    Err(format!(
        "{} returned HTTP {}: {}",
        provider.label(),
        status.as_u16(),
        snippet.trim()
    ))
}

pub async fn discover_models(
    provider: ProviderId,
    api_key: Option<String>,
    server_url: Option<String>,
    openai_base_url: Option<String>,
) -> Result<ModelDiscoveryResult, String> {
    let api_key = api_key.unwrap_or_default().trim().to_string();
    let server_url = server_url.unwrap_or_default().trim().to_string();

    if provider.uses_api_key() && api_key.is_empty() {
        return Err(format!("{} requires an API key.", provider.label()));
    }
    if !provider.uses_api_key() && server_url.is_empty() {
        return Err(format!("{} requires a server URL.", provider.label()));
    }

    let client = build_http_client(Some(DISCOVERY_TIMEOUT_SECS))?;

    let ids = match provider {
        ProviderId::AskiiCloud => {
            fetch_openai_models(&client, provider, ASKII_CLOUD_URL, Some(&api_key), false).await?
        }
        ProviderId::OpenAi => {
            let base = normalize_base_url(
                openai_base_url.as_deref().unwrap_or(""),
                OPENAI_DEFAULT_URL,
            );
            fetch_openai_models(&client, provider, &base, Some(&api_key), false).await?
        }
        ProviderId::OpencodeGo => {
            fetch_openai_models(&client, provider, OPENCODE_GO_URL, Some(&api_key), true).await?
        }
        ProviderId::OpenRouter => {
            fetch_openai_models(&client, provider, OPENROUTER_URL, Some(&api_key), false).await?
        }
        ProviderId::Gemini => fetch_gemini_models(&client, &api_key).await?,
        ProviderId::Anthropic => fetch_anthropic_models(&client, &api_key).await?,
        ProviderId::Ollama => {
            let base = normalize_base_url(&server_url, DEFAULT_OLLAMA_URL);
            fetch_ollama_models(&client, &base).await?
        }
        ProviderId::LmStudio => {
            let base = format!("{}/v1", normalize_lmstudio_http_base(&server_url));
            fetch_openai_models(&client, provider, &base, None, false).await?
        }
    };

    match ids {
        DiscoveryOutcome::Manual(res) => Ok(res),
        DiscoveryOutcome::Ids(list) => {
            let normalized = normalize_model_ids(list);
            if normalized.is_empty() {
                Ok(manual_result(provider, "the provider returned no models"))
            } else {
                Ok(ModelDiscoveryResult {
                    mode: "models".to_string(),
                    models: normalized,
                    warning: None,
                })
            }
        }
    }
}

enum DiscoveryOutcome {
    Ids(Vec<String>),
    Manual(ModelDiscoveryResult),
}

async fn fetch_openai_models(
    client: &Client,
    provider: ProviderId,
    base_url: &str,
    api_key: Option<&str>,
    opencode_headers: bool,
) -> Result<DiscoveryOutcome, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut headers = default_headers(opencode_headers);
    if let Some(key) = api_key {
        if !key.is_empty() {
            let val = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| "Invalid characters in API key.".to_string())?;
            headers.insert(AUTHORIZATION, val);
        }
    }
    let resp = client.get(&url).headers(headers).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{} did not respond within {DISCOVERY_TIMEOUT_SECS} seconds.", provider.label())
        } else {
            format!("Could not connect to {}: {e}", provider.label())
        }
    })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if let Some(manual) = handle_http_discovery_status(provider, status, &text)? {
        return Ok(DiscoveryOutcome::Manual(manual));
    }
    let json: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid model list response from {}: {e}", provider.label()))?;
    let ids = json
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(DiscoveryOutcome::Ids(ids))
}

async fn fetch_anthropic_models(client: &Client, api_key: &str) -> Result<DiscoveryOutcome, String> {
    let mut ids = Vec::new();
    let mut after_id: Option<String> = None;

    for _ in 0..5 {
        let mut url = format!("{ANTHROPIC_DEFAULT_URL}/v1/models?limit=100");
        if let Some(ref cursor) = after_id {
            url.push_str(&format!("&after_id={cursor}"));
        }
        let mut headers = default_headers(false);
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::from_str(api_key)
                .map_err(|_| "Invalid characters in Anthropic API key.".to_string())?,
        );
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );

        let resp = client.get(&url).headers(headers).send().await.map_err(|e| {
            if e.is_timeout() {
                format!("Anthropic did not respond within {DISCOVERY_TIMEOUT_SECS} seconds.")
            } else {
                format!("Could not connect to Anthropic: {e}")
            }
        })?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if let Some(manual) = handle_http_discovery_status(ProviderId::Anthropic, status, &text)? {
            return Ok(DiscoveryOutcome::Manual(manual));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid model list response from Anthropic: {e}"))?;
        if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
        let has_more = json
            .get("has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        after_id = json
            .get("last_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        if !has_more || after_id.is_none() {
            break;
        }
    }

    Ok(DiscoveryOutcome::Ids(ids))
}

async fn fetch_gemini_models(client: &Client, api_key: &str) -> Result<DiscoveryOutcome, String> {
    let url = format!("{GEMINI_API_BASE}/models?key={api_key}&pageSize=100");
    let resp = client
        .get(&url)
        .headers(default_headers(false))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("Google Gemini did not respond within {DISCOVERY_TIMEOUT_SECS} seconds.")
            } else {
                format!("Could not connect to Google Gemini: {e}")
            }
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if let Some(manual) = handle_http_discovery_status(ProviderId::Gemini, status, &text)? {
        return Ok(DiscoveryOutcome::Manual(manual));
    }
    let json: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid model list response from Google Gemini: {e}"))?;
    let ids = json
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|item| {
                    item.get("supportedGenerationMethods")
                        .and_then(|m| m.as_array())
                        .map(|methods| {
                            methods
                                .iter()
                                .any(|v| v.as_str() == Some("generateContent"))
                        })
                        .unwrap_or(true)
                })
                .filter_map(|item| {
                    item.get("name")
                        .and_then(|v| v.as_str())
                        .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(DiscoveryOutcome::Ids(ids))
}

async fn fetch_ollama_models(client: &Client, base_url: &str) -> Result<DiscoveryOutcome, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Ollama did not respond within {DISCOVERY_TIMEOUT_SECS} seconds.")
        } else {
            format!("Could not connect to Ollama at {base_url}: {e}")
        }
    })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if let Some(manual) = handle_http_discovery_status(ProviderId::Ollama, status, &text)? {
        return Ok(DiscoveryOutcome::Manual(manual));
    }
    let json: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid model list response from Ollama: {e}"))?;
    let ids = json
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.get("model")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.get("name").and_then(|v| v.as_str()))
                        .map(String::from)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(DiscoveryOutcome::Ids(ids))
}

pub async fn stream_chat<F>(
    conn: &ProviderConnection,
    messages: &[ChatMessage],
    cancel: CancellationToken,
    on_chunk: F,
) -> Result<bool, String>
where
    F: FnMut(String) + Send,
{
    let outcome = stream_chat_with_tools(conn, messages, None, cancel, on_chunk).await?;
    Ok(outcome.truncated)
}

pub async fn stream_chat_with_tools<F>(
    conn: &ProviderConnection,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    cancel: CancellationToken,
    mut on_chunk: F,
) -> Result<StreamTurnOutcome, String>
where
    F: FnMut(String) + Send,
{
    let client = build_http_client(None)?;

    match conn.provider {
        ProviderId::AskiiCloud => {
            stream_openai_compatible(
                &client,
                ASKII_CLOUD_URL,
                conn.api_key.as_deref(),
                &conn.model,
                messages,
                tools,
                false,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::OpenAi => {
            let base = normalize_base_url(
                conn.base_url.as_deref().unwrap_or(""),
                OPENAI_DEFAULT_URL,
            );
            stream_openai_compatible(
                &client,
                &base,
                conn.api_key.as_deref(),
                &conn.model,
                messages,
                tools,
                false,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::LmStudio => {
            let base = format!(
                "{}/v1",
                normalize_lmstudio_http_base(conn.base_url.as_deref().unwrap_or(DEFAULT_LMSTUDIO_URL))
            );
            stream_openai_compatible(
                &client,
                &base,
                None,
                &conn.model,
                messages,
                tools,
                false,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::Anthropic => {
            stream_anthropic_compatible(
                &client,
                &format!("{ANTHROPIC_DEFAULT_URL}/v1/messages"),
                conn.api_key.as_deref().unwrap_or(""),
                &conn.model,
                messages,
                tools,
                false,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::OpencodeGo => {
            if is_opencode_go_anthropic_model(&conn.model) {
                stream_anthropic_compatible(
                    &client,
                    &format!("{OPENCODE_GO_URL}/messages"),
                    conn.api_key.as_deref().unwrap_or(""),
                    &conn.model,
                    messages,
                    tools,
                    true,
                    cancel,
                    &mut on_chunk,
                )
                .await
            } else {
                stream_openai_compatible(
                    &client,
                    OPENCODE_GO_URL,
                    conn.api_key.as_deref(),
                    &conn.model,
                    messages,
                    tools,
                    true,
                    cancel,
                    &mut on_chunk,
                )
                .await
            }
        }
        ProviderId::OpenRouter => {
            stream_openai_compatible(
                &client,
                OPENROUTER_URL,
                conn.api_key.as_deref(),
                &conn.model,
                messages,
                tools,
                false,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::Gemini => {
            stream_gemini(
                &client,
                conn.api_key.as_deref().unwrap_or(""),
                &conn.model,
                messages,
                tools,
                cancel,
                &mut on_chunk,
            )
            .await
        }
        ProviderId::Ollama => {
            let base = normalize_base_url(
                conn.base_url.as_deref().unwrap_or(DEFAULT_OLLAMA_URL),
                DEFAULT_OLLAMA_URL,
            );
            stream_ollama(
                &client,
                &base,
                &conn.model,
                messages,
                tools,
                cancel,
                &mut on_chunk,
            )
            .await
        }
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT | StatusCode::CONFLICT | StatusCode::TOO_MANY_REQUESTS
    ) || status.is_server_error()
}

async fn send_with_retries(
    build_req: impl Fn() -> reqwest::RequestBuilder,
    cancel: &CancellationToken,
) -> Result<reqwest::Response, String> {
    let mut attempt = 0u32;
    loop {
        let send_fut = build_req().send();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
            r = send_fut => r,
        };
        match resp {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) if is_retryable_status(r.status()) && attempt < 2 => {
                attempt += 1;
                let delay = Duration::from_secs(1 << (attempt - 1));
                tokio::select! {
                    _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
                    _ = tokio::time::sleep(delay) => continue,
                }
            }
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                let detail = extract_error_message(&body);
                return Err(format!("HTTP {status}: {detail}"));
            }
            Err(_e) if attempt < 2 => {
                attempt += 1;
                let delay = Duration::from_secs(1 << (attempt - 1));
                tokio::select! {
                    _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
                    _ = tokio::time::sleep(delay) => continue,
                }
            }
            Err(e) => return Err(format!("Network error: {e}")),
        }
    }
}

fn extract_error_message(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|m| m.as_str())
        {
            return msg.to_string();
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "Request failed".to_string()
    } else {
        trimmed.chars().take(240).collect()
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_openai_compatible<F>(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    opencode_headers: bool,
    cancel: CancellationToken,
    on_chunk: &mut F,
) -> Result<StreamTurnOutcome, String>
where
    F: FnMut(String),
{
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut headers = default_headers(opencode_headers);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(key) = api_key {
        if !key.is_empty() {
            let val = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| "Invalid characters in API key.".to_string())?;
            headers.insert(AUTHORIZATION, val);
        }
    }
    let mut payload = json!({
        "model": model,
        "messages": serialize_openai_messages(messages),
        "stream": true
    });
    if let Some(tlist) = tools {
        if !tlist.is_empty() {
            let formatted: Vec<Value> = tlist
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            payload["tools"] = json!(formatted);
        }
    }

    let resp = send_with_retries(
        || client.post(&url).headers(headers.clone()).json(&payload),
        &cancel,
    )
    .await?;

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let mut truncated = false;
    let mut pending_calls: std::collections::BTreeMap<usize, (String, String, String)> =
        std::collections::BTreeMap::new();

    loop {
        let next_item = tokio::select! {
            _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
            item = stream.next() => item,
        };
        let Some(item) = next_item else {
            break;
        };
        let bytes = item.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:").map(str::trim) {
                if data == "[DONE]" {
                    return Ok(StreamTurnOutcome {
                        text: full_text,
                        tool_calls: finalize_openai_tool_calls(pending_calls),
                        truncated,
                    });
                }
                if let Ok(val) = serde_json::from_str::<Value>(data) {
                    if let Some(choice) = val.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) {
                        if let Some(delta_text) = choice
                            .get("delta")
                            .and_then(|d| d.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            if !delta_text.is_empty() {
                                full_text.push_str(delta_text);
                                on_chunk(delta_text.to_string());
                            }
                        }
                        if let Some(tc_arr) = choice
                            .get("delta")
                            .and_then(|d| d.get("tool_calls"))
                            .and_then(|t| t.as_array())
                        {
                            for tc in tc_arr {
                                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                let entry = pending_calls.entry(idx).or_insert_with(|| {
                                    (Uuid::new_v4().to_string(), String::new(), String::new())
                                });
                                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                    if !id.is_empty() {
                                        entry.0 = id.to_string();
                                    }
                                }
                                if let Some(func) = tc.get("function") {
                                    if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                        entry.1.push_str(name);
                                    }
                                    if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                        entry.2.push_str(args);
                                    }
                                }
                            }
                        }
                        if choice
                            .get("finish_reason")
                            .and_then(|f| f.as_str())
                            == Some("length")
                        {
                            truncated = true;
                        }
                    }
                }
            }
        }
    }

    Ok(StreamTurnOutcome {
        text: full_text,
        tool_calls: finalize_openai_tool_calls(pending_calls),
        truncated,
    })
}

fn finalize_openai_tool_calls(
    pending: std::collections::BTreeMap<usize, (String, String, String)>,
) -> Vec<ToolCallRequest> {
    pending
        .into_values()
        .filter(|(_, name, _)| !name.trim().is_empty())
        .map(|(id, name, raw_args)| {
            let arguments = serde_json::from_str::<Value>(&raw_args).unwrap_or_else(|_| json!({}));
            ToolCallRequest {
                id,
                name,
                arguments,
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn stream_anthropic_compatible<F>(
    client: &Client,
    endpoint_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    opencode_headers: bool,
    cancel: CancellationToken,
    on_chunk: &mut F,
) -> Result<StreamTurnOutcome, String>
where
    F: FnMut(String),
{
    let mut headers = default_headers(opencode_headers);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key)
            .map_err(|_| "Invalid characters in API key.".to_string())?,
    );
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );

    let system_parts: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect();
    let non_system: Vec<&ChatMessage> = messages.iter().filter(|m| m.role != "system").collect();

    let mut payload = json!({
        "model": model,
        "max_tokens": DEFAULT_MAX_OUTPUT_TOKENS,
        "messages": serialize_anthropic_messages(&non_system),
        "stream": true
    });
    if !system_parts.is_empty() {
        payload["system"] = json!(system_parts.join("\n\n"));
    }
    if let Some(tlist) = tools {
        if !tlist.is_empty() {
            let formatted: Vec<Value> = tlist
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.parameters,
                    })
                })
                .collect();
            payload["tools"] = json!(formatted);
        }
    }

    let resp = send_with_retries(
        || client.post(endpoint_url).headers(headers.clone()).json(&payload),
        &cancel,
    )
    .await?;

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let mut truncated = false;
    let mut pending_calls: std::collections::BTreeMap<usize, (String, String, String)> =
        std::collections::BTreeMap::new();

    loop {
        let next_item = tokio::select! {
            _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
            item = stream.next() => item,
        };
        let Some(item) = next_item else {
            break;
        };
        let bytes = item.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data.is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match val.get("type").and_then(|t| t.as_str()) {
                Some("content_block_start") => {
                    let idx = val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    if let Some(block) = val.get("content_block") {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            pending_calls.insert(idx, (id, name, String::new()));
                        }
                    }
                }
                Some("content_block_delta") => {
                    let idx = val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    if let Some(delta) = val.get("delta") {
                        match delta.get("type").and_then(|t| t.as_str()) {
                            Some("text_delta") => {
                                if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                    if !text.is_empty() {
                                        full_text.push_str(text);
                                        on_chunk(text.to_string());
                                    }
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some(pj) = delta.get("partial_json").and_then(|t| t.as_str()) {
                                    if let Some(entry) = pending_calls.get_mut(&idx) {
                                        entry.2.push_str(pj);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Some("message_delta") => {
                    if val
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|s| s.as_str())
                        == Some("max_tokens")
                    {
                        truncated = true;
                    }
                }
                Some("message_stop") => {
                    return Ok(StreamTurnOutcome {
                        text: full_text,
                        tool_calls: finalize_openai_tool_calls(pending_calls),
                        truncated,
                    });
                }
                Some("error") => {
                    let msg = val
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Anthropic streaming error");
                    return Err(msg.to_string());
                }
                _ => {}
            }
        }
    }

    Ok(StreamTurnOutcome {
        text: full_text,
        tool_calls: finalize_openai_tool_calls(pending_calls),
        truncated,
    })
}

async fn stream_ollama<F>(
    client: &Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    cancel: CancellationToken,
    on_chunk: &mut F,
) -> Result<StreamTurnOutcome, String>
where
    F: FnMut(String),
{
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let mut payload = json!({
        "model": model,
        "messages": serialize_ollama_messages(messages),
        "stream": true
    });
    if let Some(tlist) = tools {
        if !tlist.is_empty() {
            let formatted: Vec<Value> = tlist
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            payload["tools"] = json!(formatted);
        }
    }

    let resp = send_with_retries(|| client.post(&url).json(&payload), &cancel).await?;
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let mut tool_calls = Vec::new();
    let mut truncated = false;

    loop {
        let next_item = tokio::select! {
            _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
            item = stream.next() => item,
        };
        let Some(item) = next_item else {
            break;
        };
        let bytes = item.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);
            if line.is_empty() {
                continue;
            }
            let val: Value = serde_json::from_str(&line)
                .map_err(|e| format!("Invalid Ollama stream chunk: {e}"))?;
            if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            if let Some(msg) = val.get("message") {
                if let Some(delta) = msg.get("content").and_then(|c| c.as_str()) {
                    if !delta.is_empty() {
                        full_text.push_str(delta);
                        on_chunk(delta.to_string());
                    }
                }
                if let Some(tc_arr) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                    for tc in tc_arr {
                        if let Some(func) = tc.get("function") {
                            if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                let args = func.get("arguments").cloned().unwrap_or_else(|| json!({}));
                                tool_calls.push(ToolCallRequest {
                                    id: Uuid::new_v4().to_string(),
                                    name: name.to_string(),
                                    arguments: args,
                                });
                            }
                        }
                    }
                }
            }
            if val.get("done_reason").and_then(|r| r.as_str()) == Some("length") {
                truncated = true;
            }
            if val.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                return Ok(StreamTurnOutcome {
                    text: full_text,
                    tool_calls,
                    truncated,
                });
            }
        }
    }

    Ok(StreamTurnOutcome {
        text: full_text,
        tool_calls,
        truncated,
    })
}

pub fn serialize_gemini_contents(messages: &[&ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            if m.role == "tool" {
                let name = m.name.clone().unwrap_or_else(|| "tool".to_string());
                let mut parts = vec![json!({
                    "functionResponse": {
                        "name": name,
                        "response": { "output": m.content }
                    }
                })];
                for img in &m.images {
                    parts.push(json!({
                        "inlineData": {
                            "mimeType": img.mime_type,
                            "data": img.data_base64,
                        }
                    }));
                }
                return json!({
                    "role": "user",
                    "parts": parts,
                });
            }
            let role = if m.role == "assistant" { "model" } else { "user" };
            let mut parts: Vec<Value> = Vec::new();
            if !m.content.is_empty() {
                parts.push(json!({ "text": m.content }));
            }
            for img in &m.images {
                parts.push(json!({
                    "inlineData": {
                        "mimeType": img.mime_type,
                        "data": img.data_base64,
                    }
                }));
            }
            for tc in &m.tool_calls {
                parts.push(json!({
                    "functionCall": {
                        "name": tc.name,
                        "args": tc.arguments,
                    }
                }));
            }
            json!({ "role": role, "parts": parts })
        })
        .collect()
}

pub fn parse_gemini_sse_data(data: &str) -> Option<(String, Vec<ToolCallRequest>, bool)> {
    let val: Value = serde_json::from_str(data).ok()?;
    let candidate = val.get("candidates")?.as_array()?.first()?;
    let mut text = String::new();
    let mut calls = Vec::new();

    if let Some(parts) = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
    {
        for part in parts {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                text.push_str(t);
            }
            if let Some(fc) = part.get("functionCall") {
                if let Some(name) = fc.get("name").and_then(|v| v.as_str()) {
                    let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                    calls.push(ToolCallRequest {
                        id: Uuid::new_v4().to_string(),
                        name: name.to_string(),
                        arguments: args,
                    });
                }
            }
        }
    }
    let truncated = candidate
        .get("finishReason")
        .and_then(|r| r.as_str())
        .map(|r| r == "MAX_TOKENS")
        .unwrap_or(false);

    Some((text, calls, truncated))
}

async fn stream_gemini<F>(
    client: &Client,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolDefinition]>,
    cancel: CancellationToken,
    on_chunk: &mut F,
) -> Result<StreamTurnOutcome, String>
where
    F: FnMut(String),
{
    let clean_model = model.trim().strip_prefix("models/").unwrap_or(model.trim());
    let url = format!(
        "{GEMINI_API_BASE}/models/{clean_model}:streamGenerateContent?alt=sse&key={api_key}"
    );

    let system_parts: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect();
    let non_system: Vec<&ChatMessage> = messages.iter().filter(|m| m.role != "system").collect();

    let mut payload = json!({
        "contents": serialize_gemini_contents(&non_system),
    });
    if !system_parts.is_empty() {
        payload["systemInstruction"] = json!({
            "parts": [{ "text": system_parts.join("\n\n") }]
        });
    }
    if let Some(tlist) = tools {
        if !tlist.is_empty() {
            let decls: Vec<Value> = tlist
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    })
                })
                .collect();
            payload["tools"] = json!([{ "functionDeclarations": decls }]);
        }
    }

    let mut headers = default_headers(false);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let resp = send_with_retries(
        || client.post(&url).headers(headers.clone()).json(&payload),
        &cancel,
    )
    .await?;

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full_text = String::new();
    let mut tool_calls = Vec::new();
    let mut truncated = false;

    loop {
        let next_item = tokio::select! {
            _ = cancel.cancelled() => return Err("__CANCELLED__".to_string()),
            item = stream.next() => item,
        };
        let Some(item) = next_item else {
            break;
        };
        let bytes = item.map_err(|e| format!("Stream read error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:").map(str::trim) {
                if data.is_empty() {
                    continue;
                }
                if let Some((delta, calls, is_trunc)) = parse_gemini_sse_data(data) {
                    if !delta.is_empty() {
                        full_text.push_str(&delta);
                        on_chunk(delta);
                    }
                    tool_calls.extend(calls);
                    if is_trunc {
                        truncated = true;
                    }
                }
            }
        }
    }

    Ok(StreamTurnOutcome {
        text: full_text,
        tool_calls,
        truncated,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedChunk {
    pub text: Option<String>,
    pub truncated: bool,
    pub done: bool,
}

pub fn parse_openai_sse_line(line: &str) -> Option<ParsedChunk> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() {
        return None;
    }
    if data == "[DONE]" {
        return Some(ParsedChunk {
            text: None,
            truncated: false,
            done: true,
        });
    }
    let val: Value = serde_json::from_str(data).ok()?;
    let choice = val.get("choices")?.as_array()?.first()?;
    let text = choice
        .get("delta")
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .map(String::from);
    let truncated = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .map(|f| f == "length")
        .unwrap_or(false);
    Some(ParsedChunk {
        text,
        truncated,
        done: false,
    })
}

pub fn parse_anthropic_sse_line(line: &str) -> Result<Option<ParsedChunk>, String> {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return Ok(None);
    };
    if data.is_empty() {
        return Ok(None);
    }
    let Ok(val) = serde_json::from_str::<Value>(data) else {
        return Ok(None);
    };
    match val.get("type").and_then(|t| t.as_str()) {
        Some("content_block_delta") => {
            let text = val
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
                .map(String::from);
            Ok(Some(ParsedChunk {
                text,
                truncated: false,
                done: false,
            }))
        }
        Some("message_delta") => {
            let truncated = val
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(|s| s.as_str())
                .map(|s| s == "max_tokens")
                .unwrap_or(false);
            Ok(Some(ParsedChunk {
                text: None,
                truncated,
                done: false,
            }))
        }
        Some("message_stop") => Ok(Some(ParsedChunk {
            text: None,
            truncated: false,
            done: true,
        })),
        Some("error") => {
            let msg = val
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Anthropic streaming error");
            Err(msg.to_string())
        }
        _ => Ok(None),
    }
}

pub fn parse_ollama_ndjson_line(line: &str) -> Result<Option<ParsedChunk>, String> {
    let val: Value =
        serde_json::from_str(line).map_err(|e| format!("Invalid Ollama stream chunk: {e}"))?;
    if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    let text = val
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(String::from);
    let done = val.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
    let truncated = val
        .get("done_reason")
        .and_then(|r| r.as_str())
        .map(|r| r == "length")
        .unwrap_or(false);
    Ok(Some(ParsedChunk {
        text,
        truncated,
        done,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lmstudio_ws_and_http_urls() {
        assert_eq!(
            normalize_lmstudio_http_base("ws://localhost:1234"),
            "http://localhost:1234"
        );
        assert_eq!(
            normalize_lmstudio_http_base("wss://llm.local:8443/v1/"),
            "https://llm.local:8443"
        );
        assert_eq!(
            normalize_lmstudio_http_base("http://127.0.0.1:1234/v1"),
            "http://127.0.0.1:1234"
        );
    }

    #[test]
    fn routes_opencode_go_models_correctly() {
        assert!(is_opencode_go_anthropic_model("qwen3-coder"));
        assert!(is_opencode_go_anthropic_model("MiniMax-M1"));
        assert!(!is_opencode_go_anthropic_model("glm-5.2"));
        assert!(!is_opencode_go_anthropic_model("gpt-5-mini"));
    }

    #[test]
    fn parses_openai_sse_chunks() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}"#;
        let parsed = parse_openai_sse_line(line).unwrap();
        assert_eq!(parsed.text.as_deref(), Some("Hello "));
        assert!(!parsed.done);
        assert!(!parsed.truncated);

        let done = parse_openai_sse_line("data: [DONE]").unwrap();
        assert!(done.done);
    }

    #[test]
    fn parses_anthropic_sse_chunks() {
        let line = r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi!"}}"#;
        let parsed = parse_anthropic_sse_line(line).unwrap().unwrap();
        assert_eq!(parsed.text.as_deref(), Some("Hi!"));
        assert!(!parsed.done);

        let stop = parse_anthropic_sse_line(r#"data: {"type":"message_stop"}"#)
            .unwrap()
            .unwrap();
        assert!(stop.done);
    }

    #[test]
    fn parses_ollama_ndjson_chunks() {
        let line = r#"{"message":{"role":"assistant","content":"Rust"},"done":false}"#;
        let parsed = parse_ollama_ndjson_line(line).unwrap().unwrap();
        assert_eq!(parsed.text.as_deref(), Some("Rust"));
        assert!(!parsed.done);

        let done = parse_ollama_ndjson_line(r#"{"done":true,"done_reason":"length"}"#)
            .unwrap()
            .unwrap();
        assert!(done.done);
        assert!(done.truncated);
    }

    #[test]
    fn serializes_multimodal_messages_for_openai_anthropic_and_ollama() {
        let msg = ChatMessage {
            role: "user".to_string(),
            content: "What is on my screen?".to_string(),
            images: vec![ImageAttachment {
                mime_type: "image/png".to_string(),
                data_base64: "AAAA".to_string(),
            }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        };

        let oai = serialize_openai_messages(&[msg.clone()]);
        assert_eq!(oai[0]["content"][1]["type"], "image_url");
        assert_eq!(
            oai[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );

        let ant = serialize_anthropic_messages(&[&msg]);
        assert_eq!(ant[0]["content"][0]["type"], "image");
        assert_eq!(ant[0]["content"][0]["source"]["data"], "AAAA");
        assert_eq!(ant[0]["content"][1]["type"], "text");

        let oll = serialize_ollama_messages(&[msg]);
        assert_eq!(oll[0]["images"][0], "AAAA");
        assert_eq!(oll[0]["content"], "What is on my screen?");
    }

    #[test]
    fn parses_gemini_sse_text_and_function_calls() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":"Checking RAM…"},{"functionCall":{"name":"get_system_info","args":{}}}]},"finishReason":"STOP"}]}"#;
        let (text, calls, truncated) = parse_gemini_sse_data(data).unwrap();
        assert_eq!(text, "Checking RAM…");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "get_system_info");
        assert!(!truncated);
    }

    #[test]
    fn serializes_tool_result_images_for_all_providers() {
        let tool_msg = ChatMessage {
            role: "tool".to_string(),
            content: "Captured screen 1600x900".to_string(),
            images: vec![ImageAttachment {
                mime_type: "image/png".to_string(),
                data_base64: "BBBB".to_string(),
            }],
            tool_calls: Vec::new(),
            tool_call_id: Some("call_1".to_string()),
            name: Some("screen_capture".to_string()),
        };

        // OpenAI emits the tool message followed by a user image_url message
        let oai = serialize_openai_messages(&[tool_msg.clone()]);
        assert_eq!(oai.len(), 2);
        assert_eq!(oai[0]["role"], "tool");
        assert_eq!(oai[1]["role"], "user");
        assert_eq!(
            oai[1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BBBB"
        );

        // Anthropic embeds image block inside tool_result content
        let ant = serialize_anthropic_messages(&[&tool_msg]);
        assert_eq!(ant[0]["content"][0]["type"], "tool_result");
        assert_eq!(ant[0]["content"][0]["content"][1]["type"], "image");
        assert_eq!(ant[0]["content"][0]["content"][1]["source"]["data"], "BBBB");

        // Gemini appends inlineData next to functionResponse
        let gem = serialize_gemini_contents(&[&tool_msg]);
        assert_eq!(gem[0]["parts"][0]["functionResponse"]["name"], "screen_capture");
        assert_eq!(gem[0]["parts"][1]["inlineData"]["data"], "BBBB");

        // Ollama attaches images array on the tool message
        let oll = serialize_ollama_messages(&[tool_msg]);
        assert_eq!(oll[0]["role"], "tool");
        assert_eq!(oll[0]["images"][0], "BBBB");
    }
}
