import * as vscode from 'vscode';
import { hasWikiIndex, searchWiki } from '@common/wiki';
import { searchCodeWiki } from '@common/codewiki';
import { log } from './log';

// Helpers shared by the ASKII command modules (ask, edit, do, control, wiki).

export async function getWikiContext(query: string): Promise<string> {
  try {
    const config = vscode.workspace.getConfiguration('askii');
    if (!(config.get<boolean>('wikiEnabled') ?? false)) {return '';}
    const wikiPath = config.get<string>('wikiPath') ?? '';
    if (!wikiPath || !hasWikiIndex(wikiPath)) {return '';}
    return await searchWiki(wikiPath, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.warn(`[wiki] ${message}`);
    return '';
  }
}

export async function getCodeWikiContext(query: string): Promise<string> {
  try {
    const config = vscode.workspace.getConfiguration('askii');
    if (!(config.get<boolean>('codeWikiEnabled') ?? false)) {return '';}
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {return '';}
    return await searchCodeWiki(root, query);
  } catch (error) {
    // Retrieval must never break the command — log and continue without context
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.warn(`[code wiki] ${message}`);
    return '';
  }
}

// One output channel per agent, reused across runs (a new channel per run
// piled up in the Output panel and was never disposed).
const agentChannels = new Map<string, vscode.OutputChannel>();

export function getAgentChannel(name: string): vscode.OutputChannel {
  let channel = agentChannels.get(name);
  if (!channel) {
    channel = vscode.window.createOutputChannel(name);
    agentChannels.set(name, channel);
  }
  return channel;
}

export function disposeAgentChannels(): void {
  for (const channel of agentChannels.values()) {
    channel.dispose();
  }
  agentChannels.clear();
}

export async function applyFormat(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    doc.uri,
    { tabSize: 2, insertSpaces: true },
  );
  if (edits && edits.length > 0) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(workspaceEdit);
    await doc.save();
  }
}

// Timeline details are rendered as text — keep them readable, not exhaustive
export function timelineSnippet(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.substring(0, max)}…` : trimmed;
}
