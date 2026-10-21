import * as vscode from 'vscode';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { getLLMExplanation } from './providers';
import { isExcludedFromInline } from './privacy';
import { log } from './log';

export const explanationCache = new Map<string, { kaomoji: string; explanation: string }>();
const MAX_EXPLANATION_CACHE_ENTRIES = 500;

function cacheExplanation(key: string, value: { kaomoji: string; explanation: string }): void {
  // Re-insert so the Map's insertion order doubles as LRU order
  explanationCache.delete(key);
  explanationCache.set(key, value);
  while (explanationCache.size > MAX_EXPLANATION_CACHE_ENTRIES) {
    const oldest = explanationCache.keys().next().value;
    if (oldest === undefined) {break;}
    explanationCache.delete(oldest);
  }
}

let decorationType: vscode.TextEditorDecorationType;
let debounceTimer: NodeJS.Timeout | undefined;
let thinkingTimer: NodeJS.Timeout | undefined;
let currentAbortController: AbortController | undefined;

export function initDecorationType(type: vscode.TextEditorDecorationType) {
  decorationType = type;
}

export function showDecoration(
  editor: vscode.TextEditor,
  lineNumber: number,
  kaomoji: string,
  text: string,
) {
  const currentLine = editor.document.lineAt(lineNumber);
  const lineLength = currentLine.text.length;
  const range = new vscode.Range(
    new vscode.Position(lineNumber, lineLength),
    new vscode.Position(lineNumber, lineLength),
  );

  const maxLength = 100;
  const isTruncated = text.length > maxLength;
  const displayText = isTruncated ? text.substring(0, maxLength) + '...' : text;

  // Long explanations are shown in full by AskiiHoverProvider
  const decoration: vscode.DecorationOptions = {
    range,
    renderOptions: {
      after: {
        contentText: ` ${kaomoji} ${displayText}`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
    },
  };

  editor.setDecorations(decorationType, [decoration]);
}

export async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }

  // Cancel the previous line's pending work first — every path below (off,
  // blank line, cache hit) must stop its timers from drawing on a stale line.
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = undefined;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
  }

  const mode =
    vscode.workspace.getConfiguration('askii').get<string>('inlineHelperMode') || 'off';
  if (mode === 'off' || isExcludedFromInline(editor.document)) {
    editor.setDecorations(decorationType, []);
    return;
  }

  const position = editor.selection.active;
  const currentLine = editor.document.lineAt(position.line);
  const lineText = currentLine.text.trim();

  editor.setDecorations(decorationType, []);

  if (!lineText || lineText.length <= 3) {
    return;
  }

  const cacheKey = `${editor.document.uri.toString()}:${position.line}:${lineText}`;

  const cached = explanationCache.get(cacheKey);
  if (cached) {
    showDecoration(editor, position.line, cached.kaomoji, cached.explanation);
    return;
  }

  const abortController = new AbortController();
  currentAbortController = abortController;

  thinkingTimer = setTimeout(() => {
    const thinkingKaomoji = getRandomThinkingKaomoji();
    showDecoration(editor, position.line, thinkingKaomoji, 'thinking...');
  }, 300);

  debounceTimer = setTimeout(async () => {
    try {
      const kaomoji = getRandomKaomoji();
      const explanation = await getLLMExplanation(lineText, abortController.signal);

      if (!abortController.signal.aborted && explanation) {
        cacheExplanation(cacheKey, { kaomoji, explanation });
        showDecoration(editor, position.line, kaomoji, explanation);
      }
    } catch (error) {
      // Errors are not cached — the next visit to the line retries
      if (!abortController.signal.aborted) {
        clearTimeout(thinkingTimer);
        editor.setDecorations(decorationType, []);
        log.warn(`Inline explanation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, 1000);
}

export class AskiiHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = position.line;
    const lineText = document.lineAt(line).text.trim();

    if (!lineText) {
      return null;
    }

    const cacheKey = `${document.uri.toString()}:${line}:${lineText}`;
    const cached = explanationCache.get(cacheKey);
    if (cached) {
      const maxLength = 100;

      if (cached.explanation.length > maxLength && cached.explanation !== 'thinking...') {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`${cached.kaomoji} **ASKII Says:**\n\n`);
        markdown.appendText(cached.explanation);

        return new vscode.Hover(markdown);
      }
    }

    return null;
  }
}

export function cleanupDecorations() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
  }
  if (currentAbortController) {
    currentAbortController.abort();
  }
  explanationCache.clear();
}
