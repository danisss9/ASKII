# ASKII ( •*•)>⌐■-■ (⌐■*■)

An AI code assistant for VS Code with style — ask about your code, have it edited for you, run agentic tasks, drive your screen or a browser, and keep AI-classified notes, tasks and reminders. Bring your own LLM: ASKII Cloud, Ollama, LM Studio, OpenAI, Anthropic, or opencode Go.

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=danisss9.askii) · [Open VSX](https://open-vsx.org/extension/danisss9/askii) · [CLI on npm](https://www.npmjs.com/package/askii-cli)

## Quick start

1. Install ASKII from the VS Code Marketplace — or build it from source (see [Development](#development))
2. Run **ASKII: Open Setup** (`Ctrl+Alt+K S` / `Cmd+Alt+K S`) — a short wizard that walks you through provider, API key, models, options, wiki and advanced settings (notes, reliability, privacy)
3. Select some code and run **ASKII: Ask** (`Ctrl+Alt+K A`)

ASKII uses **ASKII Cloud** unless you pick another provider — see [Privacy & data](#privacy--data) for what is sent where.

## Commands

| Command (palette: `ASKII: …`)   | Keybinding     | What it does                                                                                                        |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ask                             | `Ctrl+Alt+K A` | Ask about the selected code (or anything) — answers stream into a markdown panel with Stop, follow-ups and history  |
| Edit Selection or File          | `Ctrl+Alt+K E` | Replace the selection with an AI-edited version; review the diff and undo if needed                                 |
| Do (Agent Task in Workspace)    | `Ctrl+Alt+K D` | Agentic workspace agent — explores, creates, modifies, renames and deletes files over multiple rounds               |
| Control Screen or Browser       | `Ctrl+Alt+K C` | Screen or browser agent — screenshot-driven mouse/keyboard control, or Puppeteer web automation                     |
| Notes, Tasks & Reminders        | `Ctrl+Alt+K N` | Notes / tasks / reminders panel with search and screenshots                                                         |
| Reload Wikis                    | `Ctrl+Alt+K W` | Rebuild the enabled wiki indexes (docs and/or code)                                                                 |
| Clear Cache                     | `Ctrl+Alt+K X` | Clear cached inline explanations and completions                                                                    |
| Open Setup                      | `Ctrl+Alt+K S` | Re-run the setup wizard (providers, API keys, models, options, wiki, advanced settings)                             |
| Generate Commit Message         | SCM toolbar ✦  | Write a commit message for the staged (or working-tree) diff                                                        |
| Code Review Uncommitted Changes | SCM toolbar    | Review staged, unstaged and untracked changes                                                                       |

On macOS swap `Ctrl` for `Cmd`. The **(⌐■_■)** status-bar button opens a quick-access menu for all of these.

### Ask ASKII

Select some code and ask about it, or ask a general question with nothing selected — the file name, language and selection are included as context automatically (plus matching wiki chunks when wiki RAG is on). Answers stream into the markdown panel with syntax-highlighted code blocks; **Stop** ends an answer early (closing the panel stops it too), and once it is done the panel header gives you **copy**, **follow-up** (previous questions and answers are kept as conversation context) and a **history view** to re-read the whole session.

File citations are clickable: when the answer references a file or code location, references like `src/app.ts:42` render as links — click one to open the file in the editor at exactly that line (ranges like `src/app.ts:10-20` select the whole span). Works for workspace code and docs-wiki files alike.

### ASKII Edit

Describe the change you want and ASKII rewrites your selection — or the whole file if nothing is selected, using the full file as context either way. The request shows a cancellable progress notification; the edit is applied when it arrives, then a side-by-side diff of original vs. proposed code opens beside it so you can review it, with a one-click **Undo** offer to revert (if you have typed in the file since, use the editor's own Undo instead). Optional `askii.formatAfterEdit` formats the document after the edit.

### ASKII Do

Describe a task — ASKII prints the top-level workspace structure, then loops until the task is done or `askii.doMaxRounds` (default 20) is reached. Read-only actions (`list`, `view`, `search`, `wiki_search`, `code_search`) run freely; write actions (`create`, `write`, `modify`, `rename`, `copy`, `mkdir`, `delete`) ask for confirmation (skip with `askii.doAutoConfirm`). Files are backed up before every change, and when the run ends — finished, stopped or failed — you can **Keep** the changes or **Undo all** with one click.

Safety rails that auto-confirm never turns off:

- **Shell commands** (`run`) always ask first; Stop or the 30 s timeout kills the command *and everything it started*
- **Files that can run code** — `.vscode/` (tasks, launch configs, settings), `.husky/`, `.githooks/`, `.devcontainer/` — are always confirmed
- **Never written:** anything inside `.git/` (hooks would run on your next commit) or `.askii/` (Do's own backups)
- **Sandboxed paths:** `../`, absolute paths and symlinks that lead outside the workspace are blocked for reads and writes
- A reply cut off at the model's output-token limit is never applied — the model is asked for smaller steps instead
- Disabled in **Restricted Mode** (untrusted workspaces)

### ASKII Control

Pick **Screen** or **Browser**, then describe the task. ASKII screenshots the current state each round, proposes the next action with its reasoning, and runs it without asking by default (set `askii.controlAutoConfirm` to `false` to confirm each action — it is separate from `askii.doAutoConfirm`):

- **Screen** — `mouse_move`, `mouse_left_click`, `mouse_right_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll`, `keyboard_input`, `key_press`, `click_text`, `DONE`. A `click_text` target is located before you are asked, so you confirm the actual click position
- **Browser** — `goto`, `click`, `type`, `wait_for`, `back`, `forward`, `scroll`, `click_text`, `DONE` (Puppeteer). Only `http(s)` pages can be opened (no `file:`, `javascript:` or `chrome:` URLs), Chromium's sandbox stays on, and text typed into password-like fields is masked in the log

Every proposed action is validated before it runs (numeric coordinates, known keys and directions) — a malformed sequence is rejected as a whole. Requires a **vision-capable model** (e.g. `llava`, `moondream2`). Browser mode auto-detects Chrome / Edge / Chromium / Brave (or set `askii.chromePath`) and is visible by default (`askii.browserHeadless` hides it); the browser closes when the loop ends. Screen control uses shell commands — Linux needs `xdotool`.

### ASKII Note

Type free text — the AI classifies it as a **note**, a **task** (`low` / `medium` / `high` priority) or a **reminder** (with a due time), and asks a clarifying question when the intent or time is ambiguous. Entries are stored globally, tagged by workspace, full-text searchable, and grouped by age (Pinned, Today, Yesterday, This week, Earlier). Hover an entry to pin, edit (with AI re-classify), mark done, snooze / dismiss, or delete it.

- **Time triggers** — a wide range of phrases resolve locally, right in the composer: `in 30 minutes`, `in 1h30m`, `in half an hour`, `in two hours`, `in a couple of hours`, `in a few minutes`, `20 minutes from now`, `an hour from now`, `at 5pm`, `at noon`, `tomorrow at noon`, `at 9 in the morning`, `half past 5`, `quarter to 6`, `later today`, `tonight at 8`, `tomorrow morning`, `day after tomorrow`, `this time tomorrow`, `first thing in the morning`, `on friday`, `friday evening`, `by tuesday at 5pm`, `next monday`, `friday next week`, `next week on wednesday`, `this weekend`, `end of day`, `end of month`, `end of year`, `on the 15th`, `by the 1st of next month`, `july 8th`, `2026-07-08 14:30`, …
- **Recurring triggers** — `every day at 9am`, `daily`, `every morning`, `every weekday at 9`, `every monday at 10`, `every monday and wednesday at 6pm`, `every mon, wed, fri`, `weekly on friday at 5pm`, `every weekend`, `every 2 hours`, `every hour`, `every half hour`, `every other day`, `biweekly`, `quarterly`, `every month`, `every month on the 15th`, `every year on july 8` — the entry re-arms itself after each firing and shows a repeat badge
- **Event triggers** — fire on editor events instead of a clock time: `when I open VS Code`, `on startup`, `when I open this workspace`, `when I open package.json`, `every time I save .env`, `when I open a ts file`, `when I save this file`, or bare `when I save`. One-shot triggers fire once (shown with a ⚡ badge), `every time`/`whenever` triggers re-arm on each matching event
- **Task deadlines & recurring tasks** — tasks accept due times too (`fix the login bug by friday`) and can repeat (`water the plants every 3 days`); when a deadline passes you get a task-due notification with Open / Done / Snooze, and un-completing a done task re-arms it
- **Reminders** fire as VS Code notifications with a sound (the OS's own player: `afplay` on macOS, PowerShell on Windows, `canberra-gtk-play` / `paplay` on Linux) while VS Code is running — once, even with several windows open; ones missed while it was closed re-fire on the next startup
- **Screenshots** — toggle the camera icon to attach a full-screen capture to the entry

### Inline completion & decorations

- Files matching `askii.inlineExcludeGlobs` (by default `.env*`, keys, certificates, `.npmrc`, `.netrc`, `secrets/`, `*secret*`) are never sent by either feature
- `askii.inlineCompletionEnabled` — Copilot-style ghost text; **Tab** accepts, **Esc** dismisses. Tune the trigger with `askii.inlineCompletionEagerness` (`low` 1200 ms / `medium` 500 ms / `high` 200 ms). Suggestions are cached per context, and matching context from your enabled wikis is injected into the prompt
- `askii.inlineHelperMode` — adds a kaomoji decoration after the current line: `helpful`, `funny`, or `wiki` (explanations enriched by matching context from your enabled wikis — docs and code). Example:

```javascript
const sum = a + b; (◕‿◕) Adds two variables; prefer const for variables that won't be reassigned.
```

### Wiki RAG

1. Point `askii.wikiPath` at a folder of `.md` docs
2. Run **ASKII: Reload Wikis** — chunks the docs by heading and builds a vector index (embeddings run locally via embeddinggemma2)
3. Enable `askii.wikiEnabled` — matching chunks are injected into Ask / Edit / Do as context
4. Optional: `askii.wikiAutoReload` rebuilds the index on startup

### Code wiki

A vector index over your **workspace code** (code files only — no `.md`, `.txt`, `.json`, markup, or images) used as retrieval context for Ask / Edit / Do:

1. Run **ASKII: Reload Wikis** (or `askii wiki-reload --use-code-wiki`) — walks the workspace (respecting root `.gitignore` and skipping `node_modules`/build dirs), chunks code into overlapping 60-line windows, and embeds them
2. Enable `askii.codeWikiEnabled` — relevant code chunks are injected into Ask / Edit as context, and the Do agent gets a `code_search` action for semantic lookup
3. Optional: `askii.codeWikiAutoReload` rebuilds the index on startup

Both wikis run **[embeddinggemma2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) fully locally in JavaScript** (Transformers.js + ONNX WASM — no API keys, no external services). The model downloads once (~314 MB) to `~/.askii/models` on first use and is shared by the CLI and the extension. Rebuilds are **incremental** (unchanged files keep their vectors), **crash-safe** (a rebuild commits atomically, so an interrupted one leaves the previous index intact, and a corrupt index is rebuilt from scratch) and the index is **memory-optimized**: Int8-quantized vectors (~¼ the RAM of Float32), metadata packed as typed arrays, and chunk text stays on disk — only the top hits are read back. Indexes live in `.askii/code-wiki/` (workspace) and `.askii-wiki-index/` (wiki folder).

### Commit messages

A **✦** button in the Source Control view toolbar generates a commit message from your staged (or working-tree) diff straight into the input box. It styles the message after your repo's last 10 commits, honors `askii.commitMessageStyle` (`oneliner` / `brief` / `descriptive`), and appends your own rules from the `.md` file in `askii.commitMessageInstructions`. While it runs, the button turns into a **■ stop** button that cancels it.

### Code review

The **Code Review Uncommitted Changes** button (checklist icon) in the Source Control toolbar sends all uncommitted changes (staged, unstaged and untracked files) to the Ask / Edit / Do model. It opens a review panel that lists each problem with its severity, a `file:line` link and a recommendation. While the review runs, the button turns into a **■ stop** button that cancels it.

- **Auto Fix** asks the model to fix that one problem and applies the fix to the file as an unsaved edit (`Ctrl+Z` undoes it)
- **Fixed It** marks a problem you fixed yourself; **Reopen** undoes the mark
- **Show fixed** hides or shows the problems that are already fixed

## LLM platforms

| Platform                              | Type  | Setup                                                                                  |
| ------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| **ASKII Cloud** (default)             | Cloud | API key — base URL is fixed to `https://api.askii.dev/v1`                              |
| [Ollama](https://ollama.com)          | Local | Install + pull a model (e.g. `gemma4:e4b`), runs at `http://localhost:11434`           |
| [LM Studio](https://lmstudio.ai)      | Local | Enable the local server (`ws://localhost:1234`) and load a model                       |
| OpenAI or compatible                  | Cloud | API key; set `askii.openaiUrl` for Azure etc. (empty = `api.openai.com`)               |
| Anthropic                             | Cloud | API key                                                                                |
| [opencode Go](https://opencode.ai/go) | Cloud | API key                                                                                |

**API keys** are entered in **ASKII: Open Setup** and stored in VS Code's **secret storage** (the OS keychain) — never in `settings.json`.

Each feature group picks its own platform and model, so you can mix providers:

| Feature group                                   | Platform                  | Model                  | Default model |
| ----------------------------------------------- | ------------------------- | ---------------------- | ------------- |
| Ask / Edit / Do, code review, Note              | `askii.llmPlatform`       | `askii.llmModel`       | `askii-smart` |
| Inline suggestions, completion, commit messages | `askii.llmInlinePlatform` | `askii.llmInlineModel` | `askii-fast`  |
| Control (vision)                                | `askii.llmVisionPlatform` | `askii.llmVisionModel` | `askii-smart` |

API keys and server URLs are shared per provider across all groups. An empty inline/vision model falls back to `askii.llmModel` only when that group uses the same platform. Every request can be cancelled, times out after `askii.requestTimeoutSeconds` (default 600), and is retried with backoff on network errors, rate limits (429) and server errors (5xx) — never on authentication or other client errors.

## Privacy & data

ASKII sends data only to the LLM platform you configure for each feature group — **ASKII Cloud by default**, so out of the box the following goes to `api.askii.dev` (choose Ollama or LM Studio in Setup to keep everything on your machine):

| Feature                       | What is sent                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Ask / Edit                    | Your question, the file name and language, the selection (Edit: the whole file), matching wiki chunks |
| Do                            | The task, the workspace's top-level listing, and the files / search results the agent reads        |
| Inline completion / helper    | The code around the cursor (except files matching `askii.inlineExcludeGlobs`)                      |
| Commit message / code review  | The diff of your changes and the last 10 commit messages                                           |
| Control                       | Screenshots of the screen or browser page, and the task                                            |
| Note                          | The note text and its context (workspace, file name, selection) for classification                 |

Wiki embeddings run **locally** (embeddinggemma2) — documents and code are never sent anywhere to be indexed; the model is downloaded once from Hugging Face. ASKII collects **no telemetry**.

## Security

- **Restricted Mode:** in an untrusted workspace ASKII Do is disabled, wikis are not rebuilt automatically, and the workspace's `.vscode/settings.json` cannot change which platform, files or features ASKII uses
- See [ASKII Do](#askii-do) and [ASKII Control](#askii-control) for the agents' safety rails, and [SECURITY.md](SECURITY.md) to report a vulnerability

## Configuration

All settings live in VS Code Settings under the `askii.*` namespace.

**LLM**

| Setting                       | Default                  | Description                                                        |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `askii.llmPlatform`           | `askiicloud`             | Platform for Ask / Edit / Do / code review / Note                  |
| `askii.llmModel`              | `askii-smart`            | Model for that group                                               |
| `askii.llmInlinePlatform`     | `askiicloud`             | Platform for inline features and commit messages                   |
| `askii.llmInlineModel`        | `askii-fast`             | Model for that group                                               |
| `askii.llmVisionPlatform`     | `askiicloud`             | Platform for Control                                               |
| `askii.llmVisionModel`        | `askii-smart`            | Vision-capable model for Control                                   |
| `askii.ollamaUrl`             | `http://localhost:11434` | Ollama server                                                      |
| `askii.lmStudioUrl`           | `ws://localhost:1234`    | LM Studio server                                                   |
| `askii.openaiUrl`             | _(empty)_                | OpenAI-compatible base URL                                         |
| `askii.requestTimeoutSeconds` | `600`                    | Cancel a request after this long (`0` = never)                     |
| `askii.maxOutputTokens`       | `0`                      | Output-token cap per reply (`0` = provider default; Anthropic 8192) |

**Inline**

| Setting                            | Default  | Description                                             |
| ---------------------------------- | -------- | ------------------------------------------------------- |
| `askii.inlineCompletionEnabled`    | `false`  | Ghost-text completions                                  |
| `askii.inlineCompletionEagerness`  | `medium` | `low` / `medium` / `high` trigger delay                 |
| `askii.inlineHelperMode`           | `off`    | Kaomoji line helper: `off`, `helpful`, `funny`, `wiki`  |
| `askii.inlineExcludeGlobs`         | secrets  | Files never sent by the inline features                 |

**Notes & reminders**

| Setting                   | Default | Description                        |
| ------------------------- | ------- | ---------------------------------- |
| `askii.noteReminderSound` | `true`  | Play a sound when a reminder fires |
| `askii.noteSnoozeMinutes` | `10`    | Minutes added by **Snooze**        |

**Agents & browser**

| Setting                      | Default   | Description                                                             |
| ---------------------------- | --------- | ----------------------------------------------------------------------- |
| `askii.doMaxRounds`          | `20`      | Max rounds for Do / Control                                             |
| `askii.doAutoConfirm`        | `false`   | Skip Do's file-edit confirmations (never `run` or sensitive files)       |
| `askii.controlAutoConfirm`   | `true`    | Run Control actions without asking                                      |
| `askii.formatAfterEdit`      | `false`   | Format files after Edit / Do                                            |
| `askii.browserHeadless`      | `false`   | Hide the Puppeteer browser window                                       |
| `askii.chromePath`           | _(empty)_ | Browser executable (empty = auto-detect)                                |

**Git**

| Setting                           | Default    | Description                               |
| --------------------------------- | ---------- | ----------------------------------------- |
| `askii.commitMessageStyle`        | `oneliner` | Generated message style                   |
| `askii.commitMessageInstructions` | _(empty)_  | `.md` / `.txt` file with extra commit rules |

**Wiki RAG**

| Setting                    | Default   | Description                                   |
| -------------------------- | --------- | --------------------------------------------- |
| `askii.wikiEnabled`        | `false`   | Inject docs wiki context into Ask / Edit / Do |
| `askii.wikiPath`           | _(empty)_ | Folder of `.md` docs                          |
| `askii.wikiAutoReload`     | `false`   | Rebuild docs wiki on startup                  |
| `askii.codeWikiEnabled`    | `false`   | Inject code wiki context into Ask / Edit / Do |
| `askii.codeWikiAutoReload` | `false`   | Rebuild code wiki on startup                  |

Embeddings for both wikis run locally (embeddinggemma2) — no embedding settings required. Diagnostics are logged to **Output → ASKII**.

## CLI

ASKII also ships as a terminal CLI with an interactive REPL and the same ask / edit / do / control / browse / note commands:

```bash
npm install -g askii-cli
```

See [cli/README.md](cli/README.md).

## Requirements

- VS Code **1.108+**
- Control requires a **vision-capable model**; screen control needs `xdotool` on Linux; browser mode needs a Chromium-based browser
- **Remote development** (SSH, containers, WSL): ASKII runs on the remote side, next to your files — Do, Ask, Edit and the wikis work as usual, but Control and note screenshots act on the *remote* machine's display, so use them locally

## Development

```bash
git clone https://github.com/danisss9/ASKII.git
cd ASKII && npm install

npm run watch     # tsc + esbuild watchers — then F5 to launch the extension
npm run compile   # type-check (extension + CLI) + lint + bundle
npm run package   # production bundle (for vsce)
npm run test:unit # unit tests in plain Node (fast)
npm test          # the same suites inside VS Code (@vscode/test-electron)
```

- `src/` — extension host code
- `common/` — pure Node code shared with the CLI (never imports `vscode`)
- `cli/` — the CLI package (`npm run build` / `npm run dev`)

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release process.

## License

[MIT](LICENSE)
