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
- **Code Auto-completion**: Copilot-style ghost-text code suggestions inside any open code file — Tab to accept, Esc to dismiss.
- **Codebase Wiki RAG**: Index your own workspace code files and inject relevant chunks as context into inline completion, Ask, Edit, and Do commands.
- **Commit Message Generator**: A one-click button in the Source Control view toolbar that reads your staged (or working-tree) diff and writes a generated commit message straight into the commit-message input box — powered by the same LLM platform/model used for inline completion.
- **CLI Interactive Mode**: The `askii` CLI now starts a persistent REPL session when run with no arguments — chat with persistent history, run Do/Edit/Explain agents, and switch platforms/models live, all with Tab-autocomplete slash-commands (`/do`, `/edit`, `/platform`, `/clear`, …).

## Requirements

### Option 1: Ollama (Default)

- **Ollama**: Download and install from [https://ollama.ai](https://ollama.ai)
- Pull a model, e.g., `ollama pull gemma4:e4b`
- Make sure Ollama is running (default: `http://localhost:11434`)

### Option 2: LM Studio

- **LM Studio**: Download from [https://lmstudio.ai](https://lmstudio.ai)
- Start LM Studio and load your preferred model
- Select `lmstudio` in the `askii.llmPlatform` setting

### Option 3: OpenAI

- An **OpenAI API key** (or any OpenAI-compatible API key)
- Select `openai` in the `askii.llmPlatform` setting
- Set your API key in `askii.openaiApiKey`
- Optionally set a custom `askii.openaiUrl` for Azure OpenAI or other compatible APIs (leave empty for `api.openai.com`)

### Option 4: Anthropic

- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)
- Select `anthropic` in the `askii.llmPlatform` setting
- Set your API key in `askii.anthropicApiKey`
- Optionally set a model in `askii.anthropicModel` (default: `claude-sonnet-4-6`)

### Option 5: opencode Go (New!)

- An **opencode Go API key** from [https://opencode.ai/go](https://opencode.ai/go) (a hosted, multi-model coding subscription)
- Select `opencodego` in the `askii.llmPlatform` setting
- Set your API key in `askii.opencodegoApiKey`
- Optionally set a model in `askii.opencodegoModel` (default: `glm-5.2`; e.g. `kimi-k2.7-code`, `deepseek-v4-pro`, `qwen3.7-max`, `minimax-m3`). See the full list at [opencode.ai/zen/go/v1/models](https://opencode.ai/zen/go/v1/models)

### Option 6: ASKII Cloud (New!)

- An **ASKII Cloud API key** (in-house, OpenAI-compatible inference service at [https://api.askii.dev](https://api.askii.dev))
- Select `askiicloud` in the `askii.llmPlatform` setting
- Set your API key in `askii.askiicloudApiKey`
- Optionally set a model in `askii.askiicloudModel` (default: `askii-default`)

## Usage

Inline decorations are disabled by default. Enable them by setting `askii.inlineHelperMode` to `helpful`, `funny`, or `wiki`.

### Choose Your LLM Platform

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "ASKII LLM Platform" to choose:

- `ollama` (default)
- `lmstudio`
- `openai`
- `anthropic`
- `opencodego`
- `askiicloud`

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

### Codebase Wiki RAG (Code Context)

Index your workspace code files (TypeScript, Python, Go, Rust, and more) into a BM25 search index and inject the most relevant chunks as context into inline completion, Ask, Edit, and Do commands.

1. Run **ASKII: Reload Code Wiki** from the command palette (or status-bar menu) — ASKII walks the workspace root, splits files into 60-line overlapping chunks, and saves the index as `.askii-code-wiki-index.json`. A progress notification confirms when done.
2. Enable `askii.codeWikiEnabled` to inject code context into Ask / Edit / Do commands.
3. Optionally enable `askii.codeWikiAutoReload` to rebuild the index automatically on each VS Code startup.
4. When enabled, the inline completer also uses the code wiki — querying it with recent lines near the cursor to retrieve relevant context before requesting a completion.

Skipped by default: `node_modules`, `dist`, `out`, `build`, `target`, and files over 200 KB. Add `.askii-code-wiki-index.json` to your `.gitignore`.

---

### Quick Access with Status Bar Button

Click the ASKII **(⌐■_■)** button in the bottom right status bar to quickly access:

- Ask ASKII
- ASKII Edit
- ASKII Do
- ASKII Control
- ASKII Browse
- Reload Wiki
- Reload Code Wiki
- Clear Cache

### Code Auto-completion

ASKII provides Copilot-style ghost-text completions inside any code file open in the editor.

1. Enable `askii.inlineCompletionEnabled` — ghost text appears after a short delay as you type.
2. Press **Tab** to accept the suggestion or **Esc** to dismiss it (standard VS Code inline-suggest behaviour, no custom keybindings needed).
3. Set `askii.inlineCompletionEagerness` to control responsiveness:
   - `low` — triggers after 1 200 ms with a wide code context window
   - `medium` — 500 ms (default)
   - `high` — 200 ms with a narrower context window for speed
4. Enable `askii.codeWikiEnabled` (after running **ASKII: Reload Code Wiki**) to include relevant chunks from your indexed codebase as additional context for each completion.

### Commit Message Generator

ASKII can write your Git commit messages for you. A **sparkle (✦)** button is added to the Source Control view title toolbar (the toolbar at the top of the Source Control view, visible when a Git repository is open).

1. Make some changes in a Git repository (staged or unstaged).
2. Open the **Source Control** view (`Ctrl+Shift+G` / `Cmd+Shift+G`).
3. Click the **✦** button in the Source Control view toolbar (or run **ASKII: Generate Commit Message** from the command palette, or press `Ctrl+Shift+K G` / `Cmd+Shift+K G`).
4. ASKII reads the staged diff (falling back to the working-tree diff when nothing is staged), sends it to the LLM, and writes the generated commit message straight into the input box — ready for you to review and commit.

The generator uses the **inline** LLM platform and model (`askii.inlinePlatform` / `askii.inlineModel`), so it can run on a different provider than your main Ask / Edit / Do commands. Set `askii.commitMessageInstructions` to a `.md` file with your own style rules (e.g. "always use Conventional Commits with a `feat`/`fix`/`chore` prefix and reference the Jira ticket in the body") and its contents are appended to the built-in system prompt. The path may be absolute or relative to the workspace root.

### Inline Platform & Model

Inline auto-complete and inline helper mode decorations can use a **different LLM platform and model** than the main Ask / Edit / Do commands. This is handy when you want a fast local model for ghost-text completions but a stronger cloud model for chat.

- `askii.inlinePlatform`: Platform for inline auto-complete **and** helper mode (`default` | `ollama` | `lmstudio` | `openai` | `anthropic` | `opencodego` | `askiicloud`, default: `default`). When set to `default`, the value of `askii.llmPlatform` is used.
- `askii.inlineModel`: Model id for inline auto-complete **and** helper mode (default: `default`). When set to `default`, the selected platform's default model is used (`askii.ollamaModel`, `askii.openaiModel`, `askii.anthropicModel`, `askii.lmStudioModel`, `askii.opencodegoModel`, or `askii.askiicloudModel`). Set it to any model id supported by the chosen platform to override.

## Configuration

All settings can be customized in VS Code Settings (`Ctrl+,` or `Cmd+,`):

- `askii.llmPlatform`: Choose LLM provider (`ollama` | `lmstudio` | `openai` | `anthropic` | `opencodego` | `askiicloud`)
- `askii.ollamaUrl`: URL for Ollama API server (default: `http://localhost:11434`)
- `askii.lmStudioUrl`: URL for LM Studio API server (default: `ws://localhost:1234`)
- `askii.ollamaModel`: Ollama model name (default: `gemma4:e4b`)
- `askii.lmStudioModel`: LM Studio model (default: `qwen/qwen3-coder-30b`)
- `askii.openaiApiKey`: OpenAI API key (used when `llmPlatform` is `openai`)
- `askii.openaiModel`: OpenAI model (default: `gpt-5-mini`)
- `askii.openaiUrl`: OpenAI-compatible base URL — leave empty for `api.openai.com`, or use for Azure OpenAI / other compatible APIs
- `askii.anthropicApiKey`: Anthropic API key (used when `llmPlatform` is `anthropic`)
- `askii.anthropicModel`: Anthropic model (default: `claude-sonnet-4-6`; e.g. `claude-opus-4-6`, `claude-haiku-4-5`)
- `askii.opencodegoApiKey`: opencode Go API key (used when `llmPlatform` is `opencodego`)
- `askii.opencodegoModel`: opencode Go model (default: `glm-5.2`; e.g. `kimi-k2.7-code`, `deepseek-v4-pro`, `qwen3.7-max`, `minimax-m3`)
- `askii.opencodegoUrl`: opencode Go base URL (default: `https://opencode.ai/zen/go/v1`) — override only if needed
- `askii.askiicloudApiKey`: ASKII Cloud API key (used when `llmPlatform` is `askiicloud`)
- `askii.askiicloudModel`: ASKII Cloud model (default: `askii-default`)
- `askii.askiicloudUrl`: ASKII Cloud base URL (default: `https://api.askii.dev/v1`) — override only if needed
- `askii.inlineHelperMode`: Inline helper mode (`off` | `helpful` | `funny` | `wiki`, default: `off`)
- `askii.wikiEnabled`: Enable wiki RAG context for Ask / Edit / Do commands (default: `false`)
- `askii.wikiPath`: Path to a folder containing `.md` documentation files to index for wiki RAG. Run **ASKII: Reload Wiki** after changing this or updating the docs
- `askii.wikiAutoReload`: Automatically rebuild and reload the wiki index on extension startup (default: `false`). Requires `askii.wikiEnabled` and `askii.wikiPath` to be configured
- `askii.inlineCompletionEnabled`: Enable ASKII inline code completion — ghost text in code files, Tab to accept, Esc to dismiss (default: `false`)
- `askii.inlinePlatform`: LLM platform for inline auto-complete **and** helper mode (`default` | `ollama` | `lmstudio` | `openai` | `anthropic` | `opencodego` | `askiicloud`, default: `default` — follows `askii.llmPlatform`)
- `askii.inlineModel`: Model id for inline auto-complete **and** helper mode (default: `default` — uses the selected platform's default model). Set to any model id supported by the chosen platform to override
- `askii.inlineCompletionEagerness`: Completion trigger speed — `low` (1 200 ms), `medium` (500 ms, default), `high` (200 ms)
- `askii.codeWikiEnabled`: Enable codebase wiki RAG context for inline completion, Ask, Edit, and Do (default: `false`). Run **ASKII: Reload Code Wiki** first
- `askii.codeWikiAutoReload`: Automatically rebuild the codebase wiki index on extension startup (default: `false`)
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
