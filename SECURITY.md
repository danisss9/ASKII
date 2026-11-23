# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/danisss9/ASKII/security/advisories/new)
(Security → Advisories → Report a vulnerability) rather than in a public issue. Include the ASKII
version, your Windows version, the LLM provider (and any MCP server involved), and steps to
reproduce. You should get a first response within a week; fixes ship in a patch release with a
CHANGELOG entry crediting the reporter (unless you prefer otherwise).

Only the latest released version is supported with security fixes.

## Threat model

ASKII 2.0 is an OS-level desktop assistant that can read context you attach and execute Windows
tools via **ASKII Do** and configured **MCP servers**. Its primary risk is **a model taking an
unintended action** — either from misunderstanding your request or from prompt injection inside
attached text, files, fetched web pages, screenshots, or tool output. The safeguards below assume
model output is untrusted.

### ASKII Do (Windows OS agent)

- **3-tier permission model**:
  - **Tier 0** (read-only info/search/read/fetch) runs automatically
  - **Tier 1** (open app/URL, window management, media controls, toast reminders) runs automatically by default and can be toggled to require confirmation in `/agent`
  - **Tier 2** (`run_powershell`, `write_file`, `move_or_rename_file`, and all external MCP tools) requires explicit per-action approval (**Allow once**, **Allow for session**, or **Deny**) in default `Confirm` mode
- **Destructive-command guardrails**: even when **Auto Do** autonomous mode (`/autodo`) is enabled, ASKII pauses for confirmation whenever `run_powershell` matches risky patterns (`rm -rf`, `Remove-Item`, `Format-Volume`, `Clear-Disk`, `del /s`, `rmdir /s`, `reg delete`, `Stop-Computer`, `Restart-Computer`, `shutdown /s`, `bcdedit`) or when `write_file` / `move_or_rename_file` targets `C:\Windows` (unless the user explicitly disables `guardDestructiveCommands` in `/agent`)
- **Sensitive file read block**: `read_file` refuses common credential/secret locations (`.ssh\id_*`, `.aws\credentials`, `Windows\System32\config\SAM`) and caps reads at 64 KB
- **Command timeouts**: `run_powershell` runs non-interactively with `-NoProfile` and a 30-second timeout
- **Automatic rollback backups**: `write_file` and `move_or_rename_file` create a local backup snapshot under `%LOCALAPPDATA%\dev.askii.desktop\backups\` before modifying disk state, with 1-click **Undo** in the receipt card
- **MCP servers**: external `stdio` and `http` MCP servers are user-configured and run with your Windows user privileges; all MCP tool calls are classified as **Tier 2**

### Credentials, clipboard & local data

- **API keys** are stored natively in **Windows Credential Manager** (`keyring` crate under service `dev.askii.desktop`) — never written to `config.json` or SQLite
- **Private clipboard history ring** (`@clip:1..15`) stays strictly in memory (never written to disk), can be disabled in configuration, and automatically ignores copies made while password managers are in the foreground (`1Password`, `KeePass`, `KeePassXC`, `Bitwarden`, `LastPass`, `Dashlane`, `Enpass`, `RoboForm`)
- **Markdown sanitization**: rendered assistant markdown in the Angular UI is sanitized with DOMPurify
- **Local vs Cloud indicator**: the overlay surfaces whether the active model is local (Ollama / LM Studio) or cloud-hosted so you always know before sending context

See [README.md](README.md#privacy-security--data-storage) for local storage paths and what data is sent to configured endpoints.
