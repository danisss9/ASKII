use crate::agent::tools::ToolExecutionOutput;
use crate::llm::{ImageAttachment, ToolDefinition};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const WORKER_SCRIPT_SOURCE: &str = include_str!("puppeteer-worker.mjs");
const WORKER_TIMEOUT_SECS: u64 = 35;

struct WorkerSession {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

#[derive(Default)]
pub struct BrowserController {
    session: Mutex<Option<WorkerSession>>,
    req_seq: AtomicU64,
}

impl BrowserController {
    pub async fn shutdown(&self) {
        let mut guard = self.session.lock().await;
        if let Some(mut sess) = guard.take() {
            let _ = sess.stdin.shutdown().await;
            let exited = tokio::time::timeout(Duration::from_secs(2), sess.child.wait()).await;
            if !matches!(exited, Ok(Ok(_))) {
                let _ = sess.child.kill().await;
            }
        }
    }

    async fn ensure_worker<'a>(
        guard: &'a mut Option<WorkerSession>,
    ) -> Result<&'a mut WorkerSession, String> {
        let needs_spawn = match guard.as_mut() {
            None => true,
            Some(sess) => matches!(sess.child.try_wait(), Ok(Some(_)) | Err(_)),
        };

        if needs_spawn {
            *guard = Some(spawn_puppeteer_worker()?);
        }

        guard
            .as_mut()
            .ok_or_else(|| "Puppeteer worker failed to initialize.".to_string())
    }

    pub async fn call_worker(&self, action: &str, params: Value) -> ToolExecutionOutput {
        let id = self.req_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut guard = self.session.lock().await;

        let sess = match Self::ensure_worker(&mut guard).await {
            Ok(s) => s,
            Err(e) => return ToolExecutionOutput::err(e),
        };

        let payload = json!({
            "id": id,
            "action": action,
            "params": params,
        });
        let line = format!("{payload}\n");

        if let Err(e) = sess.stdin.write_all(line.as_bytes()).await {
            *guard = None;
            return ToolExecutionOutput::err(format!("Failed to send command to Puppeteer worker: {e}"));
        }
        if let Err(e) = sess.stdin.flush().await {
            *guard = None;
            return ToolExecutionOutput::err(format!("Failed to flush Puppeteer worker stdin: {e}"));
        }

        let read_res = tokio::time::timeout(
            Duration::from_secs(WORKER_TIMEOUT_SECS),
            async {
                while let Some(raw_line) = sess
                    .stdout_lines
                    .next_line()
                    .await
                    .map_err(|e| format!("Puppeteer worker read error: {e}"))?
                {
                    let trimmed = raw_line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        if val.get("id").and_then(|v| v.as_u64()) == Some(id) {
                            return Ok(val);
                        }
                    }
                }
                Err("Puppeteer worker exited unexpectedly. Ensure Node.js and `puppeteer-core` are installed.".to_string())
            },
        )
        .await;

        let resp = match read_res {
            Ok(Ok(val)) => val,
            Ok(Err(e)) => {
                if let Some(mut dead) = guard.take() {
                    let _ = dead.child.kill().await;
                }
                return ToolExecutionOutput::err(e);
            }
            Err(_) => {
                if let Some(mut timed_out) = guard.take() {
                    let _ = timed_out.child.kill().await;
                }
                return ToolExecutionOutput::err(format!(
                    "Browser action `{action}` timed out after {WORKER_TIMEOUT_SECS}s."
                ));
            }
        };

        if action == "close" {
            if let Some(mut sess) = guard.take() {
                let _ = sess.stdin.shutdown().await;
                let exited = tokio::time::timeout(Duration::from_secs(2), sess.child.wait()).await;
                if !matches!(exited, Ok(Ok(_))) {
                    let _ = sess.child.kill().await;
                }
            }
        }

        let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        if !ok {
            let err = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Puppeteer browser error");
            return ToolExecutionOutput::err(err);
        }

        let output = resp
            .get("output")
            .and_then(|v| v.as_str())
            .unwrap_or("Done.")
            .to_string();

        let mut images = Vec::new();
        if let Some(b64) = resp.get("imageBase64").and_then(|v| v.as_str()) {
            if !b64.is_empty() {
                let mime = resp
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image/png")
                    .to_string();
                images.push(ImageAttachment {
                    mime_type: mime,
                    data_base64: b64.to_string(),
                });
            }
        }

        ToolExecutionOutput {
            success: true,
            output,
            backup_id: None,
            images,
        }
    }
}

fn ensure_worker_script_file() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("dev.askii.desktop");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ASKII local data directory: {e}"))?;
    let path = dir.join("puppeteer-worker.mjs");
    let should_write = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != WORKER_SCRIPT_SOURCE,
        Err(_) => true,
    };
    if should_write {
        std::fs::write(&path, WORKER_SCRIPT_SOURCE)
            .map_err(|e| format!("Failed to write Puppeteer worker script: {e}"))?;
    }
    Ok(path)
}

pub fn collect_node_modules_search_paths() -> Vec<PathBuf> {
    let mut dirs_out: Vec<PathBuf> = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if p.exists() && !dirs_out.iter().any(|existing| existing == &p) {
            dirs_out.push(p);
        }
    };

    if let Ok(cwd) = std::env::current_dir() {
        push_unique(cwd.join("node_modules"));
        if let Some(parent) = cwd.parent() {
            push_unique(parent.join("node_modules"));
        }
    }

    // Dev build fallback: CARGO_MANIFEST_DIR is `.../src-tauri`
    let manifest_parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from);
    if let Some(root) = manifest_parent {
        push_unique(root.join("node_modules"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_unique(dir.join("node_modules"));
            push_unique(dir.join("resources").join("node_modules"));
        }
    }

    if let Some(local_data) = dirs::data_local_dir() {
        push_unique(local_data.join("dev.askii.desktop").join("puppeteer").join("node_modules"));
    }

    if let Some(roaming) = dirs::config_dir() {
        push_unique(roaming.join("npm").join("node_modules"));
    }

    dirs_out
}

fn spawn_puppeteer_worker() -> Result<WorkerSession, String> {
    let script_path = ensure_worker_script_file()?;
    let search_paths = collect_node_modules_search_paths();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let joined_paths = search_paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(sep);

    let mut cmd = Command::new("node");
    cmd.arg(&script_path)
        .env("ASKII_NODE_MODULES", joined_paths)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Failed to start Node.js Puppeteer worker (is Node.js installed on PATH?): {e}")
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Puppeteer worker stdin unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Puppeteer worker stdout unavailable.".to_string())?;

    Ok(WorkerSession {
        child,
        stdin,
        stdout_lines: BufReader::new(stdout).lines(),
    })
}

pub fn browser_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "browser_launch".to_string(),
            description: "Launch a Puppeteer-controlled Chrome (or Chromium/Edge) browser window, or connect to an existing Chrome remote debugging URL.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional initial URL to open" },
                    "headless": { "type": "boolean", "description": "Run without a visible window (default false — visible Chrome window)" },
                    "debuggerUrl": { "type": "string", "description": "Optional Chrome DevTools remote debugging URL (e.g. http://127.0.0.1:9222)" },
                    "executablePath": { "type": "string", "description": "Optional explicit path to chrome.exe" },
                    "viewportWidth": { "type": "integer", "description": "Viewport width in px (default 1280)" },
                    "viewportHeight": { "type": "integer", "description": "Viewport height in px (default 820)" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_navigate".to_string(),
            description: "Navigate the Puppeteer Chrome tab to a URL (auto-launches Chrome if not running) and return the page title, interactive elements, and visible text.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Destination URL (e.g. https://github.com)" },
                    "waitUntil": {
                        "type": "string",
                        "enum": ["domcontentloaded", "load", "networkidle2"],
                        "description": "Navigation readiness condition (default 'domcontentloaded')"
                    }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "browser_snapshot".to_string(),
            description: "Inspect the current browser page: returns title, URL, visible text, and indexed interactive elements (links, buttons, inputs) with CSS selectors and coordinates.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "maxChars": { "type": "integer", "description": "Maximum visible body text characters to return (default 6000)" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_screenshot".to_string(),
            description: "Capture a PNG screenshot of the current Puppeteer Chrome viewport (or full page) for visual inspection.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "fullPage": { "type": "boolean", "description": "Capture the full scrollable page instead of the viewport (default false)" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_click".to_string(),
            description: "Click an element in the Puppeteer Chrome page by CSS selector, visible text, or (x, y) viewport coordinates.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector (e.g. 'button[type=\"submit\"]', '#search')" },
                    "text": { "type": "string", "description": "Visible text/aria-label of the button or link to click" },
                    "x": { "type": "integer", "description": "Viewport X coordinate (used if selector/text not provided)" },
                    "y": { "type": "integer", "description": "Viewport Y coordinate (used if selector/text not provided)" },
                    "button": { "type": "string", "enum": ["left", "right", "middle"] },
                    "clickCount": { "type": "integer", "description": "1 = single click (default), 2 = double click" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_type".to_string(),
            description: "Type text into a form input or currently focused element in Puppeteer Chrome.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "Optional CSS selector to click/focus before typing" },
                    "text": { "type": "string", "description": "Text to type" },
                    "clear": { "type": "boolean", "description": "Clear existing input value first (default false)" },
                    "pressEnter": { "type": "boolean", "description": "Press Enter after typing (default false)" }
                },
                "required": ["text"]
            }),
        },
        ToolDefinition {
            name: "browser_press_key".to_string(),
            description: "Press a keyboard key or shortcut in Puppeteer Chrome (e.g. 'Enter', 'Tab', 'Escape', 'Control+A', 'ArrowDown').".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Key or modifier chord (e.g. 'Enter', 'Control+F')" }
                },
                "required": ["key"]
            }),
        },
        ToolDefinition {
            name: "browser_scroll".to_string(),
            description: "Scroll the Puppeteer Chrome page vertically/horizontally or scroll a CSS selector into view.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "deltaY": { "type": "integer", "description": "Vertical scroll pixels (+ down, - up; default 500)" },
                    "deltaX": { "type": "integer", "description": "Horizontal scroll pixels (default 0)" },
                    "selector": { "type": "string", "description": "Optional CSS selector to scroll into view" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_evaluate".to_string(),
            description: "Run a JavaScript expression inside the active Puppeteer Chrome page and return its JSON result.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "script": { "type": "string", "description": "JavaScript expression or function body to evaluate in the page" }
                },
                "required": ["script"]
            }),
        },
        ToolDefinition {
            name: "browser_tabs".to_string(),
            description: "List open Puppeteer Chrome tabs, open a new tab, switch to a tab by index, or close a tab.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "new", "switch", "close"],
                        "description": "Tab operation (default 'list')"
                    },
                    "index": { "type": "integer", "description": "Zero-based tab index for switch/close" },
                    "url": { "type": "string", "description": "Optional URL when action is 'new'" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_wait".to_string(),
            description: "Wait for a CSS selector to become visible or pause for a number of milliseconds in Puppeteer Chrome.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "Optional CSS selector to wait for" },
                    "timeoutMs": { "type": "integer", "description": "Selector timeout in ms (default 8000)" },
                    "ms": { "type": "integer", "description": "Milliseconds to wait when no selector is provided (default 1000)" }
                }
            }),
        },
        ToolDefinition {
            name: "browser_close".to_string(),
            description: "Close the active Puppeteer Chrome browser session.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        },
    ]
}

pub fn is_browser_tool(name: &str) -> bool {
    name.starts_with("browser_")
}

pub fn browser_tool_tier(name: &str) -> u8 {
    match name {
        "browser_snapshot" | "browser_screenshot" | "browser_wait" => 0,
        _ => 2,
    }
}

pub fn summarize_browser_tool(name: &str, args: &Value) -> String {
    match name {
        "browser_launch" => match args.get("url").and_then(|v| v.as_str()) {
            Some(u) if !u.is_empty() => format!("Launch Chrome → {u}"),
            _ => "Launch Chrome (Puppeteer)".to_string(),
        },
        "browser_navigate" => {
            let u = args.get("url").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Chrome navigate → {u}")
        }
        "browser_snapshot" => "Inspect Chrome page DOM & text".to_string(),
        "browser_screenshot" => "Capture Chrome screenshot".to_string(),
        "browser_click" => {
            if let Some(s) = args.get("selector").and_then(|v| v.as_str()) {
                format!("Chrome click `{s}`")
            } else if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
                format!("Chrome click \"{t}\"")
            } else {
                let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
                let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
                format!("Chrome click ({x}, {y})")
            }
        }
        "browser_type" => {
            let txt = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let preview: String = txt.chars().take(42).collect();
            let ell = if txt.chars().count() > 42 { "…" } else { "" };
            format!("Chrome type \"{preview}{ell}\"")
        }
        "browser_press_key" => {
            let k = args.get("key").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Chrome press `{k}`")
        }
        "browser_scroll" => {
            if let Some(s) = args.get("selector").and_then(|v| v.as_str()) {
                format!("Chrome scroll to `{s}`")
            } else {
                let dy = args.get("deltaY").and_then(|v| v.as_i64()).unwrap_or(500);
                format!("Chrome scroll ({dy}px)")
            }
        }
        "browser_evaluate" => "Chrome evaluate JavaScript".to_string(),
        "browser_tabs" => {
            let op = args.get("action").and_then(|v| v.as_str()).unwrap_or("list");
            format!("Chrome tabs: {op}")
        }
        "browser_wait" => {
            if let Some(s) = args.get("selector").and_then(|v| v.as_str()) {
                format!("Chrome wait for `{s}`")
            } else {
                let ms = args.get("ms").and_then(|v| v.as_u64()).unwrap_or(1000);
                format!("Chrome wait {ms}ms")
            }
        }
        "browser_close" => "Close Chrome (Puppeteer)".to_string(),
        _ => format!("Chrome action {name}"),
    }
}

pub async fn execute_browser_tool(
    controller: &BrowserController,
    name: &str,
    args: &Value,
) -> ToolExecutionOutput {
    let Some(action) = name.strip_prefix("browser_") else {
        return ToolExecutionOutput::err(format!("Unknown browser tool \"{name}\""));
    };
    controller.call_worker(action, args.clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_tools_have_expected_names_and_tiers() {
        let defs = browser_tool_definitions();
        assert!(defs.iter().all(|d| is_browser_tool(&d.name)));
        assert_eq!(browser_tool_tier("browser_snapshot"), 0);
        assert_eq!(browser_tool_tier("browser_screenshot"), 0);
        assert_eq!(browser_tool_tier("browser_navigate"), 2);
        assert_eq!(browser_tool_tier("browser_click"), 2);
    }

    #[test]
    fn finds_workspace_node_modules_for_puppeteer() {
        let paths = collect_node_modules_search_paths();
        assert!(
            paths.iter().any(|p| p.join("puppeteer-core").exists()),
            "Expected puppeteer-core in one of {:?}",
            paths
        );
    }
}
