# ASKII

A fun VS Code extension that adds random kaomoji (Japanese emoticons) and AI-powered explanations to your code lines. Choose between Ollama, GitHub Copilot, or LM Studio as your AI provider, and toggle between humorous comments and helpful code advice!

## Features

- **Random Kaomoji**: Adds a random kaomoji emoticon after the current line
- **AI Explanations**: Uses Ollama, GitHub Copilot, or LM Studio to generate concise explanations of your code
- **Inline Helper Modes**: Choose between off, helpful, or funny modes
- **Multi-Platform AI**: Support for Ollama (local), GitHub Copilot (cloud), and LM Studio (local with official SDK)
- **Three Command Modes**:
  - **Ask ASKII**: Ask questions about your selected code
  - **ASKII Edit**: Have ASKII modify your selected code based on your request
  - **ASKII Do**: Let ASKII perform workspace actions (create, modify, delete, view files) with confirmation prompts

## Requirements

### Option 1: Ollama (Default)

- **Ollama**: Download and install from [https://ollama.ai](https://ollama.ai)
- Pull a model, e.g., `ollama pull gemma3:270m`
- Make sure Ollama is running (default: `http://localhost:11434`)

### Option 2: GitHub Copilot

- **GitHub Copilot Extension**: Install from the VS Code marketplace
- Active GitHub Copilot subscription
- Select `copilot` in the `askii.llmPlatform` setting

### Option 3: LM Studio (New!)

- **LM Studio**: Download from [https://lmstudio.ai](https://lmstudio.ai)
- Start LM Studio and load your preferred model
- Select `lmstudio` in the `askii.llmPlatform` setting

## Usage

The extension automatically shows inline comments as you move your cursor through your code.

### Choose Your LLM Platform

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "ASKII LLM Platform" to choose:

- `ollama` (default)
- `copilot`
- `lmstudio`

### Choose Your Inline Helper Mode

Search for "ASKII Inline Helper Mode" and select:

- `off` - No inline decorations
- `helpful` - Practical coding advice
- `funny` - Humorous comments (default)

### Commands

#### Ask ASKII

1. Select code in your editor
2. Open command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
3. Search for "Ask ASKII"
4. Type your question
5. View the formatted markdown response in a side panel with VS Code theme-aware styling

#### ASKII Edit

1. Select code in your editor
2. Open command palette
3. Search for "ASKII Edit"
4. Describe the changes you want
5. The selected code will be replaced with the updated version

#### ASKII Do (AI Workspace Agent)

1. Open command palette
2. Search for "ASKII Do"
3. Describe what you want ASKII to do (e.g., "Create a unit test file for src/utils.ts")
4. ASKII will analyze your workspace and interact with you:
   - **View Files**: ASKII can request to view file contents to understand your codebase
   - **Analyze & Suggest**: Based on file contents, ASKII suggests create, modify, or delete actions
   - **Multi-turn Interaction**: ASKII can request additional file views and make context-aware decisions
5. **Confirm each action** before it's applied:
   - **CREATE**: Shows confirmation to create new files
   - **MODIFY**: Shows confirmation to modify existing files
   - **DELETE**: Shows error-level warning for deletions
   - **VIEW**: No confirmation needed (read-only operation)

### Quick Access with Status Bar Button

Click the ASKII **(⌐■_■)** button in the bottom right status bar to quickly access:

- Ask ASKII
- ASKII Edit
- ASKII Do
- Clear Cache

## Configuration

All settings can be customized in VS Code Settings (`Ctrl+,` or `Cmd+,`):

- `askii.llmPlatform`: Choose LLM provider (`ollama` | `copilot` | `lmstudio`)
- `askii.ollamaUrl`: URL for Ollama API server (default: `http://localhost:11434`)
- `askii.lmStudioUrl`: URL for LM Studio API server (default: `ws://localhost:1234`)
- `askii.ollamaModel`: Ollama model name (default: `gemma3:270m`)
- `askii.copilotModel`: GitHub Copilot model (default: `gpt-4o`)
- `askii.lmStudioModel`: LM Studio model (default: `qwen/qwen3-coder-30b`)
- `askii.inlineHelperMode`: Inline helper mode (`off` | `helpful` | `funny`, default: `funny`)
- `askii.doMaxRounds`: Maximum interaction rounds for ASKII Do command (default: 5)

## Default Mode Examples

### Funny Mode (Default)

```javascript
const sum = a + b; (◕‿◕) The age-old tradition of making numbers hang out together!
```

### Helpful Mode

```javascript
const sum = a + b; (◕‿◕) Adds two variables; prefer const for variables that won't be reassigned.
```

## Technical Details

- **Markdown Rendering**: Ask ASKII responses are rendered using markdown-it with syntax highlighting and VS Code theme integration
- **Confirmation Dialogs**: ASKII Do command requires confirmation for all write operations (CREATE, MODIFY, DELETE) to prevent accidental changes
- **Smart Caching**: Inline explanations are cached to minimize API calls
- **Debouncing**: Requests are debounced for optimal performance

## Contributing

Love ASKII? Feel free to contribute to the project on GitHub!

**Enjoy! (づ｡◕‿‿◕｡)づ**
