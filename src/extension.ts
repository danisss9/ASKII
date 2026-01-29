/**
 * ASKII - AI Code Assistant with Style
 *
 * An AI-powered VS Code extension that provides inline code explanations with kaomoji (｡◕‿◕｡)
 * Supports both local Ollama and GitHub Copilot for AI-powered insights.
 *
 * Features:
 * - Inline decorations with kaomoji and AI explanations
 * - GitLens-style hover tooltips for full message display
 * - Configurable AI providers (Ollama or GitHub Copilot)
 * - Smart caching to minimize API calls
 * - Debounced requests for optimal performance
 * - Toggle between humorous and helpful mode
 */

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { Ollama } from "ollama";

// Array of kaomoji to randomly select from
const kaomojis = [
  "(◕‿◕)",
  "ヽ(´▽`)/",
  "(｡◕‿◕｡)",
  "(づ｡◕‿‿◕｡)づ",
  "ʕ•ᴥ•ʔ",
  "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
  "(◕ᴗ◕✿)",
  "(｡♥‿♥｡)",
  "♪(┌・。・)┌",
  "(ﾉ´ヮ`)ﾉ*: ･ﾟ",
  "(￣▽￣)ノ",
  "(◠‿◠)",
  "(•‿•)",
  "╰(*°▽°*)╯",
  "(≧◡≦)",
  "(☞ﾟヮﾟ)☞",
  "(づ￣ ³￣)づ",
  "ヾ(⌐■_■)ノ♪",
  "(ง •̀_•́)ง",
  "(╯°□°）╯︵ ┻━┻",
  "┬─┬ ノ( ゜-゜ノ)",
  "( •_•)>⌐■-■",
  "(⌐■_■)",
  "¯\\_(ツ)_/¯",
  "( ͡° ͜ʖ ͡°)",
  "ಠ_ಠ",
];

// Thinking kaomojis shown while waiting for response
const thinkingKaomojis = [
  "(๑•﹏•)",
  "(・_・ヾ",
  "( ˘ω˘ )",
  "(´-ω-`)",
  "( ´ ▽ ` )",
];

// Decoration type for the inline annotations
let decorationType: vscode.TextEditorDecorationType;

// Cache for line explanations to avoid redundant API calls
const explanationCache = new Map<
  string,
  { kaomoji: string; explanation: string }
>();

// Debounce timer and abort controller for cancelling requests
let debounceTimer: NodeJS.Timeout | undefined;
let thinkingTimer: NodeJS.Timeout | undefined;
let currentAbortController: AbortController | undefined;

// Function to get a random kaomoji
function getRandomKaomoji(): string {
  return kaomojis[Math.floor(Math.random() * kaomojis.length)];
}

// Function to get a random thinking kaomoji
function getRandomThinkingKaomoji(): string {
  return thinkingKaomojis[Math.floor(Math.random() * thinkingKaomojis.length)];
}

// Function to call GitHub Copilot Language Model API and get explanation
async function getCopilotExplanation(
  lineText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration("askii");
  const helpfulMode = config.get<boolean>("helpfulMode") || false;
  const copilotModel = config.get<string>("copilotModel") || "gpt-4o";

  try {
    // Check if already aborted
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    // Get available language models
    const models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: copilotModel,
    });

    if (models.length === 0) {
      return "Error: GitHub Copilot is not available. Please ensure you have GitHub Copilot installed and enabled.";
    }

    const model = models[0];

    const systemPrompt = helpfulMode
      ? "You are ASKII, a helpful coding assistant that provides clear, concise, and practical advice about code. Focus on explaining what the code does, potential issues, best practices, and optimization suggestions."
      : "You are ASKII a witty coding assistant that provides humorous comments about code.";

    const userPrompt = helpfulMode
      ? `Provide a helpful, concise explanation of this line of code in one sentence, focusing on what it does, why it might be used, or any important considerations: ${lineText}`
      : `Do a funny comment about this line of code concisely in one sentence: ${lineText}`;

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];

    const chatResponse = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    // Check if aborted after request
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    let responseText = "";
    for await (const fragment of chatResponse.text) {
      responseText += fragment;
    }

    return responseText || "No explanation available.";
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error; // Re-throw abort errors
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return `Error: ${errorMessage}`;
  }
}

// Function to call Ollama API and get explanation
async function getOllamaExplanation(
  lineText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration("askii");
  const ollamaUrl = config.get<string>("ollamaUrl") || "http://localhost:11434";
  const ollamaModel = config.get<string>("ollamaModel") || "gemma3:270m";
  const helpfulMode = config.get<boolean>("helpfulMode") || false;

  try {
    const ollama = new Ollama({ host: ollamaUrl });

    // Check if already aborted
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    const systemPrompt = helpfulMode
      ? "You are ASKII, a helpful coding assistant that provides clear, concise, and practical advice about code. Focus on explaining what the code does, potential issues, best practices, and optimization suggestions."
      : "You are ASKII a witty coding assistant that provides humorous comments about code.";

    const userPrompt = helpfulMode
      ? `Provide a helpful, concise explanation of this line of code in one sentence, focusing on what it does, why it might be used, or any important considerations: ${lineText}`
      : `Do a funny comment about this line of code concisely in one sentence: ${lineText}`;

    const response = await ollama.generate({
      model: ollamaModel,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
    });

    // Check if aborted after request
    if (abortSignal?.aborted) {
      throw new Error("Request cancelled");
    }

    return response.response || "No explanation available.";
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error; // Re-throw abort errors
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return `Error: ${errorMessage}`;
  }
}

// Function to update decorations for the current line
async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }

  const position = editor.selection.active;
  const currentLine = editor.document.lineAt(position.line);
  const lineText = currentLine.text.trim();

  // Clear previous decorations
  editor.setDecorations(decorationType, []);

  // Don't show decoration for empty lines or lines with 3 or fewer characters
  if (!lineText || lineText.length <= 3) {
    return;
  }

  // Create cache key
  const cacheKey = `${editor.document.uri.toString()}:${position.line}:${lineText}`;

  // Check cache first
  if (explanationCache.has(cacheKey)) {
    const cached = explanationCache.get(cacheKey)!;
    showDecoration(editor, position.line, cached.kaomoji, cached.explanation);
    return;
  }

  // Cancel previous request if any
  if (currentAbortController) {
    currentAbortController.abort();
  }

  // Clear previous debounce timers
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
  }

  // Create new abort controller for this request
  const abortController = new AbortController();
  currentAbortController = abortController;

  // Show thinking decoration after a short delay (300ms) - only if still on same line
  thinkingTimer = setTimeout(() => {
    const thinkingKaomoji = getRandomThinkingKaomoji();
    showDecoration(editor, position.line, thinkingKaomoji, "thinking...");
  }, 300);

  // Set up debounce timer (1 second) for actual API call
  debounceTimer = setTimeout(async () => {
    try {
      // Generate new kaomoji and get explanation
      const kaomoji = getRandomKaomoji();
      const config = vscode.workspace.getConfiguration("askii");
      const useCopilot = config.get<boolean>("useCopilot") || false;

      const explanation = useCopilot
        ? await getCopilotExplanation(lineText, abortController.signal)
        : await getOllamaExplanation(lineText, abortController.signal);

      // Only update if this request wasn't aborted
      if (!abortController.signal.aborted) {
        // Cache the result
        explanationCache.set(cacheKey, { kaomoji, explanation });

        // Update decoration with actual result
        showDecoration(editor, position.line, kaomoji, explanation);
      }
    } catch (error) {
      // Silently ignore aborted requests
      if (error instanceof Error && error.message !== "Request cancelled") {
        console.error("Error getting explanation:", error);
      }
    }
  }, 1000);
}

// Helper function to show decoration
function showDecoration(
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

  // Truncate text if too long for inline display
  const maxLength = 100;
  const isTruncated = text.length > maxLength;
  const displayText = isTruncated ? text.substring(0, maxLength) + "..." : text;
  const isThinking = text === "thinking...";

  const decoration: any = {
    range: range,
    renderOptions: {
      after: {
        contentText: ` ${kaomoji} ${displayText}`,
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
      },
    },
  };

  // Only add hover message if text was truncated and not thinking
  if (isTruncated && !isThinking) {
    decoration.hoverMessage = new vscode.MarkdownString(
      `${kaomoji} **ASKII Says:**\n\n${text}`,
    );
  }

  editor.setDecorations(decorationType, [decoration]);
}

// Hover provider to show full explanation on hover
class AskiiHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = position.line;
    const lineText = document.lineAt(line).text.trim();

    if (!lineText) {
      return null;
    }

    // Check cache for this line
    const cacheKey = `${document.uri.toString()}:${line}:${lineText}`;
    if (explanationCache.has(cacheKey)) {
      const cached = explanationCache.get(cacheKey)!;
      const maxLength = 100;

      // Only show hover if text was truncated and not thinking
      if (
        cached.explanation.length > maxLength &&
        cached.explanation !== "thinking..."
      ) {
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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "askii" is now active!');

  // Create decoration type with higher priority (rangeBehavior 1 = ClosedClosed for higher priority)
  decorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: "0 0 0 2em",
    },
  });

  // Register hover provider for all languages
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "*", language: "*" },
      new AskiiHoverProvider(),
    ),
  );

  // Register clear cache command
  const clearCacheCommand = vscode.commands.registerCommand(
    "askii.clearCache",
    () => {
      explanationCache.clear();
      vscode.window.showInformationMessage(
        "ASKII cache cleared! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
      );
      // Refresh current line decoration
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
      }
    },
  );
  context.subscriptions.push(clearCacheCommand);

  // Update decorations when cursor position changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      await updateDecorations(event.textEditor);
    }),
  );

  // Update decorations when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      await updateDecorations(editor);
    }),
  );

  // Update decorations when document changes (clear cache for changed lines)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        // Clear cache for changed lines
        const uri = event.document.uri.toString();
        for (const key of explanationCache.keys()) {
          if (key.startsWith(uri)) {
            explanationCache.delete(key);
          }
        }
      }
    }),
  );

  // Initial decoration for active editor
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(decorationType);
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Clear timers and abort controllers
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
