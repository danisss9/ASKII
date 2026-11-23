pub mod backup;
pub mod mcp;
pub mod tools;

use crate::config::{AgentMode, AgentSettings};
use crate::llm::providers::ProviderConnection;
use crate::llm::{ChatMessage, StreamEvent, stream_chat_with_tools};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowSession,
    Deny,
}

#[derive(Default)]
pub struct AgentRuntime {
    pub pending_approvals: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    pub session_allowed_tools: Mutex<HashSet<String>>,
}

impl AgentRuntime {
    pub fn resolve_approval(&self, call_id: &str, decision: ApprovalDecision) -> bool {
        let sender = self.pending_approvals.lock().unwrap().remove(call_id);
        if let Some(tx) = sender {
            let _ = tx.send(decision);
            true
        } else {
            false
        }
    }

    pub fn cancel_all_pending(&self) {
        let mut map = self.pending_approvals.lock().unwrap();
        for (_, tx) in map.drain() {
            let _ = tx.send(ApprovalDecision::Deny);
        }
    }
}

pub fn should_auto_approve(
    settings: &AgentSettings,
    tier: u8,
    tool_name: &str,
    danger_warning: Option<&str>,
    session_allowed: &HashSet<String>,
) -> bool {
    if danger_warning.is_some() && settings.guard_destructive_commands {
        return false;
    }
    if tier == 0 {
        return true;
    }
    if settings.mode == AgentMode::AutoDo {
        return true;
    }
    if tier == 1 && settings.auto_approve_desktop_controls {
        return true;
    }
    session_allowed.contains(tool_name)
}

#[allow(clippy::too_many_arguments)]
pub async fn run_agent_chat(
    app: &AppHandle,
    runtime: &AgentRuntime,
    conn: &ProviderConnection,
    settings: &AgentSettings,
    initial_messages: Vec<ChatMessage>,
    cancel: CancellationToken,
    on_event: &Channel<StreamEvent>,
) -> Result<bool, String> {
    let mut all_tools = if settings.enabled {
        let mut defs = tools::builtin_tool_definitions();
        if !settings.mcp_servers.is_empty() {
            let mcp_defs = mcp::discover_mcp_tools(&settings.mcp_servers).await;
            defs.extend(mcp_defs);
        }
        defs
    } else {
        Vec::new()
    };

    let mut messages = initial_messages;
    let max_steps = settings.max_steps.clamp(1, 20) as usize;
    let mut last_truncated = false;

    for step in 0..max_steps {
        let tools_slice = if all_tools.is_empty() {
            None
        } else {
            Some(all_tools.as_slice())
        };

        let ch_chunks = on_event.clone();
        let outcome = stream_chat_with_tools(
            conn,
            &messages,
            tools_slice,
            cancel.clone(),
            move |chunk| {
                let _ = ch_chunks.send(StreamEvent::Chunk { text: chunk });
            },
        )
        .await;

        let outcome = match outcome {
            Ok(o) => o,
            // If the model/endpoint doesn't support tool calling and returns 400 on step 0, gracefully retry without tools.
            Err(err) if step == 0 && !all_tools.is_empty() && err.contains("HTTP 400") => {
                all_tools.clear();
                let ch_retry = on_event.clone();
                stream_chat_with_tools(conn, &messages, None, cancel.clone(), move |chunk| {
                    let _ = ch_retry.send(StreamEvent::Chunk { text: chunk });
                })
                .await?
            }
            Err(err) => return Err(err),
        };

        last_truncated = outcome.truncated;

        if outcome.tool_calls.is_empty() {
            return Ok(last_truncated);
        }

        // Record assistant's message including its requested tool calls
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: outcome.text,
            images: Vec::new(),
            tool_calls: outcome.tool_calls.clone(),
            tool_call_id: None,
            name: None,
        });

        for call in outcome.tool_calls {
            if cancel.is_cancelled() {
                return Err("__CANCELLED__".to_string());
            }

            let tier = tools::tool_tier(&call.name);
            let summary = tools::summarize_tool_call(&call.name, &call.arguments);
            let danger_warning = tools::detect_destructive_warning(&call.name, &call.arguments);

            let auto_ok = {
                let allowed_set = runtime.session_allowed_tools.lock().unwrap();
                should_auto_approve(
                    settings,
                    tier,
                    &call.name,
                    danger_warning.as_deref(),
                    &allowed_set,
                )
            };

            let _ = on_event.send(StreamEvent::ToolProposed {
                call_id: call.id.clone(),
                name: call.name.clone(),
                tier,
                summary: summary.clone(),
                arguments: call.arguments.clone(),
                needs_approval: !auto_ok,
                danger_warning: danger_warning.clone(),
            });

            if !auto_ok {
                let (tx, rx) = oneshot::channel();
                runtime
                    .pending_approvals
                    .lock()
                    .unwrap()
                    .insert(call.id.clone(), tx);

                let decision = tokio::select! {
                    _ = cancel.cancelled() => {
                        runtime.pending_approvals.lock().unwrap().remove(&call.id);
                        return Err("__CANCELLED__".to_string());
                    }
                    res = rx => res.unwrap_or(ApprovalDecision::Deny),
                };

                match decision {
                    ApprovalDecision::AllowOnce => {}
                    ApprovalDecision::AllowSession => {
                        runtime
                            .session_allowed_tools
                            .lock()
                            .unwrap()
                            .insert(call.name.clone());
                    }
                    ApprovalDecision::Deny => {
                        let _ = on_event.send(StreamEvent::ToolDenied {
                            call_id: call.id.clone(),
                            name: call.name.clone(),
                            reason: "Denied by user".to_string(),
                        });
                        messages.push(ChatMessage {
                            role: "tool".to_string(),
                            content: "Tool execution was denied by the user.".to_string(),
                            images: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_call_id: Some(call.id.clone()),
                            name: Some(call.name.clone()),
                        });
                        continue;
                    }
                }
            }

            let _ = on_event.send(StreamEvent::ToolRunning {
                call_id: call.id.clone(),
                name: call.name.clone(),
            });

            let exec = if call.name.starts_with("mcp__") {
                match mcp::invoke_mcp_tool(&settings.mcp_servers, &call.name, call.arguments.clone())
                    .await
                {
                    Ok(output) => tools::ToolExecutionOutput {
                        success: true,
                        output,
                        backup_id: None,
                    },
                    Err(e) => tools::ToolExecutionOutput {
                        success: false,
                        output: e,
                        backup_id: None,
                    },
                }
            } else {
                tools::execute_builtin_tool(app, &call.name, &call.arguments).await
            };

            let _ = on_event.send(StreamEvent::ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                success: exec.success,
                output: exec.output.clone(),
                backup_id: exec.backup_id.clone(),
            });

            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: exec.output,
                images: Vec::new(),
                tool_calls: Vec::new(),
                tool_call_id: Some(call.id),
                name: Some(call.name),
            });
        }
    }

    Ok(last_truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_mode_vs_auto_do_and_destructive_guardrail() {
        let mut settings = AgentSettings::default();
        let empty = HashSet::new();

        // Confirm mode: Tier 0 auto, Tier 1 auto (default), Tier 2 requires confirm
        assert!(should_auto_approve(&settings, 0, "get_system_info", None, &empty));
        assert!(should_auto_approve(&settings, 1, "control_window", None, &empty));
        assert!(!should_auto_approve(&settings, 2, "run_powershell", None, &empty));

        // Session allowlist approves Tier 2 when not destructive
        let mut allowed = HashSet::new();
        allowed.insert("run_powershell".to_string());
        assert!(should_auto_approve(&settings, 2, "run_powershell", None, &allowed));

        // Auto Do mode approves Tier 2 automatically
        settings.mode = AgentMode::AutoDo;
        assert!(should_auto_approve(&settings, 2, "run_powershell", None, &empty));

        // Destructive guardrail STILL pauses even in Auto Do mode
        assert!(!should_auto_approve(
            &settings,
            2,
            "run_powershell",
            Some("Recursive delete"),
            &empty
        ));

        // If user explicitly disables guardrail in Auto Do, allow
        settings.guard_destructive_commands = false;
        assert!(should_auto_approve(
            &settings,
            2,
            "run_powershell",
            Some("Recursive delete"),
            &empty
        ));
    }
}
