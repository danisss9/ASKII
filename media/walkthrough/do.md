# Let ASKII do a task

**ASKII Do** (`Ctrl+Alt+K D`) explores your workspace and makes changes over several rounds — every
step shows up in the task panel.

- Reading files and searching runs freely; **every write asks first** (unless you turn on
  `askii.doAutoConfirm`)
- **Shell commands always ask**, and Stop kills them
- It never writes inside `.git/`, always asks before touching `.vscode/` or git hooks, and can't
  reach files outside the workspace — symlinks included
- Every changed file is backed up: when the run ends, **Keep** the changes or **Undo all**

ASKII Do is disabled in Restricted Mode (untrusted folders).
