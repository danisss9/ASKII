# ASKII

A fun VS Code extension that adds random kaomoji (Japanese emoticons) and AI-powered explanations to your code lines. Choose between Ollama, GitHub Copilot, LM Studio, OpenAI, or Anthropic as your AI provider, and toggle between humorous comments and helpful code advice!

## Features

- **Random Kaomoji**: Adds a random kaomoji emoticon after the current line
- **AI Explanations**: Uses Ollama, GitHub Copilot, LM Studio, OpenAI, or Anthropic to generate concise explanations of your code
- **Inline Helper Modes**: Choose between `off`, `helpful`, `funny`, or `wiki` modes
- **Wiki RAG**: Index your own `.md` documentation files and inject relevant snippets as context into any command — or display them inline as you navigate code
- **Multi-Platform AI**: Support for Ollama (local), GitHub Copilot (cloud), LM Studio (local with official SDK), OpenAI (cloud, or any OpenAI-compatible API), and Anthropic (cloud, via official `@anthropic-ai/sdk`)
- **Five Command Modes**:
  - **Ask ASKII**: Ask questions about your selected code
  - **ASKII Edit**: Have ASKII modify your selected code based on your request
  - **ASKII Do**: Agentic workspace agent — view, list, create, modify, rename, and delete files across multiple rounds until the task is complete
  - **ASKII Control**: Give ASKII a screen instruction — it takes screenshots and drives your mouse and keyboard until the task is done
  - **ASKII Browse**: Give ASKII a browser task — it launches a Puppeteer browser, takes page screenshots, and navigates the web until the task is done

## Requirements

### Option 1: Ollama (Default)

- **Ollama**: Download and install from [https://ollama.ai](https://ollama.ai)
- Pull a model, e.g., `ollama pull gemma3:270m`
- Make sure Ollama is running (default: `http://localhost:11434`)

### Option 2: GitHub Copilot

- **GitHub Copilot Extension**: Install from the VS Code marketplace
- Active GitHub Copilot subscription
- Select `copilot` in the `askii.llmPlatform` setting

### Option 3: LM Studio

- **LM Studio**: Download from [https://lmstudio.ai](https://lmstudio.ai)
- Start LM Studio and load your preferred model
- Select `lmstudio` in the `askii.llmPlatform` setting

### Option 4: OpenAI

- An **OpenAI API key** (or any OpenAI-compatible API key)
- Select `openai` in the `askii.llmPlatform` setting
- Set your API key in `askii.openaiApiKey`
- Optionally set a custom `askii.openaiUrl` for Azure OpenAI or other compatible APIs (leave empty for `api.openai.com`)

### Option 5: Anthropic (New!)

- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)
- Select `anthropic` in the `askii.llmPlatform` setting
- Set your API key in `askii.anthropicApiKey`
- Optionally set a model in `askii.anthropicModel` (default: `claude-opus-4-6`)

## Usage

Inline decorations are disabled by default. Enable them by setting `askii.inlineHelperMode` to `helpful`, `funny`, or `wiki`.

### Choose Your LLM Platform

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "ASKII LLM Platform" to choose:

- `ollama` (default)
- `copilot`
- `lmstudio`
- `openai`
- `anthropic`

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

### Quick Access with Status Bar Button

Click the ASKII **(⌐■_■)** button in the bottom right status bar to quickly access:

- Ask ASKII
- ASKII Edit
- ASKII Do
- ASKII Control
- ASKII Browse
- Reload Wiki
- Clear Cache

## Configuration

All settings can be customized in VS Code Settings (`Ctrl+,` or `Cmd+,`):

- `askii.llmPlatform`: Choose LLM provider (`ollama` | `copilot` | `lmstudio` | `openai` | `anthropic`)
- `askii.ollamaUrl`: URL for Ollama API server (default: `http://localhost:11434`)
- `askii.lmStudioUrl`: URL for LM Studio API server (default: `ws://localhost:1234`)
- `askii.ollamaModel`: Ollama model name (default: `gemma3:270m`)
- `askii.copilotModel`: GitHub Copilot model (default: `gpt-4o`)
- `askii.lmStudioModel`: LM Studio model (default: `qwen/qwen3-coder-30b`)
- `askii.openaiApiKey`: OpenAI API key (used when `llmPlatform` is `openai`)
- `askii.openaiModel`: OpenAI model (default: `gpt-4o`)
- `askii.openaiUrl`: OpenAI-compatible base URL — leave empty for `api.openai.com`, or use for Azure OpenAI / other compatible APIs
- `askii.anthropicApiKey`: Anthropic API key (used when `llmPlatform` is `anthropic`)
- `askii.anthropicModel`: Anthropic model (default: `claude-opus-4-6`; e.g. `claude-sonnet-4-6`, `claude-haiku-4-5`)
- `askii.inlineHelperMode`: Inline helper mode (`off` | `helpful` | `funny` | `wiki`, default: `off`)
- `askii.wikiEnabled`: Enable wiki RAG context for Ask / Edit / Do commands (default: `false`)
- `askii.wikiPath`: Path to a folder containing `.md` documentation files to index for wiki RAG. Run **ASKII: Reload Wiki** after changing this or updating the docs
- `askii.wikiAutoReload`: Automatically rebuild and reload the wiki index on extension startup (default: `false`). Requires `askii.wikiEnabled` and `askii.wikiPath` to be configured
- `askii.doMaxRounds`: Maximum interaction rounds for ASKII Do / Control / Browse commands (default: 5)
- `askii.doAutoConfirm`: Skip confirmation prompts in ASKII Do / Control / Browse (default: `false`)
- `askii.formatAfterEdit`: Auto-format files after ASKII Edit or Do (default: `false`)
- `askii.browserHeadless`: Run the Puppeteer browser headlessly for ASKII Browse (default: `false` — browser window is visible)
- `askii.chromePath`: Path to the Chrome/Chromium executable for ASKII Browse (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`). Leave empty to use the system default

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
