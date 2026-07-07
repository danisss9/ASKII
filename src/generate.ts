import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { getExtensionChatStreaming } from './providers';
import {
  getWorkspaceStructure,
  parseWorkspaceActions,
  sandboxPath,
  executeViewAction,
  executeSearchAction,
  buildGenerateSystemPrompt,
  writeBackup,
  recordCreatedFile,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
  type WorkspaceAction,
  type ActionResult,
} from '@common/workspace';
import { type ChatMessage } from '@common/providers';
import { unescapeJsonString } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { loadWikiIndex, searchWiki } from '@common/wiki';

// Cap the active document text we send as context to avoid blowing up the
// prompt — consistent with MAX_DIFF_CHARS in src/commitMessage.ts.
const MAX_TAB_CHARS = 8_000;

type GenerateType = 'Test' | 'Doc' | 'Json';

function defaultBaseName(fileType: GenerateType, activeFile?: string): string {
  if (!activeFile) return 'generated';
  const base = path.basename(activeFile, path.extname(activeFile));
  if (fileType === 'Test') return `${base}.test`;
  if (fileType === 'Doc') return base;
  return base; // Json — agent decides extension
}

function getWikiContext(query: string): string {
  const config = vscode.workspace.getConfiguration('askii');
  if (!(config.get<boolean>('wikiEnabled') ?? false)) return '';
  const wikiPath = config.get<string>('wikiPath') ?? '';
  if (!wikiPath) return '';
  const index = loadWikiIndex(wikiPath);
  if (!index) return '';
  return searchWiki(query, index);
}

export async function askiiGenerateCommand() {
  // ── Step 1: pick file type ────────────────────────────────────────────────
  const typePick = await vscode.window.showQuickPick(
    [
      { label: 'Test', description: 'Generate a test file' },
      { label: 'Doc', description: 'Generate a Markdown documentation file' },
      { label: 'Json', description: 'Generate a JSON file (schema/config/fixture)' },
    ],
    { placeHolder: 'What do you want to generate?' },
  );
  if (!typePick) return;
  const fileType = typePick.label as GenerateType;

  // ── Step 2: base name ─────────────────────────────────────────────────────
  const editor = vscode.window.activeTextEditor;
  const activeFile = editor ? path.basename(editor.document.fileName) : undefined;
  const defaultName = defaultBaseName(fileType, activeFile);

  const baseName = await vscode.window.showInputBox({
    prompt: `Base name for the ${fileType} file (agent decides path & extension)`,
    value: defaultName,
    placeHolder: 'e.g. myComponent',
  });
  if (!baseName) return;

  // ── Step 3: workspace + config ────────────────────────────────────────────
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace found');
    return;
  }
  const rootPath = workspaceFolder.uri.fsPath;

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 5;
  const formatAfterEdit = config.get<boolean>('formatAfterEdit') ?? false;
  const wikiPath = config.get<string>('wikiPath') ?? '';
  const wikiEnabled = config.get<boolean>('wikiEnabled') ?? false;
  const wikiAvailable = !!(wikiEnabled && wikiPath && loadWikiIndex(wikiPath));

  // ── Step 4: gather initial context ───────────────────────────────────────
  const selectedText = editor ? editor.document.getText(editor.selection) : '';
  let currentTab = '';
  let currentTabInfo = '';
  if (editor) {
    const fullText = editor.document.getText();
    currentTab =
      fullText.length > MAX_TAB_CHARS
        ? fullText.substring(0, MAX_TAB_CHARS) + '\n…[truncated]'
        : fullText;
    currentTabInfo = `File: ${path.basename(editor.document.fileName)} (language: ${editor.document.languageId})`;
  }

  const wikiContext = getWikiContext(`${fileType} ${baseName} ${selectedText}`);

  // ── Step 5: prepare agent loop ────────────────────────────────────────────
  deleteAllBackups(rootPath);

  const channel = vscode.window.createOutputChannel('ASKII Generate');
  channel.show(true);
  channel.appendLine(`ASKII Generate started ${getRandomThinkingKaomoji()}`);
  channel.appendLine(`Type: ${fileType} | Base name: ${baseName}`);

  const abortController = new AbortController();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ASKII Generate', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        abortController.abort();
        channel.appendLine('Stopped by user.');
      });

      try {
        const workspaceStructure = getWorkspaceStructure(rootPath);
        const systemPrompt = buildGenerateSystemPrompt({
          fileType,
          baseName,
          workspaceStructure,
          wikiAvailable,
          currentTab: currentTabInfo + (currentTab ? `\n${currentTab}` : ''),
          selectedText,
        });

        const userRequestParts = [
          `Generate a ${fileType} file. Base name: "${baseName}".`,
          currentTabInfo ? `Current tab: ${currentTabInfo}` : '',
          selectedText ? `Selected text:\n\`\`\`\n${selectedText}\n\`\`\`` : '',
          wikiContext ? `Relevant wiki context:\n${wikiContext}` : '',
          'Inspect the workspace as needed, ask clarifications if required, then create the file.',
        ].filter(Boolean);

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userRequestParts.join('\n\n') },
        ];

        let roundCount = 0;
        let createdPath: string | undefined;

        while (roundCount < maxRounds && !abortController.signal.aborted) {
          channel.appendLine(`\n[Round ${roundCount + 1}/${maxRounds}]`);
          channel.append('AI: ');
          const responseText = await getExtensionChatStreaming(messages, (chunk) =>
            channel.append(chunk),
          );
          channel.appendLine('');
          messages.push({ role: 'assistant', content: responseText });

          const actions = parseWorkspaceActions(responseText);
          if (actions.length === 0) {
            channel.appendLine('No actions returned. Done.');
            break;
          }

          const readActions = actions.filter(
            (a) =>
              a.type === 'view' ||
              a.type === 'list' ||
              a.type === 'search' ||
              a.type === 'wiki_search',
          );
          const clarifyActions = actions.filter((a) => a.type === 'clarify');
          const writeActions = actions.filter((a) => a.type === 'create' || a.type === 'write');

          const feedbackParts: string[] = [];

          // ── Read actions (no confirmation) ──────────────────────────────────
          const viewResults: Record<string, string> = {};
          for (const action of readActions) {
            try {
              if (action.type === 'wiki_search') {
                const q = action.query ?? '';
                channel.appendLine(`Wiki search: "${q}"`);
                const wikiData = wikiPath ? loadWikiIndex(wikiPath) : null;
                viewResults[`wiki_search:${q}`] = wikiData
                  ? searchWiki(q, wikiData) || 'No wiki results found'
                  : 'Wiki not available — set askii.wikiPath and run Reload Wiki';
              } else if (action.type === 'search') {
                channel.appendLine(`Search: "${action.pattern}"`);
                viewResults[`search:${action.pattern}`] = executeSearchAction(action, rootPath);
              } else if (action.type === 'view' && action.paths) {
                for (const p of action.paths) {
                  channel.appendLine(`Viewing: ${p}`);
                  try {
                    viewResults[p] = executeViewAction(
                      { ...action, path: p, paths: undefined },
                      rootPath,
                    );
                  } catch (e) {
                    viewResults[p] = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
                  }
                }
              } else {
                channel.appendLine(
                  `${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`,
                );
                viewResults[action.path!] = executeViewAction(action, rootPath);
              }
            } catch (e) {
              viewResults[action.path ?? 'unknown'] =
                `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
            }
          }
          if (Object.keys(viewResults).length > 0) {
            feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
          }

          // ── Clarify actions (prompt the user) ───────────────────────────────
          if (clarifyActions.length > 0) {
            const answers: string[] = [];
            for (const action of clarifyActions) {
              const q = action.question ?? 'Please clarify';
              channel.appendLine(`Clarify: ${q}`);
              const answer = await vscode.window.showInputBox({
                prompt: `ASKII asks: ${q}`,
                placeHolder: 'Type your answer (Esc to skip)',
              });
              const a = answer && answer.trim() ? answer.trim() : '(no answer)';
              answers.push(`Q: ${q}\nA: ${a}`);
            }
            feedbackParts.push(`Clarification answers:\n${answers.join('\n\n')}`);
          }

          // ── Write action (create the file directly) ─────────────────────────
          const actionResults: ActionResult[] = [];
          for (const action of writeActions) {
            let filePath: string;
            try {
              filePath = sandboxPath(rootPath, action.path!);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Path error';
              channel.appendLine(`BLOCKED: ${msg}`);
              actionResults.push({
                action: `${action.type}:${action.path}`,
                status: 'error',
                detail: msg,
              });
              continue;
            }

            try {
              if (action.type === 'create') recordCreatedFile(rootPath, action.path!);
              const dir = path.dirname(filePath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const content = action.content ? unescapeJsonString(action.content) : '';
              fs.writeFileSync(filePath, content);
              if (formatAfterEdit) {
                try {
                  const uri = vscode.Uri.file(filePath);
                  const doc = await vscode.workspace.openTextDocument(uri);
                  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                    'vscode.executeFormatDocumentProvider',
                    doc.uri,
                    { tabSize: 2, insertSpaces: true },
                  );
                  if (edits && edits.length > 0) {
                    const we = new vscode.WorkspaceEdit();
                    we.set(doc.uri, edits);
                    await vscode.workspace.applyEdit(we);
                    await doc.save();
                  }
                } catch {
                  // formatting is best-effort
                }
              }
              createdPath = filePath;
              channel.appendLine(`✓ Created: ${action.path}`);
              actionResults.push({ action: `create:${action.path}`, status: 'ok' });
            } catch (e) {
              const detail = e instanceof Error ? e.message : 'Unknown error';
              channel.appendLine(`✗ Failed: ${detail}`);
              actionResults.push({
                action: `${action.type}:${action.path}`,
                status: 'error',
                detail,
              });
            }
          }
          if (actionResults.length > 0) {
            feedbackParts.push(`Action results: ${JSON.stringify(actionResults)}`);
          }

          if (writeActions.length > 0 && createdPath) {
            // File created — task complete.
            break;
          }

          if (feedbackParts.length === 0) break;

          messages.push({
            role: 'user',
            content:
              feedbackParts.join('\n\n') +
              '\n\nContinue. Use read/clarify actions to gather more context, then finish with a single create action, or respond with [] if done.',
          });

          roundCount++;
        }

        // ── Step 6: open the file + offer Undo ───────────────────────────────
        if (createdPath) {
          const doc = await vscode.workspace.openTextDocument(createdPath);
          await vscode.window.showTextDocument(doc);
          channel.appendLine(
            `\nGenerated ${path.relative(rootPath, createdPath)}! ${getRandomKaomoji()}`,
          );
        } else {
          channel.appendLine('\nNo file was generated.');
        }

        if (hasBackups(rootPath)) {
          const choice = await vscode.window.showInformationMessage(
            `ASKII Generate: ${createdPath ? 'file created.' : 'No file created.'}`,
            'Undo',
          );
          if (choice === 'Undo') {
            const { restored, deleted } = restoreAllBackups(rootPath);
            deleteAllBackups(rootPath);
            channel.appendLine(
              `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
            );
            vscode.window.showInformationMessage(
              `ASKII Generate: Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
            );
          } else {
            deleteAllBackups(rootPath);
          }
        } else if (createdPath) {
          vscode.window.showInformationMessage(
            `ASKII Generate: Created ${path.relative(rootPath, createdPath)}.`,
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        channel.appendLine(`\nError: ${errorMsg}`);
        vscode.window.showErrorMessage(`ASKII Generate failed: ${errorMsg}`);
      }
    },
  );
}
