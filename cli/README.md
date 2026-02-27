# ASKII CLI ( •\_•)>⌐■-■ (⌐■_■)

AI code assistant for your terminal. Powered by Ollama or LM Studio.

## Install

```bash
npm install -g askii-cli
```

Or run without installing:

```bash
npx askii-cli <command>
```

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

| Action   | Description                                              | Requires confirmation |
| -------- | -------------------------------------------------------- | --------------------- |
| `list`   | List files in a folder (`[file]` / `[folder]` labels)   | No                    |
| `view`   | Read a file's contents                                   | No                    |
| `create` | Create a new file                                        | Yes                   |
| `modify` | Replace text in an existing file                         | Yes                   |
| `rename` | Rename or move a file                                    | Yes                   |
| `delete` | Delete a file                                            | Yes                   |

The loop continues after every round — not only after reads — until the AI returns `[]` or the round limit is hit.

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

## Options

| Flag                  | Short | Description                                     | Default                    |
| --------------------- | ----- | ----------------------------------------------- | -------------------------- |
| `--platform`          | `-p`  | LLM platform: `ollama`, `lmstudio`              | `ollama`                   |
| `--ollama-url`        |       | Ollama server URL                               | `http://localhost:11434`   |
| `--lmstudio-url`      |       | LM Studio server URL                            | `ws://localhost:1234`      |
| `--ollama-model`      |       | Ollama model                                    | `gemma3:270m`              |
| `--lmstudio-model`    |       | LM Studio model                                 | `qwen/qwen3-coder-30b`     |
| `--mode`              |       | Response style: `helpful`, `funny`              | `funny`                    |
| `--max-rounds`        |       | Max agent rounds for `do` / `control`           | `5`                        |
| `--dir`               |       | Working directory for `do`                      | cwd                        |
| `--code`              | `-c`  | Code input (alternative to stdin)               |                            |
| `--yes`               | `-y`  | Auto-confirm all actions                        |                            |

## Environment Variables

**bash**

```bash
export ASKII_PLATFORM=ollama

# Ollama
export ASKII_OLLAMA_URL=http://localhost:11434
export ASKII_OLLAMA_MODEL=gemma3:270m

# LM Studio
export ASKII_LMSTUDIO_URL=ws://localhost:1234
export ASKII_LMSTUDIO_MODEL=qwen/qwen3-coder-30b

# Shared
export ASKII_MODE=funny
export ASKII_MAX_ROUNDS=5
```

**PowerShell**

```powershell
$env:ASKII_PLATFORM = "ollama"

# Ollama
$env:ASKII_OLLAMA_URL = "http://localhost:11434"
$env:ASKII_OLLAMA_MODEL = "gemma3:270m"

# LM Studio
$env:ASKII_LMSTUDIO_URL = "ws://localhost:1234"
$env:ASKII_LMSTUDIO_MODEL = "qwen/qwen3-coder-30b"

# Shared
$env:ASKII_MODE = "funny"
$env:ASKII_MAX_ROUNDS = "5"
```

## Platforms

### Ollama (default)

**bash**

```bash
ollama pull gemma3:270m
askii ask "what is a closure?"
```

**PowerShell**

```powershell
ollama pull gemma3:270m
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
