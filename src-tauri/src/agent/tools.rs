use crate::agent::backup;
use crate::llm::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use sysinfo::System;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::process::Command;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionOutput {
    pub success: bool,
    pub output: String,
    pub backup_id: Option<String>,
}

pub fn builtin_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        // Tier 0 — Read-only OS & Info
        ToolDefinition {
            name: "get_system_info".to_string(),
            description: "Inspect Windows CPU usage, memory (RAM), OS version, and top running processes.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: "list_open_windows".to_string(),
            description: "List visible open desktop windows on Windows with their HWND and titles.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: "search_files".to_string(),
            description: "Search for files by filename substring under a folder on Windows.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "root": { "type": "string", "description": "Directory path to search (defaults to user home directory)" },
                    "query": { "type": "string", "description": "Case-insensitive filename substring to match" },
                    "maxResults": { "type": "integer", "description": "Maximum results (default 25, max 50)" }
                },
                "required": ["query"]
            }),
        },
        ToolDefinition {
            name: "read_file".to_string(),
            description: "Read the UTF-8 contents of a local file (capped at 64 KB).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute or relative file path" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "list_directory".to_string(),
            description: "List files and folders inside a directory.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "fetch_url".to_string(),
            description: "Fetch a web page or JSON endpoint over HTTP/HTTPS and return readable text.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "http:// or https:// URL" }
                },
                "required": ["url"]
            }),
        },
        // Tier 1 — Desktop Control
        ToolDefinition {
            name: "open_app_or_url".to_string(),
            description: "Open a Windows application, file, folder, or https:// URL.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Application name, path, or URL (e.g. notepad, calc, https://github.com)" }
                },
                "required": ["target"]
            }),
        },
        ToolDefinition {
            name: "control_window".to_string(),
            description: "Focus, minimize, maximize, restore, or snap a desktop window left or right.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "titleContains": { "type": "string", "description": "Substring of the target window title" },
                    "action": {
                        "type": "string",
                        "enum": ["focus", "minimize", "maximize", "restore", "snap_left", "snap_right"]
                    }
                },
                "required": ["titleContains", "action"]
            }),
        },
        ToolDefinition {
            name: "media_control".to_string(),
            description: "Control Windows media playback and volume.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["play_pause", "next", "previous", "mute", "volume_up", "volume_down"]
                    }
                },
                "required": ["action"]
            }),
        },
        ToolDefinition {
            name: "set_timer_reminder".to_string(),
            description: "Schedule a native Windows toast notification reminder after a given number of seconds.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "seconds": { "type": "integer", "description": "Delay in seconds (1..86400)" },
                    "message": { "type": "string", "description": "Reminder text" }
                },
                "required": ["seconds", "message"]
            }),
        },
        // Tier 2 — Mutating / Power (Confirm by default, autonomous in Auto Do, backed up)
        ToolDefinition {
            name: "run_powershell".to_string(),
            description: "Execute a Windows PowerShell command and return stdout/stderr.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "PowerShell command to execute" }
                },
                "required": ["command"]
            }),
        },
        ToolDefinition {
            name: "write_file".to_string(),
            description: "Create or overwrite a local file. Automatically saves a local rollback backup first.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Target file path" },
                    "content": { "type": "string", "description": "Full text content to write" }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "move_or_rename_file".to_string(),
            description: "Move or rename a local file, creating a rollback backup snapshot first.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Source file path" },
                    "to": { "type": "string", "description": "Destination file path" }
                },
                "required": ["from", "to"]
            }),
        },
    ]
}

pub fn tool_tier(name: &str) -> u8 {
    match name {
        "get_system_info"
        | "list_open_windows"
        | "search_files"
        | "read_file"
        | "list_directory"
        | "fetch_url" => 0,
        "open_app_or_url" | "control_window" | "media_control" | "set_timer_reminder" => 1,
        _ => 2,
    }
}

pub fn summarize_tool_call(name: &str, args: &Value) -> String {
    match name {
        "run_powershell" => {
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            format!("Run PowerShell: {}", truncate_chars(cmd, 120))
        }
        "write_file" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            let bytes = args
                .get("content")
                .and_then(|v| v.as_str())
                .map(|s| s.len())
                .unwrap_or(0);
            format!("Write file `{path}` ({bytes} bytes)")
        }
        "move_or_rename_file" => {
            let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("?");
            let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Move `{from}` → `{to}`")
        }
        "open_app_or_url" => {
            let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Open `{target}`")
        }
        "control_window" => {
            let t = args
                .get("titleContains")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let a = args.get("action").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Window `{t}` → {a}")
        }
        "media_control" => {
            let a = args.get("action").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Media control: {a}")
        }
        "set_timer_reminder" => {
            let s = args.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0);
            let m = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
            format!("Set reminder ({s}s): {}", truncate_chars(m, 80))
        }
        "search_files" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            format!("Search files matching \"{q}\"")
        }
        "read_file" => {
            let p = args.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Read `{p}`")
        }
        "fetch_url" => {
            let u = args.get("url").and_then(|v| v.as_str()).unwrap_or("?");
            format!("Fetch {u}")
        }
        _ => format!("Call {name}"),
    }
}

pub fn detect_destructive_warning(name: &str, args: &Value) -> Option<String> {
    if name == "run_powershell" {
        let cmd = args
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let risky_patterns = [
            ("rm -rf", "Recursive force-delete detected"),
            ("remove-item", "File deletion (Remove-Item) detected"),
            ("format-volume", "Disk format command detected"),
            ("clear-disk", "Disk wipe command detected"),
            ("del /s", "Recursive delete detected"),
            ("rmdir /s", "Recursive directory delete detected"),
            ("reg delete", "Windows Registry deletion detected"),
            ("stop-computer", "System shutdown command detected"),
            ("restart-computer", "System restart command detected"),
            ("shutdown /s", "System shutdown command detected"),
            ("bcdedit", "Boot configuration modification detected"),
        ];
        for (pat, reason) in risky_patterns {
            if cmd.contains(pat) {
                return Some(reason.to_string());
            }
        }
    }

    if matches!(name, "write_file" | "move_or_rename_file") {
        let path_str = args
            .get("path")
            .or_else(|| args.get("from"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if path_str.starts_with("c:\\windows") || path_str.starts_with("c:/windows") {
            return Some("Targets Windows system directory".to_string());
        }
    }

    None
}

fn is_sensitive_read_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase().replace('/', "\\");
    lower.contains("\\.ssh\\id_")
        || lower.contains("\\.aws\\credentials")
        || lower.contains("\\windows\\system32\\config\\sam")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

pub async fn execute_builtin_tool(
    app: &AppHandle,
    name: &str,
    args: &Value,
) -> ToolExecutionOutput {
    match name {
        "get_system_info" => run_system_info(),
        "list_open_windows" => run_list_open_windows(),
        "search_files" => run_search_files(args),
        "read_file" => run_read_file(args),
        "list_directory" => run_list_directory(args),
        "fetch_url" => run_fetch_url(args).await,
        "open_app_or_url" => run_open_app_or_url(args),
        "control_window" => run_control_window(args),
        "media_control" => run_media_control(args),
        "set_timer_reminder" => run_set_timer_reminder(app, args),
        "run_powershell" => run_powershell(args).await,
        "write_file" => run_write_file(args),
        "move_or_rename_file" => run_move_or_rename(args),
        _ => ToolExecutionOutput {
            success: false,
            output: format!("Unknown built-in tool \"{name}\""),
            backup_id: None,
        },
    }
}

fn run_system_info() -> ToolExecutionOutput {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_mem_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let used_mem_gb = sys.used_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let cpu_usage = sys.global_cpu_usage();
    let os_name = System::long_os_version().unwrap_or_else(|| "Windows".to_string());

    let mut procs: Vec<(String, u64)> = sys
        .processes()
        .values()
        .map(|p| (p.name().to_string_lossy().to_string(), p.memory()))
        .collect();
    procs.sort_by(|a, b| b.1.cmp(&a.1));
    let top_procs: Vec<String> = procs
        .into_iter()
        .take(8)
        .map(|(n, mem)| format!("- {n}: {:.0} MB", mem as f64 / (1024.0 * 1024.0)))
        .collect();

    let out = format!(
        "OS: {os_name}\nCPU Usage: {cpu_usage:.1}%\nMemory: {used_mem_gb:.1} GB / {total_mem_gb:.1} GB ({:.0}%)\n\nTop Processes by RAM:\n{}",
        if total_mem_gb > 0.0 {
            (used_mem_gb / total_mem_gb) * 100.0
        } else {
            0.0
        },
        top_procs.join("\n")
    );
    ToolExecutionOutput {
        success: true,
        output: out,
        backup_id: None,
    }
}

fn run_search_files(args: &Value) -> ToolExecutionOutput {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if query.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Missing required `query` parameter.".to_string(),
            backup_id: None,
        };
    }
    let root = args
        .get("root")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")));
    let max_results = args
        .get("maxResults")
        .and_then(|v| v.as_u64())
        .unwrap_or(25)
        .clamp(1, 50) as usize;

    let mut matches = Vec::new();
    let mut visited = 0usize;
    let walker = WalkDir::new(&root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            !matches!(
                name.as_str(),
                "node_modules" | ".git" | "target" | ".ssh" | "$recycle.bin" | "appdata"
            )
        });

    for entry in walker.flatten() {
        visited += 1;
        if visited > 25_000 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.contains(&query) {
            matches.push(entry.path().display().to_string());
            if matches.len() >= max_results {
                break;
            }
        }
    }

    let output = if matches.is_empty() {
        format!("No files matching \"{query}\" found under {}.", root.display())
    } else {
        matches.join("\n")
    };
    ToolExecutionOutput {
        success: true,
        output,
        backup_id: None,
    }
}

fn run_read_file(args: &Value) -> ToolExecutionOutput {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    if path.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Missing `path`.".to_string(),
            backup_id: None,
        };
    }
    if is_sensitive_read_path(path) {
        return ToolExecutionOutput {
            success: false,
            output: "Blocked reading sensitive credential/key path.".to_string(),
            backup_id: None,
        };
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let cap = 64 * 1024;
            let truncated = bytes.len() > cap;
            let text = String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).to_string();
            ToolExecutionOutput {
                success: true,
                output: if truncated {
                    format!("{text}\n\n[Truncated at 64 KB]")
                } else {
                    text
                },
                backup_id: None,
            }
        }
        Err(e) => ToolExecutionOutput {
            success: false,
            output: format!("Failed to read `{path}`: {e}"),
            backup_id: None,
        },
    }
}

fn run_list_directory(args: &Value) -> ToolExecutionOutput {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    let target = if path.is_empty() {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(path)
    };

    match std::fs::read_dir(&target) {
        Ok(rd) => {
            let mut items: Vec<String> = rd
                .flatten()
                .take(80)
                .map(|e| {
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let suffix = if is_dir { "/" } else { "" };
                    format!("{}{suffix}", e.file_name().to_string_lossy())
                })
                .collect();
            items.sort();
            ToolExecutionOutput {
                success: true,
                output: if items.is_empty() {
                    "(empty directory)".to_string()
                } else {
                    items.join("\n")
                },
                backup_id: None,
            }
        }
        Err(e) => ToolExecutionOutput {
            success: false,
            output: format!("Failed to list `{}`: {e}", target.display()),
            backup_id: None,
        },
    }
}

async fn run_fetch_url(args: &Value) -> ToolExecutionOutput {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return ToolExecutionOutput {
            success: false,
            output: "URL must start with http:// or https://".to_string(),
            backup_id: None,
        };
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("askii/{}", crate::config::APP_VERSION))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ToolExecutionOutput {
                success: false,
                output: format!("HTTP client error: {e}"),
                backup_id: None,
            };
        }
    };
    match client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();
            let cleaned = strip_html_tags(&raw);
            let out = truncate_chars(&cleaned, 12_000);
            ToolExecutionOutput {
                success: status.is_success(),
                output: format!("HTTP {}\n\n{}", status.as_u16(), out),
                backup_id: None,
            }
        }
        Err(e) => ToolExecutionOutput {
            success: false,
            output: format!("Fetch failed: {e}"),
            backup_id: None,
        },
    }
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(16_000));
    let mut in_tag = false;
    let mut last_ws = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !last_ws {
                    out.push(' ');
                    last_ws = true;
                }
            }
            c if !in_tag => {
                if c.is_whitespace() {
                    if !last_ws {
                        out.push(if c == '\n' { '\n' } else { ' ' });
                        last_ws = true;
                    }
                } else {
                    out.push(c);
                    last_ws = false;
                }
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

fn run_open_app_or_url(args: &Value) -> ToolExecutionOutput {
    let target = args
        .get("target")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if target.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Missing `target`.".to_string(),
            backup_id: None,
        };
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let res = std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        match res {
            Ok(_) => ToolExecutionOutput {
                success: true,
                output: format!("Opened `{target}`"),
                backup_id: None,
            },
            Err(e) => ToolExecutionOutput {
                success: false,
                output: format!("Failed to open `{target}`: {e}"),
                backup_id: None,
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ToolExecutionOutput {
            success: false,
            output: "Windows-only tool.".to_string(),
            backup_id: None,
        }
    }
}

fn run_set_timer_reminder(app: &AppHandle, args: &Value) -> ToolExecutionOutput {
    let secs = args
        .get("seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .clamp(1, 86_400);
    let msg = args
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("ASKII Reminder")
        .trim()
        .to_string();

    let app_handle = app.clone();
    let msg_clone = msg.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let _ = app_handle
            .notification()
            .builder()
            .title("ASKII Reminder (⌐■_■)")
            .body(&msg_clone)
            .show();
    });

    ToolExecutionOutput {
        success: true,
        output: format!("Reminder scheduled in {secs}s: \"{msg}\""),
        backup_id: None,
    }
}

async fn run_powershell(args: &Value) -> ToolExecutionOutput {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Missing `command`.".to_string(),
            backup_id: None,
        };
    }

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
                (false, false) => format!("{}\n\n[stderr]\n{}", stdout.trim(), stderr.trim()),
                (false, true) => stdout.trim().to_string(),
                (true, false) => format!("[stderr]\n{}", stderr.trim()),
                (true, true) => "(command completed with no output)".to_string(),
            };
            ToolExecutionOutput {
                success: out.status.success(),
                output: truncate_chars(&combined, 12_000),
                backup_id: None,
            }
        }
        Ok(Err(e)) => ToolExecutionOutput {
            success: false,
            output: format!("Failed to start PowerShell: {e}"),
            backup_id: None,
        },
        Err(_) => ToolExecutionOutput {
            success: false,
            output: "PowerShell command timed out after 30 seconds.".to_string(),
            backup_id: None,
        },
    }
}

fn run_write_file(args: &Value) -> ToolExecutionOutput {
    let path_str = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if path_str.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Missing `path`.".to_string(),
            backup_id: None,
        };
    }
    let path = Path::new(path_str);
    let backup_id = match backup::create_backup(path, None) {
        Ok(id) => Some(id),
        Err(e) => {
            return ToolExecutionOutput {
                success: false,
                output: format!("Backup failed before write: {e}"),
                backup_id: None,
            };
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolExecutionOutput {
                success: false,
                output: format!("Failed to create parent directory: {e}"),
                backup_id,
            };
        }
    }
    match std::fs::write(path, content) {
        Ok(()) => ToolExecutionOutput {
            success: true,
            output: format!("Wrote {} bytes to `{path_str}` (backup saved).", content.len()),
            backup_id,
        },
        Err(e) => ToolExecutionOutput {
            success: false,
            output: format!("Write failed: {e}"),
            backup_id,
        },
    }
}

fn run_move_or_rename(args: &Value) -> ToolExecutionOutput {
    let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("").trim();
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("").trim();
    if from.is_empty() || to.is_empty() {
        return ToolExecutionOutput {
            success: false,
            output: "Both `from` and `to` paths are required.".to_string(),
            backup_id: None,
        };
    }
    let from_p = Path::new(from);
    let to_p = Path::new(to);
    let backup_id = match backup::create_backup(from_p, Some(to_p)) {
        Ok(id) => Some(id),
        Err(e) => {
            return ToolExecutionOutput {
                success: false,
                output: format!("Backup failed before move: {e}"),
                backup_id: None,
            };
        }
    };
    if let Some(parent) = to_p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(from_p, to_p) {
        Ok(()) => ToolExecutionOutput {
            success: true,
            output: format!("Moved `{from}` → `{to}` (backup saved)."),
            backup_id,
        },
        Err(e) => ToolExecutionOutput {
            success: false,
            output: format!("Move failed: {e}"),
            backup_id,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindowEntry {
    pub hwnd: isize,
    pub title: String,
}

#[cfg(target_os = "windows")]
pub fn enumerate_visible_windows() -> Vec<OpenWindowEntry> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return BOOL(1);
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..copied as usize])
            .trim()
            .to_string();
        if !title.is_empty() && title != "ASKII" && title != "Program Manager" {
            let list = &mut *(lparam.0 as *mut Vec<OpenWindowEntry>);
            list.push(OpenWindowEntry {
                hwnd: hwnd.0 as isize,
                title,
            });
        }
        BOOL(1)
    }

    let mut windows = Vec::new();
    unsafe {
        let ptr = &mut windows as *mut Vec<OpenWindowEntry>;
        let _ = EnumWindows(Some(enum_proc), LPARAM(ptr as isize));
    }
    windows
}

#[cfg(not(target_os = "windows"))]
pub fn enumerate_visible_windows() -> Vec<OpenWindowEntry> {
    Vec::new()
}

fn run_list_open_windows() -> ToolExecutionOutput {
    let wins = enumerate_visible_windows();
    if wins.is_empty() {
        return ToolExecutionOutput {
            success: true,
            output: "No visible desktop windows found.".to_string(),
            backup_id: None,
        };
    }
    let lines: Vec<String> = wins
        .iter()
        .take(30)
        .map(|w| format!("- {} (hwnd:{})", w.title, w.hwnd))
        .collect();
    ToolExecutionOutput {
        success: true,
        output: lines.join("\n"),
        backup_id: None,
    }
}

#[cfg(target_os = "windows")]
pub fn focus_window_by_hwnd(hwnd_raw: isize) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };

    unsafe {
        let hwnd = HWND(hwnd_raw as *mut c_void);
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn focus_window_by_hwnd(_hwnd_raw: isize) -> Result<(), String> {
    Err("Windows-only.".to_string())
}

#[cfg(target_os = "windows")]
fn run_control_window(args: &Value) -> ToolExecutionOutput {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, HWND_TOP, SM_CXSCREEN, SM_CYSCREEN, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        SWP_SHOWWINDOW, SetForegroundWindow, SetWindowPos, ShowWindow,
    };

    let needle = args
        .get("titleContains")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("focus");

    let wins = enumerate_visible_windows();
    let Some(target) = wins
        .into_iter()
        .find(|w| w.title.to_ascii_lowercase().contains(&needle))
    else {
        return ToolExecutionOutput {
            success: false,
            output: format!("No open window matching \"{needle}\" was found."),
            backup_id: None,
        };
    };

    unsafe {
        let hwnd = HWND(target.hwnd as *mut c_void);
        let sw = GetSystemMetrics(SM_CXSCREEN);
        let sh = GetSystemMetrics(SM_CYSCREEN) - 44; // leave taskbar breathing room
        match action {
            "minimize" => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            "maximize" => {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
                let _ = SetForegroundWindow(hwnd);
            }
            "restore" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
            "snap_left" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetWindowPos(hwnd, HWND_TOP, 0, 0, sw / 2, sh, SWP_SHOWWINDOW);
                let _ = SetForegroundWindow(hwnd);
            }
            "snap_right" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetWindowPos(hwnd, HWND_TOP, sw / 2, 0, sw / 2, sh, SWP_SHOWWINDOW);
                let _ = SetForegroundWindow(hwnd);
            }
            _ => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }

    ToolExecutionOutput {
        success: true,
        output: format!("Applied `{action}` to window \"{}\"", target.title),
        backup_id: None,
    }
}

#[cfg(not(target_os = "windows"))]
fn run_control_window(_args: &Value) -> ToolExecutionOutput {
    ToolExecutionOutput {
        success: false,
        output: "Windows-only tool.".to_string(),
        backup_id: None,
    }
}

#[cfg(target_os = "windows")]
fn run_media_control(args: &Value) -> ToolExecutionOutput {
    use std::mem::size_of;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
        VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_VOLUME_DOWN,
        VK_VOLUME_MUTE, VK_VOLUME_UP,
    };

    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let vk: VIRTUAL_KEY = match action {
        "play_pause" => VK_MEDIA_PLAY_PAUSE,
        "next" => VK_MEDIA_NEXT_TRACK,
        "previous" => VK_MEDIA_PREV_TRACK,
        "mute" => VK_VOLUME_MUTE,
        "volume_up" => VK_VOLUME_UP,
        "volume_down" => VK_VOLUME_DOWN,
        _ => {
            return ToolExecutionOutput {
                success: false,
                output: format!("Unsupported media action \"{action}\""),
                backup_id: None,
            };
        }
    };

    let mk = |up: bool| INPUT {
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
    };
    let inputs = [mk(false), mk(true)];
    unsafe {
        let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
    }

    ToolExecutionOutput {
        success: true,
        output: format!("Sent Windows media command `{action}`."),
        backup_id: None,
    }
}

#[cfg(not(target_os = "windows"))]
fn run_media_control(_args: &Value) -> ToolExecutionOutput {
    ToolExecutionOutput {
        success: false,
        output: "Windows-only tool.".to_string(),
        backup_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_destructive_powershell_and_system_paths() {
        let warn = detect_destructive_warning(
            "run_powershell",
            &json!({ "command": "Remove-Item -Recurse -Force C:\\Users\\foo" }),
        );
        assert!(warn.is_some());

        let safe = detect_destructive_warning(
            "run_powershell",
            &json!({ "command": "Get-Process | Select-Object -First 5" }),
        );
        assert!(safe.is_none());

        let sys_write = detect_destructive_warning(
            "write_file",
            &json!({ "path": "C:\\Windows\\System32\\evil.dll", "content": "x" }),
        );
        assert!(sys_write.is_some());
    }

    #[test]
    fn classifies_tool_tiers_correctly() {
        assert_eq!(tool_tier("get_system_info"), 0);
        assert_eq!(tool_tier("control_window"), 1);
        assert_eq!(tool_tier("run_powershell"), 2);
        assert_eq!(tool_tier("mcp__github__create_issue"), 2);
    }
}
