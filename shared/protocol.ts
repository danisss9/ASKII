/**
 * ASKII remote-session wire protocol.
 *
 * A single source of truth for the message format spoken between the three
 * clients (VS Code extension, CLI, Android app) and the session broker
 * (ASKII Cloud in production, the small `relay/` mock in development).
 *
 * Runtime-agnostic: no Node, no DOM, no network — only types and pure
 * constants. Importable from anywhere.
 */

import type { ProviderId } from './providers';

/** The six command modes that can run on the app and be driven remotely. */
export type SessionMode = 'ask' | 'edit' | 'do' | 'note' | 'browser' | 'control';

/**
 * Provider + model selection for a remote session. Keys/URLs are resolved by
 * whichever side is the executor (the Android app, using its stored settings)
 * unless the controller supplies explicit overrides here.
 */
export interface SessionOptions {
  provider: ProviderId;
  model: string;
  /** Override the API key the executor would otherwise use. */
  apiKey?: string;
  /** Override a cloud / OpenAI-compatible base URL. */
  baseUrl?: string;
  /** Ollama host URL (local). */
  ollamaUrl?: string;
  /** LM Studio host URL (local). */
  lmStudioUrl?: string;
}

/** Request body for `POST /sessions/pair`. */
export interface PairRequest {
  deviceName: string;
  /** ASKII Cloud (broker) API key — authenticates the pairing with the broker. */
  apiKey: string;
}

/** Response from `POST /sessions/pair`. */
export interface PairResponse {
  deviceId: string;
  pairingToken: string;
  expiresAt: string; // ISO8601
}

/** Request body for `POST /sessions` (controller creates a remote session). */
export interface CreateSessionRequest {
  /** The paired Android app device to drive. */
  deviceId: string;
  /** Pairing token authorising this controller for the device. */
  pairingToken: string;
  mode: SessionMode;
  options: SessionOptions;
  /** The opening instruction / question / task text. */
  prompt: string;
  /** Broker auth (ASKII Cloud API key). */
  apiKey: string;
}

/** The outcome of session creation. */
export interface CreateSessionResponse {
  sessionId: string;
}

// ── Events (broker → clients, delivered over the events SSE stream) ──────────

export type SessionEvent =
  | { type: 'session_created'; sessionId: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'chunk'; delta: string }
  | { type: 'round'; round: number; maxRounds: number }
  | {
      type: 'action';
      actionId: string;
      mode: SessionMode;
      /** Mode-specific action payload (WorkspaceAction / BrowserAction / ControlAction). */
      action: unknown;
      description: string;
    }
  | { type: 'screenshot'; dataUrl: string; label?: string }
  | { type: 'clarify'; question: string }
  | { type: 'status'; status: 'thinking' | 'running' | 'done' | 'error'; detail?: string }
  | { type: 'done'; summary?: string }
  | { type: 'error'; message: string };

// ── Commands (client → broker, sent over POST) ──────────────────────────────

export type SessionCommand =
  | { type: 'reply'; content: string }
  | { type: 'confirm'; actionId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'cancel' };

/**
 * Commands the controller sends to the app, delivered to the app over its
 * subscriber SSE stream. A slight superset of `SessionCommand` so the broker
 * can bootstrap a new turn without an existing session open in the controller.
 */
export type DeviceCommand =
  | { type: 'start'; sessionId: string; mode: SessionMode; options: SessionOptions; prompt: string }
  | { type: 'reply'; sessionId: string; content: string }
  | { type: 'confirm'; sessionId: string; actionId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'cancel'; sessionId: string };

/** Event envelope as delivered on the wire (named `event` so a single SSE can
 * carry either a SessionEvent or a DeviceCommand). */
export interface SessionEventEnvelope {
  event: SessionEvent['type'];
  data: SessionEvent;
}

export interface DeviceCommandEnvelope {
  event: DeviceCommand['type'];
  data: DeviceCommand;
}