import * as vscode from 'vscode';

/**
 * True when a document matches askii.inlineExcludeGlobs — inline completion
 * and inline explanations never send such files (secrets, keys, credentials)
 * to the model.
 */
export function isExcludedFromInline(document: vscode.TextDocument): boolean {
  const globs = vscode.workspace.getConfiguration('askii').get<string[]>('inlineExcludeGlobs') ?? [];
  return globs.some(
    (pattern) =>
      typeof pattern === 'string' &&
      pattern.trim() !== '' &&
      vscode.languages.match({ pattern }, document) > 0,
  );
}
