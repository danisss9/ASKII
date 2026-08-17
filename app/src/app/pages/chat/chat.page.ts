import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonSpinner,
  IonLabel,
  IonChip,
  IonItem,
  IonList,
  IonInput,
} from '@ionic/angular/standalone';
import MarkdownIt from 'markdown-it';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ConfigService } from '../../services/config.service';
import { LlmService } from '../../services/llm.service';
import { HistoryService } from '../../services/history.service';
import { RemoteSessionService } from '../../services/remote-session.service';
import { BrowserModeService } from '../../services/browser-mode.service';
import { ControlModeService } from '../../services/control-mode.service';
import { MODES, type ChatMessage, type ChatSession, type ModeId } from '../../models/chat';
import type { ProviderId } from '@shared/providers';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSelect,
    IonSelectOption,
    IonTextarea,
    IonSpinner,
    IonLabel,
    IonChip,
    IonItem,
    IonList,
    IonInput,
  ],
  templateUrl: './chat.page.html',
  styleUrls: ['./chat.page.scss'],
})
export class ChatPage implements OnInit {
  protected readonly MODES = MODES;

  mode = signal<ModeId>('ask');
  input = '';
  sending = signal(false);
  session = signal<ChatSession | null>(null);

  constructor(
    protected readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly history: HistoryService,
    private readonly sanitizer: DomSanitizer,
    private readonly router: Router,
    private readonly remote: RemoteSessionService,
    private readonly browserMode: BrowserModeService,
    private readonly controlMode: ControlModeService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.config.load();
    await this.history.load();
    const c = this.config.current;
    const existing = this.history.takeActive();
    if (existing) {
      const loaded = this.history.get(existing);
      if (loaded) {
        this.session.set({ ...loaded, messages: loaded.messages.map((m) => ({ ...m })) });
        this.mode.set(loaded.mode);
        if (this.remote.isPaired) this.remote.start().catch(() => undefined);
        return;
      }
    }
    this.session.set({
      id: '',
      title: 'New chat',
      mode: 'ask',
      provider: c.provider,
      model: c.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    // Start the remote-session listener in the background if paired.
    if (this.remote.isPaired) {
      this.remote.start().catch(() => undefined);
    }
  }

  modeChanged(ev: Event): void {
    const value = (ev as CustomEvent).detail.value as ModeId;
    this.mode.set(value);
  }

  providerChanged(ev: Event): void {
    const value = (ev as CustomEvent).detail.value as ProviderId;
    this.config.setProvider(value).then(() => this.touchSession());
  }

  modelChanged(ev: Event): void {
    const value = (ev as CustomEvent).detail.value as string;
    this.config.save({ model: value }).then(() => this.touchSession());
  }

  private touchSession(): void {
    const s = this.session();
    if (s) {
      s.provider = this.config.current.provider;
      s.model = this.config.current.model;
      this.session.set({ ...s });
    }
  }

  render(content: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(md.render(content));
  }

  async send(): Promise<void> {
    const text = this.input.trim();
    if (!text || this.sending()) return;
    this.input = '';
    this.sending.set(true);

    const s = this.session()!;
    s.mode = this.mode();
    s.messages.push({ role: 'user', content: text });
    const assistant: ChatMessage = { role: 'assistant', content: '', streaming: true };
    s.messages.push(assistant);
    this.session.set({ ...s });

    const mode = this.mode();
    try {
      if (mode === 'browser') {
        await this.runBrowserAgent(text, assistant, s);
      } else if (mode === 'control') {
        await this.runControlAgent(text, assistant, s);
      } else {
        await this.runChat(text, assistant, s, mode);
      }
      assistant.streaming = false;
      if (!s.title || s.title === 'New chat') s.title = text.slice(0, 48);
    } catch (err) {
      assistant.content += `\n\n[error: ${err instanceof Error ? err.message : String(err)}]`;
      assistant.streaming = false;
    } finally {
      this.sending.set(false);
      s.updatedAt = new Date().toISOString();
      this.session.set({ ...s });
      await this.persist();
    }
  }

  private async runChat(text: string, assistant: ChatMessage, s: ChatSession, mode: ModeId): Promise<void> {
    const sys: ChatMessage = {
      role: 'system',
      content:
        mode === 'edit'
          ? 'You are ASKII Edit. Return only the updated code, no explanation.'
          : mode === 'note'
            ? 'You are ASKII Note. Classify the text as note/task/reminder and respond with concise JSON.'
            : 'You are ASKII, a helpful coding assistant. Provide clear, concise answers.',
    };
    const messages = [sys, ...s.messages.filter((m) => m.role !== 'system' && m !== assistant)];
    for await (const delta of this.llm.streamChat(this.config.current, messages)) {
      assistant.content += delta;
      this.session.set({ ...s });
    }
  }

  private async runBrowserAgent(task: string, assistant: ChatMessage, s: ChatSession): Promise<void> {
    assistant.content = `**Browser agent**: ${task}\n\n`;
    this.session.set({ ...s });

    for await (const ev of this.browserMode.run(task, 5)) {
      switch (ev.type) {
        case 'round':
          assistant.content += `\n**Round ${ev.round}/${ev.maxRounds}**\n`;
          break;
        case 'screenshot':
          assistant.content += `📸 Screenshot of ${ev.url} (${ev.width}x${ev.height})\n`;
          break;
        case 'action':
          assistant.content += `→ ${ev.description}\n`;
          break;
        case 'status':
          if (ev.status === 'thinking') assistant.content += `Thinking…\n`;
          else if (ev.status === 'executing') assistant.content += `Executing…\n`;
          break;
        case 'done':
          assistant.content += `\n✅ **Done**: ${ev.summary}\n`;
          break;
        case 'error':
          assistant.content += `\n❌ **Error**: ${ev.message}\n`;
          break;
      }
      this.session.set({ ...s });
    }
  }

  private async runControlAgent(task: string, assistant: ChatMessage, s: ChatSession): Promise<void> {
    assistant.content = `**Control agent**: ${task}\n\n`;
    this.session.set({ ...s });

    for await (const ev of this.controlMode.run(task, 5)) {
      switch (ev.type) {
        case 'round':
          assistant.content += `\n**Round ${ev.round}/${ev.maxRounds}**\n`;
          break;
        case 'screenshot':
          assistant.content += `📸 Screen captured (${ev.width}x${ev.height})\n`;
          break;
        case 'action':
          assistant.content += `→ ${ev.description}\n`;
          break;
        case 'status':
          if (ev.status === 'thinking') assistant.content += `Thinking…\n`;
          else if (ev.status === 'executing') assistant.content += `Executing…\n`;
          break;
        case 'done':
          assistant.content += `\n✅ **Done**: ${ev.summary}\n`;
          break;
        case 'error':
          assistant.content += `\n❌ **Error**: ${ev.message}\n`;
          break;
      }
      this.session.set({ ...s });
    }
  }

  private async persist(): Promise<void> {
    const s = this.session();
    if (!s) return;
    if (!s.id) {
      const created = await this.history.create(s.mode, s.provider, s.model);
      s.id = created.id;
    }
    s.messages = s.messages.map((m) => ({ role: m.role, content: m.content }));
    await this.history.update({ ...s });
  }

  newChat(): void {
    this.session.set({
      id: '',
      title: 'New chat',
      mode: this.mode(),
      provider: this.config.current.provider,
      model: this.config.current.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
  }

  openHistory(): void {
    void this.router.navigateByUrl('/history');
  }

  openSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void this.send();
    }
  }
}