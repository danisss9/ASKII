# Know what is sent where

ASKII only talks to the providers you configure — **ASKII Cloud by default**.

| Feature | Sends |
| --- | --- |
| Ask / Edit | Your question, the selection or file, matching wiki chunks |
| Do | The task, the workspace listing, files the agent reads |
| Inline completion / helper | Code around the cursor — never files matching `askii.inlineExcludeGlobs` (`.env`, keys…) |
| Commit message / review | Your diff and recent commit messages |
| Control | Screenshots of the screen or browser |

Wiki and code-wiki **embeddings run locally**. ASKII collects **no telemetry**.
Diagnostics go to **Output → ASKII**.
