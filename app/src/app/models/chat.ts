/**
 * App-side view models. The wire types that cross the remote-session boundary
 * live in `@shared/protocol`; these describe the local chat UX only.
 */

export type ModeId = 'ask' | 'edit' | 'do' | 'note' | 'browser' | 'control';

export const MODES: ReadonlyArray<{ id: ModeId; label: string; hint: string; vision?: boolean }> = [
  { id: 'ask', label: 'Ask', hint: 'Chat with the model about your code' },
  { id: 'edit', label: 'Edit', hint: 'Send code to be rewritten by the model' },
  { id: 'do', label: 'Do', hint: 'Agent over the on-device sandbox (filesystem)' },
  { id: 'note', label: 'Note', hint: 'Free-text notes / tasks / reminders' },
  { id: 'browser', label: 'Browse', hint: 'In-app WebView agent', vision: true },
  { id: 'control', label: 'Control', hint: 'Screen-control agent (requires Accessibility)', vision: true },
];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** True while this assistant message is still streaming in. */
  streaming?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  mode: ModeId;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}