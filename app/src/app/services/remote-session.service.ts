import { Injectable } from '@angular/core';
import { SessionClient } from '@shared/session-client';
import type {
  DeviceCommand,
  SessionEvent,
  SessionMode,
  SessionOptions,
} from '@shared/protocol';
import { ConfigService, type AppConfig } from './config.service';
import { LlmService } from './llm.service';
import { BrowserModeService, type BrowserEvent } from './browser-mode.service';
import { ControlModeService, type ControlEvent } from './control-mode.service';

/**
 * RemoteSessionService — the app side of the remote-session contract.
 *
 * The Android app connects outbound to the broker (ASKII Cloud by default, or
 * a `relay/` mock in development), opens a long-lived command stream, and acts
 * as the *executor*: when a controller (the VS Code extension or CLI) starts a
 * session, the app runs it locally — talking to the chosen LLM, applying Do /
 * Browser / Control actions on-device — and streams `SessionEvent`s back to the
 * controller through the broker.
 *
 * This scaffold implements the `ask` end-to-end (streaming chat relayed to the
 * controller); `edit` / `note` share the chat plumbing; `do` / `browser` /
 * `control` are wired through their services and native plugins in later
 * phases.
 */
@Injectable({ providedIn: 'root' })
export class RemoteSessionService {
  private client: SessionClient | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly browserMode: BrowserModeService,
    private readonly controlMode: ControlModeService,
  ) {}

  /** Whether the app has a pairing token registered for remote control. */
  get isPaired(): boolean {
    const c = this.config.current;
    return !!c.pairingDeviceId && !!c.pairingToken;
  }

  /** Pair the app with the broker; persists deviceId + pairingToken. */
  async pair(deviceName: string): Promise<{ deviceId: string; pairingToken: string }> {
    const client = this.ensureClient();
    const cfg = this.config.current;
    const res = await client.pair({ deviceName, apiKey: cfg.apiKey });
    await this.config.save({ pairingDeviceId: res.deviceId, pairingToken: res.pairingToken });
    return { deviceId: res.deviceId, pairingToken: res.pairingToken };
  }

  /** Forget the current pairing. */
  async unpair(): Promise<void> {
    await this.config.save({ pairingDeviceId: undefined, pairingToken: undefined });
    this.stop();
  }

  /**
   * Start listening for controller commands on the device command stream. Runs
   * until `stop()` is called (or the app is suspended by the OS).
   */
  async start(): Promise<void> {
    const cfg = this.config.current;
    if (!cfg.pairingDeviceId || !cfg.pairingToken) {
      throw new Error('Not paired — call RemoteSessionService.pair() first.');
    }
    this.stop();
    this.abort = new AbortController();
    const client = this.ensureClient();

    // Note: SSE is long-lived; this loop runs in the background. In production
    // this is kept alive by a Capacitor foreground service; the scaffold keeps
    // the connection while the app process is alive.
    void this.drainCommands(client, cfg.pairingDeviceId, cfg.pairingToken, this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async drainCommands(
    client: SessionClient,
    deviceId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const cmd of client.commands(deviceId, token, signal)) {
        await this.handle(deviceId, token, cmd).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          void this.publish(deviceId, cmd.sessionId ?? '', token, { type: 'error', message });
        });
      }
    } catch {
      // Aborts / transient disconnects are non-fatal; callers may restart.
    }
  }

  private async handle(
    deviceId: string,
    token: string,
    cmd: DeviceCommand,
  ): Promise<void> {
    const sessionId = cmd.sessionId ?? '';
    if (!sessionId) return;
    if (cmd.type === 'cancel') {
      await this.publish(deviceId, sessionId, token, { type: 'status', status: 'done', detail: 'cancelled' });
      await this.publish(deviceId, sessionId, token, { type: 'done' });
      return;
    }
    if (cmd.type === 'confirm') {
      // For scaffold: forward the confirm decision to the (future) Do/browser/
      // control loops. There's no queue to gate here yet; acknowledged.
      await this.publish(deviceId, sessionId, token, { type: 'status', status: 'running' });
      return;
    }

    // cmd.type === 'start' | 'reply'
    const prompt = cmd.type === 'reply' ? cmd.content ?? '' : cmd.prompt ?? '';
    const mode: SessionMode = cmd.type === 'start' ? cmd.mode ?? 'ask' : 'ask';
    const options: SessionOptions | undefined = cmd.type === 'start' ? cmd.options : undefined;

    const cfg = this.mergedConfig(options);

    // Route browser/control modes to their dedicated agent services
    if (cmd.type === 'start' && (mode === 'browser' || mode === 'control')) {
      await this.runAgentMode(deviceId, sessionId, token, mode, prompt, cfg);
      return;
    }

    // ask / edit / note — chat-style streaming
    const labels: Record<SessionMode, { role: 'system'; content: string }> = {
      ask: { role: 'system', content: 'You are ASKII, a helpful coding assistant. Provide clear, concise answers.' },
      edit: { role: 'system', content: 'You are ASKII Edit. Return only the updated code, no explanation.' },
      do: { role: 'system', content: 'You are ASKII Do. (filesystem sandbox applies — phase wiring).' },
      note: { role: 'system', content: 'You are ASKII Note. Classify the text as note/task/reminder and respond with JSON.' },
      browser: { role: 'system', content: 'You are ASKII Browse.' },
      control: { role: 'system', content: 'You are ASKII Control.' },
    };

    await this.publish(deviceId, sessionId, token, { type: 'message', role: 'user', content: prompt });
    await this.publish(deviceId, sessionId, token, { type: 'status', status: 'thinking' });

    let assistant = '';
    try {
      for await (const delta of this.llm.streamChat(cfg, [labels[mode], { role: 'user', content: prompt }])) {
        assistant += delta;
        await this.publish(deviceId, sessionId, token, { type: 'chunk', delta });
      }
      await this.publish(deviceId, sessionId, token, { type: 'message', role: 'assistant', content: assistant });
      await this.publish(deviceId, sessionId, token, { type: 'done', summary: assistant.slice(0, 120) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.publish(deviceId, sessionId, token, { type: 'error', message });
    }
  }

  /** Run a vision-based agent mode (browser/control) and relay events to the controller. */
  private async runAgentMode(
    deviceId: string,
    sessionId: string,
    token: string,
    mode: SessionMode,
    prompt: string,
    cfg: AppConfig,
  ): Promise<void> {
    // Temporarily apply the merged config so the agent services pick it up
    const savedConfig = { ...this.config.current };
    this.config.applyRuntimeConfig(cfg);

    await this.publish(deviceId, sessionId, token, { type: 'message', role: 'user', content: prompt });
    await this.publish(deviceId, sessionId, token, { type: 'status', status: 'thinking' });

    try {
      if (mode === 'browser') {
        for await (const ev of this.browserMode.run(prompt, 5)) {
          await this.relayBrowserEvent(deviceId, sessionId, token, ev);
        }
      } else {
        // control — screen-control agent via AskiiScreen plugin
        for await (const ev of this.controlMode.run(prompt, 5)) {
          await this.relayControlEvent(deviceId, sessionId, token, ev);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.publish(deviceId, sessionId, token, { type: 'error', message });
    } finally {
      this.config.applyRuntimeConfig(savedConfig);
    }
  }

  private async relayBrowserEvent(
    deviceId: string,
    sessionId: string,
    token: string,
    ev: BrowserEvent,
  ): Promise<void> {
    const event: SessionEvent = (() => {
      switch (ev.type) {
        case 'round':
          return { type: 'round', round: ev.round, maxRounds: ev.maxRounds } as SessionEvent;
        case 'screenshot':
          return { type: 'screenshot', dataUrl: ev.dataUrl, label: ev.url } as SessionEvent;
        case 'action':
          return { type: 'action', actionId: ev.actionId, mode: 'browser', action: ev.action, description: ev.description } as SessionEvent;
        case 'status':
          return { type: 'status', status: ev.status, detail: ev.detail } as SessionEvent;
        case 'done':
          return { type: 'done', summary: ev.summary } as SessionEvent;
        case 'error':
          return { type: 'error', message: ev.message } as SessionEvent;
      }
    })();
    await this.publish(deviceId, sessionId, token, event);
  }

  private async relayControlEvent(
    deviceId: string,
    sessionId: string,
    token: string,
    ev: ControlEvent,
  ): Promise<void> {
    const event: SessionEvent = (() => {
      switch (ev.type) {
        case 'round':
          return { type: 'round', round: ev.round, maxRounds: ev.maxRounds } as SessionEvent;
        case 'screenshot':
          return { type: 'screenshot', dataUrl: ev.dataUrl, label: 'screen' } as SessionEvent;
        case 'action':
          return { type: 'action', actionId: ev.actionId, mode: 'control', action: ev.action, description: ev.description } as SessionEvent;
        case 'status':
          return { type: 'status', status: ev.status, detail: ev.detail } as SessionEvent;
        case 'done':
          return { type: 'done', summary: ev.summary } as SessionEvent;
        case 'error':
          return { type: 'error', message: ev.message } as SessionEvent;
      }
    })();
    await this.publish(deviceId, sessionId, token, event);
  }

  private mergedConfig(options: SessionOptions | undefined): AppConfig {
    const cfg = this.config.current;
    if (!options) return cfg;
    return {
      ...cfg,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey ?? cfg.apiKey,
      brokerUrl: options.baseUrl ?? cfg.brokerUrl,
      ollamaUrl: options.ollamaUrl ?? cfg.ollamaUrl,
      lmStudioUrl: options.lmStudioUrl ?? cfg.lmStudioUrl,
    };
  }

  private async publish(
    deviceId: string,
    sessionId: string,
    token: string,
    event: SessionEvent,
  ): Promise<void> {
    const client = this.client ?? this.ensureClient();
    await client.publishEvent(deviceId, sessionId, token, event);
  }

  private ensureClient(): SessionClient {
    if (!this.client) {
      this.client = new SessionClient({ baseUrl: this.config.current.brokerUrl });
    }
    return this.client;
  }
}