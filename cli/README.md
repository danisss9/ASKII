# ASKII CLI ( •\_•)>⌐■-■ (⌐■_■)

AI code assistant for your terminal. Powered by Ollama, LM Studio, OpenAI, Anthropic, opencode Go, or ASKII Cloud.

## Install

```bash
npm install -g askii-cli
```

Or run without installing:

```bash
npx askii-cli <command>
```

## Interactive Mode

Run `askii` with no arguments to start an interactive REPL session:

```bash
askii
askii --platform anthropic   # start with a specific platform
```

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

Bare text input maintains a **persistent chat history** across turns — follow-up questions remember the full conversation. Use `/clear` to start fresh.

### REPL slash-commands

| Command                       | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `/help`                       | Show all available commands                                                  |
| `/ask <question>`             | Explicit ask (same as bare text)                                             |
| `/do <task> [flags]`          | Run the Do agent (`--max-rounds N`, `--yes`)                                 |
| `/generate <type> <base>`     | Generate a file (`test` / `doc` / `json`) — agentic, can search & ask        |
| `/commit`                     | Generate a commit message from staged/working-tree diff                      |
| `/note <subcommand>`          | Notes / tasks / reminders (`add`, `list`, `search`, `done`, `delete`, `due`) |
| `/edit --file <path> <instr>` | Edit a file in place                                                         |
| `/explain <text>`             | Explain a line of code                                                       |
| `/wiki-reload`                | Rebuild the docs wiki index                                                  |
| `/platform <name>`            | Switch platform for the session (also updates default model)                 |
| `/model <name>`               | Switch model for the session                                                 |
| `/config`                     | Show current session config (keys redacted)                                  |
| `/clear`                      | Clear chat history and start a fresh conversation                            |
| `/exit`, `/quit`              | Exit interactive mode                                                        |

Tab-complete any `/` command by pressing Tab. Up/down arrows cycle through input history.

**Config overrides** — bare `--` flags at the prompt update session config without restarting:

```
> --platform openai --model gpt-4-turbo
> --max-rounds 10
> --mode helpful
```

Ctrl+C during `/do` or `/control` cancels only that agent and returns to the `>` prompt. Ctrl+C at the idle prompt exits.

---

## Commands

### `ask` — Ask a question about code

Pipe code via stdin or use `--code`:

**bash**

```bash
cat myfile.ts | askii ask "what does this do?"
askii ask --code "const x = 1 + 1" "is this correct?"
```

**PowerShell**

```powershell
Get-Content myfile.ts | askii ask "what does this do?"
askii ask --code "const x = 1 + 1" "is this correct?"
```

---

### `edit` — Edit code

Returns the modified code to stdout (pipe-friendly):

**bash**

```bash
cat myfile.ts | askii edit "add error handling" > myfile-edited.ts
cat myfile.ts | askii edit "convert to async/await"
```

**PowerShell**

```powershell
Get-Content myfile.ts | askii edit "add error handling" | Set-Content myfile-edited.ts
Get-Content myfile.ts | askii edit "convert to async/await"
```

---

### `explain` — Explain a line of code

**bash**

```bash
askii explain "arr.reduce((a, b) => a + b, 0)"
cat myfile.ts | askii explain
```

**PowerShell**

```powershell
askii explain "arr.reduce((a, b) => a + b, 0)"
Get-Content myfile.ts | askii explain
```

---

### `do` — Agentic task runner

Prints the working directory's top-level file listing, then runs an agent loop that creates, modifies, renames, deletes, views, and lists files until the task is done or `--max-rounds` is reached.

**bash**

```bash
askii do "create a Jest test file for src/utils.ts"
askii do "rename all .js files to .ts in the src folder"
askii do "add a .gitignore for a Node.js project"
askii do --yes "scaffold a README for this project"   # auto-confirm all
askii do --dir ./my-project "refactor index.ts"
```

**PowerShell**

```powershell
askii do "create a Jest test file for src/utils.ts"
askii do "rename all .js files to .ts in the src folder"
askii do "add a .gitignore for a Node.js project"
askii do --yes "scaffold a README for this project"   # auto-confirm all
askii do --dir .\my-project "refactor index.ts"
```

The agent can use the following actions each round:

| Action        | Description                                                 | Requires confirmation |
| ------------- | ----------------------------------------------------------- | --------------------- |
| `list`        | List files in a folder (`[file]` / `[folder]` labels)       | No                    |
| `view`        | Read a file's contents                                      | No                    |
| `search`      | Grep workspace files for a pattern                          | No                    |
| `wiki_search` | BM25 search over indexed `.md` docs (requires `--use-wiki`) | No                    |
| `create`      | Create a new file                                           | Yes                   |
| `modify`      | Replace text in an existing file                            | Yes                   |
| `rename`      | Rename or move a file                                       | Yes                   |
| `delete`      | Delete a file                                               | Yes                   |
| `run`         | Run a shell command                                         | Yes (always)          |

The loop continues after every round — not only after reads — until the AI returns `[]` or the round limit is hit.

---

### `generate` — Agentic file generator

Picks a file type (Test / Doc / Json) and a base name, then runs a Do-style loop that searches the workspace, asks clarifying questions when needed, and creates the generated file. The agent decides the full path and extension based on workspace conventions.

**bash**

```bash
askii generate test utils --file src/utils.ts --instruction "use Jest"
askii generate doc api --dir ./my-project
askii generate json schema --file package.json
askii generate test utils --yes   # auto-confirm (no clarifications prompted)
```

**PowerShell**

```powershell
askii generate test utils --file src/utils.ts --instruction "use Jest"
askii generate doc api --dir .\my-project
askii generate json schema --file package.json
askii generate test utils --yes
```

Each round the agent can use:

| Action        | Description                                                           | Prompts you? |
| ------------- | --------------------------------------------------------------------- | ------------ |
| `list`        | List files in a folder (`[file]` / `[folder]` labels)                 | No           |
| `view`        | Read a file's contents                                                | No           |
| `search`      | Grep workspace files for a pattern                                    | No           |
| `wiki_search` | BM25 search over indexed `.md` docs (requires `--use-wiki`)           | No           |
| `clarify`     | Ask you a clarifying question (type your answer at the prompt)        | Yes          |
| `create`      | Create the generated file (written directly; Undo offered at the end) | No           |

Optional flags:

- `--file <path>` — read this file as context (acts as the "current tab")
- `--instruction <text>` — extra instructions for the generator
- `--dir <path>` — working directory (default: cwd)
- `--yes` — auto-confirm (skips clarification prompts)

---

### `control` — Screen control agent

Takes a screenshot, sends it to the AI, and executes the returned mouse/keyboard action. Repeats until the AI returns `DONE` or `--max-rounds` is reached. Requires a **vision-capable model** (e.g. `llava`, `moondream2`).

> **Linux**: requires `xdotool` for mouse/keyboard control (`sudo apt install xdotool` or equivalent).

**bash**

```bash
askii control --ollama-model llava "open Notepad and type hello world"
askii control --yes --ollama-model llava "click the search bar and search for cats"
askii control --max-rounds 10 --ollama-model llava "fill in the login form"
askii control -p lmstudio --lmstudio-model llava-1.5 "open the browser"
```

**PowerShell**

```powershell
askii control --ollama-model llava "open Notepad and type hello world"
askii control --yes --ollama-model llava "click the search bar and search for cats"
askii control --max-rounds 10 --ollama-model llava "fill in the login form"
askii control -p lmstudio --lmstudio-model llava-1.5 "open the browser"
```

Each round the AI can return one of:

- **mouse_move** — move the cursor to `(x, y)`
- **mouse_left_click** — left-click at `(x, y)`
- **mouse_right_click** — right-click at `(x, y)`
- **keyboard_input** — type a string
- **DONE** — task complete, stop the loop

Without `--yes`, each proposed action is shown with its reasoning and requires `y` confirmation before executing.

---

### `wiki-reload` — Index wiki documentation

Walks all `.md` files under `--wiki-path`, splits them into sections by heading, builds a [MiniSearch](https://github.com/lucaong/minisearch) BM25 index, and saves it as `.askii-wiki-index.json` inside the wiki folder. Run this once after pointing `--wiki-path` at your docs, and again whenever the docs change.

**bash**

```bash
askii wiki-reload --wiki-path ./docs
askii wiki-reload --wiki-path /home/user/my-project/docs
```

**PowerShell**

```powershell
askii wiki-reload --wiki-path .\docs
askii wiki-reload --wiki-path C:\my-project\docs
```

After indexing, pass `--wiki-path` and `--use-wiki` to any `ask`, `edit`, or `do` command to inject the top matching documentation chunks as context:

**bash**

```bash
askii ask --wiki-path ./docs --use-wiki "how do I configure the database?"
cat src/db.ts | askii edit --wiki-path ./docs --use-wiki "add connection pooling"
askii do --wiki-path ./docs --use-wiki "implement the auth flow described in the docs"
```

**PowerShell**

```powershell
askii ask --wiki-path .\docs --use-wiki "how do I configure the database?"
Get-Content src\db.ts | askii edit --wiki-path .\docs --use-wiki "add connection pooling"
askii do --wiki-path .\docs --use-wiki "implement the auth flow described in the docs"
```

---

### `commit` — Generate a commit message

Reads the staged diff (or, if nothing is staged, the working-tree diff) plus the list of changed files, asks the LLM to write a well-formed Git commit message, and prints it to **stdout**. Pipe-friendly — use it with `git commit`:

**bash**

```bash
git commit -m "$(askii commit)"
askii commit --dir ./my-project
```

**PowerShell**

```powershell
git commit -m "$(askii commit)"
askii commit --dir ..\my-project
```

The diff is capped at 12,000 characters to keep context tight. The output is cleaned of markdown fences, quotes, and `Commit message:` labels, so it's ready to pass straight to `git commit -m`.

---

### `note` — Notes / tasks / reminders

Type free text and the AI auto-classifies it into a **note**, **task** (with `low` / `medium` / `high` priority), or **reminder** (with a due time). Entries are stored globally at `~/.askii/notes.json`, tagged by workspace, and full-text searchable everywhere.

**bash**

```bash
askii note add "the API rate limit is 100 req/min"
askii note add "task: fix the login bug, high priority"
askii note add "remind me to check the build in 30 minutes"
askii note add --shot "remember this screen state"   # attach a full-screen screenshot
askii note list                                       # list all entries (most-recent first)
askii note list "login"                               # filter by full-text query
askii note search "login"                             # full-text search
askii note done abc12345                              # toggle a task's done state
askii note delete abc12345                            # delete an entry
askii note due                                        # list reminders that are due now
```

**PowerShell**

```powershell
askii note add "the API rate limit is 100 req/min"
askii note add "task: fix the login bug, high priority"
askii note add "remind me to check the build in 30 minutes"
askii note add --shot "remember this screen state"
askii note list
askii note search "login"
askii note done abc12345
askii note delete abc12345
askii note due
```

Subcommands:

| Subcommand            | Description                                        |
| --------------------- | -------------------------------------------------- |
| `add "<text>"`        | Add a note / task / reminder (AI auto-classifies)  |
| `add --shot "<text>"` | Attach a full-screen screenshot to the entry       |
| `list [query]`        | List all entries, or filter by full-text query     |
| `search "<query>"`    | Full-text search across all entries                |
| `done <id>`           | Toggle a task's done state                         |
| `delete <id>`         | Delete an entry                                    |
| `due`                 | List reminders that are due now (marks them fired) |

> **Reminders**: the CLI has no background scheduler, so reminders don't fire automatically. Run `askii note due` to see what's overdue — it prints the due entries and marks them fired. In the interactive REPL, `/note add` will ask a clarifying question if the reminder time is ambiguous.

---

### `browse` — Browser agent

Launches a Puppeteer browser, takes a screenshot of the current page and its URL, sends both to the AI, and executes the returned action. Repeats until the AI returns `DONE` or `--max-rounds` is reached. Requires a **vision-capable model** (e.g. `llava`, `moondream2`).

By default the browser window is **visible**. Pass `--headless` to run in the background.

> **Requires Chrome or Chromium** to be installed. Use `--chrome-path` (or `ASKII_CHROME_PATH`) to specify the executable path if it is not detected automatically.

**bash**

```bash
askii browse --ollama-model llava "go to https://example.com and click Learn more"
askii browse --yes --ollama-model llava "search Google for Node.js and open the first result"
askii browse --headless --yes --ollama-model llava "check the title of https://github.com"
askii browse --max-rounds 10 --ollama-model llava "fill in the login form on example.com"
askii browse -p lmstudio --lmstudio-model llava-1.5 "go to news.ycombinator.com"
askii browse --chrome-path "/usr/bin/chromium" --ollama-model llava "go to example.com"
```

**PowerShell**

```powershell
askii browse --ollama-model llava "go to https://example.com and click Learn more"
askii browse --yes --ollama-model llava "search Google for Node.js and open the first result"
askii browse --headless --yes --ollama-model llava "check the title of https://github.com"
askii browse --max-rounds 10 --ollama-model llava "fill in the login form on example.com"
askii browse -p lmstudio --lmstudio-model llava-1.5 "go to news.ycombinator.com"
askii browse --chrome-path "C:\Program Files\Google\Chrome\Application\chrome.exe" --ollama-model llava "go to example.com"
```

Each round the AI can return one of:

- **goto** — navigate to a URL
- **click** — click an element by CSS selector
- **type** — type text into an element by CSS selector (clears existing value first)
- **wait_for** — wait until a CSS selector appears in the DOM
- **back** — navigate back in browser history
- **forward** — navigate forward in browser history
- **DONE** — task complete, stop the loop

Without `--yes`, each proposed action is shown with its reasoning and requires `y` confirmation before executing.

---

## Options

| Flag                 | Short | Description                                                                           | Default                         |
| -------------------- | ----- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `--platform`         | `-p`  | LLM platform: `ollama`, `lmstudio`, `openai`, `anthropic`, `opencodego`, `askiicloud` | `ollama`                        |
| `--ollama-url`       |       | Ollama server URL                                                                     | `http://localhost:11434`        |
| `--lmstudio-url`     |       | LM Studio server URL                                                                  | `ws://localhost:1234`           |
| `--ollama-model`     |       | Ollama model                                                                          | `gemma4:e4b`                    |
| `--lmstudio-model`   |       | LM Studio model                                                                       | `qwen/qwen3-coder-30b`          |
| `--openai-key`       |       | OpenAI API key (env: `ASKII_OPENAI_KEY`)                                              |                                 |
| `--openai-model`     |       | OpenAI model                                                                          | `gpt-5-mini`                    |
| `--openai-url`       |       | OpenAI-compatible base URL (env: `ASKII_OPENAI_URL`)                                  |                                 |
| `--anthropic-key`    |       | Anthropic API key (env: `ASKII_ANTHROPIC_KEY`)                                        |                                 |
| `--anthropic-model`  |       | Anthropic model (env: `ASKII_ANTHROPIC_MODEL`)                                        | `claude-sonnet-4-6`             |
| `--opencodego-key`   |       | opencode Go API key (env: `ASKII_OPENCODEGO_KEY`)                                     |                                 |
| `--opencodego-model` |       | opencode Go model (env: `ASKII_OPENCODEGO_MODEL`)                                     | `glm-5.2`                       |
| `--opencodego-url`   |       | opencode Go base URL (env: `ASKII_OPENCODEGO_URL`)                                    | `https://opencode.ai/zen/go/v1` |
| `--askiicloud-key`   |       | ASKII Cloud API key (env: `ASKII_CLOUD_KEY`)                                          |                                 |
| `--askiicloud-model` |       | ASKII Cloud model (env: `ASKII_CLOUD_MODEL`)                                          | `askii-default`                 |
| `--mode`             |       | Response style: `helpful`, `funny`                                                    | `funny`                         |
| `--max-rounds`       |       | Max agent rounds for `do` / `generate` / `control` / `browse`                         | `5`                             |
| `--dir`              |       | Working directory for `do` / `generate`                                               | cwd                             |
| `--code`             | `-c`  | Code input (alternative to stdin)                                                     |                                 |
| `--file`             |       | Filename of the code (e.g. src/utils.ts) — also context file for `generate`           |                                 |
| `--instruction`      | `-i`  | Extra instruction for `generate`                                                      |                                 |
| `--yes`              | `-y`  | Auto-confirm all actions                                                              |                                 |
| `--headless`         |       | Run Puppeteer headlessly for `browse`                                                 | `false` (visible)               |
| `--chrome-path`      |       | Path to Chrome/Chromium executable for `browse`                                       |                                 |
| `--wiki-path`        |       | Path to folder with `.md` docs for wiki RAG (env: `ASKII_WIKI_PATH`)                  |                                 |
| `--use-wiki`         |       | Inject wiki context into `ask` / `edit` / `do` (env: `ASKII_USE_WIKI=1`)              |                                 |

## Environment Variables

**bash**

```bash
export ASKII_PLATFORM=ollama

# Ollama
export ASKII_OLLAMA_URL=http://localhost:11434
export ASKII_OLLAMA_MODEL=gemma4:e4b

# LM Studio
export ASKII_LMSTUDIO_URL=ws://localhost:1234
export ASKII_LMSTUDIO_MODEL=qwen/qwen3-coder-30b

# OpenAI
export ASKII_OPENAI_KEY=sk-...
export ASKII_OPENAI_MODEL=gpt-5-mini
export ASKII_OPENAI_URL=   # leave empty for api.openai.com

# Anthropic
export ASKII_ANTHROPIC_KEY=sk-ant-...
export ASKII_ANTHROPIC_MODEL=claude-sonnet-4-6

# opencode Go
export ASKII_OPENCODEGO_KEY=...
export ASKII_OPENCODEGO_MODEL=glm-5.2
export ASKII_OPENCODEGO_URL=https://opencode.ai/zen/go/v1

# ASKII Cloud
export ASKII_CLOUD_KEY=...
export ASKII_CLOUD_MODEL=askii-default

# Shared
export ASKII_MODE=funny
export ASKII_MAX_ROUNDS=5
export ASKII_CHROME_PATH=/usr/bin/chromium

# Docs wiki RAG
export ASKII_WIKI_PATH=./docs
export ASKII_USE_WIKI=1
```

**PowerShell**

```powershell
$env:ASKII_PLATFORM = "ollama"

# Ollama
$env:ASKII_OLLAMA_URL = "http://localhost:11434"
$env:ASKII_OLLAMA_MODEL = "gemma4:e4b"

# LM Studio
$env:ASKII_LMSTUDIO_URL = "ws://localhost:1234"
$env:ASKII_LMSTUDIO_MODEL = "qwen/qwen3-coder-30b"

# OpenAI
$env:ASKII_OPENAI_KEY = "sk-..."
$env:ASKII_OPENAI_MODEL = "gpt-5-mini"
$env:ASKII_OPENAI_URL = ""   # leave empty for api.openai.com

# Anthropic
$env:ASKII_ANTHROPIC_KEY = "sk-ant-..."
$env:ASKII_ANTHROPIC_MODEL = "claude-sonnet-4-6"

# opencode Go
$env:ASKII_OPENCODEGO_KEY = "..."
$env:ASKII_OPENCODEGO_MODEL = "glm-5.2"
$env:ASKII_OPENCODEGO_URL = "https://opencode.ai/zen/go/v1"

# ASKII Cloud
$env:ASKII_CLOUD_KEY = "..."
$env:ASKII_CLOUD_MODEL = "askii-default"

# Shared
$env:ASKII_MODE = "funny"
$env:ASKII_MAX_ROUNDS = "5"
$env:ASKII_CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# Docs wiki RAG
$env:ASKII_WIKI_PATH = ".\docs"
$env:ASKII_USE_WIKI = "1"
```

## Platforms

### Ollama (default)

**bash**

```bash
ollama pull gemma4:e4b
askii ask "what is a closure?"
```

**PowerShell**

```powershell
ollama pull gemma4:e4b
askii ask "what is a closure?"
```

### LM Studio

**bash**

```bash
# Start LM Studio with local server enabled
askii -p lmstudio ask "explain this function"
askii -p lmstudio --lmstudio-model "my-model" ask "explain this function"
```

**PowerShell**

```powershell
# Start LM Studio with local server enabled
askii -p lmstudio ask "explain this function"
askii -p lmstudio --lmstudio-model "my-model" ask "explain this function"
```

### OpenAI

**bash**

```bash
askii -p openai --openai-key sk-... ask "what does this do?"
askii -p openai --openai-key sk-... --openai-model gpt-4-turbo do "add error handling"
# Azure OpenAI or any compatible API:
askii -p openai --openai-key sk-... --openai-url https://my-resource.openai.azure.com ask "explain"
```

**PowerShell**

```powershell
askii -p openai --openai-key sk-... ask "what does this do?"
askii -p openai --openai-key sk-... --openai-model gpt-4-turbo do "add error handling"
# Azure OpenAI or any compatible API:
askii -p openai --openai-key sk-... --openai-url https://my-resource.openai.azure.com ask "explain"
```

### Anthropic

**bash**

```bash
askii -p anthropic --anthropic-key sk-ant-... ask "what does this do?"
askii -p anthropic --anthropic-key sk-ant-... --anthropic-model claude-sonnet-4-6 do "add error handling"
askii -p anthropic --anthropic-key sk-ant-... --anthropic-model claude-haiku-4-5 explain "arr.reduce((a, b) => a + b, 0)"
```

**PowerShell**

```powershell
askii -p anthropic --anthropic-key sk-ant-... ask "what does this do?"
askii -p anthropic --anthropic-key sk-ant-... --anthropic-model claude-sonnet-4-6 do "add error handling"
askii -p anthropic --anthropic-key sk-ant-... --anthropic-model claude-haiku-4-5 explain "arr.reduce((a, b) => a + b, 0)"
```

### opencode Go

A hosted, multi-model coding subscription ([opencode.ai/go](https://opencode.ai/go)). Most models use an OpenAI-compatible endpoint; Qwen and MiniMax models use an Anthropic-compatible one — ASKII routes automatically based on the model id. See the full model list at [opencode.ai/zen/go/v1/models](https://opencode.ai/zen/go/v1/models).

**bash**

```bash
askii -p opencodego --opencodego-key ... ask "what does this do?"
askii -p opencodego --opencodego-key ... --opencodego-model kimi-k2.7-code do "add error handling"
askii -p opencodego --opencodego-key ... --opencodego-model qwen3.7-max explain "arr.reduce((a, b) => a + b, 0)"
```

**PowerShell**

```powershell
askii -p opencodego --opencodego-key ... ask "what does this do?"
askii -p opencodego --opencodego-key ... --opencodego-model kimi-k2.7-code do "add error handling"
askii -p opencodego --opencodego-key ... --opencodego-model qwen3.7-max explain "arr.reduce((a, b) => a + b, 0)"
```

### ASKII Cloud

An in-house, OpenAI-compatible inference service ([api.askii.dev](https://api.askii.dev)). All it needs is an API key — the base URL is fixed to `https://api.askii.dev/v1`.

**bash**

```bash
askii -p askiicloud --askiicloud-key ... ask "what does this do?"
askii -p askiicloud --askiicloud-key ... --askiicloud-model askii-default do "add error handling"
askii -p askiicloud --askiicloud-key ... explain "arr.reduce((a, b) => a + b, 0)"
```

**PowerShell**

```powershell
askii -p askiicloud --askiicloud-key ... ask "what does this do?"
askii -p askiicloud --askiicloud-key ... --askiicloud-model askii-default do "add error handling"
askii -p askiicloud --askiicloud-key ... explain "arr.reduce((a, b) => a + b, 0)"
```
