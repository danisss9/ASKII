import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { loadCodeWikiIndex, searchCodeWiki } from '@common/codewiki';

export const INLINE_ACCEPT_COMMAND = 'askii.inlineCompletionAccepted';

const SYSTEM_PROMPT = `You are an expert code-completion engine.
Given code before and after a cursor, output ONLY the raw text to insert at the cursor.
Rules:
- Output code only: no markdown fences, no explanations, no quotes.
- Never repeat text that already appears before the cursor.
- Match the file's language, indentation and style.
- Prefer completing the current statement/block; multi-line is fine when obvious.
- If the user rejected your previous suggestion, try a different approach.
- If no useful completion exists, output nothing.`;

interface EagernessProfile {
  debounceMs: number;
  prefixChars: number;
  suffixChars: number;
  topK: number;
}

const EAGERNESS_PROFILES: Record<string, EagernessProfile> = {
  low: { debounceMs: 1200, prefixChars: 4000, suffixChars: 1000, topK: 3 },
  medium: { debounceMs: 500, prefixChars: 2500, suffixChars: 600, topK: 2 },
  high: { debounceMs: 200, prefixChars: 1500, suffixChars: 400, topK: 1 },
};

interface LastSuggestion {
  id: number;
  text: string;
  accepted: boolean;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class AskiiInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private latestRequestId = 0;
  private lastSuggestion: LastSuggestion | null = null;

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

    const id = ++this.latestRequestId;
    await delay(profile.debounceMs, token);

    if (token.isCancellationRequested || id !== this.latestRequestId) {
      return [];
    }

    try {
      return await this.fetchCompletions(document, position, token, config, profile, id);
    } catch (e) {
      console.error('Error fetching inline completion:', e);
      return [];
    }
  }

  private async fetchCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    config: vscode.WorkspaceConfiguration,
    profile: EagernessProfile,
    id: number,
  ): Promise<vscode.InlineCompletionItem[]> {
    const fullText = document.getText();
    const offset = document.offsetAt(position);

    const prefix = fullText.slice(Math.max(0, offset - profile.prefixChars), offset);
    const suffix = fullText.slice(offset, offset + profile.suffixChars);

    const currentLine = document.lineAt(position.line);
    const linePrefix = currentLine.text.slice(0, position.character);

    const fileName = path.basename(document.fileName);
    const languageId = document.languageId;

    // Current selection (if any)
    const activeEditor = vscode.window.activeTextEditor;
    let selectionSection = '';
    if (
      activeEditor &&
      activeEditor.document.uri.toString() === document.uri.toString() &&
      !activeEditor.selection.isEmpty
    ) {
      const selectedText = activeEditor.document.getText(activeEditor.selection);
      if (selectedText.trim()) {
        selectionSection = `Current selection:\n${selectedText}\n\n`;
      }
    }

    // Code wiki retrieval
    let codeWikiSection = '';
    if (config.get<boolean>('codeWikiEnabled') ?? false) {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (rootPath) {
        try {
          const index = loadCodeWikiIndex(rootPath);
          if (index) {
            // Query using the current line + last few non-empty prefix lines for relevance
            const queryLines = prefix
              .split('\n')
              .filter((l) => l.trim().length > 0)
              .slice(-4)
              .join(' ');
            const wikiResults = searchCodeWiki(queryLines, index, profile.topK);
            if (wikiResults) {
              codeWikiSection = `Relevant codebase context:\n${wikiResults}\n\n`;
            }
          }
        } catch {
          // Non-fatal — continue without wiki context
        }
      }
    }

    // Previous suggestion feedback
    let prevSuggestionSection = '';
    if (this.lastSuggestion) {
      const status = this.lastSuggestion.accepted ? 'ACCEPTED' : 'REJECTED';
      prevSuggestionSection = `Your previous suggestion was: "${this.lastSuggestion.text.substring(0, 120)}" — the user ${status} it.\n\n`;
    }

    const prompt =
      `File: ${fileName} (language: ${languageId})\n\n` +
      codeWikiSection +
      selectionSection +
      prevSuggestionSection +
      `Code before cursor:\n${prefix}\n` +
      `Code after cursor:\n${suffix}\n` +
      `The cursor is at the end of this line: ${linePrefix}\n` +
      `Output the completion text now:`;

    const completionText = await getExtensionResponse(prompt, SYSTEM_PROMPT);

    if (token.isCancellationRequested || id !== this.latestRequestId || !completionText) {
      return [];
    }

    const cleaned = this.cleanResponse(completionText, linePrefix);
    if (!cleaned) return [];

    // Track this suggestion as shown-but-not-yet-accepted
    this.lastSuggestion = { id, text: cleaned, accepted: false };

    return [
      new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position), {
        command: INLINE_ACCEPT_COMMAND,
        title: '',
        arguments: [id],
      }),
    ];
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
