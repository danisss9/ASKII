# ASKII CLI ( •*•)>⌐■-■ (⌐■*■)

AI code assistant for your terminal — ask, edit, explain, run agentic file tasks, drive your screen or a browser, and keep AI-classified notes. Works with Ollama, LM Studio, OpenAI, Anthropic, opencode Go, or ASKII Cloud. Requires Node 18+.

## Install

```bash
npm install -g askii-cli

# or run without installing
npx askii-cli <command>
```

## Interactive mode

Run `askii` with no arguments to start a REPL with persistent chat history:

```
ASKII ( •_•)>⌐■-■ (⌐■_■)  — interactive mode

  Platform : ollama (gemma4:e4b)
  Workspace: /your/project
  Wiki     : off

Type a message to chat, /help for commands, /exit to quit.

> what does a closure do in JavaScript?

ASKII: A closure is a function that retains access to variables
from its enclosing scope even after that scope has finished...

> can you give me an example?

ASKII: Sure! Here's a classic counter example...

> /platform anthropic
Platform → anthropic (claude-sonnet-4-6)

> /do add a .gitignore for a Node.js project
[Round 1/5]
...

> /exit
Bye! ( •_•)>⌐■-■ (⌐■_■)
```

Bare text keeps the full conversation across turns (`/clear` resets it). Tab completes `/` commands and ↑ / ↓ cycle input history. Bare `--` flags update the session config without restarting (`--platform openai --model gpt-4-turbo`, `--max-rounds 10`, `--mode helpful`). Ctrl+C cancels a running agent and returns to the `>` prompt; at the idle prompt it exits.

| Command                              | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| `/ask <question>`                    | Explicit ask (same as bare text)                            |
| `/do <task> [flags]`                 | Run the Do agent (`--max-rounds N`, `--yes`)                |
| `/edit --file <path> <instruction>`  | Edit a file in place                                        |
| `/explain <text>`                    | Explain a line of code                                      |
| `/commit`                            | Generate a commit message from the staged/working-tree diff |
| `/note <subcommand>`                 | Notes / tasks / reminders (same as the `note` command)      |
| `/wiki-reload`                       | Reload the enabled wiki indexes (docs and/or code)           |
| `/platform <name>` · `/model <name>` | Switch platform / model for the session                     |
| `/config`                            | Show session config (keys redacted)                         |
| `/clear`                             | Clear chat history                                          |
| `/help` · `/exit` · `/quit`          | Help, quit                                                  |

## Commands

Code is read from stdin or passed with `--code` (`--file` / `--lang` add filename and language hints). In PowerShell, pipe with `Get-Content myfile.ts | askii ...`.

### ask — ask about code

```bash
cat myfile.ts | askii ask "what does this do?"
askii ask --code "const x = 1 + 1" "is this correct?"
```

### explain — explain a line

```bash
askii explain "arr.reduce((a, b) => a + b, 0)"
cat myfile.ts | askii explain
```

### edit — transform code

Prints the edited code to stdout — pipe-friendly:

```bash
cat myfile.ts | askii edit "add error handling" > myfile-edited.ts
```

### do — agentic task runner

```bash
askii do "create a Jest test file for src/utils.ts"
askii do --yes "scaffold a README for this project"    # auto-confirm file edits
askii do --dir ./my-project "refactor index.ts"
```

Prints the working directory's top-level listing, then loops until the AI returns `[]` or `--max-rounds` (default 5):

| Action                                                           | Description                                                     | Confirm      |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `list`, `view`, `search`                                         | Explore the workspace (`list` labels `[file]` / `[folder]`)     | No           |
| `wiki_search`                                                    | Semantic vector search over indexed `.md` docs (needs `--use-wiki`) | No       |
| `code_search`                                                    | Semantic vector search over indexed workspace code (needs `--use-code-wiki`) | No |
| `create`, `write`, `modify`, `rename`, `copy`, `mkdir`, `delete` | Write files (existing files are backed up to `.askii/backups/`) | Yes          |
| `run`                                                            | Run a shell command                                             | Yes (always) |

Safety rails that `--yes` never turns off: `run` always asks (Ctrl+C or the 30 s timeout kills the command and everything it started); files that can run code — `.vscode/`, `.husky/`, `.githooks/`, `.devcontainer/` — always ask; nothing inside `.git/` or `.askii/` is ever written; paths that escape the directory (`../`, absolute paths, symlinks pointing outside it) are blocked; a reply cut off at the model's token limit is never applied. When the run ends you can undo every change. The first Ctrl+C stops the agent (and the request in flight) and still offers the undo; a second one exits immediately.

### commit — generate a commit message

```bash
git commit -m "$(askii commit)"
askii commit --dir ./my-project
```

Reads the staged diff (or the working-tree diff when nothing is staged), caps it at 12,000 characters, and prints a message styled after the repo's last 10 commits — cleaned of markdown fences, quotes and `Commit message:` labels, ready for `git commit -m`.

### note — notes / tasks / reminders

```bash
askii note add "the API rate limit is 100 req/min"
askii note add "task: fix the login bug, high priority"
askii note add "remind me to check the build in 30 minutes"
askii note add --shot "remember this screen state"   # attach a screenshot

askii note list              # list entries (most-recent first); optional query: askii note list "login"
askii note search "login"    # full-text search
askii note done abc12345     # toggle a task's done state
askii note delete abc12345   # delete an entry
askii note due               # print overdue reminders (marks them fired)
```

Free text is auto-classified as a **note**, **task** (`low` / `medium` / `high` priority) or **reminder** (with a due time). Entries are stored globally at `~/.askii/notes.json`, tagged by workspace, and searchable everywhere. The CLI has no background scheduler — run `askii note due` to see what's overdue. In the REPL, `/note add` asks a clarifying question when the reminder time is ambiguous.

### control — screen or browser agent

```bash
askii control --ollama-model llava "open Notepad and type hello world"
askii control --yes --max-rounds 10 --ollama-model llava "fill in the login form"
askii control --target browser --ollama-model llava "go to https://example.com and click Learn more"
askii control --target browser --headless --yes --ollama-model llava "check the title of https://github.com"
```

`control` drives the whole screen by default, taking a screenshot each round and executing returned `mouse_move`, `mouse_left_click`, `mouse_right_click`, `keyboard_input` or `DONE` actions. Set `--target browser` to launch and control a Puppeteer browser with `goto`, `click`, `type`, `wait_for`, `back`, `forward` or `DONE` actions. You can also set `ASKII_CONTROL_TARGET=browser` instead of passing the flag. Requires a **vision-capable model** (e.g. `llava`, `moondream2`); screen control on Linux needs `xdotool`. Without `--yes`, each action is shown with its reasoning and needs a `y` confirmation.

`browse` is an alias for `control --target browser`:

```bash
askii browse --ollama-model llava "go to https://example.com and click Learn more"
```

Browse drives a Puppeteer browser (visible by default, `--headless` to hide) with `goto`, `click`, `type`, `wait_for`, `back`, `forward` or `DONE`. Requires a **vision-capable model** and a Chromium-based browser — auto-detected (Chrome, Edge, Chromium, Brave), or set `--chrome-path` / `ASKII_CHROME_PATH`.

### wiki-reload — reload the enabled wikis

```bash
askii wiki-reload --wiki-path ./docs
askii wiki-reload --use-code-wiki
```

Reloads every wiki enabled via flags/env:

- **Docs wiki** (when `--wiki-path` is set): splits the `.md` files by heading and builds a vector index in `.askii-wiki-index/` inside the wiki folder. Then add `--wiki-path` and `--use-wiki` to inject the top matching chunks into any `ask`, `edit` or `do`:

```bash
askii ask --wiki-path ./docs --use-wiki "how do I configure the database?"
askii do --wiki-path ./docs --use-wiki "implement the auth flow described in the docs"
```

- **Code wiki** (when `--use-code-wiki` is set): walks the workspace's code files (code only — no `.md`/`.txt`/`.json`/images), respecting the root `.gitignore`, and builds a vector index in `.askii/code-wiki/`. Rebuilds are incremental (unchanged files keep their vectors). Then add `--use-code-wiki` to inject relevant code chunks into `ask` / `edit` and to give `do` a semantic `code_search` action:

```bash
askii wiki-reload --use-code-wiki
askii ask --use-code-wiki "where is buildDoSystemPrompt defined?"
askii do --use-code-wiki "update the workspace actions to support undo"
```

Both wikis embed with **embeddinggemma2 running locally in JavaScript** (Transformers.js + ONNX — no API keys, no external services). The model downloads once (~314 MB) to `~/.askii/models` on first use.

## Options

| Flag                 | Env                      | Description                                                             | Default                         |
| -------------------- | ------------------------ | ----------------------------------------------------------------------- | ------------------------------- |
| `-p`, `--platform`   | `ASKII_PLATFORM`         | `ollama`, `lmstudio`, `openai`, `anthropic`, `opencodego`, `askiicloud` | `ollama`                        |
| `--ollama-url`       | `ASKII_OLLAMA_URL`       | Ollama server URL                                                       | `http://localhost:11434`        |
| `--ollama-model`     | `ASKII_OLLAMA_MODEL`     | Ollama model                                                            | `gemma4:e4b`                    |
| `--lmstudio-url`     | `ASKII_LMSTUDIO_URL`     | LM Studio server URL                                                    | `ws://localhost:1234`           |
| `--lmstudio-model`   | `ASKII_LMSTUDIO_MODEL`   | LM Studio model                                                         | `qwen/qwen3-coder-30b`          |
| `--openai-key`       | `ASKII_OPENAI_KEY`       | OpenAI API key                                                          |                                 |
| `--openai-model`     | `ASKII_OPENAI_MODEL`     | OpenAI model                                                            | `gpt-5-mini`                    |
| `--openai-url`       | `ASKII_OPENAI_URL`       | OpenAI-compatible base URL (empty = `api.openai.com`)                   |                                 |
| `--anthropic-key`    | `ASKII_ANTHROPIC_KEY`    | Anthropic API key                                                       |                                 |
| `--anthropic-model`  | `ASKII_ANTHROPIC_MODEL`  | Anthropic model                                                         | `claude-sonnet-4-6`             |
| `--opencodego-key`   | `ASKII_OPENCODEGO_KEY`   | opencode Go API key                                                     |                                 |
| `--opencodego-model` | `ASKII_OPENCODEGO_MODEL` | opencode Go model                                                       | `glm-5.2`                       |
| `--opencodego-url`   | `ASKII_OPENCODEGO_URL`   | opencode Go base URL                                                    | `https://opencode.ai/zen/go/v1` |
| `--askiicloud-key`   | `ASKII_CLOUD_KEY`        | ASKII Cloud API key                                                     |                                 |
| `--askiicloud-model` | `ASKII_CLOUD_MODEL`      | ASKII Cloud model                                                       | `askii-default`                 |
| `--askiicloud-url`   | `ASKII_CLOUD_URL`        | ASKII Cloud base URL                                                    | `https://api.askii.dev/v1`      |
| `--timeout`          | `ASKII_TIMEOUT`          | Per-request timeout in seconds                                          | `600`                           |
| `--mode`             | `ASKII_MODE`             | Response style: `helpful` or `funny`                                    | `funny`                         |
| `--max-rounds`       | `ASKII_MAX_ROUNDS`       | Max agent rounds for `do` / `control`                                   | `5`                             |
| `--dir`              |                          | Working directory for `do`                                              | cwd                             |
| `-c`, `--code`       |                          | Code input (alternative to stdin)                                       |                                 |
| `--file`             |                          | Filename of the code (e.g. `src/utils.ts`)                              |                                 |
| `--lang`             |                          | Language of the code (e.g. `typescript`)                                |                                 |
| `-y`, `--yes`        |                          | Auto-confirm `do` file edits and `control` actions (never `run`)        |                                 |
| `--target`           | `ASKII_CONTROL_TARGET`   | Target for `control`: `screen` or `browser`                             | `screen`                        |
| `--headless`         |                          | Run Puppeteer headlessly for `control --target browser`                 | visible                         |
| `--chrome-path`      | `ASKII_CHROME_PATH`      | Browser executable for `control --target browser`                       | auto-detect                     |
| `--wiki-path`        | `ASKII_WIKI_PATH`        | Docs folder for wiki RAG                                                |                                 |
| `--use-wiki`         | `ASKII_USE_WIKI=1`       | Inject wiki context into `ask` / `edit` / `do`                          |                                 |
| `--use-code-wiki`    | `ASKII_USE_CODE_WIKI=1`  | Inject code wiki context into `ask` / `edit` / `do`                     |                                 |
| `-v`, `--version`    |                          | Print the version                                                       |                                 |
| `-h`, `--help`       |                          | Show help                                                               |                                 |

Unknown options print a warning; invalid values (`--max-rounds abc`, an unknown `--platform`) are errors.

**API keys:** prefer the `ASKII_*_KEY` environment variables — values passed as `--*-key` flags are visible to other users in the process list and stay in your shell history.

**Exit codes:** `0` success · `1` error · `2` invalid usage · `130` stopped with Ctrl+C.

LLM requests time out after `--timeout` seconds and are retried with backoff on network errors, rate limits (429) and server errors (5xx) — never on authentication or other client errors.

## Platforms

```bash
# Ollama (default, local)
ollama pull gemma4:e4b
askii ask "what is a closure?"

# LM Studio (local server enabled)
askii -p lmstudio ask "explain this function"

# OpenAI — or any OpenAI-compatible API (Azure, etc.)
export ASKII_OPENAI_KEY=sk-...
askii -p openai do "add error handling"
askii -p openai --openai-url https://my-resource.openai.azure.com ask "explain"

# Anthropic
ASKII_ANTHROPIC_KEY=sk-ant-... askii -p anthropic do "add error handling"

# opencode Go — routes OpenAI-/Anthropic-compatible per model automatically
ASKII_OPENCODEGO_KEY=... askii -p opencodego --opencodego-model kimi-k2.7-code do "add error handling"

# ASKII Cloud — https://api.askii.dev/v1 (override with --askiicloud-url)
ASKII_CLOUD_KEY=... askii -p askiicloud ask "what does this do?"
```

## Development

Part of the [ASKII](https://github.com/danisss9/ASKII) repo (VS Code extension + CLI; shared code in `common/`):

```bash
cd cli
npm install
npm run build   # esbuild bundle
npm run dev     # watch mode
```

## License

MIT
