use crate::agent::tools::ToolExecutionOutput;
use crate::context;
use crate::llm::{ImageAttachment, ToolDefinition};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenCoordContext {
    pub screen_x: i32,
    pub screen_y: i32,
    pub screen_width: i32,
    pub screen_height: i32,
    pub image_width: u32,
    pub image_height: u32,
}

#[derive(Default)]
pub struct ScreenControlState {
    pub last_capture: Mutex<Option<ScreenCoordContext>>,
}

impl ScreenControlState {
    pub fn record_capture(&self, ctx: ScreenCoordContext) {
        *self.last_capture.lock().unwrap() = Some(ctx);
    }

    pub fn last_capture(&self) -> Option<ScreenCoordContext> {
        *self.last_capture.lock().unwrap()
    }
}

pub fn map_coords_to_physical(
    x: i32,
    y: i32,
    coord_space: &str,
    ctx: Option<ScreenCoordContext>,
) -> (i32, i32) {
    if coord_space.eq_ignore_ascii_case("screen") {
        return (x, y);
    }
    let Some(c) = ctx else {
        return (x, y);
    };
    if c.image_width == 0 || c.image_height == 0 {
        return (x, y);
    }
    let px = c.screen_x
        + ((x as f64) * (c.screen_width as f64) / (c.image_width as f64)).round() as i32;
    let py = c.screen_y
        + ((y as f64) * (c.screen_height as f64) / (c.image_height as f64)).round() as i32;
    (px, py)
}

pub fn screen_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "screen_capture".to_string(),
            description: "Capture a screenshot of the Windows desktop (or active window) so you can visually inspect the screen and read coordinates before clicking or typing.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["full", "active_window"],
                        "description": "Capture the full primary display (default) or only the active target window"
                    }
                }
            }),
        },
        ToolDefinition {
            name: "screen_mouse_move".to_string(),
            description: "Move the Windows mouse cursor to (x, y). Coordinates default to the latest screen_capture image dimensions and are automatically scaled to physical screen pixels.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "integer", "description": "Horizontal coordinate" },
                    "y": { "type": "integer", "description": "Vertical coordinate" },
                    "coordSpace": {
                        "type": "string",
                        "enum": ["image", "screen"],
                        "description": "Coordinate space: 'image' (default, matches last screen_capture) or 'screen' (raw physical pixels)"
                    }
                },
                "required": ["x", "y"]
            }),
        },
        ToolDefinition {
            name: "screen_mouse_click".to_string(),
            description: "Click the Windows mouse button at (x, y) (or at the current cursor position if x/y are omitted). Supports single, double, or triple click with left, right, or middle button.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "x": { "type": "integer", "description": "Optional horizontal coordinate" },
                    "y": { "type": "integer", "description": "Optional vertical coordinate" },
                    "button": {
                        "type": "string",
                        "enum": ["left", "right", "middle"],
                        "description": "Mouse button (default 'left')"
                    },
                    "clicks": {
                        "type": "integer",
                        "description": "Number of clicks (1 = single, 2 = double, 3 = triple; default 1)"
                    },
                    "coordSpace": {
                        "type": "string",
                        "enum": ["image", "screen"],
                        "description": "Coordinate space: 'image' (default) or 'screen'"
                    }
                }
            }),
        },
        ToolDefinition {
            name: "screen_mouse_drag".to_string(),
            description: "Click and drag the mouse smoothly from (fromX, fromY) to (toX, toY).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "fromX": { "type": "integer", "description": "Start X coordinate" },
                    "fromY": { "type": "integer", "description": "Start Y coordinate" },
                    "toX": { "type": "integer", "description": "End X coordinate" },
                    "toY": { "type": "integer", "description": "End Y coordinate" },
                    "button": {
                        "type": "string",
                        "enum": ["left", "right"],
                        "description": "Mouse button to hold while dragging (default 'left')"
                    },
                    "coordSpace": {
                        "type": "string",
                        "enum": ["image", "screen"],
                        "description": "Coordinate space: 'image' (default) or 'screen'"
                    }
                },
                "required": ["fromX", "fromY", "toX", "toY"]
            }),
        },
        ToolDefinition {
            name: "screen_mouse_scroll".to_string(),
            description: "Scroll the mouse wheel at (x, y) or at the current cursor position. Positive deltaY scrolls UP; negative deltaY scrolls DOWN.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "deltaY": { "type": "integer", "description": "Vertical wheel clicks (+ up, - down, e.g. -5 to scroll down)" },
                    "deltaX": { "type": "integer", "description": "Optional horizontal wheel clicks (+ right, - left)" },
                    "x": { "type": "integer", "description": "Optional X coordinate to move cursor before scrolling" },
                    "y": { "type": "integer", "description": "Optional Y coordinate to move cursor before scrolling" },
                    "coordSpace": {
                        "type": "string",
                        "enum": ["image", "screen"],
                        "description": "Coordinate space: 'image' (default) or 'screen'"
                    }
                },
                "required": ["deltaY"]
            }),
        },
        ToolDefinition {
            name: "screen_keyboard_type".to_string(),
            description: "Type arbitrary Unicode text into the currently focused Windows application using native keyboard input.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Exact text to type" },
                    "pressEnter": { "type": "boolean", "description": "Press Enter after typing (default false)" }
                },
                "required": ["text"]
            }),
        },
        ToolDefinition {
            name: "screen_keyboard_hotkey".to_string(),
            description: "Press a key or keyboard shortcut chord on Windows (e.g. ['ctrl', 'c'], ['alt', 'tab'], ['win', 'r'], ['enter'], ['ctrl', 'shift', 'esc']).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Ordered key names to press together (modifiers first, e.g. ['ctrl', 'l'])"
                    }
                },
                "required": ["keys"]
            }),
        },
        ToolDefinition {
            name: "screen_wait".to_string(),
            description: "Wait for a short duration in milliseconds (100..10000) for windows or UI changes to settle before capturing the screen again.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ms": { "type": "integer", "description": "Milliseconds to wait (default 500, max 10000)" }
                }
            }),
        },
    ]
}

pub fn is_screen_tool(name: &str) -> bool {
    name.starts_with("screen_")
}

pub fn screen_tool_tier(name: &str) -> u8 {
    match name {
        "screen_capture" | "screen_wait" => 0,
        _ => 2,
    }
}

pub fn summarize_screen_tool(name: &str, args: &Value) -> String {
    match name {
        "screen_capture" => {
            let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("full");
            format!("Capture screen ({mode})")
        }
        "screen_mouse_move" => {
            let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
            let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
            format!("Move mouse → ({x}, {y})")
        }
        "screen_mouse_click" => {
            let btn = args.get("button").and_then(|v| v.as_str()).unwrap_or("left");
            let clicks = args.get("clicks").and_then(|v| v.as_i64()).unwrap_or(1);
            match (
                args.get("x").and_then(|v| v.as_i64()),
                args.get("y").and_then(|v| v.as_i64()),
            ) {
                (Some(x), Some(y)) => format!("Mouse {btn} click ×{clicks} at ({x}, {y})"),
                _ => format!("Mouse {btn} click ×{clicks}"),
            }
        }
        "screen_mouse_drag" => {
            let fx = args.get("fromX").and_then(|v| v.as_i64()).unwrap_or(0);
            let fy = args.get("fromY").and_then(|v| v.as_i64()).unwrap_or(0);
            let tx = args.get("toX").and_then(|v| v.as_i64()).unwrap_or(0);
            let ty = args.get("toY").and_then(|v| v.as_i64()).unwrap_or(0);
            format!("Drag mouse ({fx},{fy}) → ({tx},{ty})")
        }
        "screen_mouse_scroll" => {
            let dy = args.get("deltaY").and_then(|v| v.as_i64()).unwrap_or(0);
            format!("Scroll mouse ({dy})")
        }
        "screen_keyboard_type" => {
            let txt = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let preview: String = txt.chars().take(48).collect();
            let ellipsis = if txt.chars().count() > 48 { "…" } else { "" };
            format!("Type \"{preview}{ellipsis}\"")
        }
        "screen_keyboard_hotkey" => {
            let keys: Vec<String> = args
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|k| k.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            format!("Press hotkey {}", keys.join("+"))
        }
        "screen_wait" => {
            let ms = args.get("ms").and_then(|v| v.as_u64()).unwrap_or(500);
            format!("Wait {ms}ms")
        }
        _ => format!("Screen action {name}"),
    }
}

pub async fn execute_screen_tool(
    app: &AppHandle,
    screen_state: &ScreenControlState,
    name: &str,
    args: &Value,
    overlay_hidden_for_screen: &mut bool,
) -> ToolExecutionOutput {
    if name == "screen_wait" {
        let ms = args
            .get("ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(500)
            .clamp(100, 10_000);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        return ToolExecutionOutput::ok(format!("Waited {ms}ms."));
    }

    // Hide ASKII overlay before any visual capture or mouse/keyboard injection so ASKII never blocks clicks or steals keystrokes.
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            crate::window::hide_askii(app);
            *overlay_hidden_for_screen = true;
            let delay = if name == "screen_capture" { 140 } else { 85 };
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    match name {
        "screen_capture" => {
            let mode = args
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("full")
                .to_string();
            let target_hwnd = app
                .try_state::<crate::AppState>()
                .and_then(|st| st.previous_window.lock().unwrap().as_ref().map(|w| w.hwnd));

            let res = tokio::task::spawn_blocking(move || {
                let capture = context::capture_screen_png(&mode, target_hwnd)?;
                let (sx, sy, sw, sh) = win_impl::query_capture_bounds(&mode, target_hwnd);
                let cursor = win_impl::get_cursor_pos();
                let fg = context::capture_foreground_window();
                Ok::<_, String>((capture, sx, sy, sw, sh, cursor, fg))
            })
            .await;

            match res {
                Ok(Ok((cap, sx, sy, sw, sh, cursor, fg))) => {
                    screen_state.record_capture(ScreenCoordContext {
                        screen_x: sx,
                        screen_y: sy,
                        screen_width: sw,
                        screen_height: sh,
                        image_width: cap.width,
                        image_height: cap.height,
                    });
                    let cursor_str = cursor
                        .map(|(cx, cy)| format!("({cx}, {cy})"))
                        .unwrap_or_else(|| "unknown".to_string());
                    let fg_str = fg
                        .map(|w| format!("{} — \"{}\"", w.process_name, w.title))
                        .unwrap_or_else(|| "none".to_string());
                    let text = format!(
                        "Captured {}. imageSize={}x{}, physicalScreen={}x{} (origin {},{}). Cursor at physical {}. Foreground window: {}. Pass mouse coordinates in imageSize space (x: 0..{}, y: 0..{}).",
                        cap.label,
                        cap.width,
                        cap.height,
                        sw,
                        sh,
                        sx,
                        sy,
                        cursor_str,
                        fg_str,
                        cap.width,
                        cap.height
                    );
                    ToolExecutionOutput {
                        success: true,
                        output: text,
                        backup_id: None,
                        images: vec![ImageAttachment {
                            mime_type: "image/png".to_string(),
                            data_base64: cap.base64_png,
                        }],
                    }
                }
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Screen capture task failed: {e}")),
            }
        }
        "screen_mouse_move" => {
            let Some(x) = args.get("x").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing integer `x`.");
            };
            let Some(y) = args.get("y").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing integer `y`.");
            };
            let space = args
                .get("coordSpace")
                .and_then(|v| v.as_str())
                .unwrap_or("image");
            let (px, py) = map_coords_to_physical(x, y, space, screen_state.last_capture());
            match tokio::task::spawn_blocking(move || win_impl::mouse_move(px, py)).await {
                Ok(Ok(())) => {
                    ToolExecutionOutput::ok(format!("Moved mouse to ({x}, {y}) → physical ({px}, {py})."))
                }
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Mouse move task failed: {e}")),
            }
        }
        "screen_mouse_click" => {
            let button = args
                .get("button")
                .and_then(|v| v.as_str())
                .unwrap_or("left")
                .to_string();
            let clicks = args
                .get("clicks")
                .and_then(|v| v.as_u64())
                .unwrap_or(1)
                .clamp(1, 3) as u32;
            let space = args
                .get("coordSpace")
                .and_then(|v| v.as_str())
                .unwrap_or("image");
            let target = match (
                args.get("x").and_then(|v| v.as_i64()),
                args.get("y").and_then(|v| v.as_i64()),
            ) {
                (Some(x), Some(y)) => {
                    Some(map_coords_to_physical(x as i32, y as i32, space, screen_state.last_capture()))
                }
                _ => None,
            };
            let btn_clone = button.clone();
            match tokio::task::spawn_blocking(move || win_impl::mouse_click(target, &btn_clone, clicks))
                .await
            {
                Ok(Ok(())) => {
                    let loc = target
                        .map(|(px, py)| format!(" at physical ({px}, {py})"))
                        .unwrap_or_default();
                    ToolExecutionOutput::ok(format!("Performed {button} click ×{clicks}{loc}."))
                }
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Mouse click task failed: {e}")),
            }
        }
        "screen_mouse_drag" => {
            let Some(fx) = args.get("fromX").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing `fromX`.");
            };
            let Some(fy) = args.get("fromY").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing `fromY`.");
            };
            let Some(tx) = args.get("toX").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing `toX`.");
            };
            let Some(ty) = args.get("toY").and_then(|v| v.as_i64()).map(|v| v as i32) else {
                return ToolExecutionOutput::err("Missing `toY`.");
            };
            let button = args
                .get("button")
                .and_then(|v| v.as_str())
                .unwrap_or("left")
                .to_string();
            let space = args
                .get("coordSpace")
                .and_then(|v| v.as_str())
                .unwrap_or("image");
            let ctx = screen_state.last_capture();
            let (p_fx, p_fy) = map_coords_to_physical(fx, fy, space, ctx);
            let (p_tx, p_ty) = map_coords_to_physical(tx, ty, space, ctx);
            let btn_clone = button.clone();
            match tokio::task::spawn_blocking(move || {
                win_impl::mouse_drag(p_fx, p_fy, p_tx, p_ty, &btn_clone)
            })
            .await
            {
                Ok(Ok(())) => ToolExecutionOutput::ok(format!(
                    "Dragged {button} mouse from physical ({p_fx}, {p_fy}) to ({p_tx}, {p_ty})."
                )),
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Mouse drag task failed: {e}")),
            }
        }
        "screen_mouse_scroll" => {
            let delta_y = args.get("deltaY").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let delta_x = args.get("deltaX").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let space = args
                .get("coordSpace")
                .and_then(|v| v.as_str())
                .unwrap_or("image");
            let target = match (
                args.get("x").and_then(|v| v.as_i64()),
                args.get("y").and_then(|v| v.as_i64()),
            ) {
                (Some(x), Some(y)) => {
                    Some(map_coords_to_physical(x as i32, y as i32, space, screen_state.last_capture()))
                }
                _ => None,
            };
            match tokio::task::spawn_blocking(move || {
                win_impl::mouse_scroll(target, delta_x, delta_y)
            })
            .await
            {
                Ok(Ok(())) => {
                    ToolExecutionOutput::ok(format!("Scrolled mouse (deltaX={delta_x}, deltaY={delta_y})."))
                }
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Mouse scroll task failed: {e}")),
            }
        }
        "screen_keyboard_type" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let press_enter = args
                .get("pressEnter")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let char_count = text.chars().count();
            match tokio::task::spawn_blocking(move || win_impl::keyboard_type(&text, press_enter))
                .await
            {
                Ok(Ok(())) => ToolExecutionOutput::ok(format!(
                    "Typed {char_count} characters{}.",
                    if press_enter { " + Enter" } else { "" }
                )),
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Keyboard type task failed: {e}")),
            }
        }
        "screen_keyboard_hotkey" => {
            let keys: Vec<String> = args
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|k| k.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                return ToolExecutionOutput::err("`keys` array cannot be empty.");
            }
            let joined = keys.join("+");
            match tokio::task::spawn_blocking(move || win_impl::keyboard_hotkey(&keys)).await {
                Ok(Ok(())) => ToolExecutionOutput::ok(format!("Pressed hotkey {joined}.")),
                Ok(Err(e)) => ToolExecutionOutput::err(e),
                Err(e) => ToolExecutionOutput::err(format!("Hotkey task failed: {e}")),
            }
        }
        _ => ToolExecutionOutput::err(format!("Unknown screen tool \"{name}\"")),
    }
}

pub fn parse_virtual_key_code(key: &str) -> Option<u16> {
    let norm = key.trim().to_ascii_lowercase();
    match norm.as_str() {
        "ctrl" | "control" | "lctrl" => Some(0x11), // VK_CONTROL
        "alt" | "menu" | "lalt" => Some(0x12),      // VK_MENU
        "shift" | "lshift" => Some(0x10),           // VK_SHIFT
        "win" | "lwin" | "meta" | "super" | "cmd" => Some(0x5B), // VK_LWIN
        "enter" | "return" => Some(0x0D),           // VK_RETURN
        "tab" => Some(0x09),                        // VK_TAB
        "esc" | "escape" => Some(0x1B),             // VK_ESCAPE
        "space" | " " => Some(0x20),                // VK_SPACE
        "backspace" | "back" => Some(0x08),         // VK_BACK
        "delete" | "del" => Some(0x2E),             // VK_DELETE
        "insert" | "ins" => Some(0x2D),             // VK_INSERT
        "home" => Some(0x24),                       // VK_HOME
        "end" => Some(0x23),                        // VK_END
        "pageup" | "pgup" => Some(0x21),            // VK_PRIOR
        "pagedown" | "pgdn" => Some(0x22),          // VK_NEXT
        "left" | "arrowleft" => Some(0x25),         // VK_LEFT
        "up" | "arrowup" => Some(0x26),             // VK_UP
        "right" | "arrowright" => Some(0x27),       // VK_RIGHT
        "down" | "arrowdown" => Some(0x28),         // VK_DOWN
        "capslock" => Some(0x14),                   // VK_CAPITAL
        "printscreen" | "prtsc" => Some(0x2C),      // VK_SNAPSHOT
        "minus" | "-" => Some(0xBD),                // VK_OEM_MINUS
        "equal" | "equals" | "=" | "plus" => Some(0xBB), // VK_OEM_PLUS
        "[" => Some(0xDB),                          // VK_OEM_4
        "]" => Some(0xDD),                          // VK_OEM_6
        "\\" => Some(0xDC),                         // VK_OEM_5
        ";" => Some(0xBA),                          // VK_OEM_1
        "'" => Some(0xDE),                          // VK_OEM_7
        "," => Some(0xBC),                          // VK_OEM_COMMA
        "." => Some(0xBE),                          // VK_OEM_PERIOD
        "/" => Some(0xBF),                          // VK_OEM_2
        "`" => Some(0xC0),                          // VK_OEM_3
        _ => {
            if let Some(rest) = norm.strip_prefix('f') {
                if let Ok(n) = rest.parse::<u16>() {
                    if (1..=24).contains(&n) {
                        return Some(0x70 + (n - 1)); // VK_F1..VK_F24
                    }
                }
            }
            let mut chars = norm.chars();
            if let (Some(ch), None) = (chars.next(), chars.next()) {
                if ch.is_ascii_lowercase() {
                    return Some(0x41 + (ch as u16 - 'a' as u16));
                }
                if ch.is_ascii_digit() {
                    return Some(0x30 + (ch as u16 - '0' as u16));
                }
            }
            None
        }
    }
}

#[cfg(target_os = "windows")]
mod win_impl {
    use super::parse_virtual_key_code;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput, VIRTUAL_KEY, VK_RETURN, VK_TAB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMetrics, GetWindowRect, SM_CXSCREEN, SM_CYSCREEN, SetCursorPos,
    };

    pub fn query_capture_bounds(mode: &str, target_hwnd: Option<isize>) -> (i32, i32, i32, i32) {
        unsafe {
            if mode == "active_window" {
                if let Some(hwnd_raw) = target_hwnd {
                    let hwnd = HWND(hwnd_raw as *mut c_void);
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_ok() {
                        let w = rect.right - rect.left;
                        let h = rect.bottom - rect.top;
                        if w > 0 && h > 0 {
                            return (rect.left, rect.top, w, h);
                        }
                    }
                }
            }
            let w = GetSystemMetrics(SM_CXSCREEN).max(1);
            let h = GetSystemMetrics(SM_CYSCREEN).max(1);
            (0, 0, w, h)
        }
    }

    pub fn get_cursor_pos() -> Option<(i32, i32)> {
        unsafe {
            let mut pt = POINT::default();
            if GetCursorPos(&mut pt).is_ok() {
                Some((pt.x, pt.y))
            } else {
                None
            }
        }
    }

    pub fn mouse_move(x: i32, y: i32) -> Result<(), String> {
        unsafe {
            SetCursorPos(x, y).map_err(|e| format!("SetCursorPos({x}, {y}) failed: {e}"))?;
        }
        Ok(())
    }

    fn mouse_input(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub fn mouse_click(target: Option<(i32, i32)>, button: &str, clicks: u32) -> Result<(), String> {
        if let Some((x, y)) = target {
            mouse_move(x, y)?;
            std::thread::sleep(Duration::from_millis(25));
        }

        let (down_flag, up_flag) = match button {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };

        for idx in 0..clicks {
            let inputs = [mouse_input(down_flag, 0), mouse_input(up_flag, 0)];
            unsafe {
                let sent = SendInput(&inputs, size_of::<INPUT>() as i32);
                if sent == 0 {
                    return Err("Windows SendInput failed for mouse click.".to_string());
                }
            }
            if idx + 1 < clicks {
                std::thread::sleep(Duration::from_millis(45));
            }
        }
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }

    pub fn mouse_drag(
        from_x: i32,
        from_y: i32,
        to_x: i32,
        to_y: i32,
        button: &str,
    ) -> Result<(), String> {
        let (down_flag, up_flag) = if button == "right" {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };

        mouse_move(from_x, from_y)?;
        std::thread::sleep(Duration::from_millis(30));

        unsafe {
            let down = [mouse_input(down_flag, 0)];
            let _ = SendInput(&down, size_of::<INPUT>() as i32);
        }

        let steps = 12;
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            let cx = from_x + ((to_x - from_x) as f64 * t).round() as i32;
            let cy = from_y + ((to_y - from_y) as f64 * t).round() as i32;
            let _ = mouse_move(cx, cy);
            std::thread::sleep(Duration::from_millis(14));
        }

        unsafe {
            let up = [mouse_input(up_flag, 0)];
            let _ = SendInput(&up, size_of::<INPUT>() as i32);
        }
        std::thread::sleep(Duration::from_millis(50));
        Ok(())
    }

    pub fn mouse_scroll(
        target: Option<(i32, i32)>,
        delta_x: i32,
        delta_y: i32,
    ) -> Result<(), String> {
        if let Some((x, y)) = target {
            mouse_move(x, y)?;
            std::thread::sleep(Duration::from_millis(20));
        }

        let mut inputs = Vec::new();
        if delta_y != 0 {
            let amount = (delta_y.saturating_mul(120)) as u32;
            inputs.push(mouse_input(MOUSEEVENTF_WHEEL, amount));
        }
        if delta_x != 0 {
            let amount = (delta_x.saturating_mul(120)) as u32;
            inputs.push(mouse_input(MOUSEEVENTF_HWHEEL, amount));
        }
        if !inputs.is_empty() {
            unsafe {
                let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
            }
        }
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }

    fn vk_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: if up {
                        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                    } else {
                        KEYEVENTF_UNICODE
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub fn keyboard_type(text: &str, press_enter: bool) -> Result<(), String> {
        let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 2 + 2);
        for ch in text.chars() {
            match ch {
                '\r' => continue,
                '\n' => {
                    inputs.push(vk_input(VK_RETURN, false));
                    inputs.push(vk_input(VK_RETURN, true));
                }
                '\t' => {
                    inputs.push(vk_input(VK_TAB, false));
                    inputs.push(vk_input(VK_TAB, true));
                }
                c => {
                    let mut buf = [0u16; 2];
                    for unit in c.encode_utf16(&mut buf).iter().copied() {
                        inputs.push(unicode_input(unit, false));
                        inputs.push(unicode_input(unit, true));
                    }
                }
            }
        }
        if press_enter {
            inputs.push(vk_input(VK_RETURN, false));
            inputs.push(vk_input(VK_RETURN, true));
        }

        for chunk in inputs.chunks(64) {
            unsafe {
                let _ = SendInput(chunk, size_of::<INPUT>() as i32);
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        std::thread::sleep(Duration::from_millis(50));
        Ok(())
    }

    pub fn keyboard_hotkey(keys: &[String]) -> Result<(), String> {
        let mut vks = Vec::with_capacity(keys.len());
        for k in keys {
            let Some(code) = parse_virtual_key_code(k) else {
                return Err(format!("Unsupported key name \"{k}\" in hotkey."));
            };
            vks.push(VIRTUAL_KEY(code));
        }

        let mut inputs = Vec::with_capacity(vks.len() * 2);
        for &vk in &vks {
            inputs.push(vk_input(vk, false));
        }
        for &vk in vks.iter().rev() {
            inputs.push(vk_input(vk, true));
        }

        unsafe {
            let sent = SendInput(&inputs, size_of::<INPUT>() as i32);
            if sent == 0 {
                return Err("Windows SendInput failed for hotkey.".to_string());
            }
        }
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod win_impl {
    pub fn query_capture_bounds(_mode: &str, _target_hwnd: Option<isize>) -> (i32, i32, i32, i32) {
        (0, 0, 1920, 1080)
    }
    pub fn get_cursor_pos() -> Option<(i32, i32)> {
        None
    }
    pub fn mouse_move(_x: i32, _y: i32) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
    pub fn mouse_click(_target: Option<(i32, i32)>, _button: &str, _clicks: u32) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
    pub fn mouse_drag(
        _from_x: i32,
        _from_y: i32,
        _to_x: i32,
        _to_y: i32,
        _button: &str,
    ) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
    pub fn mouse_scroll(_target: Option<(i32, i32)>, _delta_x: i32, _delta_y: i32) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
    pub fn keyboard_type(_text: &str, _press_enter: bool) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
    pub fn keyboard_hotkey(_keys: &[String]) -> Result<(), String> {
        Err("Screen control is Windows-only.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_image_space_coordinates_to_physical_screen() {
        let ctx = ScreenCoordContext {
            screen_x: 0,
            screen_y: 0,
            screen_width: 1920,
            screen_height: 1080,
            image_width: 1600,
            image_height: 900,
        };
        assert_eq!(map_coords_to_physical(800, 450, "image", Some(ctx)), (960, 540));
        assert_eq!(map_coords_to_physical(800, 450, "screen", Some(ctx)), (800, 450));
    }

    #[test]
    fn parses_common_virtual_keys() {
        assert_eq!(parse_virtual_key_code("ctrl"), Some(0x11));
        assert_eq!(parse_virtual_key_code("Enter"), Some(0x0D));
        assert_eq!(parse_virtual_key_code("a"), Some(0x41));
        assert_eq!(parse_virtual_key_code("9"), Some(0x39));
        assert_eq!(parse_virtual_key_code("F5"), Some(0x74));
        assert_eq!(parse_virtual_key_code("not_a_real_key"), None);
    }
}
