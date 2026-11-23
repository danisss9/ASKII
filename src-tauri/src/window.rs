use crate::AppState;
use crate::context::{PreviousWindowInfo, capture_foreground_window};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const WINDOW_LOGICAL_WIDTH: f64 = 760.0;
pub const WINDOW_MIN_HEIGHT: f64 = 124.0;
pub const WINDOW_MAX_HEIGHT: f64 = 720.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowShownPayload {
    pub open_setup: bool,
    pub previous_window: Option<PreviousWindowInfo>,
    pub selection_text: Option<String>,
}

pub fn position_on_active_monitor(window: &WebviewWindow) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| {
            window.available_monitors().ok().and_then(|monitors| {
                monitors.into_iter().find(|m| {
                    let pos = m.position();
                    let size = m.size();
                    cursor.x >= pos.x as f64
                        && cursor.x < (pos.x + size.width as i32) as f64
                        && cursor.y >= pos.y as f64
                        && cursor.y < (pos.y + size.height as i32) as f64
                })
            })
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };

    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let scale = monitor.scale_factor();
    let win_width = window
        .outer_size()
        .map(|s| s.width as i32)
        .unwrap_or((WINDOW_LOGICAL_WIDTH * scale) as i32);

    let x = mon_pos.x + ((mon_size.width as i32 - win_width) / 2);
    let y = mon_pos.y + ((mon_size.height as f64 * 0.14) as i32);

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub fn set_window_height(app: &AppHandle, logical_height: f64) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let clamped = logical_height.clamp(WINDOW_MIN_HEIGHT, WINDOW_MAX_HEIGHT);
    let _ = window.set_size(Size::Logical(LogicalSize::new(WINDOW_LOGICAL_WIDTH, clamped)));
}

pub fn show_askii(app: &AppHandle, open_setup: bool) {
    let prev = capture_foreground_window();
    show_askii_with_context(app, open_setup, prev, None);
}

pub fn show_askii_with_context(
    app: &AppHandle,
    open_setup: bool,
    previous_window: Option<PreviousWindowInfo>,
    selection_text: Option<String>,
) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let effective_prev = {
        let state = app.state::<AppState>();
        let mut guard = state.previous_window.lock().unwrap();
        if let Some(p) = previous_window {
            *guard = Some(p.clone());
            Some(p)
        } else {
            guard.clone()
        }
    };

    position_on_active_monitor(&window);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit(
        "askii://shown",
        WindowShownPayload {
            open_setup,
            previous_window: effective_prev,
            selection_text,
        },
    );
}

pub fn hide_askii(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.hide();
    let _ = app.emit("askii://hidden", ());
}

pub fn toggle_askii(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        hide_askii(app);
    } else {
        let needs_setup = {
            let state = app.state::<AppState>();
            let cfg = state.config.lock().unwrap();
            !crate::config::is_config_ready(&cfg)
        };
        show_askii(app, needs_setup);
    }
}

pub fn open_sticky_slip_window(app: &AppHandle, slip_id: &str) -> Result<(), String> {
    let clean_id: String = slip_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let label = format!("sticky-{clean_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?sticky={clean_id}").into());
    let win = WebviewWindowBuilder::new(app, &label, url)
        .title(format!("ASKII Slip #{clean_id}"))
        .inner_size(430.0, 500.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .center()
        .build()
        .map_err(|e| format!("Failed to open sticky slip window: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    }
    Ok(())
}
