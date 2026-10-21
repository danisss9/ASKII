import * as vscode from 'vscode';
import { mediaRoot } from './webviewAssets';
import { randomBytes } from 'crypto';
import type { ReviewProblem } from '@common/codeReview';
import { getCodeReviewPanelHtml } from './codeReviewPanelHtml';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';

export type ReviewStatus = 'running' | 'done' | 'cancelled' | 'error';

interface ProblemState extends ReviewProblem {
  status: 'open' | 'fixing' | 'fixed';
  fixedBy?: 'auto' | 'manual';
  error?: string;
}

interface PanelState {
  status: ReviewStatus;
  message?: string;
  thinking?: string;
  repoName: string;
  fileCount: number;
  problems: ProblemState[];
}

/** Actions the panel delegates back to the review command module. */
export interface ReviewPanelHandlers {
  /** Stops the running review (Stop button or the panel being closed). */
  cancel(): void;
  /** Starts a fresh review of the same repository. */
  rerun(): void;
  /** Applies a model-generated fix; throws with a user-facing message on failure. */
  autoFix(problem: ReviewProblem, signal: AbortSignal): Promise<void>;
  /** Opens the problem's file at its line. */
  open(problem: ReviewProblem): Promise<void>;
}

// ── Single-instance panel ────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;
let handlers: ReviewPanelHandlers | undefined;
let state: PanelState = { status: 'done', repoName: '', fileCount: 0, problems: [] };
// In-flight auto fixes by problem id — aborted when the panel closes or a new
// review replaces the list.
const fixControllers = new Map<string, AbortController>();

function postState(): void {
  void currentPanel?.webview.postMessage({ type: 'state', state });
}

function abortFixes(): void {
  for (const controller of fixControllers.values()) {
    controller.abort();
  }
  fixControllers.clear();
}

function ensurePanel(): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'askiiCodeReview',
    'ASKII Code Review',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot()] },
  );
  currentPanel = panel;
  const nonce = randomBytes(16).toString('base64');
  panel.webview.html = getCodeReviewPanelHtml(panel.webview, nonce, getRandomKaomoji());
  panel.webview.onDidReceiveMessage((message: unknown) => handleMessage(panel, message));
  panel.onDidDispose(() => {
    if (currentPanel !== panel) {
      return;
    }
    currentPanel = undefined;
    abortFixes();
    if (state.status === 'running') {
      handlers?.cancel();
    }
  });
}

/** Opens (or reveals) the panel in its "Reviewing…" state for a new review. */
export function beginReviewPanel(
  info: { repoName: string; fileCount: number },
  reviewHandlers: ReviewPanelHandlers,
): void {
  abortFixes();
  handlers = reviewHandlers;
  state = {
    status: 'running',
    thinking: getRandomThinkingKaomoji(),
    repoName: info.repoName,
    fileCount: info.fileCount,
    problems: [],
  };
  ensurePanel();
  postState();
}

/** Shows the review's final outcome in the panel (no-op once it was closed). */
export function finishReviewPanel(
  status: Exclude<ReviewStatus, 'running'>,
  result: { problems?: ReviewProblem[]; message?: string } = {},
): void {
  state = {
    ...state,
    status,
    message: result.message,
    problems: (result.problems ?? []).map((p) => ({ ...p, status: 'open' })),
  };
  postState();
}

/** Brings the panel to the front, if open. */
export function revealReviewPanel(): void {
  currentPanel?.reveal(vscode.ViewColumn.Active, false);
}

async function runAutoFix(problem: ProblemState): Promise<void> {
  if (!handlers || problem.status !== 'open') {
    return;
  }
  const controller = new AbortController();
  fixControllers.set(problem.id, controller);
  problem.status = 'fixing';
  problem.error = undefined;
  postState();
  try {
    await handlers.autoFix(problem, controller.signal);
    if (!controller.signal.aborted) {
      problem.status = 'fixed';
      problem.fixedBy = 'auto';
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      problem.status = 'open';
      problem.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (fixControllers.get(problem.id) === controller) {
      fixControllers.delete(problem.id);
    }
    postState();
  }
}

function handleMessage(panel: vscode.WebviewPanel, raw: unknown): void {
  if (currentPanel !== panel || typeof raw !== 'object' || raw === null) {
    return;
  }
  const message = raw as { type?: unknown; id?: unknown };
  const problem = state.problems.find((p) => p.id === message.id);

  switch (message.type) {
    case 'ready':
      postState();
      break;
    case 'cancel':
      handlers?.cancel();
      break;
    case 'rerun':
      if (state.status !== 'running') {
        handlers?.rerun();
      }
      break;
    case 'openFile':
      if (problem && handlers) {
        handlers.open(problem).catch((error) => {
          const text = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`ASKII: Could not open ${problem.file}: ${text}`);
        });
      }
      break;
    case 'autoFix':
      if (problem) {
        void runAutoFix(problem);
      }
      break;
    case 'cancelFix':
      if (problem && problem.status === 'fixing') {
        fixControllers.get(problem.id)?.abort();
        fixControllers.delete(problem.id);
        problem.status = 'open';
        postState();
      }
      break;
    case 'markFixed':
      if (problem && problem.status === 'open') {
        problem.status = 'fixed';
        problem.fixedBy = 'manual';
        problem.error = undefined;
        postState();
      }
      break;
    case 'reopen':
      if (problem && problem.status === 'fixed') {
        problem.status = 'open';
        problem.fixedBy = undefined;
        postState();
      }
      break;
  }
}
