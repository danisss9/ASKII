# ASKII ( •*•)>⌐■-■ (⌐■*■)

An AI code assistant for VS Code with style — ask about your code, have it edited for you, run agentic tasks, drive your screen or a browser, and keep AI-classified notes, tasks and reminders. Bring your own LLM: ASKII Cloud, Ollama, LM Studio, OpenAI, Anthropic, or opencode Go.

## Quick start

1. Install ASKII from the VS Code Marketplace — or build it from source (see [Development](#development))
2. Run **ASKII: Open Setup** (`Ctrl+Shift+A S` / `Cmd+Shift+A S`) — a short wizard that walks you through provider, models, options and wiki setup
3. Select some code and run **Ask ASKII** (`Ctrl+Shift+K A`)

## Commands

| Command            | Keybinding       | What it does                                                                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ask ASKII          | `Ctrl+Shift+K A` | Ask about the selected code (or anything) — answers stream into a markdown panel with follow-ups and a history view |
| ASKII Edit         | `Ctrl+Shift+K E` | Replace the selection with an AI-edited version; review the diff and undo if needed                                 |
| ASKII Do           | `Ctrl+Shift+K D` | Agentic workspace agent — explores, creates, modifies, renames and deletes files over multiple rounds               |
| ASKII Control      | `Ctrl+Shift+K C` | Screen or browser agent — screenshot-driven mouse/keyboard control, or Puppeteer web automation                     |
| ASKII Note         | `Ctrl+Shift+K N` | Notes / tasks / reminders panel with search, screenshots and voice input                                            |
| ASKII: Reload Wiki | `Ctrl+Shift+K W` | Rebuild the wiki RAG index                                                                                          |
| ASKII: Clear Cache | `Ctrl+Shift+K X` | Clear cached inline explanations and completions                                                                    |
| ASKII: Open Setup  | `Ctrl+Shift+A S` | Re-run the setup wizard                                                                                             |

On macOS swap `Ctrl` for `Cmd`. The **(⌐■_■)** status-bar button opens a quick-access menu for all of these.

### Ask ASKII

Select some code and ask about it, or ask a general question with nothing selected — the file name, language and selection are included as context automatically (plus matching wiki chunks when wiki RAG is on). Answers stream into the markdown panel with syntax-highlighted code blocks, and the panel header gives you **copy**, **follow-up** (previous questions and answers are kept as conversation context) and a **history view** to re-read the whole session.

### ASKII Edit

Describe the change you want and ASKII rewrites your selection — or the whole file if nothing is selected, using the full file as context either way. The edit is applied immediately, then a side-by-side diff of original vs. proposed code opens beside it so you can review it, with a one-click **Undo** offer to revert. Optional `askii.formatAfterEdit` formats the document after the edit.

### ASKII Do

Describe a task — ASKII prints the top-level workspace structure, then loops until the task is done or `askii.doMaxRounds` (default 5) is reached. Read-only actions (`list`, `view`, `search`, `wiki_search`) run freely; write actions (`create`, `write`, `modify`, `rename`, `copy`, `mkdir`, `delete`) and shell `run` ask for confirmation (skip with `askii.doAutoConfirm`). Files are backed up before destructive changes, and the whole run can be undone with one click when it finishes.

### ASKII Control

Pick **Screen** or **Browser**, then describe the task. ASKII screenshots the current state each round and proposes the next action with its reasoning:

- **Screen** — `mouse_move`, `mouse_left_click`, `mouse_right_click`, `keyboard_input`, `DONE`
- **Browser** — `goto`, `click`, `type`, `wait_for`, `back`, `forward`, `DONE` (Puppeteer)

Requires a **vision-capable model** (e.g. `llava`, `moondream2`). Browser mode auto-detects Chrome / Edge / Chromium / Brave (or set `askii.chromePath`) and is visible by default (`askii.browserHeadless` hides it); the browser closes when the loop ends. Screen control uses shell commands — Linux needs `xdotool`.

### ASKII Note

Type free text — the AI classifies it as a **note**, a **task** (`low` / `medium` / `high` priority) or a **reminder** (with a due time), and asks a clarifying question when the intent or time is ambiguous. Entries are stored globally, tagged by workspace, full-text searchable, and grouped by age (Pinned, Today, Yesterday, This week, Earlier). Hover an entry to pin, edit (with AI re-classify), mark done, snooze / dismiss, or delete it.

- **Reminders** fire as VS Code notifications with a sound while VS Code is running; ones missed while it was closed re-fire on the next startup
- **Screenshots** — toggle the camera icon to attach a full-screen capture to the entry
- **Voice input** — click the mic icon, speak, click again; the recording is transcribed straight into the composer (needs `ffmpeg`)

### Inline completion & decorations

- `askii.inlineCompletionEnabled` — Copilot-style ghost text; **Tab** accepts, **Esc** dismisses. Tune the trigger with `askii.inlineCompletionEagerness` (`low` 1200 ms / `medium` 500 ms / `high` 200 ms). Suggestions are cached per context
- `askii.inlineHelperMode` — adds a kaomoji decoration after the current line: `helpful`, `funny`, or `wiki` (explanations enriched by your indexed docs). Example:

```javascript
const sum = a + b; (◕‿◕) Adds two variables; prefer const for variables that won't be reassigned.
```

### Wiki RAG

1. Point `askii.wikiPath` at a folder of `.md` docs
2. Run **ASKII: Reload Wiki** — builds a local [MiniSearch](https://github.com/lucaong/minisearch) BM25 index
3. Enable `askii.wikiEnabled` — matching chunks are injected into Ask / Edit / Do as context
4. Optional: `askii.wikiAutoReload` rebuilds the index on startup

### Commit messages

A **✦** button in the Source Control view toolbar generates a commit message from your staged (or working-tree) diff straight into the input box. It styles the message after your repo's last 10 commits, honors `askii.commitMessageStyle` (`oneliner` / `brief` / `descriptive`), and appends your own rules from the `.md` file in `askii.commitMessageInstructions`.

## LLM platforms

| Platform                              | Type  | Setup                                                                                 |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| **ASKII Cloud** (default)             | Cloud | API key in `askii.askiicloudApiKey` — base URL is fixed to `https://api.askii.dev/v1` |
| [Ollama](https://ollama.com)          | Local | Install + pull a model (e.g. `gemma4:e4b`), runs at `http://localhost:11434`          |
| [LM Studio](https://lmstudio.ai)      | Local | Enable the local server (`ws://localhost:1234`) and load a model                      |
| OpenAI or compatible                  | Cloud | `askii.openaiApiKey`; set `askii.openaiUrl` for Azure etc. (empty = `api.openai.com`) |
| Anthropic                             | Cloud | `askii.anthropicApiKey`                                                               |
| [opencode Go](https://opencode.ai/go) | Cloud | `askii.opencodegoApiKey`                                                              |

Each feature group picks its own platform and model, so you can mix providers:

| Feature group                                   | Platform                  | Model                  | Default model |
| ----------------------------------------------- | ------------------------- | ---------------------- | ------------- |
| Ask / Edit / Do                                 | `askii.llmPlatform`       | `askii.llmModel`       | `askii-smart` |
| Inline suggestions, completion, commit messages | `askii.llmInlinePlatform` | `askii.llmInlineModel` | `askii-fast`  |
| Control / Note (vision)                         | `askii.llmVisionPlatform` | `askii.llmVisionModel` | `askii-smart` |

API keys and server URLs are shared per provider across all groups.

## Configuration

All settings live in VS Code Settings under the `askii.*` namespace.

**Notes & voice**

| Setting                   | Default      | Description                                             |
| ------------------------- | ------------ | ------------------------------------------------------- |
| `askii.noteReminderSound` | `true`       | Play a sound when a reminder fires                      |
| `askii.noteSnoozeMinutes` | `10`         | Minutes added by **Snooze**                             |
| `askii.sttPlatform`       | `askiicloud` | Platform used to transcribe voice input                 |
| `askii.sttModel`          | `whisper-1`  | Speech-to-text model                                    |
| `askii.ffmpegPath`        | _(empty)_    | ffmpeg executable for voice input (empty = auto-detect) |

**Agents & browser**

| Setting                 | Default   | Description                              |
| ----------------------- | --------- | ---------------------------------------- |
| `askii.doMaxRounds`     | `5`       | Max rounds for Do / Control              |
| `askii.doAutoConfirm`   | `false`   | Skip write confirmations                 |
| `askii.formatAfterEdit` | `false`   | Format files after Edit / Do             |
| `askii.browserHeadless` | `false`   | Hide the Puppeteer browser window        |
| `askii.chromePath`      | _(empty)_ | Browser executable (empty = auto-detect) |

**Git**

| Setting                           | Default    | Description                        |
| --------------------------------- | ---------- | ---------------------------------- |
| `askii.commitMessageStyle`        | `oneliner` | Generated message style            |
| `askii.commitMessageInstructions` | _(empty)_  | `.md` file with extra commit rules |

## CLI

ASKII also ships as a terminal CLI with an interactive REPL and the same ask / edit / do / control / browse / note commands:

```bash
npm install -g askii-cli
```

See [cli/README.md](cli/README.md).

## Requirements

- VS Code **1.108+**
- Control requires a **vision-capable model**; screen control needs `xdotool` on Linux; browser mode needs a Chromium-based browser
- Voice input requires **ffmpeg** on PATH (auto-detected, or set `askii.ffmpegPath`)

## Development

```bash
git clone https://github.com/danisss9/ASKII.git
cd ASKII && npm install

npm run watch     # tsc + esbuild watchers — then F5 to launch the extension
npm run compile   # type-check + lint + bundle
npm run package   # production bundle (for vsce)
npm test          # integration tests (@vscode/test-electron)
```

- `src/` — extension host code
- `common/` — pure Node code shared with the CLI (never imports `vscode`)
- `cli/` — the CLI package (`npm run build` / `npm run dev`)

## License

[MIT](LICENSE)
