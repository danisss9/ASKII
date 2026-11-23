import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AgentSettings,
  AppStateDto,
  ApprovalDecision,
  ChatMessage,
  ClipboardContextPayload,
  ClipboardHistoryItem,
  DiscoverModelsRequest,
  FileAttachmentResult,
  InstantResult,
  MemoryEntry,
  ModelDiscoveryResult,
  PreviousWindowInfo,
  PromptRecipe,
  ProviderDefinition,
  ProviderId,
  SaveSetupRequest,
  ScreenCaptureResult,
  SlipSummary,
  StoredSlip,
  StreamEvent,
  WindowShownPayload,
} from './models';

const MOCK_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'askiicloud',
    label: 'ASKII Cloud',
    description: 'ASKII-hosted models with sensible defaults out of the box.',
    connection: 'apiKey',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI models or any OpenAI-compatible endpoint via custom base URL.',
    connection: 'apiKey',
    supportsCustomBaseUrl: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models served directly through the Anthropic API.',
    connection: 'apiKey',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models served directly through the Google AI Studio API.',
    connection: 'apiKey',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Unified gateway to 200+ frontier and open models via OpenRouter.',
    connection: 'apiKey',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'opencodego',
    label: 'opencode Go',
    description: 'Hosted fast models from the opencode Go inference service.',
    connection: 'apiKey',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Run open models completely locally through your Ollama server.',
    connection: 'serverUrl',
    supportsCustomBaseUrl: false,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: 'Connect to models loaded in your local LM Studio server.',
    connection: 'serverUrl',
    supportsCustomBaseUrl: false,
  },
];

const MOCK_RECIPES: PromptRecipe[] = [
  {
    command: '/fix',
    label: '/fix',
    description: 'Fix grammar, clarity, and tone — returns clean ready-to-insert text',
    systemPrompt:
      'You are an expert editor. Fix grammar, spelling, and flow while preserving the original meaning. Return ONLY the improved text.',
    userPrefix: 'Rewrite and polish the following text:',
    autoAttachClipboard: true,
    modelOverride: null,
  },
  {
    command: '/translate',
    label: '/translate',
    description: 'Translate attached text or your prompt (e.g. /translate Spanish)',
    systemPrompt: 'Translate naturally into the target language (default English).',
    userPrefix: 'Translate:',
    autoAttachClipboard: true,
    modelOverride: null,
  },
  {
    command: '/summarize',
    label: '/summarize',
    description: 'Distill attached text, file, or screenshot into tight bullet points',
    systemPrompt: 'Summarize into concise high-signal bullet points.',
    userPrefix: 'Summarize the following:',
    autoAttachClipboard: true,
    modelOverride: null,
  },
  {
    command: '/explain',
    label: '/explain',
    description: 'Explain code, errors, or concepts clearly and concisely',
    systemPrompt: 'Explain clearly and concisely, highlighting root cause and fix first.',
    userPrefix: 'Explain the following:',
    autoAttachClipboard: true,
    modelOverride: null,
  },
  {
    command: '/shell',
    label: '/shell',
    description: 'Generate a clean Windows PowerShell one-liner with a brief note',
    systemPrompt:
      'Provide the exact Windows PowerShell command in a ```powershell block followed by a 1-sentence note.',
    userPrefix: 'Write a Windows PowerShell command to:',
    autoAttachClipboard: false,
    modelOverride: null,
  },
];

@Injectable({ providedIn: 'root' })
export class TauriBridgeService {
  readonly isTauri =
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);

  private mockState: AppStateDto = {
    config: {
      setupCompleted: false,
      provider: 'askiicloud',
      model: 'askii-smart',
      ollamaUrl: 'http://localhost:11434',
      lmstudioUrl: 'http://localhost:1234',
      openaiUrl: '',
      shortcut: 'Alt+Space',
      actionShortcut: 'Alt+Shift+Space',
      whisperUrl: '',
      startWithWindows: false,
      clipboardHistoryEnabled: true,
      recentModels: [],
      promptHistory: [
        'Explain how Windows virtual desktops work',
        'Write a PowerShell one-liner to find large files',
      ],
      recipes: MOCK_RECIPES,
      agent: {
        enabled: true,
        mode: 'confirm',
        autoApproveDesktopControls: true,
        guardDestructiveCommands: true,
        maxSteps: 10,
        mcpServers: [],
      },
    },
    providers: MOCK_PROVIDERS,
    savedCredentials: {
      askiicloud: false,
      openai: false,
      anthropic: false,
      gemini: false,
      openrouter: false,
      opencodego: false,
      ollama: false,
      lmstudio: false,
    },
    needsSetup: true,
  };

  async getAppState(): Promise<AppStateDto> {
    if (!this.isTauri) {
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('get_app_state');
  }

  async discoverProviderModels(req: DiscoverModelsRequest): Promise<ModelDiscoveryResult> {
    if (!this.isTauri) {
      await new Promise((r) => setTimeout(r, 450));
      return {
        mode: 'models',
        models:
          req.provider === 'askiicloud'
            ? ['askii-smart', 'askii-fast']
            : ['demo-model-1', 'demo-model-2'],
      };
    }
    return invoke<ModelDiscoveryResult>('discover_provider_models', { req });
  }

  async saveSetup(req: SaveSetupRequest): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState = {
        ...this.mockState,
        config: {
          ...this.mockState.config,
          setupCompleted: true,
          provider: req.provider,
          model: req.model,
          ollamaUrl: req.ollamaUrl ?? this.mockState.config.ollamaUrl,
          lmstudioUrl: req.lmstudioUrl ?? this.mockState.config.lmstudioUrl,
          openaiUrl: req.openaiUrl ?? this.mockState.config.openaiUrl,
          shortcut: req.shortcut ?? this.mockState.config.shortcut,
          actionShortcut: req.actionShortcut ?? this.mockState.config.actionShortcut,
        },
        needsSetup: false,
      };
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('save_setup', { req });
  }

  async updateShortcut(shortcut: string): Promise<string> {
    if (!this.isTauri) {
      this.mockState.config.shortcut = shortcut;
      return shortcut;
    }
    return invoke<string>('update_shortcut', { shortcut });
  }

  async updateActionShortcut(shortcut: string): Promise<string> {
    if (!this.isTauri) {
      this.mockState.config.actionShortcut = shortcut;
      return shortcut;
    }
    return invoke<string>('update_action_shortcut', { shortcut });
  }

  async saveRecipes(recipes: PromptRecipe[]): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.recipes = recipes;
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('save_recipes', { recipes });
  }

  async saveAgentSettings(agent: AgentSettings): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.agent = agent;
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('save_agent_settings', { agent });
  }

  async toggleAutoDo(): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.agent.mode =
        this.mockState.config.agent.mode === 'autoDo' ? 'confirm' : 'autoDo';
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('toggle_auto_do');
  }

  async resolveToolApproval(callId: string, decision: ApprovalDecision): Promise<boolean> {
    if (!this.isTauri) {
      return true;
    }
    return invoke<boolean>('resolve_tool_approval', { callId, decision });
  }

  async undoToolBackup(backupId: string): Promise<string> {
    if (!this.isTauri) {
      return 'Restored backup (preview)';
    }
    return invoke<string>('undo_tool_backup', { backupId });
  }

  async askStream(
    prompt: string,
    messages: ChatMessage[],
    onEvent: (event: StreamEvent) => void,
    options?: {
      systemPromptOverride?: string;
      modelOverride?: string;
    },
  ): Promise<void> {
    if (!this.isTauri) {
      const demo = `### ASKII Preview\n\nYou asked: **${prompt}**\n\n\`\`\`powershell\nGet-ChildItem -Recurse | Sort-Object Length -Descending | Select-Object -First 5\n\`\`\`\n\nRunning in browser preview mode — launch the Tauri Windows app to stream live replies.`;
      for (const word of demo.split(' ')) {
        await new Promise((r) => setTimeout(r, 20));
        onEvent({ event: 'chunk', data: { text: word + ' ' } });
      }
      onEvent({ event: 'done', data: { truncated: false } });
      return;
    }

    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    await invoke<void>('ask_stream', {
      req: {
        prompt,
        messages,
        systemPromptOverride: options?.systemPromptOverride ?? null,
        modelOverride: options?.modelOverride ?? null,
      },
      onEvent: channel,
    });
  }

  async cancelActiveStream(): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('cancel_active_stream');
  }

  async setPinned(pinned: boolean): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('set_pinned', { pinned });
  }

  async setInSetup(inSetup: boolean): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('set_in_setup', { inSetup });
  }

  async setWindowHeight(height: number): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('set_window_height', { height });
  }

  async getPreviousWindow(): Promise<PreviousWindowInfo | null> {
    if (!this.isTauri) {
      return null;
    }
    return invoke<PreviousWindowInfo | null>('get_previous_window');
  }

  async captureClipboard(): Promise<ClipboardContextPayload> {
    if (!this.isTauri) {
      try {
        const text = await navigator.clipboard.readText();
        return text ? { kind: 'text', text } : { kind: 'empty' };
      } catch {
        return { kind: 'empty' };
      }
    }
    return invoke<ClipboardContextPayload>('capture_clipboard');
  }

  async captureScreen(mode: 'full' | 'active_window' = 'full'): Promise<ScreenCaptureResult> {
    if (!this.isTauri) {
      throw new Error('Screen capture requires the Windows desktop app.');
    }
    return invoke<ScreenCaptureResult>('capture_screen', { mode });
  }

  async readFileAttachment(path: string): Promise<FileAttachmentResult> {
    if (!this.isTauri) {
      throw new Error('File attachment requires the Windows desktop app.');
    }
    return invoke<FileAttachmentResult>('read_file_attachment', { path });
  }

  async insertReply(text: string): Promise<void> {
    if (!this.isTauri) {
      await navigator.clipboard.writeText(text);
      return;
    }
    await invoke<void>('insert_reply', { text });
  }

  async hideWindow(): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('hide_window');
  }

  async closeCurrentWindow(): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await getCurrentWindow().close();
  }

  async queryInstant(query: string): Promise<InstantResult[]> {
    if (!this.isTauri) {
      return [];
    }
    return invoke<InstantResult[]>('query_instant', { query });
  }

  async executeInstant(item: InstantResult): Promise<string> {
    if (!this.isTauri) {
      if (item.copyValue) {
        await navigator.clipboard.writeText(item.copyValue);
        return `Copied "${item.copyValue}"`;
      }
      return `Executed ${item.label}`;
    }
    return invoke<string>('execute_instant', { item });
  }

  async refreshAppIndex(): Promise<number> {
    if (!this.isTauri) {
      return 0;
    }
    return invoke<number>('refresh_app_index');
  }

  async saveSlip(slip: StoredSlip): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('save_slip', { slip });
  }

  async listSlips(query?: string, limit = 40): Promise<SlipSummary[]> {
    if (!this.isTauri) {
      return [];
    }
    return invoke<SlipSummary[]>('list_slips', { query: query ?? null, limit });
  }

  async getSlip(id: string): Promise<StoredSlip | null> {
    if (!this.isTauri) {
      return null;
    }
    return invoke<StoredSlip | null>('get_slip', { id });
  }

  async deleteSlip(id: string): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('delete_slip', { id });
  }

  async detachSlip(slipId: string): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('detach_slip', { slipId });
  }

  async listMemories(): Promise<MemoryEntry[]> {
    if (!this.isTauri) {
      return [];
    }
    return invoke<MemoryEntry[]>('list_memories');
  }

  async addMemory(content: string): Promise<MemoryEntry> {
    if (!this.isTauri) {
      return { id: Date.now(), content, createdAt: Math.floor(Date.now() / 1000) };
    }
    return invoke<MemoryEntry>('add_memory', { content });
  }

  async deleteMemory(id: number): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('delete_memory', { id });
  }

  async transcribeVoice(audioBytes: Uint8Array, mimeType: string): Promise<string> {
    if (!this.isTauri) {
      throw new Error('Voice transcription requires the Windows desktop app.');
    }
    return invoke<string>('transcribe_voice', {
      audioBytes: Array.from(audioBytes),
      mimeType,
    });
  }

  async switchModelProfile(provider: ProviderId, model: string): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.provider = provider;
      this.mockState.config.model = model;
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('switch_model_profile', { provider, model });
  }

  async setAutostart(enabled: boolean): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.startWithWindows = enabled;
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('set_autostart', { enabled });
  }

  async setClipboardHistoryEnabled(enabled: boolean): Promise<AppStateDto> {
    if (!this.isTauri) {
      this.mockState.config.clipboardHistoryEnabled = enabled;
      return structuredClone(this.mockState);
    }
    return invoke<AppStateDto>('set_clipboard_history_enabled', { enabled });
  }

  async getClipboardHistory(): Promise<ClipboardHistoryItem[]> {
    if (!this.isTauri) {
      return [];
    }
    return invoke<ClipboardHistoryItem[]>('get_clipboard_history');
  }

  async quitApp(): Promise<void> {
    if (!this.isTauri) {
      return;
    }
    await invoke<void>('quit_app');
  }

  async onWindowShown(handler: (payload: WindowShownPayload) => void): Promise<UnlistenFn> {
    if (!this.isTauri) {
      return () => undefined;
    }
    return listen<WindowShownPayload>('askii://shown', (ev) => handler(ev.payload));
  }

  async onFileDrop(
    onDrop: (paths: string[]) => void,
    onHover?: (hovering: boolean) => void,
  ): Promise<UnlistenFn> {
    if (!this.isTauri) {
      return () => undefined;
    }
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'over' || event.payload.type === 'enter') {
        onHover?.(true);
      } else if (event.payload.type === 'leave') {
        onHover?.(false);
      } else if (event.payload.type === 'drop') {
        onHover?.(false);
        if (event.payload.paths.length > 0) {
          onDrop(event.payload.paths);
        }
      }
    });
  }
}
