# ASKII

A fun VS Code extension that adds random kaomoji (Japanese emoticons) and AI-powered explanations to your code lines. Choose between Ollama, GitHub Copilot, LM Studio, or OpenAI as your AI provider, and toggle between humorous comments and helpful code advice!

## Features

- **Random Kaomoji**: Adds a random kaomoji emoticon after the current line
- **AI Explanations**: Uses Ollama, GitHub Copilot, LM Studio, or OpenAI to generate concise explanations of your code
- **Inline Helper Modes**: Choose between off, helpful, or funny modes
- **Multi-Platform AI**: Support for Ollama (local), GitHub Copilot (cloud), LM Studio (local with official SDK), and OpenAI (cloud, or any OpenAI-compatible API)
- **Four Command Modes**:
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

### Option 4: OpenAI (New!)

- An **OpenAI API key** (or any OpenAI-compatible API key)
- Select `openai` in the `askii.llmPlatform` setting
- Set your API key in `askii.openaiApiKey`
- Optionally set a custom `askii.openaiUrl` for Azure OpenAI or other compatible APIs (leave empty for `api.openai.com`)

## Usage

The extension automatically shows inline comments as you move your cursor through your code.

### Choose Your LLM Platform

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "ASKII LLM Platform" to choose:

- `ollama` (default)
- `copilot`
- `lmstudio`
- `openai`

### Choose Your Inline Helper Mode

Search for "ASKII Inline Helper Mode" and select:

- `off` - No inline decorations
- `helpful` - Practical coding advice
- `funny` - Humorous comments (default)

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

### Quick Access with Status Bar Button

Click the ASKII **(⌐■_■)** button in the bottom right status bar to quickly access:

- Ask ASKII
- ASKII Edit
- ASKII Do
- ASKII Control
- ASKII Browse
- Clear Cache

## Configuration

All settings can be customized in VS Code Settings (`Ctrl+,` or `Cmd+,`):

- `askii.llmPlatform`: Choose LLM provider (`ollama` | `copilot` | `lmstudio` | `openai`)
- `askii.ollamaUrl`: URL for Ollama API server (default: `http://localhost:11434`)
- `askii.lmStudioUrl`: URL for LM Studio API server (default: `ws://localhost:1234`)
- `askii.ollamaModel`: Ollama model name (default: `gemma3:270m`)
- `askii.copilotModel`: GitHub Copilot model (default: `gpt-4o`)
- `askii.lmStudioModel`: LM Studio model (default: `qwen/qwen3-coder-30b`)
- `askii.openaiApiKey`: OpenAI API key (used when `llmPlatform` is `openai`)
- `askii.openaiModel`: OpenAI model (default: `gpt-4o`)
- `askii.openaiUrl`: OpenAI-compatible base URL — leave empty for `api.openai.com`, or use for Azure OpenAI / other compatible APIs
- `askii.inlineHelperMode`: Inline helper mode (`off` | `helpful` | `funny`, default: `funny`)
- `askii.doMaxRounds`: Maximum interaction rounds for ASKII Do / Control / Browse commands (default: 5)
- `askii.doAutoConfirm`: Skip confirmation prompts in ASKII Do / Control / Browse (default: `false`)
- `askii.formatAfterEdit`: Auto-format files after ASKII Edit or Do (default: `false`)
- `askii.browserHeadless`: Run the Puppeteer browser headlessly for ASKII Browse (default: `false` — browser window is visible)
- `askii.chromePath`: Path to the Chrome/Chromium executable for ASKII Browse (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`). Leave empty to use the system default

## Default Mode Examples

### Funny Mode (Default)

```javascript
const sum = a + b; (◕‿◕) The age-old tradition of making numbers hang out together!
```

### Helpful Mode

```javascript
const sum = a + b; (◕‿◕) Adds two variables; prefer const for variables that won't be reassigned.
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
