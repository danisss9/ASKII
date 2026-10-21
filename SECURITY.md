# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[private vulnerability reporting](https://github.com/danisss9/ASKII/security/advisories/new)
(Security → Advisories → Report a vulnerability) rather than in a public issue. Include the ASKII
version (extension or CLI), your OS, the LLM platform, and steps to reproduce. You should get a
first response within a week; fixes ship in a patch release with a CHANGELOG entry crediting the
reporter (unless you prefer otherwise).

Only the latest released version is supported with security fixes.

## Threat model

ASKII lets a language model act on your machine, so its main risk is **a model doing something you
did not intend** — because it misunderstood, or because content it read (a file, a web page, a
screenshot) contains instructions aimed at it (prompt injection). The safeguards below assume the
model's output is untrusted.

**ASKII Do (workspace agent)**

- Every path is resolved inside the workspace; `../`, absolute paths and symlinks pointing outside
  it are refused for reads and writes
- It never writes inside `.git/` (hooks run code on your next commit) or `.askii/` (its own backups)
- Writes to files that can make the editor or git run code — `.vscode/`, `.husky/`, `.githooks/`,
  `.devcontainer/` — are always confirmed, even with `askii.doAutoConfirm` / `--yes`
- Shell commands (`run`) are always confirmed; Stop or the 30 s timeout kills the whole process tree
- Every changed file is backed up, and the whole run can be undone
- Disabled in VS Code's Restricted Mode

**ASKII Control (screen / browser agent)**

- Screen and browser actions run without asking by default; set `askii.controlAutoConfirm` to `false` to require a confirmation for each action
- Actions are validated before execution; malformed sequences are rejected
- The browser only opens `http(s)` pages (no `file:`, `javascript:` or browser-internal URLs) and
  keeps Chromium's sandbox enabled (except as root on Linux, where Chromium requires disabling it)
- Treat Control like handing someone your mouse: don't run it unattended on a machine with sessions
  you could not afford to have clicked on

**Credentials and settings**

- API keys are stored in VS Code secret storage (the OS keychain), never in `settings.json`
- In Restricted Mode (untrusted workspaces) workspace values of sensitive settings are ignored
- Inline features never send files matching `askii.inlineExcludeGlobs` (secrets, keys, credentials)
- CLI: prefer `ASKII_*_KEY` environment variables over `--*-key` flags, which are visible in the
  process list and your shell history

See the README's **Privacy & data** section for what each feature sends to the LLM provider.
