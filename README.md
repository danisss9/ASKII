# ASKII 2.0 ( •_•)>⌐■-■ (⌐■_■)

An OS-level AI personal assistant & instant launcher for Windows built with **Tauri v2 (Rust)** and **Angular 22** — a complete ground-up remake of [ASKII](https://askii.dev/).

> **Looking for ASKII v1.0?** The legacy VS Code extension and `askii-cli` npm package remain on the [`main`](https://github.com/danisss9/ASKII/tree/main) branch.

## Quick start

1. Install ASKII Desktop (or run from source — see [Development & Build](#development--build-windows)).
2. Press **`Alt+Space`** (or click the **(⌐■_■)** system tray icon) to open the floating spotlight overlay.
3. Complete the first-run **Setup** (`/setup`) by choosing one of the 8 LLM connectors, entering an API key (stored in **Windows Credential Manager**) or local server URL, and selecting a model.
4. Ask anything, attach screen/clipboard context with `@` mentions, run built-in recipes with `/`, or let **ASKII Do** perform OS tasks with one-click approval and rollback.

## Features

### Always-Available System Tray & Dynamic Overlay

- **Global shortcuts** — Toggle ASKII from anywhere with **`Alt+Space`**, or capture the active selection and summon ASKII immediately with **`Alt+Shift+Space`** (both customizable in `/shortcut`).
- **Smart placement & sizing** — Opens centered on the active monitor, automatically resizes window height to fit answers, supports `/pin` to stay visible while switching windows, and optionally starts with Windows.
- **Tactile receipt-slip UI** — Streaming markdown answers print onto a tearable receipt slip with live status kaomoji, follow-up turns, and **1-click `Insert` (`Ctrl+Enter`)** to paste the response directly back into your previous application.

### OS Context Awareness & Vision

- **Selection capture (`Alt+Shift+Space`)** — Automatically attaches text highlighted in your previous window.
- **Clipboard & private clipboard ring (`@clip`, `@clip:1..15`, `Ctrl+V`)** — Attach current clipboard text or images, or pick from the last 15 copied text snippets. Entries copied from password managers (1Password, KeePass, KeePassXC, Bitwarden, LastPass, Dashlane, Enpass, RoboForm) are automatically skipped.
- **Active window & screenshots (`@window`, `@screen`, `@winscreen`, `/snip`)** — Attach the foreground window's title/process info or capture full-display / active-window PNG screenshots for vision-capable models.
- **Drag-and-drop files** — Drop text files or images directly onto the overlay to include them as context attachments.

### "ASKII Do" Agent, Auto Do Mode & MCP

ASKII Do equips your model with native Windows OS tools using a 3-tier permission model and receipt-style approval cards:

| Tier | Tools | Default behavior (`Confirm` mode) |
| --- | --- | --- |
| **Tier 0** (Read-only) | `get_system_info`, `list_open_windows`, `search_files`, `read_file`, `list_directory`, `fetch_url` | Runs automatically |
| **Tier 1** (Desktop controls) | `open_app_or_url`, `control_window` (focus/minimize/maximize/restore/snap left & right), `media_control` (play/pause/next/prev/volume/mute), `set_timer_reminder` (Windows toast notifications) | Runs automatically (configurable in `/agent`) |
| **Tier 2** (Mutating / Power) | `run_powershell` (30s timeout), `write_file`, `move_or_rename_file`, and all **MCP server** tools | Prompts for approval (**Allow once**, **Allow for session**, or **Deny**) |

- **Auto Do mode (`/autodo`)** — Lets ASKII Do execute Tier 2 actions autonomously up to `maxSteps` (default 10, max 20) while **still pausing on destructive commands** (`rm -rf`, `Remove-Item`, `Format-Volume`, `Clear-Disk`, `del /s`, `rmdir /s`, `reg delete`, `Stop-Computer`, `Restart-Computer`, `shutdown /s`, `bcdedit`, or writes/moves targeting `C:\Windows`) whenever the destructive-command guardrail is enabled.
- **Automatic rollback backups & 1-click Undo** — Every `write_file` and `move_or_rename_file` saves a local snapshot first so you can restore the previous file (or remove a newly created file) with one click.
- **MCP servers (`/agent`)** — Connect external **Model Context Protocol** servers over `stdio` or `http` to extend ASKII Do with custom tools.

### Instant Launcher & Local Evaluators

Sub-50ms local results right inside the spotlight input — no LLM round-trip required:

- **Calculator** — Math expressions such as `(1280 * 0.85) / 4`, `2^10`, or `= 42` (`Enter` to copy).
- **Unit conversions** — Temperature (`100 c to f`, `0 c to k`), length (`5 km to mi`), mass (`10 kg to lb`), and binary data sizes (`2 gb to mb`).
- **Dev utilities** — `uuid` / `guid` (fresh UUID v4), `now` / `epoch` / `timestamp` (Unix epoch seconds), `b64 <text>` / `base64 <text>`, and `#hex` (`#1d4ed8` → `rgb(...)`).
- **Window switcher & Start Menu app launcher** — Type an app or window name (or prefix with `>` to force launcher mode) to switch to any open window or launch installed Start Menu apps. Refresh the index anytime with `/reindex`.

### Persistent SQLite Slips, Sticky Windows, Memory & Voice

- **Archived receipt slips (`/history`)** — Every conversation slip is stored locally in SQLite so you can search, reopen, continue, or delete past sessions.
- **Floating Sticky windows** — Detach any slip into a standalone always-on-top sticky note window while you work.
- **Personal memory (`/remember`, `/memory`)** — Save preferences or facts (e.g. `/remember I prefer PowerShell 7`) that are transparently injected into future prompts and manageable at any time.
- **Voice-to-Ask dictation** — Record voice straight from the input bar and transcribe via a custom local Whisper server URL (`whisperUrl`), your OpenAI API key, or ASKII Cloud.

## Slash Commands, Recipes & Context Mentions

### Slash Commands

| Command | Action |
| --- | --- |
| `/screen <task>` | Opt-in Windows mouse, keyboard & desktop vision control (`screen_capture`, `screen_mouse_*`, `screen_keyboard_*`) — disabled on normal prompts |
| `/browser <task>` | Opt-in Chrome browser automation via Puppeteer (`browser_launch`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_tabs`) — disabled on normal prompts |
| `/model [filter]` | Hot-switch between recently used providers & models without opening Setup |
| `/autodo` | Toggle **Auto Do** autonomous OS action mode on or off |
| `/agent` | Configure ASKII Do permissions, Auto Do mode, destructive guardrails, and MCP servers |
| `/snip [window]` | Capture full display or active window screenshot for vision |
| `/history` | Search, reopen, detach, or delete archived receipt slips from local SQLite |
| `/remember <fact>` | Save a personal preference or fact into persistent memory |
| `/memory` | View or delete saved personal memories |
| `/reindex` | Refresh the Windows Start Menu instant app launcher index |
| `/setup` / `/provider` / `/shortcut` | Open Setup for providers, models, global shortcuts, Whisper URL, and Windows startup |
| `/pin` | Pin or unpin the overlay so it stays visible when switching windows |
| `/clear` | Tear off the current receipt slip and clear attachments |
| `/hide` | Hide ASKII back into the Windows system tray |
| `/quit` | Exit ASKII completely |

### Built-in Prompt Recipes

Recipes are configurable in `config.json` and auto-attach your current selection/clipboard when enabled:

| Recipe | Action |
| --- | --- |
| `/fix` | Fix grammar, clarity, and tone — returns clean ready-to-insert text |
| `/translate [lang]` | Translate attached text or prompt into the requested language (defaults to English) |
| `/summarize` | Distill attached text, file, or screenshot into crisp bullet points |
| `/explain` | Explain code, errors, or concepts concisely with root cause and fix first |
| `/shell` | Generate a Windows PowerShell one-liner with a brief explanation |

### Context Mentions

| Mention | Action |
| --- | --- |
| `@clip` | Attach current Windows clipboard text or image |
| `@clip:1` … `@clip:15` | Attach a specific entry from the private in-memory clipboard history ring |
| `@window` | Attach the foreground window's title and process info |
| `@screen` | Capture a full display screenshot for vision analysis |
| `@winscreen` | Capture a screenshot of the active target window |

## LLM Providers

ASKII 2.0 ships with **8 native LLM connectors** and a **Local (green) vs Cloud (blue)** privacy indicator in the UI:

| Provider | Type | Endpoint / Setup |
| --- | --- | --- |
| **ASKII Cloud** (default) | Cloud | API key (`https://api.askii.dev/v1`), default model `askii-smart` |
| **OpenAI / Compatible** | Cloud / Custom | API key + optional custom base URL (defaults to `https://api.openai.com/v1`) |
| **Anthropic** | Cloud | API key (`https://api.anthropic.com`) |
| **Google Gemini** | Cloud | API key (`https://generativelanguage.googleapis.com/v1beta`) |
| **OpenRouter** | Cloud | API key (`https://openrouter.ai/api/v1`) |
| **opencode Go** | Cloud | API key (`https://opencode.ai/zen/go/v1`) |
| **[Ollama](https://ollama.com)** | Local | Server URL (defaults to `http://localhost:11434`) |
| **[LM Studio](https://lmstudio.ai)** | Local | Server URL (defaults to `http://localhost:1234`) |

## Privacy, Security & Data Storage

- **Credentials** — All API keys are stored natively in **Windows Credential Manager** under service `dev.askii.desktop`, never in plaintext config files.
- **Local storage locations**:
  - Configuration: `%APPDATA%\dev.askii.desktop\config.json`
  - Slips & memories SQLite DB: `%LOCALAPPDATA%\dev.askii.desktop\askii.db`
  - ASKII Do file rollback backups: `%LOCALAPPDATA%\dev.askii.desktop\backups\`
- **Clipboard privacy** — The in-memory clipboard ring (`@clip:1..15`) never persists to disk and automatically ignores password managers.
- **No telemetry** — ASKII sends prompts, attachments, and tool outputs only to the LLM/Whisper/MCP endpoints you configure. Choose **Ollama** or **LM Studio** (plus a local Whisper endpoint) to keep everything 100% on-device.

See [SECURITY.md](SECURITY.md) for the full threat model and vulnerability reporting instructions.

## Development & Build (Windows)

### Prerequisites

- **Windows 10/11** with WebView2 Runtime (preinstalled on Windows 11)
- **Node.js 22+** and **npm**
- **Rust toolchain** (`rustup`, `cargo`) + MSVC C++ Build Tools (see [Tauri v2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows))

### Commands

```powershell
# Install frontend dependencies
npm install

# Run ASKII Desktop in development mode (Angular dev server + Tauri Rust backend)
npm run tauri:dev

# Run Angular (Vitest) unit tests
npm test

# Run Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml

# Build production Angular bundle
npm run build

# Build Windows .exe + NSIS installer
npm run tauri:build
```

## Contributing & License

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
