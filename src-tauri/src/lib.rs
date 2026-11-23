pub mod agent;
pub mod clipboard_ring;
pub mod commands;
pub mod config;
pub mod context;
pub mod launcher;
pub mod llm;
pub mod storage;
pub mod tray;
pub mod voice;
pub mod window;

use agent::AgentRuntime;
use clipboard_ring::ClipboardRing;
use config::{AppConfig, DEFAULT_ACTION_SHORTCUT, DEFAULT_SHORTCUT, is_config_ready, load_config};
use context::PreviousWindowInfo;
use launcher::IndexedApp;
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use storage::Storage;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio_util::sync::CancellationToken;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub active_cancel: Mutex<Option<CancellationToken>>,
    pub previous_window: Mutex<Option<PreviousWindowInfo>>,
    pub action_shortcut_parsed: Mutex<Option<Shortcut>>,
    pub agent_runtime: AgentRuntime,
    pub storage: Mutex<Storage>,
    pub indexed_apps: Mutex<Vec<IndexedApp>>,
    pub clipboard_ring: ClipboardRing,
    pub is_pinned: AtomicBool,
    pub in_setup: AtomicBool,
}

pub fn register_shortcuts(
    app: &AppHandle,
    toggle_shortcut: &str,
    action_shortcut: Option<&str>,
    strict_action: bool,
) -> Result<(), String> {
    let parsed_toggle = Shortcut::from_str(toggle_shortcut)
        .map_err(|e| format!("Invalid shortcut \"{toggle_shortcut}\": {e}"))?;

    let parsed_action = match action_shortcut.map(str::trim).filter(|s| !s.is_empty()) {
        Some(act) if !act.eq_ignore_ascii_case(toggle_shortcut.trim()) => {
            match Shortcut::from_str(act) {
                Ok(s) => Some(s),
                Err(e) if strict_action => {
                    return Err(format!("Invalid selection shortcut \"{act}\": {e}"));
                }
                Err(_) => None,
            }
        }
        _ => None,
    };

    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    manager.register(parsed_toggle).map_err(|e| {
        format!(
            "Could not register shortcut \"{toggle_shortcut}\" (it may be reserved by Windows or another app): {e}"
        )
    })?;

    let mut active_action = None;
    if let Some(act_sc) = parsed_action {
        match manager.register(act_sc) {
            Ok(()) => active_action = Some(act_sc),
            Err(e) if strict_action => {
                return Err(format!(
                    "Could not register selection shortcut (it may be reserved by Windows or another app): {e}"
                ));
            }
            Err(_) => {}
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        *state.action_shortcut_parsed.lock().unwrap() = active_action;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_config = load_config();
    let initial_shortcut = initial_config.shortcut.clone();
    let initial_action_shortcut = initial_config.action_shortcut.clone();
    let needs_setup_on_start = !is_config_ready(&initial_config);

    let storage = Storage::open_default()
        .or_else(|_| Storage::open_in_memory())
        .expect("SQLite storage initialization failed");
    let indexed_apps = launcher::scan_windows_start_menu_apps();

    let state = AppState {
        config: Mutex::new(initial_config),
        active_cancel: Mutex::new(None),
        previous_window: Mutex::new(None),
        action_shortcut_parsed: Mutex::new(None),
        agent_runtime: AgentRuntime::default(),
        storage: Mutex::new(storage),
        indexed_apps: Mutex::new(indexed_apps),
        clipboard_ring: ClipboardRing::default(),
        is_pinned: AtomicBool::new(false),
        in_setup: AtomicBool::new(needs_setup_on_start),
    };

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_askii(app, false);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let is_action = {
                        let st = app.state::<AppState>();
                        let guard = st.action_shortcut_parsed.lock().unwrap();
                        guard.as_ref().map(|s| s == shortcut).unwrap_or(false)
                    };

                    if is_action {
                        let app_handle = app.clone();
                        std::thread::spawn(move || {
                            let prev = context::capture_foreground_window();
                            let selection = context::capture_selection_text().ok().flatten();
                            let needs_setup = {
                                let st = app_handle.state::<AppState>();
                                let cfg = st.config.lock().unwrap();
                                !crate::config::is_config_ready(&cfg)
                            };
                            window::show_askii_with_context(
                                &app_handle,
                                needs_setup,
                                prev,
                                selection,
                            );
                        });
                    } else {
                        window::toggle_askii(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::discover_provider_models,
            commands::save_setup,
            commands::update_shortcut,
            commands::update_action_shortcut,
            commands::save_recipes,
            commands::save_agent_settings,
            commands::toggle_auto_do,
            commands::resolve_tool_approval,
            commands::undo_tool_backup,
            commands::ask_stream,
            commands::cancel_active_stream,
            commands::set_pinned,
            commands::set_in_setup,
            commands::set_window_height,
            commands::get_previous_window,
            commands::capture_clipboard,
            commands::capture_screen,
            commands::read_file_attachment,
            commands::insert_reply,
            commands::query_instant,
            commands::execute_instant,
            commands::refresh_app_index,
            commands::save_slip,
            commands::list_slips,
            commands::get_slip,
            commands::delete_slip,
            commands::detach_slip,
            commands::list_memories,
            commands::add_memory,
            commands::delete_memory,
            commands::transcribe_voice,
            commands::switch_model_profile,
            commands::set_autostart,
            commands::set_clipboard_history_enabled,
            commands::get_clipboard_history,
            commands::hide_window,
            commands::quit_app,
        ])
        .setup(move |app| {
            let handle = app.handle();

            // Register saved toggle + selection-action shortcuts.
            let active_shortcut = if register_shortcuts(
                handle,
                &initial_shortcut,
                Some(&initial_action_shortcut),
                false,
            )
            .is_ok()
            {
                initial_shortcut.clone()
            } else if initial_shortcut != DEFAULT_SHORTCUT
                && register_shortcuts(
                    handle,
                    DEFAULT_SHORTCUT,
                    Some(DEFAULT_ACTION_SHORTCUT),
                    false,
                )
                .is_ok()
            {
                DEFAULT_SHORTCUT.to_string()
            } else {
                initial_shortcut.clone()
            };

            tray::setup_tray(handle, &active_shortcut)?;
            clipboard_ring::spawn_clipboard_watcher(handle.clone());

            if let Some(main_win) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = main_win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }

                window::show_askii(handle, needs_setup_on_start);

                let app_handle_for_events = handle.clone();
                main_win.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        window::hide_askii(&app_handle_for_events);
                    }
                    WindowEvent::Focused(false) => {
                        let st = app_handle_for_events.state::<AppState>();
                        let keep_open = st.is_pinned.load(Ordering::Relaxed)
                            || st.in_setup.load(Ordering::Relaxed);
                        if !keep_open {
                            let h = app_handle_for_events.clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                                if let Some(w) = h.get_webview_window("main") {
                                    let still_unfocused = !w.is_focused().unwrap_or(false);
                                    let st_now = h.state::<AppState>();
                                    let keep_now = st_now.is_pinned.load(Ordering::Relaxed)
                                        || st_now.in_setup.load(Ordering::Relaxed);
                                    if still_unfocused && !keep_now {
                                        window::hide_askii(&h);
                                    }
                                }
                            });
                        }
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ASKII");
}
