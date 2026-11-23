# Contributing to ASKII

Thanks for helping! Bug reports, ideas, and pull requests are all welcome.

## Project Structure (v2.0 Desktop)

ASKII 2.0 is a Windows desktop application built with **Angular 22** (frontend) and **Tauri v2 / Rust** (native OS backend):

- `src/` — Angular 22 UI (spotlight input, receipt print paper, setup morph, history drawer, sticky slip window, state service, autocomplete, markdown renderer, Tauri IPC bridge)
- `src-tauri/` — Tauri v2 Rust backend:
  - `src-tauri/src/llm/` — Streaming LLM client & 8 provider connectors + model discovery
  - `src-tauri/src/agent/` — ASKII Do tool loop, 13 native Windows tools, rollback backups, and `stdio`/`http` MCP client
  - `src-tauri/src/commands.rs` — Tauri IPC command handlers
  - `src-tauri/src/config.rs` — Config persistence (`config.json`) & Windows Credential Manager integration
  - `src-tauri/src/storage.rs` — Local SQLite archive for slips and personal memory
  - `src-tauri/src/launcher.rs` — Instant math/unit/dev evaluators, window switcher, and Start Menu indexer
  - `src-tauri/src/clipboard_ring.rs`, `context.rs`, `tray.rs`, `voice.rs`, `window.rs` — Windows OS integrations
- `public/` — Static assets

## Setup (Windows)

Install **Node.js 22+**, the **Rust toolchain** (`rustup` / `cargo`), and the [Tauri v2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows), then:

```powershell
git clone https://github.com/danisss9/ASKII.git
cd ASKII
npm install
npm run tauri:dev
```

## Before you open a pull request

```powershell
npm test                                          # Angular Vitest unit tests
npm run build                                     # Production Angular build & TypeScript check
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

- Add or update unit tests for behavior changes — especially anything touching agent tools, destructive guardrails, backup/restore, LLM protocol parsing, SQLite storage, or autocomplete.
- Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Keep any new slash commands, context mentions, providers, or security safeguards documented in [README.md](README.md) and [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

1. Bump the version in **all three** manifests (keep them identical — CI checks):
   - `package.json` (and `package-lock.json`)
   - `src-tauri/Cargo.toml` (and `src-tauri/Cargo.lock`)
   - `src-tauri/tauri.conf.json`
2. Move the `## [Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under the new version heading.
3. Commit, then push a tag `askii_<version>` (e.g. `askii_2.0.0`).

The release workflow runs CI checks, verifies the tag matches all manifest versions, builds the Windows NSIS installer via Tauri, and publishes a GitHub Release.
