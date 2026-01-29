# ASKII

A fun VS Code extension that adds random kaomoji (Japanese emoticons) and AI-powered explanations to your code lines. Choose between Ollama or GitHub Copilot as your AI provider, and toggle between humorous comments for entertainment or helpful code advice for learning!

## Features

- **Random Kaomoji**: Adds a random kaomoji emoticon after the current line
- **AI Explanations**: Uses Ollama or GitHub Copilot to generate concise explanations of your code
- **Helpful Mode**: Toggle between fun humorous comments and practical coding advice
- **Dual AI Provider**: Choose between Ollama (local) or GitHub Copilot (cloud)

## Requirements

### Option 1: Ollama (Default)

- **Ollama**: Download and install from [https://ollama.ai](https://ollama.ai)
- Pull a model, e.g., `ollama pull gemma3:270m`
- Make sure Ollama is running (default: `http://localhost:11434`)

### Option 2: GitHub Copilot

- **GitHub Copilot Extension**: Install the GitHub Copilot extension from the VS Code marketplace
- Active GitHub Copilot subscription
- Enable `askii.useCopilot` in settings

## Usage

The extension automatically shows inline comments as you move your cursor through your code.

### Choose Your AI Provider

**Ollama (Default):**
Uses local AI models - no internet required, fully private.

**GitHub Copilot:**
Uses cloud-based Copilot models - requires subscription but offers powerful AI capabilities.

**To use GitHub Copilot:**

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "ASKII Use Copilot"
3. Check the box to enable Copilot mode

### Default Mode (Humorous)

By default, ASKII provides witty, fun comments about your code:

```javascript
const sum = a + b; (◕‿◕) Ah yes, the ancient art of addition - bringing numbers together since forever!
```

### Helpful Mode

Enable `askii.helpfulMode` in settings to get practical coding advice:

```javascript
const sum = a + b; (◕‿◕) Adds two variables and stores the result; consider using const for immutable values.
```

**To enable Helpful Mode:**

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "ASKII Helpful Mode"
3. Check the box to enable helpful advice mode

## Extension Settings

This extension contributes the following settings:

- `askii.ollamaUrl`: URL of the Ollama API server (default: `http://localhost:11434`)
- `askii.ollamaModel`: Ollama model to use for explanations (default: `gemma3:270m`)
- `askii.helpfulMode`: When enabled, provides helpful code advice instead of humorous comments (default: `false`)
- `askii.useCopilot`: Use GitHub Copilot's Chat & Language Model APIs instead of Ollama (default: `false`)
- `askii.copilotModel`: GitHub Copilot model to use (default: `gpt-4o`).

## Configuration

To customize the extension settings:

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "ASKII"
3. Adjust the Ollama URL and model as needed

## Release Notes

### 0.0.3

New features:

- Added GitHub Copilot integration as an alternative to Ollama
- New `useCopilot` setting to switch between Ollama and GitHub Copilot
- Supports VS Code's Language Model API for seamless Copilot integration

### 0.0.2

New features:

- Added Helpful Mode setting for practical code advice instead of humorous comments
- Toggle between entertainment and educational explanations
- Improved AI prompts for both modes

### 0.0.1

Initial release:

- Random kaomoji insertion
- Ollama AI integration for code explanations
- Configurable Ollama URL and model

## Following Extension Development

This extension was created as a fun way to add personality to code comments while learning about what each line does!

**Enjoy! (づ｡◕‿‿◕｡)づ**
