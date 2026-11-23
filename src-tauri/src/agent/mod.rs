pub mod backup;
pub mod browser;
pub mod mcp;
pub mod screen;
pub mod tools;

use crate::config::{AgentMode, AgentSettings};
use crate::llm::providers::ProviderConnection;
use crate::llm::{ChatMessage, StreamEvent, ToolDefinition, stream_chat_with_tools};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentRunCapabilities {
    pub allow_screen_control: bool,
    pub allow_browser_control: bool,
}

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
    pub screen_state: screen::ScreenControlState,
    pub browser_controller: browser::BrowserController,
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

pub fn resolve_tools_for_run(
    settings: &AgentSettings,
    caps: AgentRunCapabilities,
    mcp_defs: Vec<ToolDefinition>,
) -> Vec<ToolDefinition> {
    let mut defs = if settings.enabled {
        let mut base = tools::builtin_tool_definitions();
        base.extend(mcp_defs);
        base
    } else {
        Vec::new()
    };

    if caps.allow_screen_control {
        defs.extend(screen::screen_tool_definitions());
    }
    if caps.allow_browser_control {
        defs.extend(browser::browser_tool_definitions());
    }
    defs
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
    caps: AgentRunCapabilities,
    initial_messages: Vec<ChatMessage>,
    cancel: CancellationToken,
    on_event: &Channel<StreamEvent>,
) -> Result<bool, String> {
    let mcp_defs = if settings.enabled && !settings.mcp_servers.is_empty() {
        mcp::discover_mcp_tools(&settings.mcp_servers).await
    } else {
        Vec::new()
    };
    let mut all_tools = resolve_tools_for_run(settings, caps, mcp_defs);

    let mut messages = initial_messages;
    let max_steps = if caps.allow_screen_control || caps.allow_browser_control {
        settings.max_steps.max(15).clamp(1, 25) as usize
    } else {
        settings.max_steps.clamp(1, 20) as usize
    };
    let mut last_truncated = false;
    let mut overlay_hidden_for_screen = false;

    let restore_overlay_if_hidden = |hidden: &mut bool| {
        if *hidden {
            crate::window::show_askii_with_context(app, false, None, None);
            *hidden = false;
        }
    };

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
                match stream_chat_with_tools(conn, &messages, None, cancel.clone(), move |chunk| {
                    let _ = ch_retry.send(StreamEvent::Chunk { text: chunk });
                })
                .await
                {
                    Ok(o) => o,
                    Err(e) => {
                        restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
                        return Err(e);
                    }
                }
            }
            Err(err) => {
                restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
                return Err(err);
            }
        };

        last_truncated = outcome.truncated;

        if outcome.tool_calls.is_empty() {
            restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
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
                restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
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

            if !auto_ok {
                restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
            }

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
                        restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
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

            let exec = if screen::is_screen_tool(&call.name) {
                if !caps.allow_screen_control {
                    tools::ToolExecutionOutput::err(
                        "Screen mouse/keyboard control is disabled unless the user uses the /screen command.",
                    )
                } else {
                    screen::execute_screen_tool(
                        app,
                        &runtime.screen_state,
                        &call.name,
                        &call.arguments,
                        &mut overlay_hidden_for_screen,
                    )
                    .await
                }
            } else if browser::is_browser_tool(&call.name) {
                if !caps.allow_browser_control {
                    tools::ToolExecutionOutput::err(
                        "Chrome Puppeteer control is disabled unless the user uses the /browser command.",
                    )
                } else {
                    browser::execute_browser_tool(
                        &runtime.browser_controller,
                        &call.name,
                        &call.arguments,
                    )
                    .await
                }
            } else if call.name.starts_with("mcp__") {
                match mcp::invoke_mcp_tool(&settings.mcp_servers, &call.name, call.arguments.clone())
                    .await
                {
                    Ok(output) => tools::ToolExecutionOutput::ok(output),
                    Err(e) => tools::ToolExecutionOutput::err(e),
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
                images: exec.images,
                tool_calls: Vec::new(),
                tool_call_id: Some(call.id),
                name: Some(call.name),
            });
        }
    }

    restore_overlay_if_hidden(&mut overlay_hidden_for_screen);
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

    #[test]
    fn gates_screen_and_browser_tools_behind_explicit_capabilities() {
        let settings = AgentSettings::default();

        let default_tools =
            resolve_tools_for_run(&settings, AgentRunCapabilities::default(), Vec::new());
        assert!(!default_tools.iter().any(|t| screen::is_screen_tool(&t.name)));
        assert!(!default_tools.iter().any(|t| browser::is_browser_tool(&t.name)));

        let screen_only = resolve_tools_for_run(
            &settings,
            AgentRunCapabilities {
                allow_screen_control: true,
                allow_browser_control: false,
            },
            Vec::new(),
        );
        assert!(screen_only.iter().any(|t| t.name == "screen_capture"));
        assert!(screen_only.iter().any(|t| t.name == "screen_mouse_click"));
        assert!(screen_only.iter().any(|t| t.name == "screen_keyboard_type"));
        assert!(!screen_only.iter().any(|t| browser::is_browser_tool(&t.name)));

        let browser_only = resolve_tools_for_run(
            &settings,
            AgentRunCapabilities {
                allow_screen_control: false,
                allow_browser_control: true,
            },
            Vec::new(),
        );
        assert!(browser_only.iter().any(|t| t.name == "browser_navigate"));
        assert!(browser_only.iter().any(|t| t.name == "browser_click"));
        assert!(!browser_only.iter().any(|t| screen::is_screen_tool(&t.name)));
    }
}
