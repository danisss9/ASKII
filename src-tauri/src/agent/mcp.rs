use crate::config::McpServerConfig;
use crate::llm::ToolDefinition;
use reqwest::Client;
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub fn build_mcp_tool_name(server_id: &str, tool_name: &str) -> String {
    let clean_server: String = server_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("mcp__{clean_server}__{tool_name}")
}

pub fn parse_mcp_tool_name(full_name: &str) -> Option<(String, String)> {
    let rest = full_name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    let server = rest[..idx].to_string();
    let tool = rest[idx + 2..].to_string();
    if server.is_empty() || tool.is_empty() {
        None
    } else {
        Some((server, tool))
    }
}

pub fn jsonrpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

async fn http_rpc(client: &Client, url: &str, method: &str, params: Value) -> Result<Value, String> {
    let req = jsonrpc_request(1, method, params);
    let resp = client
        .post(url)
        .timeout(Duration::from_secs(12))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("MCP HTTP error ({url}): {e}"))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("MCP HTTP body error: {e}"))?;
    let val: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid MCP JSON-RPC response: {e}"))?;
    if let Some(err) = val.get("error") {
        return Err(format!("MCP error: {err}"));
    }
    Ok(val.get("result").cloned().unwrap_or(Value::Null))
}

async fn stdio_rpc(
    command: &str,
    args: &[String],
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server \"{command}\": {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "MCP stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP stdout unavailable".to_string())?;

    let init = jsonrpc_request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "askii", "version": crate::config::APP_VERSION }
        }),
    );
    let call = jsonrpc_request(2, method, params);

    let payload = format!("{init}\n{call}\n");
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("MCP write failed: {e}"))?;
    let _ = stdin.flush().await;
    drop(stdin);

    let mut reader = BufReader::new(stdout).lines();
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.get("id").and_then(|v| v.as_u64()) == Some(2) {
                    if let Some(err) = val.get("error") {
                        return Err(format!("MCP error: {err}"));
                    }
                    return Ok(val.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }
        Err("MCP server closed without responding.".to_string())
    })
    .await
    .map_err(|_| "MCP server timed out.".to_string())?;

    let _ = child.kill().await;
    result
}

pub async fn discover_mcp_tools(servers: &[McpServerConfig]) -> Vec<ToolDefinition> {
    let client = Client::new();
    let mut out = Vec::new();

    for server in servers.iter().filter(|s| s.enabled) {
        let res = if server.transport.eq_ignore_ascii_case("http") {
            if let Some(ref url) = server.url {
                http_rpc(&client, url, "tools/list", json!({})).await
            } else {
                continue;
            }
        } else if let Some(ref cmd) = server.command {
            stdio_rpc(cmd, &server.args, "tools/list", json!({})).await
        } else {
            continue;
        };

        if let Ok(val) = res {
            if let Some(arr) = val.get("tools").and_then(|t| t.as_array()) {
                for tool in arr {
                    let Some(name) = tool.get("name").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let desc = tool
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("External MCP tool");
                    let schema = tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                    out.push(ToolDefinition {
                        name: build_mcp_tool_name(&server.id, name),
                        description: format!("[MCP:{}] {}", server.name, desc),
                        parameters: schema,
                    });
                }
            }
        }
    }

    out
}

pub async fn invoke_mcp_tool(
    servers: &[McpServerConfig],
    full_name: &str,
    arguments: Value,
) -> Result<String, String> {
    let (clean_server_id, tool_name) = parse_mcp_tool_name(full_name)
        .ok_or_else(|| format!("Invalid MCP tool name: {full_name}"))?;

    let server = servers
        .iter()
        .find(|s| {
            s.enabled
                && s.id
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect::<String>()
                    == clean_server_id
        })
        .ok_or_else(|| format!("MCP server \"{clean_server_id}\" is not configured or enabled."))?;

    let params = json!({
        "name": tool_name,
        "arguments": arguments,
    });

    let val = if server.transport.eq_ignore_ascii_case("http") {
        let url = server
            .url
            .as_deref()
            .ok_or_else(|| "MCP HTTP server has no URL.".to_string())?;
        http_rpc(&Client::new(), url, "tools/call", params).await?
    } else {
        let cmd = server
            .command
            .as_deref()
            .ok_or_else(|| "MCP stdio server has no command.".to_string())?;
        stdio_rpc(cmd, &server.args, "tools/call", params).await?
    };

    if let Some(arr) = val.get("content").and_then(|c| c.as_array()) {
        let texts: Vec<String> = arr
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()).map(String::from))
            .collect();
        if !texts.is_empty() {
            return Ok(texts.join("\n"));
        }
    }

    Ok(serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_parses_mcp_tool_names() {
        let full = build_mcp_tool_name("my-github", "list_issues");
        assert_eq!(full, "mcp__my_github__list_issues");
        let parsed = parse_mcp_tool_name(&full).unwrap();
        assert_eq!(parsed, ("my_github".to_string(), "list_issues".to_string()));
        assert!(parse_mcp_tool_name("run_powershell").is_none());
    }

    #[test]
    fn formats_jsonrpc_envelope() {
        let req = jsonrpc_request(2, "tools/list", json!({}));
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["id"], 2);
        assert_eq!(req["method"], "tools/list");
    }
}
