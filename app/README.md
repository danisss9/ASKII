# ASKII Android App

The ASKII Android app built with Ionic 8 + Capacitor 7 + Angular 22.

## Features

- **Chat with LLMs** — streaming chat with history (persisted on-device)
- **6 providers** — ASKII Cloud, Ollama, LM Studio, OpenAI, Anthropic, opencode Go
- **6 modes**:
  - **Ask** — streaming chat about code
  - **Edit** — paste code, get it rewritten
  - **Do** — agentic filesystem sandbox (coming soon)
  - **Note** — AI-classified notes / tasks / reminders
  - **Browse** — in-app WebView agent with screenshots
  - **Control** — screen-control agent via AccessibilityService
- **Remote sessions** — the VS Code extension and CLI can drive this app via the ASKII Cloud broker (or a local relay)

## Prerequisites

- Node.js 24+
- Java 21+ (for Android builds)
- Android SDK (API 36) — only needed for APK builds

## Development

```bash
# Install dependencies
cd app
npm install

# Run in browser (ionic serve)
npm run serve

# Build web assets
npm run build

# Add Android platform (first time only — already added)
npx cap add android

# Sync web build to Android project
npx cap sync android

# Open in Android Studio
npx cap open android
```

## Building an APK

```bash
# Debug APK
cd app/android
./gradlew assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk

# Release APK (requires keystore setup)
./gradlew assembleRelease
```

## Pairing with the VS Code Extension / CLI

1. Open the app → Settings
2. Enter your ASKII Cloud API key
3. Tap **Pair** — the app registers with the broker and displays a QR code
4. In VS Code: run **ASKII: Connect to Android App** and paste the pairing payload
5. In the CLI: `askii connect --qr '{"deviceId":"dev-1","pairingToken":"tok-..."}'`
6. Start a remote session:
   - VS Code: run **ASKII: Remote Session**
   - CLI: `askii session "hello from terminal" --device dev-1`

## Local Relay (Development)

For development without the ASKII Cloud broker, use the local relay mock:

```bash
# Start the relay
cd relay
npm install && npm run build
npm start  # listens on http://127.0.0.1:4242

# Point the app and the controller to the relay:
# App: Settings → Broker URL → http://127.0.0.1:4242/v1
# CLI: askii connect --broker-url http://127.0.0.1:4242/v1 ...
```

## Native Plugins

| Plugin | Description |
|--------|-------------|
| `AskiiHttpPlugin` | OkHttp streaming chat (bypasses WebView CORS) |
| `AskiiBrowserPlugin` | In-app WebView agent (navigation, JS injection, screenshots) |
| `AskiiScreenPlugin` | Screen control (MediaProjection + AccessibilityService) |

## Architecture

```
app/
  src/
    app/
      pages/        Chat, History, Settings
      services/     Config, Llm, History, RemoteSession, BrowserMode, ControlMode
      plugins/      Capacitor plugin TS interfaces + web fallbacks
      models/       Chat view models
  android/          Native Android project (Capacitor)
  capacitor.config.ts
```

The app imports pure logic from `../shared/` (prompts, parsers, protocol, session-client) and reuses the same LLM contracts as the extension and CLI.
