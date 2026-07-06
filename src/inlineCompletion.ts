import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionResponse } from './providers';

export const INLINE_ACCEPT_COMMAND = 'askii.inlineCompletionAccepted';

const SYSTEM_PROMPT = `You are a code-completion engine. Output ONLY the raw text to insert at the cursor.
No markdown fences, no explanations, no quotes. Never repeat text already before the cursor.
Match the file's language, indentation and style. Output nothing if no useful completion exists.`;

// Hard cap on the most variable prompt sections to keep requests small and fast.
const SELECTION_CHAR_CAP = 300;

interface EagernessProfile {
  debounceMs: number;
  prefixChars: number;
  suffixChars: number;
}

const EAGERNESS_PROFILES: Record<string, EagernessProfile> = {
  low: { debounceMs: 1200, prefixChars: 2000, suffixChars: 500 },
  medium: { debounceMs: 500, prefixChars: 1200, suffixChars: 300 },
  high: { debounceMs: 200, prefixChars: 800, suffixChars: 200 },
};

interface LastSuggestion {
  id: number;
  text: string;
  contextKey: string;
  accepted: boolean;
}

// Cheap context computed on every invocation (no RAG/LLM work) — also yields the cache key.
interface BaseContext {
  offset: number;
  prefix: string;
  suffix: string;
  linePrefix: string;
  fileName: string;
  languageId: string;
  selectionText: string;
  contextKey: string;
}

// Fast, stable string hash (djb2) so the cache key stays short instead of embedding full prefix/suffix.
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve();
      return;
    }
    let sub: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub?.dispose();
      resolve();
    });
  });
}

export class AskiiInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private latestRequestId = 0;
  private lastSuggestion: LastSuggestion | null = null;
  private pendingController: AbortController | null = null;

  public notifyAccepted(id: number): void {
    if (this.lastSuggestion?.id === id) {
      this.lastSuggestion.accepted = true;
    }
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const config = vscode.workspace.getConfiguration('askii');
    if (!config.get<boolean>('inlineCompletionEnabled')) {
      return [];
    }

    const eagerness = config.get<string>('inlineCompletionEagerness') ?? 'medium';
    const profile = EAGERNESS_PROFILES[eagerness] ?? EAGERNESS_PROFILES['medium'];

    const ctx = this.buildBaseContext(document, position, profile);

    // Cache hit: VSCode re-triggers frequently (edits, cursor moves, re-renders). If the context is
    // identical to the suggestion already on screen, return it as-is instead of starting a new request
    // that would needlessly supersede/cancel the valid one.
    if (this.lastSuggestion && this.lastSuggestion.contextKey === ctx.contextKey) {
      return [this.makeItem(this.lastSuggestion.text, position, this.lastSuggestion.id)];
    }

    const id = ++this.latestRequestId;
    await delay(profile.debounceMs, token);

    if (token.isCancellationRequested || id !== this.latestRequestId) {
      return [];
    }

    // Abort any still-running request — only the latest matters, and leaving stale LLM calls in flight
    // (especially on a serial local backend) starves the one we actually want.
    this.pendingController?.abort();
    const controller = new AbortController();
    this.pendingController = controller;
    const cancelSub = token.onCancellationRequested(() => controller.abort());

    try {
      return await this.fetchCompletions(position, token, config, id, ctx, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error('Error fetching inline completion:', e);
      }
      return [];
    } finally {
      cancelSub.dispose();
      if (this.pendingController === controller) {
        this.pendingController = null;
      }
    }
  }

  private buildBaseContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    profile: EagernessProfile,
  ): BaseContext {
    const fullText = document.getText();
    const offset = document.offsetAt(position);

    const prefix = fullText.slice(Math.max(0, offset - profile.prefixChars), offset);
    const suffix = fullText.slice(offset, offset + profile.suffixChars);

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    // Current selection (if any), capped to a short excerpt.
    let selectionText = '';
    const activeEditor = vscode.window.activeTextEditor;
    if (
      activeEditor &&
      activeEditor.document.uri.toString() === document.uri.toString() &&
      !activeEditor.selection.isEmpty
    ) {
      const selected = activeEditor.document.getText(activeEditor.selection).trim();
      if (selected) selectionText = selected.slice(0, SELECTION_CHAR_CAP);
    }

    const contextKey = `${document.uri.toString()}:${offset}:${hashString(prefix)}:${hashString(suffix)}`;

    return {
      offset,
      prefix,
      suffix,
      linePrefix,
      fileName: path.basename(document.fileName),
      languageId: document.languageId,
      selectionText,
      contextKey,
    };
  }

  private makeItem(
    text: string,
    position: vscode.Position,
    id: number,
  ): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
      command: INLINE_ACCEPT_COMMAND,
      title: '',
      arguments: [id],
    });
  }

  private async fetchCompletions(
    position: vscode.Position,
    token: vscode.CancellationToken,
    config: vscode.WorkspaceConfiguration,
    id: number,
    ctx: BaseContext,
    signal: AbortSignal,
  ): Promise<vscode.InlineCompletionItem[]> {
    const selectionSection = ctx.selectionText
      ? `Current selection:\n${ctx.selectionText}\n\n`
      : '';

    const prompt =
      `File: ${ctx.fileName} (language: ${ctx.languageId})\n\n` +
      selectionSection +
      `Code before cursor:\n${ctx.prefix}\n` +
      `Code after cursor:\n${ctx.suffix}\n` +
      `The cursor is at the end of this line: ${ctx.linePrefix}\n` +
      `Output the completion text now:`;

    const completionText = await getExtensionResponse(
      prompt,
      SYSTEM_PROMPT,
      config.get<string>('inlinePlatform'),
      config.get<string>('inlineModel'),
      signal,
    );

    if (token.isCancellationRequested || id !== this.latestRequestId || !completionText) {
      return [];
    }

    const cleaned = this.cleanResponse(completionText, ctx.linePrefix);
    if (!cleaned) return [];

    // Track this suggestion as shown-but-not-yet-accepted, keyed by the context that produced it.
    this.lastSuggestion = { id, text: cleaned, contextKey: ctx.contextKey, accepted: false };

    return [this.makeItem(cleaned, position, id)];
  }

  private cleanResponse(raw: string, linePrefix: string): string {
    let text = raw.trim();

    // Strip markdown fences (```lang ... ```)
    if (text.startsWith('```')) {
      const lines = text.split('\n');
      lines.shift(); // remove opening fence
      if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) {
        lines.pop(); // remove closing fence
      }
      text = lines.join('\n').trim();
    }

    // If the model echoed the current line prefix at the start, strip it
    if (linePrefix && text.startsWith(linePrefix)) {
      text = text.slice(linePrefix.length);
    }

    return text.trim();
  }
}
