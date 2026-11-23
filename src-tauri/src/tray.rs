use crate::AppState;
use crate::config::{AgentMode, save_config};
use crate::window;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

pub const TRAY_ID: &str = "askii-tray";

fn build_tray_menu(app: &AppHandle, shortcut: &str, autostart: bool, auto_do: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle_item = MenuItem::with_id(
        app,
        "toggle",
        format!("Show / Hide ASKII ({shortcut})"),
        true,
        None::<&str>,
    )?;
    let autodo_item = CheckMenuItem::with_id(
        app,
        "autodo",
        "Auto Do Mode (Autonomous OS Actions)",
        true,
        auto_do,
        None::<&str>,
    )?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start ASKII with Windows",
        true,
        autostart,
        None::<&str>,
    )?;
    let setup_item = MenuItem::with_id(app, "setup", "Setup & Settings…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit ASKII", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &toggle_item,
            &autodo_item,
            &autostart_item,
            &setup_item,
            &sep,
            &quit_item,
        ],
    )
}

pub fn setup_tray(app: &AppHandle, shortcut: &str) -> tauri::Result<()> {
    let (autostart, auto_do) = {
        let st = app.state::<AppState>();
        let cfg = st.config.lock().unwrap();
        (cfg.start_with_windows, cfg.agent.mode == AgentMode::AutoDo)
    };
    let menu = build_tray_menu(app, shortcut, autostart, auto_do)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(format!("ASKII (⌐■_■) — Press {shortcut}"))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => window::toggle_askii(app),
            "setup" => window::show_askii(app, true),
            "autodo" => {
                let (sc, autostart, next_autodo) = {
                    let st = app.state::<AppState>();
                    let mut cfg = st.config.lock().unwrap();
                    cfg.agent.mode = match cfg.agent.mode {
                        AgentMode::Confirm => AgentMode::AutoDo,
                        AgentMode::AutoDo => AgentMode::Confirm,
                    };
                    let _ = save_config(&cfg);
                    (
                        cfg.shortcut.clone(),
                        cfg.start_with_windows,
                        cfg.agent.mode == AgentMode::AutoDo,
                    )
                };
                refresh_tray(app, &sc, autostart, next_autodo);
            }
            "autostart" => {
                let (sc, next_autostart, auto_do) = {
                    let st = app.state::<AppState>();
                    let mut cfg = st.config.lock().unwrap();
                    cfg.start_with_windows = !cfg.start_with_windows;
                    let target = cfg.start_with_windows;
                    if target {
                        let _ = app.autolaunch().enable();
                    } else {
                        let _ = app.autolaunch().disable();
                    }
                    let _ = save_config(&cfg);
                    (
                        cfg.shortcut.clone(),
                        cfg.start_with_windows,
                        cfg.agent.mode == AgentMode::AutoDo,
                    )
                };
                refresh_tray(app, &sc, next_autostart, auto_do);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle_askii(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub fn refresh_tray(app: &AppHandle, shortcut: &str, autostart: bool, auto_do: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("ASKII (⌐■_■) — Press {shortcut}")));
        if let Ok(menu) = build_tray_menu(app, shortcut, autostart, auto_do) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn update_tray_shortcut(app: &AppHandle, shortcut: &str) {
    let (autostart, auto_do) = {
        let st = app.state::<AppState>();
        let cfg = st.config.lock().unwrap();
        (cfg.start_with_windows, cfg.agent.mode == AgentMode::AutoDo)
    };
    refresh_tray(app, shortcut, autostart, auto_do);
}
