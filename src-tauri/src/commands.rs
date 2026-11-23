use crate::AppState;
use crate::agent::{self, ApprovalDecision};
use crate::clipboard_ring::ClipboardHistoryItem;
use crate::config::{
    AgentMode, AgentSettings, AppConfig, PromptRecipe, ProviderDefinitionDto, ProviderId,
    all_provider_definitions, get_api_key, get_saved_credentials_map, is_config_ready, save_config,
    store_api_key,
};
use crate::context::{
    ClipboardContextPayload, FileAttachmentResult, PreviousWindowInfo, ScreenCaptureResult,
};
use crate::launcher::InstantResult;
use crate::llm::providers::ProviderConnection;
use crate::llm::{
    ChatMessage, DiscoverModelsRequest, ModelDiscoveryResult, StreamEvent, discover_models,
};
use crate::storage::{MemoryEntry, SlipSummary, StoredSlip};
use crate::{context, launcher, register_shortcuts, tray, voice, window};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    pub config: AppConfig,
    pub providers: Vec<ProviderDefinitionDto>,
    pub saved_credentials: HashMap<String, bool>,
    pub needs_setup: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSetupRequest {
    pub provider: ProviderId,
    pub model: String,
    pub api_key: Option<String>,
    pub ollama_url: Option<String>,
    pub lmstudio_url: Option<String>,
    pub openai_url: Option<String>,
    pub shortcut: Option<String>,
    pub action_shortcut: Option<String>,
    pub whisper_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub prompt: String,
    pub messages: Vec<ChatMessage>,
    pub system_prompt_override: Option<String>,
    pub model_override: Option<String>,
}

fn build_state_dto(config: &AppConfig) -> AppStateDto {
    AppStateDto {
        config: config.clone(),
        providers: all_provider_definitions(),
        saved_credentials: get_saved_credentials_map(),
        needs_setup: !is_config_ready(config),
    }
}

#[tauri::command]
pub fn get_app_state(state: State<'_, AppState>) -> AppStateDto {
    let config = state.config.lock().unwrap();
    build_state_dto(&config)
}

#[tauri::command]
pub async fn discover_provider_models(
    req: DiscoverModelsRequest,
) -> Result<ModelDiscoveryResult, String> {
    let effective_key = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| get_api_key(req.provider));

    discover_models(req.provider, effective_key, req.server_url, req.openai_base_url).await
}

#[tauri::command]
pub fn save_setup(
    app: AppHandle,
    state: State<'_, AppState>,
    req: SaveSetupRequest,
) -> Result<AppStateDto, String> {
    let model = req.model.trim().to_string();
    if model.is_empty() {
        return Err("Please choose or enter a model ID.".to_string());
    }

    if let Some(ref key) = req.api_key {
        if !key.trim().is_empty() {
            store_api_key(req.provider, key)?;
        }
    }

    if req.provider.uses_api_key() && get_api_key(req.provider).is_none() {
        return Err(format!("{} requires an API key.", req.provider.label()));
    }

    let mut config = state.config.lock().unwrap();
    config.provider = req.provider;
    config.model = model.clone();
    config.record_model_profile(req.provider, &model);
    if let Some(url) = req.whisper_url {
        config.whisper_url = url.trim().to_string();
    }
    if let Some(url) = req.ollama_url {
        let trimmed = url.trim().to_string();
        if !trimmed.is_empty() {
            config.ollama_url = trimmed;
        }
    }
    if let Some(url) = req.lmstudio_url {
        let trimmed = url.trim().to_string();
        if !trimmed.is_empty() {
            config.lmstudio_url = trimmed;
        }
    }
    if let Some(url) = req.openai_url {
        config.openai_url = url.trim().to_string();
    }

    let next_toggle = req
        .shortcut
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| config.shortcut.clone());

    let next_action = req
        .action_shortcut
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| config.action_shortcut.clone());

    if next_toggle != config.shortcut || next_action != config.action_shortcut {
        register_shortcuts(&app, &next_toggle, Some(&next_action), true)?;
        config.shortcut = next_toggle.clone();
        config.action_shortcut = next_action;
        tray::update_tray_shortcut(&app, &next_toggle);
    }

    config.setup_completed = true;
    save_config(&config)?;
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn update_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<String, String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("Shortcut cannot be empty.".to_string());
    }
    let mut config = state.config.lock().unwrap();
    register_shortcuts(&app, &trimmed, Some(&config.action_shortcut), false)?;
    config.shortcut = trimmed.clone();
    save_config(&config)?;
    tray::update_tray_shortcut(&app, &trimmed);
    Ok(trimmed)
}

#[tauri::command]
pub fn update_action_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<String, String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("Selection shortcut cannot be empty.".to_string());
    }
    let mut config = state.config.lock().unwrap();
    register_shortcuts(&app, &config.shortcut, Some(&trimmed), true)?;
    config.action_shortcut = trimmed.clone();
    save_config(&config)?;
    Ok(trimmed)
}

#[tauri::command]
pub fn save_recipes(
    state: State<'_, AppState>,
    recipes: Vec<PromptRecipe>,
) -> Result<AppStateDto, String> {
    let mut config = state.config.lock().unwrap();
    config.recipes = recipes;
    save_config(&config)?;
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn save_agent_settings(
    state: State<'_, AppState>,
    agent: AgentSettings,
) -> Result<AppStateDto, String> {
    let mut config = state.config.lock().unwrap();
    config.agent = agent;
    save_config(&config)?;
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn toggle_auto_do(app: AppHandle, state: State<'_, AppState>) -> Result<AppStateDto, String> {
    let mut config = state.config.lock().unwrap();
    config.agent.mode = match config.agent.mode {
        AgentMode::Confirm => AgentMode::AutoDo,
        AgentMode::AutoDo => AgentMode::Confirm,
    };
    save_config(&config)?;
    tray::refresh_tray(
        &app,
        &config.shortcut,
        config.start_with_windows,
        config.agent.mode == AgentMode::AutoDo,
    );
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn resolve_tool_approval(
    state: State<'_, AppState>,
    call_id: String,
    decision: ApprovalDecision,
) -> bool {
    state.agent_runtime.resolve_approval(&call_id, decision)
}

#[tauri::command]
pub fn undo_tool_backup(backup_id: String) -> Result<String, String> {
    agent::backup::restore_backup(&backup_id)
}

#[tauri::command]
pub async fn ask_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    req: AskRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let (conn, agent_settings) = {
        let mut config = state.config.lock().unwrap();
        if !is_config_ready(&config) {
            return Err("ASKII is not configured yet. Type /setup to connect an LLM provider.".to_string());
        }
        config.record_prompt(&req.prompt);
        let _ = save_config(&config);

        let base_url = match config.provider {
            ProviderId::Ollama => Some(config.ollama_url.clone()),
            ProviderId::LmStudio => Some(config.lmstudio_url.clone()),
            ProviderId::OpenAi => {
                if config.openai_url.trim().is_empty() {
                    None
                } else {
                    Some(config.openai_url.clone())
                }
            }
            _ => None,
        };

        let chosen_model = req
            .model_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| config.model.clone());

        (
            ProviderConnection {
                provider: config.provider,
                model: chosen_model,
                api_key: get_api_key(config.provider),
                base_url,
            },
            config.agent.clone(),
        )
    };

    // Cancel any previously running stream before starting a new one.
    let token = CancellationToken::new();
    {
        let mut active = state.active_cancel.lock().unwrap();
        if let Some(prev) = active.replace(token.clone()) {
            prev.cancel();
        }
    }
    state.agent_runtime.cancel_all_pending();

    let mut base_system = req
        .system_prompt_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            "You are ASKII (⌐■_■), a crisp, friendly Windows OS-level AI personal assistant living on the user's desktop. You have native Windows tools to inspect the PC, search/read/write files, manage windows, control media, set reminders, and run PowerShell commands when the user asks you to inspect or act on their system. Answer clearly, concisely, and helpfully using clean Markdown.".to_string()
        });

    if let Some(mem_block) = state.storage.lock().unwrap().format_memories_block() {
        base_system.push_str("\n\n");
        base_system.push_str(&mem_block);
    }

    let mut full_messages = Vec::with_capacity(req.messages.len() + 1);
    full_messages.push(ChatMessage {
        role: "system".to_string(),
        content: base_system,
        images: Vec::new(),
        tool_calls: Vec::new(),
        tool_call_id: None,
        name: None,
    });
    full_messages.extend(req.messages);

    let result = agent::run_agent_chat(
        &app,
        &state.agent_runtime,
        &conn,
        &agent_settings,
        full_messages,
        token.clone(),
        &on_event,
    )
    .await;

    // Clear active cancel handle if it is still ours.
    {
        let mut active = state.active_cancel.lock().unwrap();
        if active
            .as_ref()
            .map(|t| t.is_cancelled() == token.is_cancelled())
            .unwrap_or(false)
        {
            *active = None;
        }
    }

    match result {
        Ok(truncated) => {
            let _ = on_event.send(StreamEvent::Done { truncated });
        }
        Err(ref msg) if msg == "__CANCELLED__" => {
            let _ = on_event.send(StreamEvent::Cancelled);
        }
        Err(message) => {
            let _ = on_event.send(StreamEvent::Error { message });
        }
    }

    Ok(())
}

#[tauri::command]
pub fn cancel_active_stream(state: State<'_, AppState>) {
    state.agent_runtime.cancel_all_pending();
    let mut active = state.active_cancel.lock().unwrap();
    if let Some(token) = active.take() {
        token.cancel();
    }
}

#[tauri::command]
pub fn set_pinned(state: State<'_, AppState>, pinned: bool) {
    state.is_pinned.store(pinned, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_in_setup(state: State<'_, AppState>, in_setup: bool) {
    state.in_setup.store(in_setup, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_window_height(app: AppHandle, height: f64) {
    window::set_window_height(&app, height);
}

#[tauri::command]
pub fn get_previous_window(state: State<'_, AppState>) -> Option<PreviousWindowInfo> {
    state.previous_window.lock().unwrap().clone()
}

#[tauri::command]
pub fn capture_clipboard() -> Result<ClipboardContextPayload, String> {
    context::read_clipboard_context()
}

#[tauri::command]
pub async fn capture_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<ScreenCaptureResult, String> {
    let target_hwnd = state
        .previous_window
        .lock()
        .unwrap()
        .as_ref()
        .map(|w| w.hwnd);

    // Briefly hide ASKII so it doesn't appear inside its own screenshot.
    window::hide_askii(&app);
    tokio::time::sleep(std::time::Duration::from_millis(140)).await;

    let res = tokio::task::spawn_blocking(move || context::capture_screen_png(&mode, target_hwnd))
        .await
        .map_err(|e| format!("Capture task failed: {e}"))?;

    // Re-show ASKII without overwriting previous_window.
    window::show_askii_with_context(&app, false, None, None);
    res
}

#[tauri::command]
pub fn read_file_attachment(path: String) -> Result<FileAttachmentResult, String> {
    context::read_file_attachment(&path)
}

#[tauri::command]
pub async fn insert_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let hwnd = state
        .previous_window
        .lock()
        .unwrap()
        .as_ref()
        .map(|w| w.hwnd)
        .unwrap_or(0);

    if hwnd == 0 {
        return Err("No active target window to insert into.".to_string());
    }

    window::hide_askii(&app);
    tokio::task::spawn_blocking(move || context::insert_into_previous_window(hwnd, &text))
        .await
        .map_err(|e| format!("Insert task failed: {e}"))?
}

#[tauri::command]
pub fn query_instant(state: State<'_, AppState>, query: String) -> Vec<InstantResult> {
    let apps = state.indexed_apps.lock().unwrap();
    launcher::query_instant_results(&query, &apps)
}

#[tauri::command]
pub fn execute_instant(app: AppHandle, item: InstantResult) -> Result<String, String> {
    let msg = launcher::execute_instant_result(&item)?;
    if item.hwnd.is_some() || item.launch_path.is_some() {
        window::hide_askii(&app);
    }
    Ok(msg)
}

#[tauri::command]
pub fn refresh_app_index(state: State<'_, AppState>) -> usize {
    let apps = launcher::scan_windows_start_menu_apps();
    let count = apps.len();
    *state.indexed_apps.lock().unwrap() = apps;
    count
}

#[tauri::command]
pub fn save_slip(state: State<'_, AppState>, slip: StoredSlip) -> Result<(), String> {
    state.storage.lock().unwrap().save_slip(&slip)
}

#[tauri::command]
pub fn list_slips(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<SlipSummary>, String> {
    state
        .storage
        .lock()
        .unwrap()
        .list_slips(query.as_deref(), limit.unwrap_or(40))
}

#[tauri::command]
pub fn get_slip(state: State<'_, AppState>, id: String) -> Result<Option<StoredSlip>, String> {
    state.storage.lock().unwrap().get_slip(&id)
}

#[tauri::command]
pub fn delete_slip(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.storage.lock().unwrap().delete_slip(&id)
}

#[tauri::command]
pub fn detach_slip(app: AppHandle, slip_id: String) -> Result<(), String> {
    window::open_sticky_slip_window(&app, &slip_id)
}

#[tauri::command]
pub fn list_memories(state: State<'_, AppState>) -> Result<Vec<MemoryEntry>, String> {
    state.storage.lock().unwrap().list_memories()
}

#[tauri::command]
pub fn add_memory(state: State<'_, AppState>, content: String) -> Result<MemoryEntry, String> {
    state.storage.lock().unwrap().add_memory(&content)
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.storage.lock().unwrap().delete_memory(id)
}

#[tauri::command]
pub async fn transcribe_voice(
    state: State<'_, AppState>,
    audio_bytes: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    let cfg = state.config.lock().unwrap().clone();
    voice::transcribe_audio(&cfg, audio_bytes, &mime_type).await
}

#[tauri::command]
pub fn switch_model_profile(
    state: State<'_, AppState>,
    provider: ProviderId,
    model: String,
) -> Result<AppStateDto, String> {
    let trimmed = model.trim().to_string();
    if trimmed.is_empty() {
        return Err("Model ID cannot be empty.".to_string());
    }
    if provider.uses_api_key() && get_api_key(provider).is_none() {
        return Err(format!(
            "{} has no saved API key yet. Open /setup to connect it first.",
            provider.label()
        ));
    }
    let mut config = state.config.lock().unwrap();
    config.provider = provider;
    config.model = trimmed.clone();
    config.record_model_profile(provider, &trimmed);
    config.setup_completed = true;
    save_config(&config)?;
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AppStateDto, String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|e| format!("Failed to enable Windows startup: {e}"))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|e| format!("Failed to disable Windows startup: {e}"))?;
    }
    let mut config = state.config.lock().unwrap();
    config.start_with_windows = enabled;
    save_config(&config)?;
    tray::refresh_tray(
        &app,
        &config.shortcut,
        enabled,
        config.agent.mode == AgentMode::AutoDo,
    );
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn set_clipboard_history_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AppStateDto, String> {
    let mut config = state.config.lock().unwrap();
    config.clipboard_history_enabled = enabled;
    save_config(&config)?;
    Ok(build_state_dto(&config))
}

#[tauri::command]
pub fn get_clipboard_history(state: State<'_, AppState>) -> Vec<ClipboardHistoryItem> {
    state.clipboard_ring.list()
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    window::hide_askii(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
