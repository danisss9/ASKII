# Change Log

All notable changes to the "askii" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.4.0] - 2026-07-07

### Added

- **ASKII Cloud platform support**: Added `askiicloud` as a new LLM platform across the extension and CLI, powered by ASKII Cloud — an in-house, OpenAI-compatible inference service at [https://api.askii.dev](https://api.askii.dev). All it needs is an API key
- **`askii.askiicloudApiKey` setting**: Your ASKII Cloud API key (used when any `llm*Platform` is `askiicloud`)
- **`getAskiiCloudResponse` / `getAskiiCloudChat` / `getAskiiCloudChatStreaming`** in `common/providers.ts`: Shared ASKII Cloud provider functions (thin wrappers over the OpenAI-compatible client, pinned to `ASKII_CLOUD_URL`); vision (base64 images) and streaming are supported
- **Per-feature LLM platform/model settings**: Replaced the per-provider model settings with a single model setting per feature group, so each ASKII capability can target a different platform and model without duplicating config:
  - `askii.llmModel` (default: `askii-smart`) — model id for ASKII Ask, Edit, Do and Generate
  - `askii.llmInlinePlatform` (default: `askiicloud`) and `askii.llmInlineModel` (default: `askii-fast`) — platform and model for ASKII inline suggestions, inline completion and git commit message generation
  - `askii.llmVisionPlatform` (default: `askiicloud`) and `askii.llmVisionModel` (default: `askii-smart`) — platform and model for ASKII Browse, Control and Note (vision-capable features)
- **CLI flags / env vars**: `--askiicloud-key` (`ASKII_CLOUD_KEY`), `--askiicloud-model` (`ASKII_CLOUD_MODEL`); selectable via `-p askiicloud` and the REPL `/platform askiicloud`

### Changed

- **Status-bar quick-pick menu**: Renamed the **Generate Commit Message** entry to **ASKII Git** and moved it to sit above **Reload Wiki** and below **ASKII Browse** for a more logical grouping
- **Default LLM platform is now ASKII Cloud**: `askii.llmPlatform` now defaults to `askiicloud` (previously `ollama`), so ASKII works out of the box once an `askii.askiicloudApiKey` is set. The CLI default platform remains `ollama`.
- **opencode Go base URL is no longer configurable**: The `askii.opencodegoUrl` setting and the `--opencodego-url` CLI flag / `ASKII_OPENCODEGO_URL` env var have been removed. opencode Go now always uses `https://opencode.ai/zen/go/v1` (via the `OPENCODE_GO_URL` constant in `common/providers.ts`).
- **ASKII Cloud base URL is no longer configurable**: The `askii.askiicloudUrl` setting and the `--askiicloud-url` CLI flag / `ASKII_CLOUD_URL` env var have been removed. ASKII Cloud now always uses `https://api.askii.dev/v1` (via the `ASKII_CLOUD_URL` constant in `common/providers.ts`).
- **`getExtensionResponseWithImage`** (Browse / Control) now reads `askii.llmVisionPlatform` and `askii.llmVisionModel` instead of `askii.llmPlatform` and the platform's default model.
- **`getExtensionResponseStreaming` / `getExtensionChat` / `getExtensionChatStreaming`** (Ask / Do) now read `askii.llmModel` instead of the per-provider model settings.
- **`getLLMExplanation`** (inline helper mode) now resolves its platform and model from `askii.llmInlinePlatform` / `askii.llmInlineModel` instead of `askii.inlinePlatform` / `askii.inlineModel`.
- **Inline completion and commit message generation** now use `askii.llmInlinePlatform` / `askii.llmInlineModel` instead of `askii.inlinePlatform` / `askii.inlineModel`.

### Removed

- **Per-provider model settings**: Replaced by the per-feature `askii.llmModel` / `askii.llmInlineModel` / `askii.llmVisionModel` settings. The following have been removed:
  - `askii.ollamaModel`
  - `askii.lmStudioModel`
  - `askii.openaiModel`
  - `askii.anthropicModel`
  - `askii.opencodegoModel`
  - `askii.askiicloudModel`
- **`askii.inlinePlatform` and `askii.inlineModel` settings**: Replaced by `askii.llmInlinePlatform` and `askii.llmInlineModel` (no more `"default"` sentinel — each feature group now has its own explicit platform and model).
- **`askii.opencodegoUrl` setting**: opencode Go now always uses `https://opencode.ai/zen/go/v1`.
- **`askii.askiicloudUrl` setting**: ASKII Cloud now always uses `https://api.askii.dev/v1`.
- **`resolvePlatform` helper** in `src/providers.ts`: No longer needed now that each feature group reads its own `llm*Platform` setting directly.
- **Codebase wiki (code wiki) feature**: Removed the code wiki RAG feature entirely, leaving only the docs wiki (`askii.wikiPath` / `askii.wikiEnabled`) for documentation context. The following have been removed:
  - `common/codewiki.ts` module (MiniSearch index over workspace code files)
  - `ASKII: Reload Code Wiki` command (`askii.reloadCodeWiki`) and its status-bar menu entry
  - `askii.codeWikiEnabled` and `askii.codeWikiAutoReload` settings
  - `code_search` Do action type and its handling in the Do agent (extension + CLI)
  - Code-wiki context injection in Ask / Edit / Do commands and inline completion
  - CLI `code-wiki-reload` command, `/code-wiki-reload` REPL command, and `--code-wiki-path` / `--use-code-wiki` flags (plus `ASKII_CODE_WIKI_PATH` / `ASKII_USE_CODE_WIKI` env vars)
- **GitHub Copilot LLM provider**: Removed `copilot` as a selectable LLM platform from the extension and CLI. The `askii.copilotModel` setting, the `copilot` enum value in `askii.llmPlatform` / `askii.inlinePlatform`, and all Copilot-specific code paths in `src/providers.ts` (including `getCopilotResponse`) have been removed. Use any of the remaining platforms — `ollama`, `lmstudio`, `openai`, `anthropic`, `opencodego`, or `askiicloud` — instead.

## [0.3.1] - 2026-06-23

### Added

- **CLI interactive mode**: Running `askii` with no arguments now starts a persistent REPL instead of showing help and exiting. Inspired by Claude Code, OpenCode, and Copilot CLI
  - Bare text input sends a message to the LLM with **persistent chat history** across turns (same conversation until `/clear`)
  - `/command` slash-commands with **Tab autocomplete**: `/ask`, `/do`, `/edit`, `/explain`, `/wiki-reload`, `/code-wiki-reload`, `/platform`, `/model`, `/config`, `/clear`, `/exit`, `/quit`
  - `/do <task> [--max-rounds N] [--yes]` runs the Do agent inside the REPL and returns to the `>` prompt when done; Ctrl+C during `/do` cancels only the agent
  - `/edit --file <path> "<instruction>"` edits a file in place without needing stdin
  - `/platform <name>` and `/model <name>` switch the LLM platform/model for the current session (platform switch also updates the default model)
  - Bare `--flag` overrides at the prompt (e.g. `--max-rounds 10`) update session config without restarting
  - Welcome banner showing current platform, model, workspace, and wiki status
  - Ctrl+C at the idle prompt exits cleanly

## [0.3.0] - 2026-06-20

### Added

- **opencode Go platform support**: Added `opencodego` as a new LLM platform across the extension and CLI, powered by [opencode Go](https://opencode.ai/go) — a hosted, multi-model coding subscription (GLM, Kimi, DeepSeek, Mimo, Qwen, MiniMax, and more)
- **`askii.opencodegoApiKey` setting**: Your opencode Go API key (used when `llmPlatform` is `opencodego`). Get it from [https://opencode.ai/go](https://opencode.ai/go)
- **`askii.opencodegoModel` setting**: opencode Go model id (default: `glm-5.2`; e.g. `kimi-k2.7-code`, `deepseek-v4-pro`, `qwen3.7-max`, `minimax-m3`). See the full list at [https://opencode.ai/zen/go/v1/models](https://opencode.ai/zen/go/v1/models)
- **`askii.opencodegoUrl` setting**: opencode Go base URL (default: `https://opencode.ai/zen/go/v1`); override only if needed
- **`getOpenCodeGoResponse` / `getOpenCodeGoChat` / `getOpenCodeGoChatStreaming`** in `common/providers.ts`: Shared opencode Go provider functions that route per model — Qwen and MiniMax over opencode Go's Anthropic-compatible `/messages` endpoint, all other models over its OpenAI-compatible `/chat/completions` endpoint (`isOpenCodeGoAnthropicModel()` + `OPENCODE_GO_URL`). Reuses the existing OpenAI and Anthropic clients; vision (base64 images) and streaming are supported
- **Optional `baseURL` on the Anthropic provider functions**: `getAnthropicResponse` / `getAnthropicChat` / `getAnthropicChatStreaming` now accept an optional `baseURL`, enabling Anthropic-compatible endpoints such as opencode Go
- **CLI `--opencodego-key`, `--opencodego-model`, `--opencodego-url` flags**: CLI equivalents of the extension settings; also readable via `ASKII_OPENCODEGO_KEY`, `ASKII_OPENCODEGO_MODEL`, `ASKII_OPENCODEGO_URL` environment variables
- **`askii.inlinePlatform` setting**: Choose a separate LLM platform for inline auto-complete **and** inline helper mode decorations (`default` | `ollama` | `copilot` | `lmstudio` | `openai` | `anthropic` | `opencodego`, default: `default`). When set to `default`, the value of `askii.llmPlatform` is used, so inline features can run on a different provider than the main Ask / Edit / Do commands (e.g. a fast local model for ghost text, a stronger cloud model for chat).
- **`askii.inlineModel` setting**: Model id for inline auto-complete **and** helper mode (default: `default`). When set to `default`, the selected platform's default model is used (`askii.ollamaModel`, `askii.copilotModel`, `askii.openaiModel`, `askii.anthropicModel`, `askii.lmStudioModel`, or `askii.opencodegoModel`). Set it to any model id supported by the chosen platform to override.
- **Commit Message Generator** (`askii.generateCommitMessage` command): A new command that reads the staged diff (falling back to the working-tree diff when nothing is staged) from the built-in `vscode.git` extension and writes an AI-generated commit message straight into the Source Control commit-message input box. Uses the same LLM platform/model as inline completion (`askii.inlinePlatform` / `askii.inlineModel`), so it can run on a different provider than the main Ask / Edit / Do commands. A **sparkle (✦)** button is added to the Source Control view title toolbar via the `scm/title` menu (visible when a Git repository is open); also available from the command palette, the status-bar quick-pick menu, and the `Ctrl+Shift+K G` / `Cmd+Shift+K G` keybinding (active when a Git repository is open). The diff is capped at ~12 000 characters to keep latency and token usage reasonable.
- **`askii.commitMessageInstructions` setting**: Path to a `.md` file with custom instructions for the commit message generator (e.g. "always use Conventional Commits and reference the Jira ticket in the body"). Its contents are appended to the built-in system prompt. May be absolute or relative to the workspace root; leave empty to use the built-in prompt (default: `""`).

### Changed

- **Updated default LLM models for all providers**:
  - `askii.ollamaModel`: `gemma3:270m` → `gemma4:e4b`
  - `askii.copilotModel`: `gpt-4o` → `gpt-5-mini`
  - `askii.openaiModel`: `gpt-4o` → `gpt-5-mini`
  - `askii.anthropicModel`: `claude-opus-4-6` → `claude-sonnet-4-6`
  - `askii.lmStudioModel`: unchanged (`qwen/qwen3-coder-30b`)
- **`getExtensionResponse` signature**: Now accepts optional `platformOverride` and `modelOverride` parameters so callers (inline completion) can target a different platform/model than the global `askii.llmPlatform`.
- **`getLLMExplanation`**: Now resolves its platform via `askii.inlinePlatform` and its model via `askii.inlineModel` instead of always using `askii.llmPlatform` and the platform's default model.
- **README**: Refreshed the Configuration and Requirements sections to reflect the new default models, documented the `askii.copilotModel` setting, and added a new "Inline Platform & Model" section explaining how to run inline features on a different provider than the main commands.

## [0.2.12] - 2026-06-11

### Added

- **Code Auto-completion**: Replaced terminal/chat inline completion with a code completion engine for all code files. Ghost text appears after a configurable delay; press Tab to accept, Esc to dismiss — VS Code's native `editor.inlineSuggest` handles it with no custom keybindings required.
- **`askii.inlineCompletionEagerness` setting**: `low` (1 200 ms debounce, wide context), `medium` (500 ms, default), or `high` (200 ms, narrow context) — controls how frequently completions are requested and how much surrounding code is sent.
- **Accept/reject tracking**: Each suggestion carries an ID; accepting via Tab records it, and the next prompt tells the model whether the previous suggestion was accepted or rejected so it can self-correct.
- **Codebase wiki** (`common/codewiki.ts`): Index workspace code files into a BM25 full-text search index (powered by MiniSearch, same engine as the docs wiki). Chunks in 60-line overlapping windows; skips `node_modules`, `dist`, `out`, `build`, and files over 200 KB. Stored as `.askii-code-wiki-index.json` in the workspace root.
- **`ASKII: Reload Code Wiki` command** (`askii.reloadCodeWiki`): Walks all supported code files in the workspace, builds the MiniSearch index, and saves it with a progress notification and chunk/file count summary. Also available in the status-bar quick-pick menu.
- **`askii.codeWikiEnabled` setting**: Enable codebase wiki context injection for inline completion, Ask, Edit, and Do commands (default: `false`). Run **ASKII: Reload Code Wiki** first.
- **`askii.codeWikiAutoReload` setting**: Automatically rebuild the codebase wiki index on extension startup (default: `false`). Requires `askii.codeWikiEnabled`.
- **`code_search` Do action**: The Do agent can issue `{"type": "code_search", "query": "..."}` to retrieve relevant code chunks from the indexed codebase, analogous to `wiki_search`.
- **Codebase wiki context in Ask / Edit**: When `askii.codeWikiEnabled` is true, the top matching code chunks are prepended as `Relevant code from the codebase:` context alongside any docs wiki context.
- **CLI `code-wiki-reload` command**: Build the codebase wiki index from `--code-wiki-path` (default: cwd).
- **CLI `--use-code-wiki` / `--code-wiki-path` flags**: Enable codebase wiki context for `ask`, `edit`, and `do`. Also readable via `ASKII_USE_CODE_WIKI=1` / `ASKII_CODE_WIKI_PATH` environment variables.

### Changed

- **Inline completion targets code files**: The provider is now registered for `{ scheme: 'file' }` and `{ scheme: 'untitled' }` instead of terminal and chat schemes.
- **Debounce + cancellation hardened**: A `latestRequestId` guard ensures stale LLM responses from superseded requests never produce ghost text.

### Removed

- **`askii.inlineCompletionScreenshot` setting**: Screenshot capture is no longer part of inline completion. Screenshots are still used by ASKII Control and ASKII Browse.

## [0.2.10] - 2026-04-28

### Added

- **Terminal and Chat Prompts Auto-completion**: Added inline ghost text completions in VS Code terminal and GitHub Copilot/Claude chat input boxes.
- **`askii.inlineCompletionEnabled` setting**: Boolean option (default: `false`) — enables ASKII inline auto-completion for terminal and chat prompts.
- **`askii.inlineCompletionScreenshot` setting**: Boolean option (default: `false`) — when enabled, incorporates a low-res screen capture as visual context to improve the inline completions.

## [0.2.9] - 2026-04-23

### Added

- **Keybindings**: Added default chorded keybindings starting with `Ctrl+Shift+K` (Mac: `Cmd+Shift+K`) followed by an intuitive letter for each command (e.g., `A` for Ask, `E` for Edit, `D` for Do).

## [0.2.8] - 2026-04-21

### Added

- **`askii.wikiAutoReload` setting**: Boolean option (default: `false`) — when enabled alongside `askii.wikiEnabled`, the wiki index is automatically rebuilt and reloaded every time the extension starts, so your docs are always fresh without running **Reload Wiki** manually
- **Early Provider Validation**: Verifies LLM configurations (missing API keys, unavailable Copilot, dead local endpoints from Ollama/LM Studio) as soon as the extension activates or settings change. Actionable warning notifications direct users straight to the settings pane.

### Changed

- **Hardened Ask Panel**:
  - Injected `nonce`-based CSP constraints and disabled `localResourceRoots` to prevent executing arbitrary code or loading unrelated disk assets in the response webview window.
  - Added stricter `typeof` and failure guards when processing host-webview messages.
  - Made the response copy button show visual `Copy failed` feedback instead of failing silently when clipboard writing throws.
  - Included a safe Markdown render fallback.
- **Tightened Typings and Lint Coverage**:
  - Activated the `eslint` script on `common/` files to establish identical lint constraints as `src/`.
  - Enabled rigorous compiler checks across `tsconfig.json` configurations including `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedParameters`, and OS-agnostic path constraints (`forceConsistentCasingInFileNames`).

### Fixed

- **Wiki context stale on follow-up questions**: In Ask ASKII, wiki context was fetched once for the initial question and reused for all follow-ups. It is now re-queried with each follow-up question so the injected documentation matches what was actually asked
- **`wikiEnabled` ignored in ASKII Do**: The Do command was loading the wiki index regardless of the `askii.wikiEnabled` setting. It now correctly checks `wikiEnabled` before loading or injecting wiki context

## [0.2.7] - 2026-03-15

### Added

- **Anthropic platform support**: Added `anthropic` as a new LLM platform across the extension and CLI, powered by the official `@anthropic-ai/sdk` npm package
- **`askii.anthropicApiKey` setting**: Your Anthropic API key (used when `llmPlatform` is `anthropic`)
- **`askii.anthropicModel` setting**: Anthropic model to use (default: `claude-opus-4-6`; also supports `claude-sonnet-4-6`, `claude-haiku-4-5`, etc.)
- **`getAnthropicResponse` / `getAnthropicChat` / `getAnthropicChatStreaming`** in `common/providers.ts`: Shared Anthropic provider functions supporting system prompts, vision (base64 images), streaming chat, and proper system-role extraction (Anthropic API takes `system` as a top-level parameter rather than a message role)
- **CLI `--anthropic-key`, `--anthropic-model` flags**: CLI equivalents of the extension settings; also readable via `ASKII_ANTHROPIC_KEY`, `ASKII_ANTHROPIC_MODEL` environment variables
- **Wiki RAG system** (`common/wiki.ts`): Index any folder of `.md` documentation files into a local vector database and inject the most relevant chunks as context into Ask, Edit, and Do commands
- **`minisearch` vector database**: The wiki index uses [MiniSearch](https://github.com/lucaong/minisearch) — a pure JavaScript/TypeScript BM25 full-text search library with no native dependencies, fully bundled into the extension. Supports fuzzy matching, prefix search, and heading-boosted relevance scoring
- **`askii.wikiPath` setting**: Path to a folder containing `.md` documentation files to index
- **`askii.wikiEnabled` setting**: Toggle wiki RAG context on/off for Ask / Edit / Do commands (requires `askii.wikiPath` to be set and indexed)
- **`ASKII: Reload Wiki` command** (`askii.reloadWiki`): Walks all `.md` files under `askii.wikiPath`, splits them into chunks by heading, builds the MiniSearch index, and saves it as `.askii-wiki-index.json` inside the wiki folder. Shows a progress notification spinner with step messages and a completion notification reporting chunk and file counts. Also available in the status-bar quick-pick menu
- **Wiki context injection in Ask / Edit / Do**: When `askii.wikiEnabled` is true, ASKII searches the index for the top 3 most relevant chunks and prepends them as `Relevant documentation:` context before sending the prompt to the LLM
- **`"wiki"` inline helper mode**: New `inlineHelperMode` option that searches the wiki index for the current line, injects the top 2 matching chunks as documentation context, then asks the LLM for a one-sentence explanation — combining wiki knowledge with LLM reasoning. `enumDescriptions` added to all four inline modes in the extension manifest
- **In-memory wiki cache**: The raw `WikiIndexData` (disk read + JSON parse) and the deserialized `MiniSearch` instance are both cached at module level after the first load. Subsequent calls — including every inline decoration trigger — use the cache with zero disk I/O. `saveWikiIndex` warms both caches immediately so the first query after a reload is also fast
- **CLI `wiki-reload` command**: Indexes `.md` files from `--wiki-path` and saves the index. Reports chunk and file counts on completion
- **CLI `--wiki-path` flag / `ASKII_WIKI_PATH` env var**: Path to the wiki docs folder for the CLI
- **CLI `--use-wiki` flag / `ASKII_USE_WIKI=1` env var**: Enable wiki context injection for CLI `ask`, `edit`, and `do` commands

## [0.2.6] - 2026-03-05

### Added

- **OpenAI platform support**: Added `openai` as a new LLM platform across the extension and CLI, powered by the official `openai` npm SDK
- **`askii.openaiApiKey` setting**: Your OpenAI API key (used when `llmPlatform` is `openai`)
- **`askii.openaiModel` setting**: OpenAI model to use (default: `gpt-4o`)
- **`askii.openaiUrl` setting**: Custom OpenAI-compatible base URL — leave empty for `api.openai.com`, or set to an Azure OpenAI endpoint or any compatible API
- **`getOpenAIResponse` / `getOpenAIChat`** in `common/providers.ts`: Shared OpenAI provider functions supporting system prompts, vision (base64 image_url), and optional custom `baseURL`
- **CLI `--openai-key`, `--openai-model`, `--openai-url` flags**: CLI equivalents of the extension settings; also readable via `ASKII_OPENAI_KEY`, `ASKII_OPENAI_MODEL`, `ASKII_OPENAI_URL` environment variables
- **Streaming responses in ASKII Do**: The Do command now streams LLM output token-by-token to the output channel / stderr instead of waiting for the full response — all four providers (Ollama, OpenAI, LM Studio, Copilot) supported. New `getOllamaChatStreaming`, `getOpenAIChatStreaming`, `getLMStudioChatStreaming` in `common/providers.ts` and `getExtensionChatStreaming` / `getChatResponseStreaming` in `src/providers.ts` / `cli/index.ts`
- **`retryLLMCall` utility** (`common/providers.ts`): Generic retry wrapper for LLM calls — retries up to 2 times on transient failures with an optional callback for retry logging; used in the CLI `do` command
- **`scroll` browser action** (`common/browser.ts`): ASKII Browse can now scroll pages up or down (`{"action": "scroll", "direction": "up"|"down", "amount": 1-10}`). Implemented via `page.evaluate(() => window.scrollBy(...))`. Documented in the browser system prompt
- **`click_text` browser action** (`common/browser.ts`): Click a visible element by its exact text label instead of a CSS selector (`{"action": "click_text", "text": "Submit"}`). Executes a DOM search across all elements matching by `textContent` or `value`. Prefer over `click` when text is clearly readable
- **`click_text` control action** (`common/control.ts`): ASKII Control now accepts `click_text` — the system makes a second LLM call with the screenshot to resolve the text to pixel coordinates, then executes `mouse_left_click` at those coordinates. Documented in the control system prompt
- **`checkControlDependencies()`** (`common/control.ts`): Exported function that verifies required OS tools are installed (`xdotool` on Linux, `osascript` on macOS). Called at startup of both the extension and CLI control commands — shows a clear error listing missing tools instead of crashing mid-execution

### Fixed

- **ReDoS in workspace search**: The `pattern` field from LLM responses is now regex-escaped before being compiled, preventing potential denial-of-service from LLM-generated metacharacters in search actions
- **Raw response logged on empty parse**: When the `do` command LLM response parses to zero actions, the first 500 characters of the raw response are now logged so users can diagnose malformed LLM output

### Changed

- **Workspace listing limit raised 100 → 200** (`common/workspace.ts`): `getWorkspaceStructure` now returns up to 200 top-level entries (previously 100) and appends `[...N more items not shown]` when the directory exceeds the limit
- **ASKII Browse now uses `puppeteer-core`**: Replaced the full `puppeteer` package (which auto-downloads Chromium) with `puppeteer-core`, which requires an existing Chrome/Chromium installation. This removes the bundled browser download and reduces install size
- **`askii.chromePath` setting**: New string config for the extension (default: empty) that sets the path to the Chrome/Chromium executable used by ASKII Browse. Leave empty to use the system default. Example: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **`--chrome-path` CLI flag / `ASKII_CHROME_PATH` env var**: CLI equivalent of `askii.chromePath` — pass the path to Chrome via `--chrome-path /path/to/chrome` or the `ASKII_CHROME_PATH` environment variable

## [0.2.5] - 2026-03-03

### Added

- **New ASKII Control action types**: `mouse_double_click`, `mouse_drag` (from/to coordinates), `mouse_scroll` (direction + amount), and `key_press` (special keys and modifier combos like `ctrl+c`, `alt+tab`, `enter`, `escape`, `f5`, etc.)
- **Action sequences in Control**: The LLM can now return a JSON array of actions to execute in one round instead of a single action, reducing round-trips for simple multi-step tasks
- **Action history context in Control**: Each control round includes a summary of all previous actions (round, description, reasoning, whether the screen changed) so the LLM can track progress and avoid repeating steps
- **Two-phase zoom coordinate refinement in Control**: For single click actions (`mouse_left_click`, `mouse_right_click`, `mouse_double_click`), ASKII crops a 400×400 pixel region around the target, upscales it 2× with jimp, and sends it to the LLM for sub-pixel coordinate refinement before executing
- **Multi-monitor support in Control**: At startup, ASKII lists available displays (via `screenshot-desktop`) and prompts to select a monitor — both in the extension (QuickPick) and CLI (numbered list)
- **Stop mid-execution in Control**: The extension shows a cancellable progress notification; click **Stop** at any time to abort the loop. The CLI handles `Ctrl+C` (SIGINT) gracefully
- **Screenshot auto-downscaling**: Screenshots larger than 1920×1080 are automatically resized with jimp before being sent to the LLM, reducing token usage and latency
- **Per-action adaptive delays**: Each action type waits a calibrated amount of time after execution (mouse move: 300 ms, clicks: 800 ms, scroll: 500 ms, keyboard input: 1 000 ms, key press: 500 ms)
- **ASKII Browse command** (`askii.browseTask`): A new agentic browser command powered by Puppeteer. Give ASKII a natural-language task (e.g., "Search Google for foo and click the first result") and it will launch a browser, take screenshots of the current page, and drive it through a JSON-action protocol (goto, click, type, wait_for, back, forward, DONE) until the task is complete or `askii.doMaxRounds` is reached
- **`common/browser.ts` helper module**: Defines `BrowserAction` union type, `buildBrowserSystemPrompt`, `parseBrowserAction`, `describeBrowserAction`, `executeBrowserAction`, and `takePageScreenshot` helpers used by the browse loop
- **`askii.browserHeadless` setting**: Boolean config (default `false`) that controls whether ASKII Browse launches Puppeteer in headless mode. Set to `false` to watch the browser window while the agent works
- **Browse entry in status-bar quick-pick**: The `(⌐■_■)` status-bar menu now includes an **ASKII Browse** option
- **Puppeteer dependency**: Added `puppeteer ^24.3.0` as a runtime dependency; marked external in esbuild so Chromium is resolved from `node_modules` at runtime

### Changed

- **`jimp` replaces platform-specific image processing**: Crop-and-scale for the zoom phase (and screenshot downscaling) now uses jimp v0.22.12 (pure JS, bundles with esbuild) instead of temporary files + PowerShell/sips/ImageMagick — works cross-platform with no extra dependencies

### Removed

- **`askii.controlDelay` setting**: Replaced by per-action adaptive delays built into the control loop

## [0.2.4] - 2026-03-03

### Added

- **Streaming responses in Ask ASKII**: The webview now streams AI output in real time (token by token) for Ollama and Copilot; LM Studio delivers a single chunk. New `getOllamaResponseStreaming` in `common/providers.ts` and `getExtensionResponseStreaming` in `src/providers.ts`
- **Multi-turn follow-up in Ask ASKII**: A chat bubble button in the response panel lets you ask follow-up questions in the same conversation, maintaining context from previous turns
- **Copy response button in Ask ASKII**: Icon button in the panel header copies the raw response text to the clipboard with a visual checkmark confirmation
- **Ask ASKII works without a selection**: The command no longer requires an active editor or selected text — you can ask any free-form question; code context is included only when text is selected
- **File and language context in Ask ASKII**: When code is selected, the file name and language ID are included in the prompt so the LLM has richer context
- **ASKII Edit works without a selection**: When nothing is selected, the entire file is sent for editing. When a selection is present, the full file is included as context but only the selected portion is returned and replaced
- **ASKII Edit diff preview**: After applying an edit, VS Code's built-in diff editor opens side-by-side showing original vs. AI-proposed code, powered by a new `askii-diff://` in-memory content provider
- **Undo button after ASKII Edit**: The success notification now includes an "Undo" button that immediately reverts the applied edit
- **`--lang` and `--file` flags for CLI `ask` and `edit`**: Pass `--lang typescript --file src/utils.ts` to include language and filename metadata in the prompt (e.g. `cat myfile.ts | askii ask --lang typescript --file src/utils.ts "what does this do?"`)
- **GitHub Actions release workflow**: New `.github/workflows/release.yml` triggered on `askii_*` tags — packages the `.vsix`, publishes the CLI to npm, creates a GitHub Release with the `.vsix` attached, and publishes the extension to the VS Code Marketplace

### Changed

- **`CONTROL_SYSTEM_PROMPT` replaced with `buildControlSystemPrompt(width, height)`**: The control system prompt is now generated dynamically with the actual screenshot dimensions so the LLM knows the exact pixel bounds of the image
- **DPI-aware mouse coordinates in Control mode**: On macOS and Linux, physical screenshot pixel coordinates are now scaled down to logical screen points before being passed to `osascript` / `xdotool`, fixing misaligned clicks on HiDPI/Retina displays
- **Windows mouse coordinates clamped to 65535**: Normalized absolute mouse coordinates are now clamped to the valid `[0, 65535]` range, preventing overflow at the screen edges
- **`getExtensionResponse` accepts an optional `system` prompt**: All three platforms (Copilot, LM Studio, Ollama) now forward a system message when provided

## [0.2.3] - 2026-02-27

### Changed

- **Mouse/keyboard control is now bundleable**: Replaced `@nut-tree-fork/nut-js` (native Node module, incompatible with extension bundling) with platform-specific shell commands — PowerShell + `user32.dll` on Windows, `osascript` + `pbcopy` on macOS, and `xdotool` on Linux. No new runtime dependencies; uses only Node built-ins (`child_process`, `os`)
- **Keyboard input uses clipboard paste**: On Windows and macOS, `keyboard_input` now writes text to the clipboard and pastes it, avoiding `SendKeys`-style special-character escaping issues and supporting arbitrary Unicode text

### Removed

- `@nut-tree-fork/nut-js` dependency from both the extension and CLI packages

## [0.2.2] - 2026-02-27

### Added

- **`rename` action in ASKII Do**: LLM can now rename or move files (`{"type": "rename", "path": "old", "newPath": "new"}`). Confirmation prompt shown before executing; intermediate directories are created automatically
- **`list` action in ASKII Do**: LLM can list the contents of any folder (`{"type": "list", "path": "folder"}`). Results are returned to the LLM (like `view`) with `[file]` / `[folder]` labels so it can decide whether to drill deeper
- **Continuous agent loop in ASKII Do**: The `do` command now keeps asking the LLM "what next?" after every round — not only after view/list results. The loop only exits when the LLM returns `[]` or `doMaxRounds` is reached
- **Workspace listing printed at start of CLI `do`**: The working directory path and top-level file tree are printed to stderr when `askii do` begins, so you can see exactly what context the LLM receives

### Changed

- **`getWorkspaceStructure` is now flat / top-level only**: Instead of recursing into subdirectories, the initial workspace snapshot lists only the root entries with `[file]` / `[folder]` labels. The LLM can use the `list` action to explore subdirectories on demand, keeping the initial prompt compact

## [0.2.1] - 2026-02-27

### Fixed

- **LM Studio image support**: Updated image passing to use `client.files.prepareImageBase64()` and `FileHandle` — the API required by `@lmstudio/sdk` v1.5.0. The previous multimodal content block format (`imageUrl` in content array) was rejected by the SDK's runtime Zod validation, causing `Invalid parameter(s) for model.respond — chat: Invalid input` errors on any command using images (e.g. `control`)

## [0.2.0] - 2026-02-27

### Added

- **ASKII Control Command**: New screen control agent — give a natural language instruction, ASKII takes a screenshot, sends it to the LLM, and executes the returned action (mouse move, left click, right click, or keyboard input). Repeats until the LLM returns `DONE` or `doMaxRounds` is reached. Requires a vision-capable model (e.g. `llava`, `moondream2`)
- **Per-action Confirmation**: Each proposed action is shown with the AI's reasoning before executing; use `askii.doAutoConfirm` to skip prompts
- **Image Support in Providers**: Ollama provider now accepts an `images` array; LM Studio provider accepts a base64 image via multimodal content blocks
- **`getExtensionResponseWithImage`**: New extension provider function that routes image+prompt requests to the configured platform (Copilot falls back to text-only)
- **`common/control.ts`**: Shared control utilities — `ControlAction` type, `CONTROL_SYSTEM_PROMPT`, `takeScreenshot()`, `parseControlAction()`, `describeAction()`, `executeControlAction()`
- **CLI `control` command**: Same screenshot-loop flow available in the terminal (`askii control --ollama-model llava "..."`)
- **CLI platform-specific config**: Added `--ollama-url`, `--lmstudio-url`, `--ollama-model`, `--lmstudio-model` flags and their corresponding env vars (`ASKII_OLLAMA_URL`, `ASKII_LMSTUDIO_URL`, `ASKII_OLLAMA_MODEL`, `ASKII_LMSTUDIO_MODEL`) — mirroring the extension's per-platform settings. Generic `--url` / `--model` remain as overrides.

### Dependencies

- Added `screenshot-desktop` for cross-platform screen capture
- Added `@nut-tree-fork/nut-js` for mouse and keyboard automation

## [0.1.3] - 2026-02-16

### Added

- **Markdown-it Integration**: Ask ASKII now renders markdown responses as formatted HTML with proper syntax highlighting

### Changed

- **Configuration Split**: Renamed `askii.llmUrl` to `askii.ollamaUrl` for clarity, added dedicated `askii.lmStudioUrl`
- **Enhanced Webview Styling**: Improved code block styling, blockquotes, and link colors in Ask ASKII responses

## [0.1.2] - 2026-02-14

### Added

- **Enhanced ASKII Do Command**: Now supports multi-turn interactions with the LLM
- **File Viewing in ASKII Do**: LLM can now request to view files and analyze their contents before making modifications
- **JSON-based Action Format**: Replaced pipe-delimited text with structured JSON format (MCP-style) for more reliable command parsing
- **New `askii.doMaxRounds` Setting**: Customize the maximum interaction rounds (1-20) for ASKII Do command (default: 5)
- **Improved LM Studio Support**: Fixed configuration to properly use `baseUrl` and `llmUrl` settings

### Changed

- ASKII Do command now uses intelligent multi-turn workflow where LLM can view files and make context-aware decisions
- View actions no longer open files in editor but instead send content back to LLM for analysis
- Improved error handling for file operations in ASKII Do
- System prompt now clearly describes the MCP-style action format

### Fixed

- LM Studio client initialization now properly respects the `llmUrl` configuration setting
- JSON parsing in workspace actions now handles extra text from LLM responses gracefully

## [0.1.0] - 2026-02-10

### Added

- **LM Studio Support**: Integrated official `@lmstudio/sdk` for native LM Studio client
- **Confirmation Dialogs**: ASKII Do now shows confirmation for CREATE, MODIFY, DELETE actions
- **Unified LLM URL**: Single `llmUrl` setting works for both Ollama and LM Studio
- **Three New Commands**: Ask ASKII, ASKII Edit, ASKII Do with status bar button

## [0.0.5] - 2026-02-05

### Added

- Refactored settings for multi-platform LLM support
- Inline helper mode with three options: off, helpful, funny
- Status bar button with kaomoji for quick command access

## [0.0.4] - 2026-01-29

### Added

- GitLens-style hover tooltips showing full message on hover
- Inline text truncation (80 chars) with "..." for longer messages
- `askii.clearCache` command to manually clear the explanation cache
- Hover provider for rich markdown tooltips on any line with ASKII annotations
- Higher decoration priority to ensure ASKII appears before other extensions

### Changed

- Decorations now use `ClosedClosed` range behavior for better priority
- Improved documentation and code comments

### Fixed

- Long explanations no longer clutter the editor - they're shown in hover tooltips instead

## [0.0.3] - 2026-01-29

### Added

- GitHub Copilot integration as an alternative AI provider to Ollama
- New `askii.useCopilot` setting to switch between Ollama and GitHub Copilot
- New `askii.copilotModel` setting to choose which Copilot model to use
- Support for multiple Copilot models: gpt-4o (default), gpt-4, gpt-3.5-turbo, o1-preview, o1-mini
- VS Code Language Model API integration for seamless Copilot support

### Changed

- Extension now supports dual AI providers (local Ollama or cloud-based Copilot)
- Updated documentation to explain both AI provider options

## [0.0.2] - 2026-01-29

### Added

- New `askii.helpfulMode` setting for practical code advice instead of humorous comments
- Toggle between entertainment and educational explanations
- Improved AI prompts for both humorous and helpful modes

### Changed

- AI system prompts now adapt based on helpful mode setting
- Better user experience with mode-specific explanations

## [0.0.1] - 2026-01-29

### Added

- Initial release
- Random kaomoji insertion after code lines
- Ollama AI integration for code explanations
- Configurable Ollama URL and model settings
- Automatic inline comments as you navigate code
- Caching system to avoid redundant API calls
- Debounced requests for better performance
- Thinking indicators while waiting for AI responses
