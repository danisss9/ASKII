# ASKII CLI ( •_•)>⌐■-■ (⌐■_■)

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

| Command | Description |
| --- | --- |
| `/ask <question>` | Explicit ask (same as bare text) |
| `/do <task> [flags]` | Run the Do agent (`--max-rounds N`, `--yes`) |
| `/edit --file <path> <instruction>` | Edit a file in place |
| `/explain <text>` | Explain a line of code |
| `/commit` | Generate a commit message from the staged/working-tree diff |
| `/note <subcommand>` | Notes / tasks / reminders (same as the `note` command) |
| `/wiki-reload` | Rebuild the wiki index |
| `/platform <name>` · `/model <name>` | Switch platform / model for the session |
| `/config` | Show session config (keys redacted) |
| `/clear` | Clear chat history |
| `/help` · `/exit` · `/quit` | Help, quit |

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
askii do --yes "scaffold a README for this project"    # auto-confirm all
askii do --dir ./my-project "refactor index.ts"
```

Prints the working directory's top-level listing, then loops until the AI returns `[]` or `--max-rounds` (default 5):

| Action | Description | Confirm |
| --- | --- | --- |
| `list`, `view`, `search` | Explore the workspace (`list` labels `[file]` / `[folder]`) | No |
| `wiki_search` | BM25 search over indexed `.md` docs (needs `--use-wiki`) | No |
| `create`, `write`, `modify`, `rename`, `copy`, `mkdir`, `delete` | Write files (existing files are backed up to `.askii/backups/`) | Yes |
| `run` | Run a shell command | Yes (always) |

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

### control — screen agent

```bash
askii control --ollama-model llava "open Notepad and type hello world"
askii control --yes --max-rounds 10 --ollama-model llava "fill in the login form"
```

Takes a screenshot each round and executes the returned `mouse_move`, `mouse_left_click`, `mouse_right_click`, `keyboard_input` or `DONE`. Requires a **vision-capable model** (e.g. `llava`, `moondream2`); Linux needs `xdotool`. Without `--yes`, each action is shown with its reasoning and needs a `y` confirmation.

### browse — browser agent

```bash
askii browse --ollama-model llava "go to https://example.com and click Learn more"
askii browse --headless --yes --ollama-model llava "check the title of https://github.com"
```

Drives a Puppeteer browser (visible by default, `--headless` to hide) with `goto`, `click`, `type`, `wait_for`, `back`, `forward` or `DONE`. Requires a **vision-capable model** and a Chromium-based browser — auto-detected (Chrome, Edge, Chromium, Brave), or set `--chrome-path` / `ASKII_CHROME_PATH`.

### wiki-reload — index docs for RAG

```bash
askii wiki-reload --wiki-path ./docs
```

Splits the `.md` files under `--wiki-path` by heading and builds a [MiniSearch](https://github.com/lucaong/minisearch) BM25 index (`.askii-wiki-index.json` inside the wiki folder). Re-run whenever the docs change. Then add `--wiki-path` and `--use-wiki` to inject the top matching chunks into any `ask`, `edit` or `do`:

```bash
askii ask --wiki-path ./docs --use-wiki "how do I configure the database?"
askii do --wiki-path ./docs --use-wiki "implement the auth flow described in the docs"
```

## Options

| Flag | Env | Description | Default |
| --- | --- | --- | --- |
| `-p`, `--platform` | `ASKII_PLATFORM` | `ollama`, `lmstudio`, `openai`, `anthropic`, `opencodego`, `askiicloud` | `ollama` |
| `--ollama-url` | `ASKII_OLLAMA_URL` | Ollama server URL | `http://localhost:11434` |
| `--ollama-model` | `ASKII_OLLAMA_MODEL` | Ollama model | `gemma4:e4b` |
| `--lmstudio-url` | `ASKII_LMSTUDIO_URL` | LM Studio server URL | `ws://localhost:1234` |
| `--lmstudio-model` | `ASKII_LMSTUDIO_MODEL` | LM Studio model | `qwen/qwen3-coder-30b` |
| `--openai-key` | `ASKII_OPENAI_KEY` | OpenAI API key | |
| `--openai-model` | `ASKII_OPENAI_MODEL` | OpenAI model | `gpt-5-mini` |
| `--openai-url` | `ASKII_OPENAI_URL` | OpenAI-compatible base URL (empty = `api.openai.com`) | |
| `--anthropic-key` | `ASKII_ANTHROPIC_KEY` | Anthropic API key | |
| `--anthropic-model` | `ASKII_ANTHROPIC_MODEL` | Anthropic model | `claude-sonnet-4-6` |
| `--opencodego-key` | `ASKII_OPENCODEGO_KEY` | opencode Go API key | |
| `--opencodego-model` | `ASKII_OPENCODEGO_MODEL` | opencode Go model | `glm-5.2` |
| `--opencodego-url` | `ASKII_OPENCODEGO_URL` | opencode Go base URL | `https://opencode.ai/zen/go/v1` |
| `--askiicloud-key` | `ASKII_CLOUD_KEY` | ASKII Cloud API key | |
| `--askiicloud-model` | `ASKII_CLOUD_MODEL` | ASKII Cloud model | `askii-default` |
| `--mode` | `ASKII_MODE` | Response style: `helpful` or `funny` | `funny` |
| `--max-rounds` | `ASKII_MAX_ROUNDS` | Max agent rounds for `do` / `control` / `browse` | `5` |
| `--dir` | | Working directory for `do` | cwd |
| `-c`, `--code` | | Code input (alternative to stdin) | |
| `--file` | | Filename of the code (e.g. `src/utils.ts`) | |
| `--lang` | | Language of the code (e.g. `typescript`) | |
| `-y`, `--yes` | | Auto-confirm all actions | |
| `--headless` | | Run Puppeteer headlessly for `browse` | visible |
| `--chrome-path` | `ASKII_CHROME_PATH` | Browser executable for `browse` | auto-detect |
| `--wiki-path` | `ASKII_WIKI_PATH` | Docs folder for wiki RAG | |
| `--use-wiki` | `ASKII_USE_WIKI=1` | Inject wiki context into `ask` / `edit` / `do` | |
| `-h`, `--help` | | Show help | |

## Platforms

```bash
# Ollama (default, local)
ollama pull gemma4:e4b
askii ask "what is a closure?"

# LM Studio (local server enabled)
askii -p lmstudio ask "explain this function"

# OpenAI — or any OpenAI-compatible API (Azure, etc.)
askii -p openai --openai-key sk-... do "add error handling"
askii -p openai --openai-key sk-... --openai-url https://my-resource.openai.azure.com ask "explain"

# Anthropic
askii -p anthropic --anthropic-key sk-ant-... do "add error handling"

# opencode Go — routes OpenAI-/Anthropic-compatible per model automatically
askii -p opencodego --opencodego-key ... --opencodego-model kimi-k2.7-code do "add error handling"

# ASKII Cloud — base URL fixed to https://api.askii.dev/v1
askii -p askiicloud --askiicloud-key ... ask "what does this do?"
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
