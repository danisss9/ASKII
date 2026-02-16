# Change Log

All notable changes to the "askii" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.3] - 2026-02-16

### Added

- **Markdown-it Integration**: Ask ASKII now renders markdown responses as formatted HTML with proper syntax highlighting

### Changed

- **Configuration Split**: Renamed `askii.llmUrl` to `askii.ollamaUrl` for clarity, added dedicated `askii.lmStudioUrl`
- **Enhanced Webview Styling**: Improved code block styling, blockquotes, and link colors in Ask ASKII responses

## [0.1.2] - 2026-02-14

### Added

- **Enhanced ASKII Do Command**: Now supports multi-turn interactions with the LLM
- **File Viewing in ASKII Do**: LLM can now request to view files and analyze their contents before making modifications
- **JSON-based Action Format**: Replaced pipe-delimited text with structured JSON format (MCP-style) for more reliable command parsing
- **New `askii.doMaxRounds` Setting**: Customize the maximum interaction rounds (1-20) for ASKII Do command (default: 5)
- **Improved LM Studio Support**: Fixed configuration to properly use `baseUrl` and `llmUrl` settings

### Changed

- ASKII Do command now uses intelligent multi-turn workflow where LLM can view files and make context-aware decisions
- View actions no longer open files in editor but instead send content back to LLM for analysis
- Improved error handling for file operations in ASKII Do
- System prompt now clearly describes the MCP-style action format

### Fixed

- LM Studio client initialization now properly respects the `llmUrl` configuration setting
- JSON parsing in workspace actions now handles extra text from LLM responses gracefully

## [0.1.0] - 2026-02-10

### Added

- **LM Studio Support**: Integrated official `@lmstudio/sdk` for native LM Studio client
- **Confirmation Dialogs**: ASKII Do now shows confirmation for CREATE, MODIFY, DELETE actions
- **Unified LLM URL**: Single `llmUrl` setting works for both Ollama and LM Studio
- **Three New Commands**: Ask ASKII, ASKII Edit, ASKII Do with status bar button

## [0.0.5] - 2026-02-05

### Added

- Refactored settings for multi-platform LLM support
- Inline helper mode with three options: off, helpful, funny
- Status bar button with kaomoji for quick command access

## [0.0.4] - 2026-01-29

### Added

- GitLens-style hover tooltips showing full message on hover
- Inline text truncation (80 chars) with "..." for longer messages
- `askii.clearCache` command to manually clear the explanation cache
- Hover provider for rich markdown tooltips on any line with ASKII annotations
- Higher decoration priority to ensure ASKII appears before other extensions

### Changed

- Decorations now use `ClosedClosed` range behavior for better priority
- Improved documentation and code comments

### Fixed

- Long explanations no longer clutter the editor - they're shown in hover tooltips instead

## [0.0.3] - 2026-01-29

### Added

- GitHub Copilot integration as an alternative AI provider to Ollama
- New `askii.useCopilot` setting to switch between Ollama and GitHub Copilot
- New `askii.copilotModel` setting to choose which Copilot model to use
- Support for multiple Copilot models: gpt-4o (default), gpt-4, gpt-3.5-turbo, o1-preview, o1-mini
- VS Code Language Model API integration for seamless Copilot support

### Changed

- Extension now supports dual AI providers (local Ollama or cloud-based Copilot)
- Updated documentation to explain both AI provider options

## [0.0.2] - 2026-01-29

### Added

- New `askii.helpfulMode` setting for practical code advice instead of humorous comments
- Toggle between entertainment and educational explanations
- Improved AI prompts for both humorous and helpful modes

### Changed

- AI system prompts now adapt based on helpful mode setting
- Better user experience with mode-specific explanations

## [0.0.1] - 2026-01-29

### Added

- Initial release
- Random kaomoji insertion after code lines
- Ollama AI integration for code explanations
- Configurable Ollama URL and model settings
- Automatic inline comments as you navigate code
- Caching system to avoid redundant API calls
- Debounced requests for better performance
- Thinking indicators while waiting for AI responses
