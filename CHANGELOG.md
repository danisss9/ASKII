# Change Log

All notable changes to the "askii" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.7] - 2026-03-04

### Added

- **OpenAI platform support**: Added `openai` as a new LLM platform across the extension and CLI, powered by the official `openai` npm SDK
- **`askii.openaiApiKey` setting**: Your OpenAI API key (used when `llmPlatform` is `openai`)
- **`askii.openaiModel` setting**: OpenAI model to use (default: `gpt-4o`)
- **`askii.openaiUrl` setting**: Custom OpenAI-compatible base URL — leave empty for `api.openai.com`, or set to an Azure OpenAI endpoint or any compatible API
- **`getOpenAIResponse` / `getOpenAIChat`** in `common/providers.ts`: Shared OpenAI provider functions supporting system prompts, vision (base64 image_url), and optional custom `baseURL`
- **CLI `--openai-key`, `--openai-model`, `--openai-url` flags**: CLI equivalents of the extension settings; also readable via `ASKII_OPENAI_KEY`, `ASKII_OPENAI_MODEL`, `ASKII_OPENAI_URL` environment variables

## [0.2.6] - 2026-03-04

### Changed

- **ASKII Browse now uses `puppeteer-core`**: Replaced the full `puppeteer` package (which auto-downloads Chromium) with `puppeteer-core`, which requires an existing Chrome/Chromium installation. This removes the bundled browser download and reduces install size
- **`askii.chromePath` setting**: New string config for the extension (default: empty) that sets the path to the Chrome/Chromium executable used by ASKII Browse. Leave empty to use the system default. Example: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **`--chrome-path` CLI flag / `ASKII_CHROME_PATH` env var**: CLI equivalent of `askii.chromePath` — pass the path to Chrome via `--chrome-path /path/to/chrome` or the `ASKII_CHROME_PATH` environment variable
- **`puppeteer-core` bundled by esbuild**: Both the extension and CLI now bundle `puppeteer-core` directly into their output files rather than keeping it as an external dependency

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
