use crate::context::capture_foreground_window;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_CLIPBOARD_RING: usize = 15;
const MAX_ENTRY_CHARS: usize = 32_000;

const EXCLUDED_PROCESSES: &[&str] = &[
    "keepass",
    "keepassxc",
    "1password",
    "bitwarden",
    "lastpass",
    "dashlane",
    "enpass",
    "roboform",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardHistoryItem {
    pub index: usize, // 1-based (@clip:1 is most recent)
    pub text: String,
    pub preview: String,
    pub source_app: Option<String>,
    pub captured_at: i64,
}

#[derive(Default)]
pub struct ClipboardRing {
    items: Mutex<VecDeque<ClipboardHistoryItem>>,
}

pub fn is_excluded_process(process_name: Option<&str>) -> bool {
    let Some(name) = process_name else {
        return false;
    };
    let lower = name.trim().to_ascii_lowercase();
    EXCLUDED_PROCESSES.iter().any(|p| lower.contains(p))
}

impl ClipboardRing {
    pub fn push(&self, text: &str, source_app: Option<String>) -> bool {
        if is_excluded_process(source_app.as_deref()) {
            return false;
        }
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_ENTRY_CHARS {
            return false;
        }
        let preview: String = trimmed
            .replace(['\r', '\n'], " ")
            .chars()
            .take(88)
            .collect();
        let captured_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let mut guard = self.items.lock().unwrap();
        guard.retain(|item| item.text != trimmed);
        guard.push_front(ClipboardHistoryItem {
            index: 1,
            text: trimmed.to_string(),
            preview,
            source_app,
            captured_at,
        });
        while guard.len() > MAX_CLIPBOARD_RING {
            guard.pop_back();
        }
        for (i, item) in guard.iter_mut().enumerate() {
            item.index = i + 1;
        }
        true
    }

    pub fn list(&self) -> Vec<ClipboardHistoryItem> {
        self.items.lock().unwrap().iter().cloned().collect()
    }

    pub fn get_one_based(&self, idx: usize) -> Option<ClipboardHistoryItem> {
        if idx == 0 {
            return None;
        }
        self.items.lock().unwrap().get(idx - 1).cloned()
    }
}

#[cfg(target_os = "windows")]
pub fn spawn_clipboard_watcher(app: tauri::AppHandle) {
    use crate::AppState;
    use tauri::Manager;
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    tauri::async_runtime::spawn(async move {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(850)).await;
            let enabled = {
                let st = app.state::<AppState>();
                let v = st.config.lock().unwrap().clipboard_history_enabled;
                v
            };
            if !enabled {
                continue;
            }
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq {
                continue;
            }
            last_seq = seq;

            let source_app = capture_foreground_window().map(|w| w.process_name);
            if is_excluded_process(source_app.as_deref()) {
                continue;
            }
            if let Ok(mut cb) = arboard::Clipboard::new() {
                if let Ok(text) = cb.get_text() {
                    let st = app.state::<AppState>();
                    st.clipboard_ring.push(&text, source_app);
                }
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_clipboard_watcher(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_caps_and_excludes_password_managers() {
        let ring = ClipboardRing::default();
        assert!(!ring.push("super-secret-pw", Some("1Password".to_string())));
        assert!(!ring.push("secret2", Some("KeePassXC".to_string())));
        assert!(ring.push("first snippet", Some("Code".to_string())));
        assert!(ring.push("second snippet", Some("Chrome".to_string())));
        assert!(ring.push("first snippet", Some("Code".to_string())));

        let list = ring.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 1);
        assert_eq!(list[0].text, "first snippet");
        assert_eq!(list[1].index, 2);
        assert_eq!(list[1].text, "second snippet");

        for i in 0..25 {
            ring.push(&format!("entry {i}"), None);
        }
        assert_eq!(ring.list().len(), MAX_CLIPBOARD_RING);
        assert_eq!(ring.get_one_based(1).unwrap().text, "entry 24");
    }
}
