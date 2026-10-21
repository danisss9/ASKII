# Choose your LLM

ASKII works with the provider you pick — per feature group, so you can mix them:

| Provider | Runs | Needs |
| --- | --- | --- |
| **ASKII Cloud** (default) | Cloud | API key |
| **Ollama** | Your machine | `ollama pull gemma4:e4b` |
| **LM Studio** | Your machine | Local server enabled, a model loaded |
| **OpenAI** / compatible | Cloud | API key (optional base URL for Azure etc.) |
| **Anthropic** | Cloud | API key |
| **opencode Go** | Cloud | API key |

The setup wizard checks the connection, lists the provider's models and stores API keys in
VS Code's secret storage — never in `settings.json`.

Want everything to stay on your machine? Pick **Ollama** or **LM Studio**.
