use crate::agent::tools::{enumerate_visible_windows, focus_window_by_hwnd};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedApp {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstantResult {
    pub id: String,
    pub kind: String, // "calc" | "unit" | "util" | "app" | "window"
    pub label: String,
    pub description: String,
    pub badge: String,
    pub copy_value: Option<String>,
    pub launch_path: Option<String>,
    pub hwnd: Option<isize>,
}

pub fn scan_windows_start_menu_apps() -> Vec<IndexedApp> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Ok(progdata) = std::env::var("ProgramData") {
        roots.push(
            PathBuf::from(progdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }

    let mut seen = HashSet::new();
    let mut apps = Vec::new();

    for root in roots {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root).max_depth(5).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if !matches!(ext.as_str(), "lnk" | "url" | "exe") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let name = stem.trim().to_string();
            let lower = name.to_ascii_lowercase();
            if name.is_empty()
                || lower.contains("uninstall")
                || lower.contains("readme")
                || lower.contains("help")
                || !seen.insert(lower)
            {
                continue;
            }
            apps.push(IndexedApp {
                name,
                path: path.display().to_string(),
            });
        }
    }

    apps.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    apps
}

pub fn query_instant_results(raw_query: &str, apps: &[IndexedApp]) -> Vec<InstantResult> {
    let trimmed = raw_query.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return Vec::new();
    }

    let (force_launcher, query) = if let Some(rest) = trimmed.strip_prefix('>') {
        (true, rest.trim())
    } else {
        (false, trimmed)
    };

    let mut out = Vec::new();

    // 1. Instant local utilities & math/unit evaluators (unless forced launcher-only with empty query)
    if !force_launcher {
        if let Some(util) = eval_dev_utility(query) {
            out.push(util);
        }
        if let Some(unit) = eval_unit_conversion(query) {
            out.push(unit);
        }
        if let Some(calc) = eval_math_expression(query) {
            out.push(calc);
        }
    }

    // 2. Open windows + installed Windows apps when `>` is used OR query is short app-like token (1-2 words, >= 2 chars)
    let word_count = query.split_whitespace().count();
    let should_search_launcher = force_launcher || (!query.is_empty() && query.len() >= 2 && word_count <= 2 && !query.contains('?'));

    if should_search_launcher {
        let needle = query.to_ascii_lowercase();

        // Open windows (instant focus)
        let windows = enumerate_visible_windows();
        let mut win_matches: Vec<_> = windows
            .into_iter()
            .filter(|w| needle.is_empty() || w.title.to_ascii_lowercase().contains(&needle))
            .collect();
        win_matches.sort_by_key(|w| {
            if w.title.to_ascii_lowercase().starts_with(&needle) {
                0
            } else {
                1
            }
        });
        for w in win_matches.into_iter().take(if force_launcher { 4 } else { 2 }) {
            out.push(InstantResult {
                id: format!("win-{}", w.hwnd),
                kind: "window".to_string(),
                label: w.title.clone(),
                description: "Switch to open window · Enter to focus".to_string(),
                badge: "WINDOW".to_string(),
                copy_value: None,
                launch_path: None,
                hwnd: Some(w.hwnd),
            });
        }

        // Installed apps from Start Menu
        let mut app_matches: Vec<&IndexedApp> = apps
            .iter()
            .filter(|a| needle.is_empty() || a.name.to_ascii_lowercase().contains(&needle))
            .collect();
        app_matches.sort_by_key(|a| {
            let l = a.name.to_ascii_lowercase();
            if l == needle {
                0
            } else if l.starts_with(&needle) {
                1
            } else {
                2
            }
        });
        for app in app_matches.into_iter().take(if force_launcher { 6 } else { 3 }) {
            out.push(InstantResult {
                id: format!("app-{}", app.name),
                kind: "app".to_string(),
                label: app.name.clone(),
                description: "Launch Windows app · Enter to open".to_string(),
                badge: "APP".to_string(),
                copy_value: None,
                launch_path: Some(app.path.clone()),
                hwnd: None,
            });
        }
    }

    out.truncate(7);
    out
}

pub fn execute_instant_result(item: &InstantResult) -> Result<String, String> {
    if let Some(ref copy) = item.copy_value {
        let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {e}"))?;
        cb.set_text(copy.clone())
            .map_err(|e| format!("Copy failed: {e}"))?;
        return Ok(format!("Copied \"{copy}\" to clipboard"));
    }
    if let Some(hwnd) = item.hwnd {
        focus_window_by_hwnd(hwnd)?;
        return Ok(format!("Switched to \"{}\"", item.label));
    }
    if let Some(ref path) = item.launch_path {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to launch \"{}\": {e}", item.label))?;
            return Ok(format!("Launched {}", item.label));
        }
    }
    Err("Nothing to execute for this item.".to_string())
}

fn eval_dev_utility(query: &str) -> Option<InstantResult> {
    let lower = query.trim().to_ascii_lowercase();
    if lower == "uuid" || lower == "guid" {
        let val = Uuid::new_v4().to_string();
        return Some(InstantResult {
            id: "util-uuid".to_string(),
            kind: "util".to_string(),
            label: val.clone(),
            description: "Fresh UUID v4 · Enter to copy".to_string(),
            badge: "UUID".to_string(),
            copy_value: Some(val),
            launch_path: None,
            hwnd: None,
        });
    }
    if lower == "now" || lower == "epoch" || lower == "timestamp" {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let val = secs.to_string();
        return Some(InstantResult {
            id: "util-now".to_string(),
            kind: "util".to_string(),
            label: format!("{val} (Unix epoch seconds)"),
            description: "Current Unix timestamp · Enter to copy".to_string(),
            badge: "TIME".to_string(),
            copy_value: Some(val),
            launch_path: None,
            hwnd: None,
        });
    }
    if let Some(rest) = query.strip_prefix("b64 ").or_else(|| query.strip_prefix("base64 ")) {
        let encoded = BASE64.encode(rest.as_bytes());
        return Some(InstantResult {
            id: "util-b64".to_string(),
            kind: "util".to_string(),
            label: encoded.clone(),
            description: "Base64 encoded · Enter to copy".to_string(),
            badge: "B64".to_string(),
            copy_value: Some(encoded),
            launch_path: None,
            hwnd: None,
        });
    }
    if query.starts_with('#') && (query.len() == 7 || query.len() == 4) {
        let hex = &query[1..];
        if hex.chars().all(|c| c.is_ascii_hexdigit()) {
            let expanded = if hex.len() == 3 {
                hex.chars().flat_map(|c| [c, c]).collect::<String>()
            } else {
                hex.to_string()
            };
            let r = u8::from_str_radix(&expanded[0..2], 16).ok()?;
            let g = u8::from_str_radix(&expanded[2..4], 16).ok()?;
            let b = u8::from_str_radix(&expanded[4..6], 16).ok()?;
            let rgb = format!("rgb({r}, {g}, {b})");
            return Some(InstantResult {
                id: "util-color".to_string(),
                kind: "util".to_string(),
                label: format!("{query} = {rgb}"),
                description: "Color conversion · Enter to copy RGB".to_string(),
                badge: "COLOR".to_string(),
                copy_value: Some(rgb),
                launch_path: None,
                hwnd: None,
            });
        }
    }
    None
}

pub fn eval_unit_conversion(query: &str) -> Option<InstantResult> {
    // Matches "<number> <from> to <to>" or "<number> <from> in <to>"
    let tokens: Vec<&str> = query.split_whitespace().collect();
    if tokens.len() != 4 {
        return None;
    }
    let sep = tokens[2].to_ascii_lowercase();
    if sep != "to" && sep != "in" {
        return None;
    }
    let val: f64 = tokens[0].parse().ok()?;
    let from = tokens[1].to_ascii_lowercase();
    let to = tokens[3].to_ascii_lowercase();

    let converted = convert_units(val, &from, &to)?;
    let formatted = format_number(converted);
    let result_str = format!("{formatted} {to}");

    Some(InstantResult {
        id: format!("unit-{from}-{to}"),
        kind: "unit".to_string(),
        label: format!("= {result_str}"),
        description: format!("{val} {from} → {to} · Enter to copy"),
        badge: "UNIT".to_string(),
        copy_value: Some(formatted),
        launch_path: None,
        hwnd: None,
    })
}

fn convert_units(v: f64, from: &str, to: &str) -> Option<f64> {
    // Temperature
    match (from, to) {
        ("c" | "celsius", "f" | "fahrenheit") => return Some(v * 9.0 / 5.0 + 32.0),
        ("f" | "fahrenheit", "c" | "celsius") => return Some((v - 32.0) * 5.0 / 9.0),
        ("c" | "celsius", "k" | "kelvin") => return Some(v + 273.15),
        ("k" | "kelvin", "c" | "celsius") => return Some(v - 273.15),
        _ => {}
    }

    // Length (meters base)
    let len_m = |u: &str| match u {
        "mm" => Some(0.001),
        "cm" => Some(0.01),
        "m" | "meter" | "meters" => Some(1.0),
        "km" | "kilometer" | "kilometers" => Some(1000.0),
        "in" | "inch" | "inches" => Some(0.0254),
        "ft" | "foot" | "feet" => Some(0.3048),
        "yd" | "yard" | "yards" => Some(0.9144),
        "mi" | "mile" | "miles" => Some(1609.344),
        _ => None,
    };
    if let (Some(a), Some(b)) = (len_m(from), len_m(to)) {
        return Some(v * a / b);
    }

    // Mass (grams base)
    let mass_g = |u: &str| match u {
        "mg" => Some(0.001),
        "g" | "gram" | "grams" => Some(1.0),
        "kg" | "kilogram" | "kilograms" => Some(1000.0),
        "oz" | "ounce" | "ounces" => Some(28.349523125),
        "lb" | "lbs" | "pound" | "pounds" => Some(453.59237),
        _ => None,
    };
    if let (Some(a), Some(b)) = (mass_g(from), mass_g(to)) {
        return Some(v * a / b);
    }

    // Data size (bytes base, binary 1024)
    let data_b = |u: &str| match u {
        "b" | "bytes" => Some(1.0),
        "kb" => Some(1024.0),
        "mb" => Some(1024.0_f64.powi(2)),
        "gb" => Some(1024.0_f64.powi(3)),
        "tb" => Some(1024.0_f64.powi(4)),
        _ => None,
    };
    if let (Some(a), Some(b)) = (data_b(from), data_b(to)) {
        return Some(v * a / b);
    }

    None
}

pub fn eval_math_expression(query: &str) -> Option<InstantResult> {
    let expr = query.trim().strip_prefix('=').unwrap_or(query.trim()).trim();
    if expr.is_empty() {
        return None;
    }
    // Require at least one operator so plain numbers like "42" don't hijack the dropdown unless prefixed with "="
    let has_op = expr.contains('+')
        || expr.contains('-')
        || expr.contains('*')
        || expr.contains('/')
        || expr.contains('^')
        || expr.contains('%');
    if !has_op && !query.trim().starts_with('=') {
        return None;
    }
    // Only allow math characters
    if !expr
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '*' | '/' | '^' | '%' | '(' | ')' | '.' | ' '))
    {
        return None;
    }

    let val = parse_math(expr)?;
    if !val.is_finite() {
        return None;
    }
    let formatted = format_number(val);
    Some(InstantResult {
        id: "calc-result".to_string(),
        kind: "calc".to_string(),
        label: format!("= {formatted}"),
        description: format!("{expr} · Enter to copy"),
        badge: "CALC".to_string(),
        copy_value: Some(formatted),
        launch_path: None,
        hwnd: None,
    })
}

fn format_number(val: f64) -> String {
    if (val - val.round()).abs() < 1e-9 && val.abs() < 1e15 {
        format!("{}", val.round() as i64)
    } else {
        let s = format!("{val:.6}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// Simple safe recursive-descent math parser (+ - * / % ^ parentheses)
struct MathParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> MathParser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    fn parse_expr(&mut self) -> Option<f64> {
        let mut left = self.parse_term()?;
        while let Some(op) = self.peek() {
            if op == b'+' || op == b'-' {
                self.pos += 1;
                let right = self.parse_term()?;
                left = if op == b'+' { left + right } else { left - right };
            } else {
                break;
            }
        }
        Some(left)
    }

    fn parse_term(&mut self) -> Option<f64> {
        let mut left = self.parse_power()?;
        while let Some(op) = self.peek() {
            if op == b'*' || op == b'/' || op == b'%' {
                self.pos += 1;
                let right = self.parse_power()?;
                left = match op {
                    b'*' => left * right,
                    b'/' => {
                        if right == 0.0 {
                            return None;
                        }
                        left / right
                    }
                    b'%' => {
                        if right == 0.0 {
                            return None;
                        }
                        left % right
                    }
                    _ => unreachable!(),
                };
            } else {
                break;
            }
        }
        Some(left)
    }

    fn parse_power(&mut self) -> Option<f64> {
        let base = self.parse_unary()?;
        if self.peek() == Some(b'^') {
            self.pos += 1;
            let exp = self.parse_power()?;
            Some(base.powf(exp))
        } else {
            Some(base)
        }
    }

    fn parse_unary(&mut self) -> Option<f64> {
        match self.peek()? {
            b'-' => {
                self.pos += 1;
                Some(-self.parse_unary()?)
            }
            b'+' => {
                self.pos += 1;
                self.parse_unary()
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Option<f64> {
        if self.peek() == Some(b'(') {
            self.pos += 1;
            let val = self.parse_expr()?;
            if self.peek() != Some(b')') {
                return None;
            }
            self.pos += 1;
            return Some(val);
        }

        self.skip_ws();
        let start = self.pos;
        let mut saw_dot = false;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b.is_ascii_digit() {
                self.pos += 1;
            } else if b == b'.' && !saw_dot {
                saw_dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .ok()?
            .parse::<f64>()
            .ok()
    }
}

pub fn parse_math(input: &str) -> Option<f64> {
    let mut p = MathParser {
        bytes: input.as_bytes(),
        pos: 0,
    };
    let val = p.parse_expr()?;
    p.skip_ws();
    if p.pos == p.bytes.len() {
        Some(val)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_math_expressions_accurately() {
        assert_eq!(eval_math_expression("(1280 * 0.85) / 4").unwrap().copy_value.as_deref(), Some("272"));
        assert_eq!(eval_math_expression("2^10").unwrap().copy_value.as_deref(), Some("1024"));
        assert!(eval_math_expression("42").is_none());
        assert_eq!(eval_math_expression("= 42").unwrap().copy_value.as_deref(), Some("42"));
    }

    #[test]
    fn evaluates_unit_conversions_and_dev_utilities() {
        let temp = eval_unit_conversion("100 c to f").unwrap();
        assert_eq!(temp.copy_value.as_deref(), Some("212"));

        let data = eval_unit_conversion("2 gb to mb").unwrap();
        assert_eq!(data.copy_value.as_deref(), Some("2048"));

        let color = eval_dev_utility("#1d4ed8").unwrap();
        assert_eq!(color.copy_value.as_deref(), Some("rgb(29, 78, 216)"));

        let uuid = eval_dev_utility("uuid").unwrap();
        assert_eq!(uuid.copy_value.unwrap().len(), 36);
    }
}
