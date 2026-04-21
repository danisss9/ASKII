import * as vscode from 'vscode';
import {
  initDecorationType,
  cleanupDecorations,
  updateDecorations,
  AskiiHoverProvider,
  explanationCache,
} from './decorations';
import {
  askAskiiCommand,
  askiiEditCommand,
  askiiDoCommand,
  askiiControlCommand,
  askiiBrowseCommand,
  askiiReloadWikiCommand,
  askiiDiffProvider,
} from './commands';
import { validateProviderConfig } from './providers';

export function activate(context: vscode.ExtensionContext) {
  // Register the in-memory content provider for diff previews
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('askii-diff', askiiDiffProvider),
  );

  // Auto-reload wiki on startup if configured
  const wikiConfig = vscode.workspace.getConfiguration('askii');
  if (
    (wikiConfig.get<boolean>('wikiEnabled') ?? false) &&
    (wikiConfig.get<boolean>('wikiAutoReload') ?? false)
  ) {
    askiiReloadWikiCommand();
  }
  const decorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: '0 0 0 2em',
    },
  });
  initDecorationType(decorationType);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: '*', language: '*' },
      new AskiiHoverProvider(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('askii.clearCache', () => {
      explanationCache.clear();
      vscode.window.showInformationMessage('ASKII cache cleared! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
      }
    }),
  );

  context.subscriptions.push(vscode.commands.registerCommand('askii.askQuestion', askAskiiCommand));
  context.subscriptions.push(vscode.commands.registerCommand('askii.editCode', askiiEditCommand));
  context.subscriptions.push(vscode.commands.registerCommand('askii.doTask', askiiDoCommand));
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.controlTask', askiiControlCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.browseTask', askiiBrowseCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.reloadWiki', askiiReloadWikiCommand),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '(⌐■_■)';
  statusBarItem.tooltip = 'Click for ASKII commands';
  statusBarItem.command = 'askii.showCommandMenu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('askii.showCommandMenu', async () => {
      const selected = await vscode.window.showQuickPick([
        { label: '$(comment) Ask ASKII', command: 'askii.askQuestion' },
        { label: '$(edit) ASKII Edit', command: 'askii.editCode' },
        { label: '$(files) ASKII Do', command: 'askii.doTask' },
        { label: '$(screen-full) ASKII Control', command: 'askii.controlTask' },
        { label: '$(browser) ASKII Browse', command: 'askii.browseTask' },
        { label: '$(book) Reload Wiki', command: 'askii.reloadWiki' },
        { label: '$(refresh) Clear Cache', command: 'askii.clearCache' },
      ]);

      if (selected) {
        vscode.commands.executeCommand(selected.command);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(
      async (event: vscode.TextEditorSelectionChangeEvent) => {
        await updateDecorations(event.textEditor);
      },
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor: vscode.TextEditor | undefined) => {
      await updateDecorations(editor);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        const uri = event.document.uri.toString();
        for (const key of explanationCache.keys()) {
          if (key.startsWith(uri)) {
            explanationCache.delete(key);
          }
        }
      }
    }),
  );

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  // Validate provider config at startup and re-validate on settings changes.
  function runValidation() {
    validateProviderConfig().then((problem) => {
      if (problem) {
        vscode.window.showWarningMessage(problem, 'Open Settings').then((choice) => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:danisss9.askii');
          }
        });
      }
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('askii')) {
        runValidation();
      }
    }),
  );

  context.subscriptions.push(decorationType);
}

export function deactivate() {
  cleanupDecorations();
}
