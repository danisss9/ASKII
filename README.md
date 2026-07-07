# ASKII

A fun VS Code extension that adds random kaomoji (Japanese emoticons) and AI-powered explanations to your code lines. Choose between Ollama, LM Studio, OpenAI, Anthropic, opencode Go, or ASKII Cloud as your AI provider, and toggle between humorous comments and helpful code advice!

## Features

- **Random Kaomoji**: Adds a random kaomoji emoticon after the current line
- **AI Explanations**: Uses Ollama, LM Studio, OpenAI, Anthropic, opencode Go, or ASKII Cloud to generate concise explanations of your code
- **Inline Helper Modes**: Choose between `off`, `helpful`, `funny`, or `wiki` modes
- **Wiki RAG**: Index your own `.md` documentation files and inject relevant snippets as context into any command — or display them inline as you navigate code
- **Multi-Platform AI**: Support for Ollama (local), LM Studio (local with official SDK), OpenAI (cloud, or any OpenAI-compatible API), Anthropic (cloud, via official `@anthropic-ai/sdk`), opencode Go (cloud, hosted multi-model coding subscription), and ASKII Cloud (cloud, in-house OpenAI-compatible service)
- **Five Command Modes**:
  - **Ask ASKII**: Ask questions about your selected code
  - **ASKII Edit**: Have ASKII modify your selected code based on your request
  - **ASKII Do**: Agentic workspace agent — view, list, create, modify, rename, and delete files across multiple rounds until the task is complete
  - **ASKII Control**: Give ASKII a screen instruction — it takes screenshots and drives your mouse and keyboard until the task is done
  - **ASKII Browse**: Give ASKII a browser task — it launches a Puppeteer browser, takes page screenshots, and navigates the web until the task is done
  - **ASKII Note**: A notes / tasks / reminders mode — type free text and the AI auto-classifies it (note, task with priority, or reminder with a time), can ask clarifying questions back, captures full-screen screenshots, and pings you with a notification + sound when a reminder is due. Notes are stored globally (tagged by workspace, searchable everywhere) and reminders fire while VS Code is running.
- **Code Auto-completion**: Copilot-style ghost-text code suggestions inside any open code file — Tab to accept, Esc to dismiss.
- **Codebase Wiki RAG**: Index your own workspace code files and inject relevant chunks as context into inline completion, Ask, Edit, and Do commands.
- **Commit Message Generator**: A one-click button in the Source Control view toolbar that reads your staged (or working-tree) diff and writes a generated commit message straight into the commit-message input box — powered by the same LLM platform/model used for inline completion.
- **CLI Interactive Mode**: The `askii` CLI now starts a persistent REPL session when run with no arguments — chat with persistent history, run Do/Edit/Explain agents, and switch platforms/models live, all with Tab-autocomplete slash-commands (`/do`, `/edit`, `/platform`, `/clear`, …).

## Requirements

### Option 1: ASKII Cloud (Default)

- An **ASKII Cloud API key** (in-house, OpenAI-compatible inference service at [https://api.askii.dev](https://api.askii.dev))
- Set your API key in `askii.askiicloudApiKey`
- `askii.llmPlatform` defaults to `askiicloud`, so you're ready to go once the key is set
- The default model is `askii-smart` (`askii.llmModel`)

### Option 2: Ollama

- **Ollama**: Download and install from [https://ollama.ai](https://ollama.ai)
- Pull a model, e.g., `ollama pull gemma4:e4b`
- Make sure Ollama is running (default: `http://localhost:11434`)
- Select `ollama` in the `askii.llmPlatform` setting and set the model in `askii.llmModel`

### Option 3: LM Studio

- **LM Studio**: Download from [https://lmstudio.ai](https://lmstudio.ai)
- Start LM Studio and load your preferred model
- Select `lmstudio` in the `askii.llmPlatform` setting and set the model in `askii.llmModel`

### Option 4: OpenAI

- An **OpenAI API key** (or any OpenAI-compatible API key)
- Select `openai` in the `askii.llmPlatform` setting
- Set your API key in `askii.openaiApiKey`
- Set the model in `askii.llmModel` (e.g. `gpt-5-mini`, `gpt-4o`)
- Optionally set a custom `askii.openaiUrl` for Azure OpenAI or other compatible APIs (leave empty for `api.openai.com`)

### Option 5: Anthropic

- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)
- Select `anthropic` in the `askii.llmPlatform` setting
- Set your API key in `askii.anthropicApiKey`
- Set the model in `askii.llmModel` (e.g. `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`)

### Option 6: opencode Go

- An **opencode Go API key** from [https://opencode.ai/go](https://opencode.ai/go) (a hosted, multi-model coding subscription)
- Select `opencodego` in the `askii.llmPlatform` setting
- Set your API key in `askii.opencodegoApiKey`
- Set the model in `askii.llmModel` (e.g. `glm-5.2`, `kimi-k2.7-code`, `deepseek-v4-pro`, `qwen3.7-max`, `minimax-m3`). See the full list at [opencode.ai/zen/go/v1/models](https://opencode.ai/zen/go/v1/models)

## Usage

Inline decorations are disabled by default. Enable them by setting `askii.inlineHelperMode` to `helpful`, `funny`, or `wiki`.

### Choose Your LLM Platform

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "ASKII LLM Platform" to choose:

- `askiicloud` (default)
- `ollama`
- `lmstudio`
- `openai`
- `anthropic`
- `opencodego`

### Choose Your Inline Helper Mode

Search for "ASKII Inline Helper Mode" and select:

- `off` — No inline decorations
- `helpful` — Practical coding advice
- `funny` — Humorous comments
- `wiki` — Shows a one-sentence explanation informed by your indexed wiki docs. Searches the wiki index for the current line and passes the top matching chunks as context to the LLM. Requires `askii.wikiPath` to be set and indexed

### Commands

#### Ask ASKII

1. Select code in your editor
2. Open command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
3. Search for "Ask ASKII"
4. Type your question
5. View the formatted markdown response in a side panel with VS Code theme-aware styling

#### ASKII Edit

1. Select code in your editor
2. Open command palette
3. Search for "ASKII Edit"
4. Describe the changes you want
5. The selected code will be replaced with the updated version

#### ASKII Do (AI Workspace Agent)

1. Open command palette
2. Search for "ASKII Do"
3. Describe what you want ASKII to do (e.g., "Create a unit test file for src/utils.ts")
4. ASKII shows the top-level workspace structure, then runs in a loop until the task is done or `doMaxRounds` is reached:
   - **List Folder**: ASKII can list any folder's contents (`[file]` / `[folder]` labels) to explore the workspace
   - **View File**: ASKII can read file contents to understand your codebase before acting
   - **Analyze & Act**: Based on what it reads, ASKII issues create, modify, rename, or delete actions
   - **Continuous Loop**: After each round ASKII is asked "what next?" — it keeps going until it returns `[]`
5. **Confirm each action** before it's applied:
   - **CREATE**: Confirmation to create new files
   - **MODIFY**: Confirmation to modify existing files
   - **RENAME**: Confirmation to rename or move files
   - **DELETE**: Warning confirmation for deletions
   - **VIEW / LIST**: No confirmation needed (read-only)

#### ASKII Control (Screen Agent)

1. Open command palette
2. Search for **"ASKII Control"**
3. Describe what you want done on screen (e.g., "Open Notepad and type hello world")
4. ASKII takes a screenshot and proposes the next action (mouse move, click, or keyboard input) with its reasoning
5. **Confirm each action** before it executes — or enable `askii.doAutoConfirm` to run unattended
6. After each action a new screenshot is taken and the loop repeats until ASKII returns **DONE** or `askii.doMaxRounds` is reached

> **Requires a vision-capable model** such as `llava` or `moondream2`.

---

#### ASKII Browse (Browser Agent)

1. Open command palette
2. Search for **"ASKII Browse"**
3. Describe what you want done in a browser (e.g., "Go to https://example.com and click Learn more")
4. ASKII launches a Puppeteer browser (visible by default), takes a screenshot of the current page and its URL, then proposes the next action with its reasoning. Supported actions:
   - **goto**: Navigate to a URL
   - **click**: Click an element by CSS selector
   - **type**: Type text into an element by CSS selector
   - **wait_for**: Wait until a CSS selector appears in the DOM
   - **back / forward**: Navigate the browser history
   - **DONE**: Returned when the task is complete
5. **Confirm each action** before it executes — or enable `askii.doAutoConfirm` to run unattended
6. After each action a new screenshot is taken and the loop repeats until ASKII returns **DONE** or `askii.doMaxRounds` is reached
7. The browser is closed automatically when the loop ends

> **Requires a vision-capable model**. Set `askii.browserHeadless` to `false` (default) to watch the browser window while ASKII works.
>
> **Requires Chrome or Chromium** to be installed. Set `askii.chromePath` to the executable path if it is not detected automatically.

#### ASKII Note (Notes / Tasks / Reminders)

1. Press `Ctrl+Shift+K N` (or `Cmd+Shift+K N`) — or pick **ASKII Note** from the command palette / status-bar menu
2. The ASKII Note panel opens. Type free text in the box at the bottom and hit **Send** (or `Ctrl+Enter`):
   - A plain note: `the API rate limit is 100 req/min`
   - A task with priority: `task: fix the login bug, high priority`
   - A reminder: `remind me to check the build in 30 minutes` or `remind me tomorrow 9am`
3. The AI auto-classifies your text into a **note**, **task** (with `low` / `medium` / `high` priority), or **reminder** (with a due time). If the intent or time is ambiguous it asks a clarifying question in a small dialog — answer it and the entry is saved.
4. Click **📎 Shot** before sending to attach a full-screen screenshot to the entry (reuses the ASKII Control capture pipeline). Thumbnails appear in the list and click-to-open.
5. Use the **search box** at the top to full-text search across all notes, tasks and reminders.
6. **Reminders** fire as VS Code notifications with a sound while VS Code is running, including the context that was open when you created the note (open file, selected text, workspace). Choose **Open** (reveals the entry), **Snooze** (reschedules by `askii.noteSnoozeMinutes`), or **Dismiss**.
7. Notes are stored **globally** (survive across workspaces), tagged with their origin workspace, and searchable everywhere. Tasks can be toggled done; any entry can be deleted.

> Reminders only fire while VS Code is running. Reminders that were missed while VS Code was closed are flagged **missed** and fire once on the next startup.
>
> New settings: `askii.noteReminderSound` (default `true`) and `askii.noteSnoozeMinutes` (default `10`).

---

### Wiki RAG (Documentation Context)

Point ASKII at a folder of `.md` files and it will index them into a local vector database (powered by [MiniSearch](https://github.com/lucaong/minisearch) — pure JS, no native dependencies). The relevant chunks are automatically prepended as context when you Ask, Edit, or Do tasks.

1. Set `askii.wikiPath` to the folder containing your `.md` docs
2. Run **ASKII: Reload Wiki** from the command palette (or status-bar menu) to build the index — a progress spinner shows while indexing and a notification confirms when done
3. Enable `askii.wikiEnabled` to inject wiki context into Ask / Edit / Do commands
4. Optionally set `askii.inlineHelperMode` to `wiki` for inline decorations that show LLM explanations enriched by your docs
5. Optionally enable `askii.wikiAutoReload` to have the index rebuilt automatically each time VS Code starts

The index is cached in memory after the first load — no disk reads on subsequent queries.

---

### Quick Access with Status Bar Button

Click the ASKII **(⌐■_■)** button in the bottom right status bar to quickly access:

- Ask ASKII
- ASKII Edit
- ASKII Do
- ASKII Control
- ASKII Browse
- Reload Wiki
- Clear Cache

### Code Auto-completion

ASKII provides Copilot-style ghost-text completions inside any code file open in the editor.

1. Enable `askii.inlineCompletionEnabled` — ghost text appears after a short delay as you type.
2. Press **Tab** to accept the suggestion or **Esc** to dismiss it (standard VS Code inline-suggest behaviour, no custom keybindings needed).
3. Set `askii.inlineCompletionEagerness` to control responsiveness:
   - `low` — triggers after 1 200 ms with a wide code context window
   - `medium` — 500 ms (default)
   - `high` — 200 ms with a narrower context window for speed

### Commit Message Generator

ASKII can write your Git commit messages for you. A **sparkle (✦)** button is added to the Source Control view title toolbar (the toolbar at the top of the Source Control view, visible when a Git repository is open).

1. Make some changes in a Git repository (staged or unstaged).
2. Open the **Source Control** view (`Ctrl+Shift+G` / `Cmd+Shift+G`).
3. Click the **✦** button in the Source Control view toolbar (or run **ASKII: Generate Commit Message** from the command palette, or press `Ctrl+Shift+K G` / `Cmd+Shift+K G`).
4. ASKII reads the staged diff (falling back to the working-tree diff when nothing is staged), sends it to the LLM, and writes the generated commit message straight into the input box — ready for you to review and commit.

The generator uses the **inline** LLM platform and model (`askii.llmInlinePlatform` / `askii.llmInlineModel`), so it can run on a different provider than your main Ask / Edit / Do commands. Set `askii.commitMessageInstructions` to a `.md` file with your own style rules (e.g. "always use Conventional Commits with a `feat`/`fix`/`chore` prefix and reference the Jira ticket in the body") and its contents are appended to the built-in system prompt. The path may be absolute or relative to the workspace root.

### Per-Feature Platform & Model

ASKII splits its LLM usage into three feature groups, each with its own platform and model settings. This lets you run a fast model for inline completions, a strong model for chat/edit/do, and a vision-capable model for browse/control — all independently.

- **Ask / Edit / Do / Generate** — `askii.llmPlatform` (default: `askiicloud`) and `askii.llmModel` (default: `askii-smart`)
- **Inline suggestions / inline completion / git commit message** — `askii.llmInlinePlatform` (default: `askiicloud`) and `askii.llmInlineModel` (default: `askii-fast`)
- **Browse / Control / Note (vision)** — `askii.llmVisionPlatform` (default: `askiicloud`) and `askii.llmVisionModel` (default: `askii-smart`)

Each `llm*Platform` accepts the same values: `askiicloud`, `ollama`, `lmstudio`, `openai`, `anthropic`, `opencodego`. API keys are shared per provider across all feature groups (e.g. `askii.openaiApiKey` is used whether `openai` is selected for `llmPlatform`, `llmInlinePlatform`, or `llmVisionPlatform`).

## Configuration

All settings can be customized in VS Code Settings (`Ctrl+,` or `Cmd+,`):

**LLM platforms & models (per feature group):**

- `askii.llmPlatform`: Platform for Ask / Edit / Do / Generate (`askiicloud` | `ollama` | `lmstudio` | `openai` | `anthropic` | `opencodego`, default: `askiicloud`)
- `askii.llmModel`: Model id for Ask / Edit / Do / Generate (default: `askii-smart`)
- `askii.llmInlinePlatform`: Platform for inline suggestions, inline completion and git commit message generation (same enum as `llmPlatform`, default: `askiicloud`)
- `askii.llmInlineModel`: Model id for inline suggestions, inline completion and git commit message generation (default: `askii-fast`)
- `askii.llmVisionPlatform`: Platform for Browse / Control / Note — vision-capable features (same enum as `llmPlatform`, default: `askiicloud`)
- `askii.llmVisionModel`: Model id for Browse / Control / Note (default: `askii-smart`)

**Provider API keys & URLs (shared across all feature groups):**

- `askii.askiicloudApiKey`: ASKII Cloud API key (used when any `llm*Platform` is `askiicloud`). ASKII Cloud always uses `https://api.askii.dev/v1`
- `askii.openaiApiKey`: OpenAI API key (used when any `llm*Platform` is `openai`)
- `askii.openaiUrl`: OpenAI-compatible base URL — leave empty for `api.openai.com`, or use for Azure OpenAI / other compatible APIs
- `askii.anthropicApiKey`: Anthropic API key (used when any `llm*Platform` is `anthropic`)
- `askii.opencodegoApiKey`: opencode Go API key (used when any `llm*Platform` is `opencodego`). opencode Go always uses `https://opencode.ai/zen/go/v1`
- `askii.ollamaUrl`: URL for Ollama API server (default: `http://localhost:11434`)
- `askii.lmStudioUrl`: URL for LM Studio API server (default: `ws://localhost:1234`)

**Inline & wiki:**

- `askii.inlineHelperMode`: Inline helper mode (`off` | `helpful` | `funny` | `wiki`, default: `off`)
- `askii.inlineCompletionEnabled`: Enable ASKII inline code completion — ghost text in code files, Tab to accept, Esc to dismiss (default: `false`)
- `askii.inlineCompletionEagerness`: Completion trigger speed — `low` (1 200 ms), `medium` (500 ms, default), `high` (200 ms)
- `askii.wikiEnabled`: Enable wiki RAG context for Ask / Edit / Do commands (default: `false`)
- `askii.wikiPath`: Path to a folder containing `.md` documentation files to index for wiki RAG. Run **ASKII: Reload Wiki** after changing this or updating the docs
- `askii.wikiAutoReload`: Automatically rebuild and reload the wiki index on extension startup (default: `false`). Requires `askii.wikiEnabled` and `askii.wikiPath` to be configured

**Agent & misc:**

- `askii.commitMessageInstructions`: Path to a `.md` file with custom instructions for the commit message generator (appended to the built-in system prompt). Absolute or relative to the workspace root. Leave empty to use the built-in prompt (default: `""`)
- `askii.doMaxRounds`: Maximum interaction rounds for ASKII Do / Control / Browse commands (default: 5)
- `askii.doAutoConfirm`: Skip confirmation prompts in ASKII Do / Control / Browse (default: `false`)
- `askii.formatAfterEdit`: Auto-format files after ASKII Edit or Do (default: `false`)
- `askii.browserHeadless`: Run the Puppeteer browser headlessly for ASKII Browse (default: `false` — browser window is visible)
- `askii.chromePath`: Path to the Chrome/Chromium executable for ASKII Browse (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`). Leave empty to use the system default

## Keybindings

You can invoke ASKII commands using the following default keybindings:

- **Ask ASKII**: `Ctrl+Shift+K A` (Mac: `Cmd+Shift+K A`)
- **ASKII Edit**: `Ctrl+Shift+K E` (Mac: `Cmd+Shift+K E`)
- **ASKII Do**: `Ctrl+Shift+K D` (Mac: `Cmd+Shift+K D`)
- **ASKII Control**: `Ctrl+Shift+K C` (Mac: `Cmd+Shift+K C`)
- **ASKII Browse**: `Ctrl+Shift+K B` (Mac: `Cmd+Shift+K B`)
- **ASKII: Reload Wiki**: `Ctrl+Shift+K R` (Mac: `Cmd+Shift+K R`)
- **ASKII: Clear Cache**: `Ctrl+Shift+K X` (Mac: `Cmd+Shift+K X`)
- **ASKII: Generate Commit Message**: `Ctrl+Shift+K G` (Mac: `Cmd+Shift+K G`) — available when a Git repository is open in the Source Control view

## Default Mode Examples

### Funny Mode

```javascript
const sum = a + b; (◕‿◕) The age-old tradition of making numbers hang out together!
```

### Helpful Mode

```javascript
const sum = a + b; (◕‿◕) Adds two variables; prefer const for variables that won't be reassigned.
```

### Wiki Mode

```javascript
connectToDatabase(config); (⌐■_■) [docs/database.md — Connection] Pass the config object returned by loadConfig(); see the Connection section for supported options.
```

## Technical Details

- **Markdown Rendering**: Ask ASKII responses are rendered using markdown-it with syntax highlighting and VS Code theme integration
- **Confirmation Dialogs**: ASKII Do command requires confirmation for all write operations (CREATE, MODIFY, DELETE) to prevent accidental changes
- **Smart Caching**: Inline explanations are cached to minimize API calls
- **Debouncing**: Requests are debounced for optimal performance
- **Mouse/Keyboard Control**: ASKII Control uses platform shell commands (PowerShell on Windows, AppleScript on macOS, `xdotool` on Linux) instead of native Node modules, so the extension bundles cleanly with no native `.node` files. Linux users need `xdotool` installed (`sudo apt install xdotool` or equivalent)

## Contributing

Love ASKII? Feel free to contribute to the project on GitHub!

**Enjoy! (づ｡◕‿‿◕｡)づ**
