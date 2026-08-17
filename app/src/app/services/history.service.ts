import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import type { ChatSession, ModeId } from '../models/chat';

const STORE_KEY = 'askii.sessions';

/**
 * HistoryService — persisted named chat sessions (the History drawer).
 * Backed by `@capacitor/preferences` so chat history survives app restarts.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private sessions: ChatSession[] = [];
  private activeId: string | null = null;

  async load(): Promise<ChatSession[]> {
    const { value } = await Preferences.get({ key: STORE_KEY });
    if (value) {
      try {
        this.sessions = JSON.parse(value) as ChatSession[];
      } catch {
        this.sessions = [];
      }
    }
    return [...this.sessions];
  }

  list(): ChatSession[] {
    return [...this.sessions];
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  async create(mode: ModeId, provider: string, model: string): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: 'New chat',
      mode,
      provider,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.unshift(session);
    await this.persist();
    return session;
  }

  async update(session: ChatSession): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    if (idx !== -1) this.sessions[idx] = session;
    else this.sessions.unshift(session);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    await this.persist();
  }

  /** Mark a session as the one to load when the chat page next initialises. */
  setActive(id: string): void {
    this.activeId = id;
  }

  /** Consume the pending active id (returns null if none queued). */
  takeActive(): string | null {
    const id = this.activeId;
    this.activeId = null;
    return id;
  }

  private async persist(): Promise<void> {
    await Preferences.set({ key: STORE_KEY, value: JSON.stringify(this.sessions) });
  }
}