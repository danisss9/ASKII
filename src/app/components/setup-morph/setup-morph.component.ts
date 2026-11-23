import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AskiiStateService } from '../../core/askii-state.service';
import { AgentMode, McpServerConfig, ProviderId } from '../../core/models';
import { TauriBridgeService } from '../../core/tauri-bridge.service';

@Component({
  selector: 'app-setup-morph',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './setup-morph.component.html',
  styleUrl: './setup-morph.component.scss',
})
export class SetupMorphComponent implements OnInit {
  readonly state = inject(AskiiStateService);
  private readonly bridge = inject(TauriBridgeService);

  readonly step = signal<'provider' | 'model' | 'agent'>('provider');
  readonly selectedProvider = signal<ProviderId>('askiicloud');

  readonly apiKey = signal('');
  readonly ollamaUrl = signal('http://localhost:11434');
  readonly lmstudioUrl = signal('http://localhost:1234');
  readonly openaiUrl = signal('');

  readonly discoveredModels = signal<string[]>([]);
  readonly manualModelMode = signal(false);
  readonly modelWarning = signal<string | null>(null);
  readonly selectedModel = signal('askii-smart');

  readonly shortcut = signal('Alt+Space');
  readonly actionShortcut = signal('Alt+Shift+Space');
  readonly whisperUrl = signal('');
  readonly recordingTarget = signal<'toggle' | 'action' | null>(null);

  // Phase 2: ASKII Do & Auto Do Settings + MCP
  readonly agentEnabled = signal(true);
  readonly agentMode = signal<AgentMode>('confirm');
  readonly autoApproveDesktop = signal(true);
  readonly guardDestructive = signal(true);
  readonly mcpServers = signal<McpServerConfig[]>([]);
  readonly newMcpName = signal('');
  readonly newMcpTransport = signal<'stdio' | 'http'>('stdio');
  readonly newMcpEndpoint = signal('');

  readonly isLoading = signal(false);
  readonly isSaving = signal(false);
  readonly error = signal<string | null>(null);

  readonly providerDef = computed(() =>
    this.state.providers().find((p) => p.id === this.selectedProvider()),
  );

  readonly hasSavedKey = computed(
    () => Boolean(this.state.savedCredentials()[this.selectedProvider()]),
  );

  ngOnInit(): void {
    const cfg = this.state.config();
    this.selectedProvider.set(cfg.provider);
    this.ollamaUrl.set(cfg.ollamaUrl || 'http://localhost:11434');
    this.lmstudioUrl.set(cfg.lmstudioUrl || 'http://localhost:1234');
    this.openaiUrl.set(cfg.openaiUrl || '');
    this.selectedModel.set(cfg.model || 'askii-smart');
    this.shortcut.set(cfg.shortcut || 'Alt+Space');
    this.actionShortcut.set(cfg.actionShortcut || 'Alt+Shift+Space');
    this.whisperUrl.set(cfg.whisperUrl || '');

    const ag = cfg.agent;
    if (ag) {
      this.agentEnabled.set(ag.enabled);
      this.agentMode.set(ag.mode);
      this.autoApproveDesktop.set(ag.autoApproveDesktopControls);
      this.guardDestructive.set(ag.guardDestructiveCommands);
      this.mcpServers.set(structuredClone(ag.mcpServers ?? []));
    }

    if (this.state.setupInitialStep() === 'shortcut' && !this.state.needsSetup()) {
      this.step.set('model');
      this.manualModelMode.set(true);
    } else if (this.state.setupInitialStep() === 'agent' && !this.state.needsSetup()) {
      this.step.set('agent');
    }
  }

  addMcpServer(): void {
    const name = this.newMcpName().trim();
    const endpoint = this.newMcpEndpoint().trim();
    if (!name || !endpoint) {
      this.error.set('Enter both an MCP server name and command/URL.');
      return;
    }
    this.error.set(null);
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || `mcp_${Date.now()}`;
    const transport = this.newMcpTransport();
    let command: string | null = null;
    let args: string[] = [];
    let url: string | null = null;
    if (transport === 'http') {
      url = endpoint;
    } else {
      const tokens = endpoint.split(/\s+/).filter(Boolean);
      command = tokens[0] ?? endpoint;
      args = tokens.slice(1);
    }
    this.mcpServers.update((list) => [
      ...list,
      { id, name, transport, command, args, url, enabled: true },
    ]);
    this.newMcpName.set('');
    this.newMcpEndpoint.set('');
  }

  removeMcpServer(id: string): void {
    this.mcpServers.update((list) => list.filter((s) => s.id !== id));
  }

  async saveAgentTab(): Promise<void> {
    this.error.set(null);
    this.isSaving.set(true);
    try {
      await this.state.saveAgentSettings({
        enabled: this.agentEnabled(),
        mode: this.agentMode(),
        autoApproveDesktopControls: this.autoApproveDesktop(),
        guardDestructiveCommands: this.guardDestructive(),
        maxSteps: this.state.config().agent.maxSteps || 10,
        mcpServers: this.mcpServers(),
      });
      this.state.closeSetup();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
    }
  }

  chooseProvider(id: ProviderId): void {
    this.selectedProvider.set(id);
    this.apiKey.set('');
    this.error.set(null);
  }

  async validateAndDiscover(): Promise<void> {
    this.error.set(null);
    this.modelWarning.set(null);
    this.isLoading.set(true);

    const provider = this.selectedProvider();
    const def = this.providerDef();
    const serverUrl =
      provider === 'ollama'
        ? this.ollamaUrl().trim()
        : provider === 'lmstudio'
          ? this.lmstudioUrl().trim()
          : undefined;

    try {
      const res = await this.bridge.discoverProviderModels({
        provider,
        apiKey: def?.connection === 'apiKey' ? this.apiKey().trim() || undefined : undefined,
        serverUrl,
        openaiBaseUrl: provider === 'openai' ? this.openaiUrl().trim() || undefined : undefined,
      });

      this.discoveredModels.set(res.models);
      this.manualModelMode.set(res.mode === 'manual' || res.models.length === 0);
      this.modelWarning.set(res.warning ?? null);

      const currentModel = this.state.config().model;
      if (res.models.length > 0) {
        if (this.state.config().provider === provider && res.models.includes(currentModel)) {
          this.selectedModel.set(currentModel);
        } else if (provider === 'askiicloud' && res.models.includes('askii-smart')) {
          this.selectedModel.set('askii-smart');
        } else {
          this.selectedModel.set(res.models[0]);
        }
      } else if (provider === 'askiicloud') {
        this.selectedModel.set('askii-smart');
      } else if (this.state.config().provider !== provider) {
        this.selectedModel.set('');
      }

      this.step.set('model');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isLoading.set(false);
    }
  }

  startRecordingShortcut(target: 'toggle' | 'action' = 'toggle'): void {
    this.recordingTarget.set(target);
    this.error.set(null);
  }

  onShortcutKeyDown(event: KeyboardEvent): void {
    const target = this.recordingTarget();
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      this.recordingTarget.set(null);
      return;
    }

    const ignored = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (ignored.has(event.key)) {
      return;
    }

    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');

    if (parts.length === 0) {
      this.error.set('Include at least one modifier key (Alt, Ctrl, or Shift).');
      return;
    }

    const keyName = this.normalizeKeyToken(event.key, event.code);
    if (!keyName) {
      this.error.set('Unsupported key — try Space, a letter, or a function key.');
      return;
    }

    parts.push(keyName);
    if (target === 'action') {
      this.actionShortcut.set(parts.join('+'));
    } else {
      this.shortcut.set(parts.join('+'));
    }
    this.recordingTarget.set(null);
    this.error.set(null);
  }

  resetShortcut(): void {
    this.shortcut.set('Alt+Space');
    this.recordingTarget.set(null);
  }

  resetActionShortcut(): void {
    this.actionShortcut.set('Alt+Shift+Space');
    this.recordingTarget.set(null);
  }

  async finishSetup(): Promise<void> {
    const model = this.selectedModel().trim();
    if (!model) {
      this.error.set('Choose or enter a model ID to continue.');
      return;
    }

    this.error.set(null);
    this.isSaving.set(true);
    const provider = this.selectedProvider();

    try {
      await this.state.saveSetup({
        provider,
        model,
        apiKey: this.apiKey().trim() || undefined,
        ollamaUrl: this.ollamaUrl().trim(),
        lmstudioUrl: this.lmstudioUrl().trim(),
        openaiUrl: this.openaiUrl().trim(),
        shortcut: this.shortcut().trim() || 'Alt+Space',
        actionShortcut: this.actionShortcut().trim() || 'Alt+Shift+Space',
        whisperUrl: this.whisperUrl().trim(),
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.isSaving.set(false);
    }
  }

  private normalizeKeyToken(key: string, code: string): string | null {
    if (key === ' ' || code === 'Space') return 'Space';
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    if (/^F([1-9]|1[0-2])$/.test(key)) return key;
    if (key === 'Tab' || key === 'Enter' || key === 'Backspace') return key;
    return null;
  }
}
