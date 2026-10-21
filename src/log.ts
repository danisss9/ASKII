import * as vscode from 'vscode';

// One "ASKII" log channel (Output panel → ASKII) for diagnostics that used to
// go to console.error, where only the extension-host dev tools could see them.
let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('ASKII', { log: true });
  context.subscriptions.push(channel);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export const log = {
  info(message: string): void {
    channel?.info(message);
  },
  warn(message: string): void {
    if (channel) {
      channel.warn(message);
    } else {
      console.warn(`[askii] ${message}`);
    }
  },
  error(message: string, error?: unknown): void {
    const text = error === undefined ? message : `${message}: ${describe(error)}`;
    if (channel) {
      channel.error(text);
    } else {
      console.error(`[askii] ${text}`);
    }
  },
  show(): void {
    channel?.show(true);
  },
};
