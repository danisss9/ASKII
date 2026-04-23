import * as vscode from 'vscode';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { getLLMExplanation } from './providers';

export const explanationCache = new Map<string, { kaomoji: string; explanation: string }>();

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
  const isThinking = text === 'thinking...';

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

  if (isTruncated && !isThinking) {
    decoration.hoverMessage = new vscode.MarkdownString(`${kaomoji} **ASKII Says:**\n\n${text}`);
  }

  editor.setDecorations(decorationType, [decoration]);
}

export async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }

  const mode =
    vscode.workspace.getConfiguration('askii').get<string>('inlineHelperMode') || 'funny';
  if (mode === 'off') {
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

  if (currentAbortController) {
    currentAbortController.abort();
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
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

      if (!abortController.signal.aborted) {
        explanationCache.set(cacheKey, { kaomoji, explanation });
        showDecoration(editor, position.line, kaomoji, explanation);
      }
    } catch (error) {
      if (error instanceof Error && error.message !== 'Request cancelled') {
        console.error('Error getting explanation:', error);
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
        markdown.isTrusted = true;

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
