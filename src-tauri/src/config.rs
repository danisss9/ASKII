use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const KEYRING_SERVICE: &str = "dev.askii.desktop";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
pub const DEFAULT_ACTION_SHORTCUT: &str = "Alt+Shift+Space";
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
pub const DEFAULT_LMSTUDIO_URL: &str = "http://localhost:1234";
pub const MAX_PROMPT_HISTORY: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    AskiiCloud,
    OpenAi,
    Anthropic,
    Gemini,
    OpenRouter,
    OpencodeGo,
    Ollama,
    LmStudio,
}

impl ProviderId {
    pub const ALL: [ProviderId; 8] = [
        ProviderId::AskiiCloud,
        ProviderId::OpenAi,
        ProviderId::Anthropic,
        ProviderId::Gemini,
        ProviderId::OpenRouter,
        ProviderId::OpencodeGo,
        ProviderId::Ollama,
        ProviderId::LmStudio,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderId::AskiiCloud => "askiicloud",
            ProviderId::OpenAi => "openai",
            ProviderId::Anthropic => "anthropic",
            ProviderId::Gemini => "gemini",
            ProviderId::OpenRouter => "openrouter",
            ProviderId::OpencodeGo => "opencodego",
            ProviderId::Ollama => "ollama",
            ProviderId::LmStudio => "lmstudio",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ProviderId::AskiiCloud => "ASKII Cloud",
            ProviderId::OpenAi => "OpenAI",
            ProviderId::Anthropic => "Anthropic",
            ProviderId::Gemini => "Google Gemini",
            ProviderId::OpenRouter => "OpenRouter",
            ProviderId::OpencodeGo => "opencode Go",
            ProviderId::Ollama => "Ollama",
            ProviderId::LmStudio => "LM Studio",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            ProviderId::AskiiCloud => "ASKII-hosted models with sensible defaults out of the box.",
            ProviderId::OpenAi => "OpenAI models or any OpenAI-compatible endpoint via custom base URL.",
            ProviderId::Anthropic => "Claude models served directly through the Anthropic API.",
            ProviderId::Gemini => "Gemini models served directly through the Google AI Studio API.",
            ProviderId::OpenRouter => "Unified gateway to 200+ frontier and open models via OpenRouter.",
            ProviderId::OpencodeGo => "Hosted fast models from the opencode Go inference service.",
            ProviderId::Ollama => "Run open models completely locally through your Ollama server.",
            ProviderId::LmStudio => "Connect to models loaded in your local LM Studio server.",
        }
    }

    pub fn uses_api_key(&self) -> bool {
        matches!(
            self,
            ProviderId::AskiiCloud
                | ProviderId::OpenAi
                | ProviderId::Anthropic
                | ProviderId::Gemini
                | ProviderId::OpenRouter
                | ProviderId::OpencodeGo
        )
    }

    pub fn supports_custom_base_url(&self) -> bool {
        matches!(self, ProviderId::OpenAi)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinitionDto {
    pub id: ProviderId,
    pub label: &'static str,
    pub description: &'static str,
    pub connection: &'static str,
    pub supports_custom_base_url: bool,
}

pub fn all_provider_definitions() -> Vec<ProviderDefinitionDto> {
    ProviderId::ALL
        .iter()
        .map(|p| ProviderDefinitionDto {
            id: *p,
            label: p.label(),
            description: p.description(),
            connection: if p.uses_api_key() {
                "apiKey"
            } else {
                "serverUrl"
            },
            supports_custom_base_url: p.supports_custom_base_url(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptRecipe {
    pub command: String,
    pub label: String,
    pub description: String,
    pub system_prompt: String,
    pub user_prefix: String,
    #[serde(default)]
    pub auto_attach_clipboard: bool,
    #[serde(default)]
    pub model_override: Option<String>,
}

pub fn default_recipes() -> Vec<PromptRecipe> {
    vec![
        PromptRecipe {
            command: "/fix".to_string(),
            label: "/fix".to_string(),
            description: "Fix grammar, clarity, and tone — returns clean ready-to-insert text".to_string(),
            system_prompt: "You are an expert editor. Fix grammar, spelling, and flow while preserving the original meaning and voice. Return ONLY the improved text with no preamble unless asked.".to_string(),
            user_prefix: "Rewrite and polish the following text:".to_string(),
            auto_attach_clipboard: true,
            model_override: None,
        },
        PromptRecipe {
            command: "/translate".to_string(),
            label: "/translate".to_string(),
            description: "Translate attached text or your prompt (e.g. /translate Spanish)".to_string(),
            system_prompt: "You are a crisp, natural translator. Translate accurately into the requested target language (default English if not specified). Output the translation cleanly.".to_string(),
            user_prefix: "Translate:".to_string(),
            auto_attach_clipboard: true,
            model_override: None,
        },
        PromptRecipe {
            command: "/summarize".to_string(),
            label: "/summarize".to_string(),
            description: "Distill attached text, file, or screenshot into tight bullet points".to_string(),
            system_prompt: "Summarize the provided content into crisp, high-signal bullet points with key takeaways first.".to_string(),
            user_prefix: "Summarize the following:".to_string(),
            auto_attach_clipboard: true,
            model_override: None,
        },
        PromptRecipe {
            command: "/explain".to_string(),
            label: "/explain".to_string(),
            description: "Explain code, errors, or concepts clearly and concisely".to_string(),
            system_prompt: "Explain clearly and concisely. For code or errors, highlight root cause and actionable fix first.".to_string(),
            user_prefix: "Explain the following:".to_string(),
            auto_attach_clipboard: true,
            model_override: None,
        },
        PromptRecipe {
            command: "/shell".to_string(),
            label: "/shell".to_string(),
            description: "Generate a clean Windows PowerShell one-liner with a brief note".to_string(),
            system_prompt: "You are a Windows PowerShell expert. Provide the exact PowerShell command inside a ```powershell code block followed by a 1-sentence explanation.".to_string(),
            user_prefix: "Write a Windows PowerShell command to:".to_string(),
            auto_attach_clipboard: false,
            model_override: None,
        },
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AgentMode {
    #[default]
    Confirm,
    AutoDo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: String, // "stdio" | "http"
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_max_steps() -> u8 {
    10
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub mode: AgentMode,
    #[serde(default = "default_true")]
    pub auto_approve_desktop_controls: bool,
    #[serde(default = "default_true")]
    pub guard_destructive_commands: bool,
    #[serde(default = "default_max_steps")]
    pub max_steps: u8,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: AgentMode::Confirm,
            auto_approve_desktop_controls: true,
            guard_destructive_commands: true,
            max_steps: 10,
            mcp_servers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub provider: ProviderId,
    pub model: String,
}

fn default_action_shortcut() -> String {
    DEFAULT_ACTION_SHORTCUT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub setup_completed: bool,
    pub provider: ProviderId,
    pub model: String,
    pub ollama_url: String,
    pub lmstudio_url: String,
    pub openai_url: String,
    pub shortcut: String,
    #[serde(default = "default_action_shortcut")]
    pub action_shortcut: String,
    #[serde(default)]
    pub whisper_url: String,
    #[serde(default)]
    pub start_with_windows: bool,
    #[serde(default = "default_true")]
    pub clipboard_history_enabled: bool,
    #[serde(default)]
    pub recent_models: Vec<ModelProfile>,
    #[serde(default)]
    pub prompt_history: Vec<String>,
    #[serde(default = "default_recipes")]
    pub recipes: Vec<PromptRecipe>,
    #[serde(default)]
    pub agent: AgentSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            setup_completed: false,
            provider: ProviderId::AskiiCloud,
            model: "askii-smart".to_string(),
            ollama_url: DEFAULT_OLLAMA_URL.to_string(),
            lmstudio_url: DEFAULT_LMSTUDIO_URL.to_string(),
            openai_url: String::new(),
            shortcut: DEFAULT_SHORTCUT.to_string(),
            action_shortcut: DEFAULT_ACTION_SHORTCUT.to_string(),
            whisper_url: String::new(),
            start_with_windows: false,
            clipboard_history_enabled: true,
            recent_models: Vec::new(),
            prompt_history: Vec::new(),
            recipes: default_recipes(),
            agent: AgentSettings::default(),
        }
    }
}

impl AppConfig {
    pub fn record_model_profile(&mut self, provider: ProviderId, model: &str) {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return;
        }
        self.recent_models
            .retain(|m| !(m.provider == provider && m.model.eq_ignore_ascii_case(trimmed)));
        self.recent_models.insert(
            0,
            ModelProfile {
                provider,
                model: trimmed.to_string(),
            },
        );
        if self.recent_models.len() > 12 {
            self.recent_models.truncate(12);
        }
    }

    pub fn record_prompt(&mut self, prompt: &str) {
        let trimmed = prompt.trim();
        if trimmed.is_empty() || trimmed.starts_with('/') {
            return;
        }
        self.prompt_history
            .retain(|existing| !existing.eq_ignore_ascii_case(trimmed));
        self.prompt_history.insert(0, trimmed.to_string());
        if self.prompt_history.len() > MAX_PROMPT_HISTORY {
            self.prompt_history.truncate(MAX_PROMPT_HISTORY);
        }
    }
}

pub fn config_file_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("dev.askii.desktop").join("config.json")
}

pub fn load_config() -> AppConfig {
    let path = config_file_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return AppConfig::default();
    };
    serde_json::from_str::<AppConfig>(&raw).unwrap_or_default()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))
}

fn secret_account(provider: ProviderId) -> Option<String> {
    if provider.uses_api_key() {
        Some(format!("credentials.{}.apiKey", provider.as_str()))
    } else {
        None
    }
}

pub fn store_api_key(provider: ProviderId, api_key: &str) -> Result<(), String> {
    let Some(account) = secret_account(provider) else {
        return Ok(());
    };
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("Credential Manager unavailable: {e}"))?;
    entry
        .set_password(trimmed)
        .map_err(|e| format!("Failed to store API key in Windows Credential Manager: {e}"))
}

pub fn get_api_key(provider: ProviderId) -> Option<String> {
    let account = secret_account(provider)?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account).ok()?;
    let value = entry.get_password().ok()?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn get_saved_credentials_map() -> HashMap<String, bool> {
    ProviderId::ALL
        .iter()
        .map(|p| {
            let saved = if p.uses_api_key() {
                get_api_key(*p).is_some()
            } else {
                false
            };
            (p.as_str().to_string(), saved)
        })
        .collect()
}

pub fn is_config_ready(config: &AppConfig) -> bool {
    if !config.setup_completed || config.model.trim().is_empty() {
        return false;
    }
    match config.provider {
        ProviderId::AskiiCloud
        | ProviderId::OpenAi
        | ProviderId::Anthropic
        | ProviderId::Gemini
        | ProviderId::OpenRouter
        | ProviderId::OpencodeGo => get_api_key(config.provider).is_some(),
        ProviderId::Ollama => !config.ollama_url.trim().is_empty(),
        ProviderId::LmStudio => !config.lmstudio_url.trim().is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_prompt_deduplicates_and_caps_history() {
        let mut cfg = AppConfig::default();
        cfg.record_prompt("What is Rust?");
        cfg.record_prompt("/setup");
        cfg.record_prompt("   ");
        cfg.record_prompt("Explain Tauri");
        cfg.record_prompt("what is rust?");

        assert_eq!(cfg.prompt_history.len(), 2);
        assert_eq!(cfg.prompt_history[0], "what is rust?");
        assert_eq!(cfg.prompt_history[1], "Explain Tauri");

        for i in 0..120 {
            cfg.record_prompt(&format!("Prompt {i}"));
        }
        assert_eq!(cfg.prompt_history.len(), MAX_PROMPT_HISTORY);
        assert_eq!(cfg.prompt_history[0], "Prompt 119");
    }

    #[test]
    fn provider_definitions_include_all_eight_connectors() {
        let defs = all_provider_definitions();
        assert_eq!(defs.len(), 8);
        assert_eq!(defs[0].id, ProviderId::AskiiCloud);
        assert_eq!(defs[3].id, ProviderId::Gemini);
        assert_eq!(defs[4].id, ProviderId::OpenRouter);
        assert_eq!(defs[7].id, ProviderId::LmStudio);
    }

    #[test]
    fn legacy_config_migrates_with_default_recipes_and_action_shortcut() {
        let legacy = r#"{
            "setupCompleted": true,
            "provider": "openai",
            "model": "gpt-4o-mini",
            "ollamaUrl": "http://localhost:11434",
            "lmstudioUrl": "http://localhost:1234",
            "openaiUrl": "",
            "shortcut": "Alt+Space",
            "promptHistory": []
        }"#;
        let parsed: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.action_shortcut, DEFAULT_ACTION_SHORTCUT);
        assert!(parsed.recipes.len() >= 5);
        assert_eq!(parsed.recipes[0].command, "/fix");
    }
}
