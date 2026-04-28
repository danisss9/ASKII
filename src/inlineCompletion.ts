import * as vscode from 'vscode';
import * as path from 'path';
import screenshot from 'screenshot-desktop';
import Jimp from 'jimp';
import { getExtensionResponse, getExtensionResponseWithImage } from './providers';

export class AskiiInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | null = null;
  
  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const config = vscode.workspace.getConfiguration('askii');
    if (!config.get<boolean>('inlineCompletionEnabled')) {
      return [];
    }

    // Debounce to prevent spamming the LLM
    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) {
          resolve([]);
          return;
        }

        try {
          const items = await this.fetchCompletions(document, position, token, config);
          resolve(items);
        } catch (e) {
          console.error('Error fetching inline completion:', e);
          resolve([]);
        }
      }, 400); // 400ms debounce
    });
  }

  private async fetchCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    config: vscode.WorkspaceConfiguration
  ): Promise<vscode.InlineCompletionItem[]> {
    // Collect context
    const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const activeEditor = vscode.window.activeTextEditor;
    let editorContext = '';
    
    if (activeEditor && activeEditor.document.uri.toString() !== document.uri.toString()) {
      const editorDoc = activeEditor.document;
      // Mock "AST tokens" by passing the last N lines of the active editor
      const editorText = editorDoc.getText();
      // limit to ~2000 chars to avoid prompt explosion
      editorContext = `\nActive editor context (${path.basename(editorDoc.fileName)}):\n${editorText.slice(-2000)}`;
    }

    let screenshotBase64: string | undefined = undefined;
    if (config.get<boolean>('inlineCompletionScreenshot')) {
      try {
        const displays = await screenshot.listDisplays();
        const primary = displays && displays.length > 0 ? displays[0] : undefined;
        const imgBuffer = await screenshot({ screen: primary ? primary.id : undefined, format: 'png' });
        const image = await Jimp.read(imgBuffer);
        // Resize heavily to save tokens, e.g. 800px width max
        image.scaleToFit(800, 800, Jimp.RESIZE_BICUBIC);
        // Convert to base64
        const fullBase64 = await image.getBase64Async(Jimp.MIME_PNG);
        // jimp returns "data:image/png;base64,..." we need just the base64 part
        screenshotBase64 = fullBase64.replace(/^data:image\/png;base64,/, '');
      } catch (e) {
        console.error('Screenshot failed for inline completion:', e);
      }
    }

    if (token.isCancellationRequested) return [];

    const prompt = `You are a highly capable AI code and terminal autocomplete assistant.
Your goal is to complete the text the user is typing in a terminal or chat input box.
Only provide the exact completion string that should be inserted at the cursor position.
Do not wrap it in quotes, markdown, or add any explanations. Just the completion text.
Do not repeat what the user has already typed, only provide the continuation.

Input context:
${editorContext}

Text before cursor in the input box:
${textBeforeCursor}

Provide the continuation text now:`;

    let completionText = '';
    if (screenshotBase64) {
      completionText = await getExtensionResponseWithImage(prompt, screenshotBase64);
    } else {
      completionText = await getExtensionResponse(prompt);
    }

    if (token.isCancellationRequested || !completionText) return [];

    completionText = completionText.trim();
    // Remove if it tries to echo the prompt or wrap in markdown
    if (completionText.startsWith('\`\`\`')) {
      const lines = completionText.split('\\n');
      lines.shift(); // remove opening
      if (lines.length > 0 && lines[lines.length - 1].startsWith('\`\`\`')) {
        lines.pop(); // remove closing
      }
      completionText = lines.join('\\n');
    }

    if (!completionText) return [];

    return [new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position))];
  }
}
