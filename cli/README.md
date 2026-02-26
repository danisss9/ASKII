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

Reads the workspace structure, then creates/modifies/deletes files with your confirmation:

**bash**

```bash
askii do "create a Jest test file for src/utils.ts"
askii do "add a .gitignore for a Node.js project"
askii do --yes "scaffold a README for this project"   # auto-confirm all
askii do --dir ./my-project "refactor index.ts"
```

**PowerShell**

```powershell
askii do "create a Jest test file for src/utils.ts"
askii do "add a .gitignore for a Node.js project"
askii do --yes "scaffold a README for this project"   # auto-confirm all
askii do --dir .\my-project "refactor index.ts"
```

---

## Options

| Flag           | Short | Description                          | Default                  |
| -------------- | ----- | ------------------------------------ | ------------------------ |
| `--platform`   | `-p`  | LLM platform: `ollama`, `lmstudio`   | `ollama`                 |
| `--url`        |       | Server URL                           | `http://localhost:11434` |
| `--model`      | `-m`  | Model name                           | `gemma3:270m`            |
| `--mode`       |       | Response style: `helpful`, `funny`   | `funny`                  |
| `--max-rounds` |       | Max agent rounds for `do`            | `5`                      |
| `--dir`        |       | Working directory for `do`           | cwd                      |
| `--code`       | `-c`  | Code input (alternative to stdin)    |                          |
| `--yes`        | `-y`  | Auto-confirm file operations in `do` |                          |

## Environment Variables

**bash**

```bash
export ASKII_PLATFORM=ollama
export ASKII_URL=http://localhost:11434
export ASKII_MODEL=gemma3:270m
export ASKII_MODE=funny
export ASKII_MAX_ROUNDS=5
```

**PowerShell**

```powershell
$env:ASKII_PLATFORM = "ollama"
$env:ASKII_URL = "http://localhost:11434"
$env:ASKII_MODEL = "gemma3:270m"
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
askii -p lmstudio -m "qwen/qwen3-coder-30b" ask "explain this function"
```

**PowerShell**

```powershell
# Start LM Studio with local server enabled
askii -p lmstudio -m "qwen/qwen3-coder-30b" ask "explain this function"
```
