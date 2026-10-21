import * as vscode from 'vscode';
import {
  initDecorationType,
  cleanupDecorations,
  updateDecorations,
  AskiiHoverProvider,
  explanationCache,
} from './decorations';
import { askAskiiCommand } from './ask';
import { askiiEditCommand } from './edit';
import { askiiDoCommand } from './do';
import { askiiReloadWikiCommand } from './wikiReload';
import { askiiDiffProvider } from './diffProvider';
import { disposeAgentChannels } from './commandUtils';
import { validateProviderConfig } from './providers';
import {
  AskiiInlineCompletionProvider,
  INLINE_ACCEPT_COMMAND,
  completionCache,
} from './inlineCompletion';
import { cancelCommitMessageCommand, generateCommitMessageCommand } from './commitMessage';
import { cancelCodeReviewCommand, codeReviewCommand } from './codeReview';
import { askiiNoteCommand } from './notesPanel';
import { startNoteScheduler, stopNoteScheduler } from './notesScheduler';
import {
  clearApiKeyCommand,
  initializeProviderSecrets,
  migrateLegacyApiKeys,
} from './providerSecrets';
import { initLog } from './log';
import { openSetupPanel, shouldOpenSetupAutomatically } from './setupPanel';

export async function activate(context: vscode.ExtensionContext) {
  initLog(context);
  initializeProviderSecrets(context.secrets);
  const migrationProblems = await migrateLegacyApiKeys(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('askii.openSetup', () => openSetupPanel(context)),
    vscode.commands.registerCommand('askii.clearApiKey', clearApiKeyCommand),
  );

  if (migrationProblems.length > 0) {
    vscode.window
      .showWarningMessage(
        `ASKII could not securely migrate every legacy API key: ${migrationProblems.join('; ')}`,
        'Open Setup',
      )
      .then((choice) => {
        if (choice === 'Open Setup') {
          vscode.commands.executeCommand('askii.openSetup');
        }
      });
  }

  // Register the in-memory content provider for diff previews
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('askii-diff', askiiDiffProvider),
  );

  // Auto-reload enabled wikis on startup if configured
  const wikiConfig = vscode.workspace.getConfiguration('askii');
  const docsWikiReload =
    (wikiConfig.get<boolean>('wikiEnabled') ?? false) &&
    (wikiConfig.get<boolean>('wikiAutoReload') ?? false);
  const codeWikiReload =
    (wikiConfig.get<boolean>('codeWikiEnabled') ?? false) &&
    (wikiConfig.get<boolean>('codeWikiAutoReload') ?? false);
  // Restricted Mode: indexing writes into the workspace and downloads a model
  if ((docsWikiReload || codeWikiReload) && vscode.workspace.isTrusted) {
    void askiiReloadWikiCommand();
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

  const inlineProvider = new AskiiInlineCompletionProvider();
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.clearCache', () => {
      explanationCache.clear();
      inlineProvider.clearCache();
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
    // Loaded on first use: Control pulls in jimp, screenshot-desktop and Puppeteer
    vscode.commands.registerCommand('askii.controlTask', async () =>
      (await import('./control.js')).askiiControlCommand(),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.reloadWiki', askiiReloadWikiCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.generateCommitMessage', generateCommitMessageCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.cancelCommitMessage', cancelCommitMessageCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.codeReviewUncommitted', codeReviewCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.cancelCodeReview', cancelCodeReviewCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.noteTask', (args?: { selectId?: string }) =>
      askiiNoteCommand(context, args),
    ),
  );

  // Start the reminder scheduler for ASKII Note
  startNoteScheduler(context);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '(⌐■_■)';
  statusBarItem.tooltip = 'Click for ASKII commands';
  statusBarItem.command = 'askii.showCommandMenu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('askii.showCommandMenu', async () => {
      const selected = await vscode.window.showQuickPick([
        {
          label: '$(comment) Ask ASKII',
          description: 'Ask anything or about selection',
          command: 'askii.askQuestion',
        },
        {
          label: '$(edit) ASKII Edit',
          description: 'Edit code with AI',
          command: 'askii.editCode',
        },
        {
          label: '$(files) ASKII Do',
          description: 'Run multi-file tasks',
          command: 'askii.doTask',
        },
        {
          label: '$(screen-full) ASKII Control',
          description: 'Screen or browser',
          command: 'askii.controlTask',
        },
        {
          label: '$(note) ASKII Note',
          description: 'Notes & reminders',
          command: 'askii.noteTask',
        },
        {
          label: '$(book) Reload Wikis',
          description: 'Reindex enabled wikis (docs + code)',
          command: 'askii.reloadWiki',
        },
        {
          label: '$(refresh) Clear Cache',
          description: 'Reset explanation & completion caches',
          command: 'askii.clearCache',
        },
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
      // Explanations are keyed by line number, which edits shift. Completions
      // are keyed by a hash of the surrounding text, so they invalidate
      // themselves and stay reusable (e.g. after an undo).
      if (event.document === vscode.window.activeTextEditor?.document) {
        const prefix = `${event.document.uri.toString()}:`;
        for (const key of [...explanationCache.keys()]) {
          if (key.startsWith(prefix)) {
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
  // Debounced: the setup panel saves several settings one after another, and
  // validating between those writes reports half-saved configs as problems.
  let validationTimer: NodeJS.Timeout | undefined;
  function runValidation() {
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      validateProviderConfig().then((problem) => {
        if (problem) {
          vscode.window.showWarningMessage(problem, 'Open Setup').then((choice) => {
            if (choice === 'Open Setup') {
              vscode.commands.executeCommand('askii.openSetup');
            }
          });
        }
      });
    }, 750);
  }
  context.subscriptions.push({ dispose: () => clearTimeout(validationTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('askii')) {
        runValidation();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(INLINE_ACCEPT_COMMAND, (id: number) => {
      inlineProvider.notifyAccepted(id);
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      inlineProvider,
    ),
  );

  context.subscriptions.push(decorationType);

  if (await shouldOpenSetupAutomatically(context)) {
    await openSetupPanel(context);
  } else {
    // First-run setup walks through providers itself; otherwise check now
    runValidation();
  }
}

export function deactivate() {
  cleanupDecorations();
  disposeAgentChannels();
  completionCache.clear();
  stopNoteScheduler();
}
