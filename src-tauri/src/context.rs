use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::{ImageFormat, RgbaImage, imageops::FilterType};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_VISION_DIMENSION: u32 = 1600;
const MAX_TEXT_FILE_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousWindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub process_name: String,
    pub exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContextPayload {
    pub kind: String, // "text" | "image" | "empty"
    pub text: Option<String>,
    pub base64_png: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureResult {
    pub base64_png: String,
    pub width: u32,
    pub height: u32,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachmentResult {
    pub kind: String, // "text" | "image"
    pub name: String,
    pub path: String,
    pub text: Option<String>,
    pub truncated: bool,
    pub base64_png: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn encode_rgba_to_png_base64(rgba: RgbaImage) -> Result<(String, u32, u32), String> {
    let (w, h) = rgba.dimensions();
    let img = if w > MAX_VISION_DIMENSION || h > MAX_VISION_DIMENSION {
        let dyn_img = image::DynamicImage::ImageRgba8(rgba);
        dyn_img
            .resize(MAX_VISION_DIMENSION, MAX_VISION_DIMENSION, FilterType::Triangle)
            .to_rgba8()
    } else {
        rgba
    };
    let (final_w, final_h) = img.dimensions();
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    Ok((BASE64.encode(bytes.into_inner()), final_w, final_h))
}

pub fn read_clipboard_context() -> Result<ClipboardContextPayload, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;

    if let Ok(text) = clipboard.get_text() {
        if !text.trim().is_empty() {
            return Ok(ClipboardContextPayload {
                kind: "text".to_string(),
                text: Some(text),
                base64_png: None,
                width: None,
                height: None,
            });
        }
    }

    if let Ok(img) = clipboard.get_image() {
        let rgba = RgbaImage::from_raw(
            img.width as u32,
            img.height as u32,
            img.bytes.into_owned(),
        )
        .ok_or_else(|| "Invalid clipboard image buffer".to_string())?;
        let (b64, width, height) = encode_rgba_to_png_base64(rgba)?;
        return Ok(ClipboardContextPayload {
            kind: "image".to_string(),
            text: None,
            base64_png: Some(b64),
            width: Some(width),
            height: Some(height),
        });
    }

    Ok(ClipboardContextPayload {
        kind: "empty".to_string(),
        text: None,
        base64_png: None,
        width: None,
        height: None,
    })
}

pub fn read_file_attachment(path_str: &str) -> Result<FileAttachmentResult, String> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(format!("File not found: {path_str}"));
    }
    if path.is_dir() {
        return Err("Folders cannot be attached directly yet — select a file.".to_string());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path_str)
        .to_string();

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        let dyn_img = image::open(path).map_err(|e| format!("Failed to read image \"{name}\": {e}"))?;
        let (b64, width, height) = encode_rgba_to_png_base64(dyn_img.to_rgba8())?;
        return Ok(FileAttachmentResult {
            kind: "image".to_string(),
            name,
            path: path_str.to_string(),
            text: None,
            truncated: false,
            base64_png: Some(b64),
            width: Some(width),
            height: Some(height),
        });
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read \"{name}\": {e}"))?;
    let truncated = bytes.len() > MAX_TEXT_FILE_BYTES;
    let slice = if truncated {
        &bytes[..MAX_TEXT_FILE_BYTES]
    } else {
        &bytes[..]
    };
    let text = String::from_utf8_lossy(slice).to_string();

    Ok(FileAttachmentResult {
        kind: "text".to_string(),
        name,
        path: path_str.to_string(),
        text: Some(text),
        truncated,
        base64_png: None,
        width: None,
        height: None,
    })
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH, RECT};
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SRCCOPY, SelectObject,
    };
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
        VK_C, VK_CONTROL, VK_LMENU, VK_LSHIFT, VK_MENU, VK_RMENU, VK_RSHIFT, VK_SHIFT, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, SM_CXSCREEN, SM_CYSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };
    use windows::core::PWSTR;

    pub fn capture_foreground_window() -> Option<PreviousWindowInfo> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return None;
            }

            let title_len = GetWindowTextLengthW(hwnd);
            let title = if title_len > 0 {
                let mut buf = vec![0u16; (title_len + 1) as usize];
                let copied = GetWindowTextW(hwnd, &mut buf);
                String::from_utf16_lossy(&buf[..copied as usize])
                    .trim()
                    .to_string()
            } else {
                String::new()
            };

            let exe_path = query_process_exe_path(pid);
            let process_name = exe_path
                .as_deref()
                .and_then(|p| Path::new(p).file_stem().and_then(|s| s.to_str()))
                .map(String::from)
                .unwrap_or_else(|| format!("pid:{pid}"));

            if title.is_empty() && process_name.starts_with("pid:") {
                return None;
            }

            Some(PreviousWindowInfo {
                hwnd: hwnd.0 as isize,
                title: if title.is_empty() {
                    process_name.clone()
                } else {
                    title
                },
                process_name,
                exe_path,
            })
        }
    }

    unsafe fn query_process_exe_path(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if ok && size > 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    }

    fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
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

    unsafe fn send_ctrl_combo(key: VIRTUAL_KEY, release_hotkeys_first: bool) {
        let mut inputs = Vec::with_capacity(12);
        if release_hotkeys_first {
            // Release modifiers that may still be physically held from Alt+Shift+Space
            for vk in [VK_MENU, VK_LMENU, VK_RMENU, VK_SHIFT, VK_LSHIFT, VK_RSHIFT] {
                inputs.push(key_input(vk, true));
            }
        }
        inputs.push(key_input(VK_CONTROL, false));
        inputs.push(key_input(key, false));
        inputs.push(key_input(key, true));
        inputs.push(key_input(VK_CONTROL, true));
        let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
    }

    pub fn capture_selection_text() -> Result<Option<String>, String> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
        let previous_text = clipboard.get_text().ok();
        let seq_before = unsafe { GetClipboardSequenceNumber() };

        unsafe {
            send_ctrl_combo(VK_C, true);
        }

        let deadline = Instant::now() + Duration::from_millis(240);
        let mut changed = false;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            let seq_now = unsafe { GetClipboardSequenceNumber() };
            if seq_now != seq_before {
                changed = true;
                break;
            }
        }

        if !changed {
            return Ok(None);
        }

        let captured = clipboard.get_text().ok().and_then(|t| {
            if t.trim().is_empty() {
                None
            } else {
                Some(t)
            }
        });

        // Restore previous clipboard text so selection capture feels non-destructive.
        if let Some(prev) = previous_text {
            let _ = clipboard.set_text(prev);
        }

        Ok(captured)
    }

    pub fn insert_into_previous_window(hwnd_raw: isize, text: &str) -> Result<(), String> {
        if hwnd_raw == 0 {
            return Err("No previous target window is available to insert into.".to_string());
        }
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
        let previous_text = clipboard.get_text().ok();
        clipboard
            .set_text(text.to_string())
            .map_err(|e| format!("Failed to stage text on clipboard: {e}"))?;

        unsafe {
            let hwnd = HWND(hwnd_raw as *mut c_void);
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }

        std::thread::sleep(Duration::from_millis(95));
        unsafe {
            send_ctrl_combo(VK_V, false);
        }

        if let Some(prev) = previous_text {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(380));
                if let Ok(mut cb) = arboard::Clipboard::new() {
                    let _ = cb.set_text(prev);
                }
            });
        }

        Ok(())
    }

    pub fn capture_screen_png(
        mode: &str,
        target_hwnd: Option<isize>,
    ) -> Result<ScreenCaptureResult, String> {
        unsafe {
            let (x, y, w, h, label) = if mode == "active_window" {
                let hwnd_raw = target_hwnd.ok_or_else(|| {
                    "No active target window recorded. Focus a window before capturing.".to_string()
                })?;
                let hwnd = HWND(hwnd_raw as *mut c_void);
                let mut rect = RECT::default();
                GetWindowRect(hwnd, &mut rect)
                    .map_err(|e| format!("Could not read target window bounds: {e}"))?;
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width <= 0 || height <= 0 {
                    return Err("Target window is minimized or has zero size.".to_string());
                }
                (
                    rect.left,
                    rect.top,
                    width,
                    height,
                    format!("Window ({width}×{height})"),
                )
            } else {
                let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let px = GetSystemMetrics(SM_CXSCREEN);
                let py = GetSystemMetrics(SM_CYSCREEN);
                let _ = (vx, vy);
                if px <= 0 || py <= 0 {
                    return Err("Could not query primary display dimensions.".to_string());
                }
                (0, 0, px, py, format!("Screen ({px}×{py})"))
            };

            let screen_dc = GetDC(HWND::default());
            if screen_dc.is_invalid() {
                return Err("Failed to acquire Windows screen DC.".to_string());
            }

            let mem_dc = CreateCompatibleDC(screen_dc);
            let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
            let old_obj = SelectObject(mem_dc, bitmap);

            let blt_res = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];
            let scanlines = if blt_res.is_ok() {
                GetDIBits(
                    mem_dc,
                    bitmap,
                    0,
                    h as u32,
                    Some(bgra.as_mut_ptr() as *mut c_void),
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            SelectObject(mem_dc, old_obj);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(HWND::default(), screen_dc);

            if blt_res.is_err() || scanlines == 0 {
                return Err("Windows screen capture failed.".to_string());
            }

            // Convert BGRA -> RGBA (force opaque alpha)
            for pixel in bgra.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                pixel[3] = 255;
            }

            let rgba = RgbaImage::from_raw(w as u32, h as u32, bgra)
                .ok_or_else(|| "Failed to build captured image buffer.".to_string())?;
            let (base64_png, final_w, final_h) = encode_rgba_to_png_base64(rgba)?;

            Ok(ScreenCaptureResult {
                base64_png,
                width: final_w,
                height: final_h,
                label,
            })
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    use super::*;
    pub fn capture_foreground_window() -> Option<PreviousWindowInfo> {
        None
    }
    pub fn capture_selection_text() -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn insert_into_previous_window(_hwnd_raw: isize, _text: &str) -> Result<(), String> {
        Err("Insert-back is Windows-only.".to_string())
    }
    pub fn capture_screen_png(
        _mode: &str,
        _target_hwnd: Option<isize>,
    ) -> Result<ScreenCaptureResult, String> {
        Err("Screen capture is Windows-only.".to_string())
    }
}

pub use win::{
    capture_foreground_window, capture_screen_png, capture_selection_text,
    insert_into_previous_window,
};

#[cfg(target_os = "windows")]
pub fn spawn_activity_watcher(app: tauri::AppHandle) {
    use crate::AppState;
    use tauri::{Emitter, Manager};

    tauri::async_runtime::spawn(async move {
        let mut last_seen: Option<(isize, String, String)> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if !visible {
                continue;
            }

            let Some(info) = capture_foreground_window() else {
                continue;
            };

            let key = (info.hwnd, info.process_name.clone(), info.title.clone());
            if last_seen.as_ref() == Some(&key) {
                continue;
            }
            last_seen = Some(key);

            {
                let st = app.state::<AppState>();
                *st.previous_window.lock().unwrap() = Some(info.clone());
            }
            let _ = app.emit("askii://activity", info);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_activity_watcher(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_downscales_large_rgba_image() {
        let img = RgbaImage::from_pixel(2000, 1000, image::Rgba([29, 78, 216, 255]));
        let (b64, w, h) = encode_rgba_to_png_base64(img).unwrap();
        assert!(!b64.is_empty());
        assert_eq!(w, 1600);
        assert_eq!(h, 800);
    }

    #[test]
    fn reads_text_file_attachment_safely() {
        let tmp = std::env::temp_dir().join("askii_test_attach.txt");
        std::fs::write(&tmp, "hello askii").unwrap();
        let res = read_file_attachment(tmp.to_str().unwrap()).unwrap();
        assert_eq!(res.kind, "text");
        assert_eq!(res.text.as_deref(), Some("hello askii"));
        assert!(!res.truncated);
        let _ = std::fs::remove_file(&tmp);
    }
}
