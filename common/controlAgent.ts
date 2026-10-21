// The ASKII Control loops (screen and browser), shared by the extension and
// the CLI. Like the Do agent, callers own the UI and the model call; this
// module owns the rounds: screenshot, ask the model, validate its actions,
// confirm, execute, and keep the history the next prompt is built from.

import type { Page } from 'puppeteer-core';
import {
  buildControlSystemPrompt,
  describeAction,
  executeControlAction,
  getSystemInfo,
  parseControlResponse,
  refineCoordinates,
  takeScreenshot,
  type ControlAction,
  type ControlHistoryEntry,
  type SystemInfo,
} from './control';
import {
  buildBrowserSystemPrompt,
  describeBrowserAction,
  executeBrowserAction,
  parseBrowserResponse,
  takePageScreenshot,
} from './browser';
import { parseJsonFromModel } from './utils';

export type ControlEvent =
  | { type: 'round-start'; id: number; round: number; maxRounds: number }
  /** The round's screenshot (base64 PNG) plus a note: the page URL, or a warning. */
  | { type: 'screenshot'; id: number; image: string; note?: string }
  | { type: 'round-end'; id: number }
  | { type: 'parse-error'; raw: string }
  | { type: 'done'; reasoning: string }
  | { type: 'action-planned'; id: number; label: string; reasoning: string }
  | {
      type: 'action-update';
      id: number;
      status?: 'ok' | 'error' | 'skipped';
      label?: string;
      detail?: string;
    }
  | { type: 'notice'; message: string; level: 'info' | 'warning' }
  | { type: 'max-rounds'; maxRounds: number };

export type ControlOutcome = 'complete' | 'max-rounds' | 'aborted' | 'stopped' | 'parse-error';

export interface ControlAgentResult {
  outcome: ControlOutcome;
  rounds: number;
}

/** Vision model call: system prompt ('' for none), user prompt, base64 PNG. */
export type VisionAsk = (
  system: string,
  prompt: string,
  imageBase64: string,
  signal: AbortSignal,
) => Promise<string>;

interface AgentBase {
  task: string;
  maxRounds: number;
  signal: AbortSignal;
  autoConfirm: boolean;
  ask: VisionAsk;
  /** Asks before running; `id` is the action-planned event the question belongs to. */
  confirm: (request: { id: number; message: string }) => Promise<boolean>;
  emit: (event: ControlEvent) => void;
}

/** State kept across follow-up tasks in one session. */
export interface ScreenSession {
  history: ControlHistoryEntry[];
  systemInfo?: SystemInfo;
  prevScreenshot?: string;
}

export interface ScreenAgentOptions extends AgentBase {
  monitorId?: string | number;
  session: ScreenSession;
  /** Refine a single click's coordinates with a zoomed-in second look. */
  refineClicks?: boolean;
  /** Pause after the user confirms, so focus can return to the target window. */
  afterConfirmDelayMs?: number;
  /** Replaces the real screen I/O (tests). */
  io?: {
    takeScreenshot: typeof takeScreenshot;
    getSystemInfo: typeof getSystemInfo;
    executeControlAction: typeof executeControlAction;
  };
}

export interface BrowserAgentOptions extends AgentBase {
  page: Page;
}

const ZOOM_ACTIONS = new Set(['mouse_left_click', 'mouse_right_click', 'mouse_double_click']);

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Asks the vision model where the element labeled `text` is. */
async function locateText(
  text: string,
  imageBase64: string,
  ask: VisionAsk,
  signal: AbortSignal,
): Promise<{ x: number; y: number } | undefined> {
  const prompt = `Find the EXACT pixel coordinates of the UI element whose visible text is "${text}". Return ONLY valid JSON: {"x": number, "y": number}`;
  const raw = await ask('', prompt, imageBase64, signal);
  return parseJsonFromModel(
    raw,
    (v) =>
      !!v &&
      typeof (v as { x?: unknown }).x === 'number' &&
      typeof (v as { y?: unknown }).y === 'number',
    '{',
  ) as { x: number; y: number } | undefined;
}

/** Screen control: drives the mouse and keyboard from screenshots. */
export async function runScreenAgent(options: ScreenAgentOptions): Promise<ControlAgentResult> {
  const { task, maxRounds, signal, session, emit } = options;
  const io = options.io ?? { takeScreenshot, getSystemInfo, executeControlAction };
  let nextId = 1;
  // History entries of the previous round — the next screenshot tells whether they changed anything
  let lastRoundEntries: ControlHistoryEntry[] = [];

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) {
      return { outcome: 'aborted', rounds: round };
    }
    const roundId = nextId++;
    emit({ type: 'round-start', id: roundId, round: round + 1, maxRounds });

    const shot = await io.takeScreenshot(options.monitorId);
    session.systemInfo ??= await io.getSystemInfo(shot.physWidth, shot.physHeight);
    const screenChanged = session.prevScreenshot === undefined || session.prevScreenshot !== shot.base64;
    for (const entry of lastRoundEntries) {
      entry.screenChanged = screenChanged;
    }
    session.prevScreenshot = shot.base64;
    emit({
      type: 'screenshot',
      id: roundId,
      image: shot.base64,
      note: screenChanged ? undefined : 'Screen unchanged since last action.',
    });

    const prompt =
      round === 0
        ? `Instruction to complete: ${task}\n\nAnalyze the screenshot and determine the next action(s).`
        : `Continuing instruction: ${task}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;
    const raw = await options.ask(
      buildControlSystemPrompt(shot.width, shot.height, session.systemInfo, session.history),
      prompt,
      shot.base64,
      signal,
    );
    if (signal.aborted) {
      return { outcome: 'aborted', rounds: round };
    }
    emit({ type: 'round-end', id: roundId });

    const parsed = parseControlResponse(raw);
    if (!parsed) {
      emit({ type: 'parse-error', raw });
      return { outcome: 'parse-error', rounds: round };
    }
    if (parsed.type === 'done') {
      emit({ type: 'done', reasoning: parsed.reasoning });
      return { outcome: 'complete', rounds: round };
    }

    const actions = parsed.actions as ControlAction[];
    const ids = actions.map((a) => {
      const id = nextId++;
      emit({ type: 'action-planned', id, label: describeAction(a), reasoning: a.reasoning });
      return id;
    });

    // Two-phase zoom: refine the coordinates of a single position-based click
    if (options.refineClicks && actions.length === 1 && ZOOM_ACTIONS.has(actions[0].action)) {
      const a = actions[0] as ControlAction & { x: number; y: number };
      try {
        const refined = await refineCoordinates(
          Buffer.from(shot.base64, 'base64'),
          a.x,
          a.y,
          shot.width,
          shot.height,
          a,
          (sys, img) => options.ask('', sys, img, signal),
        );
        if (refined) {
          const detail = `Zoom: (${a.x}, ${a.y}) → (${refined.x}, ${refined.y})`;
          a.x = refined.x;
          a.y = refined.y;
          emit({ type: 'action-update', id: ids[0], label: describeAction(a), detail });
        }
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        // zoom failed — keep the original coordinates
      }
    }

    // Locate click_text targets before asking, so the user approves the actual click position
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.action !== 'click_text') {
        continue;
      }
      let coords: { x: number; y: number } | undefined;
      try {
        coords = await locateText(a.text, shot.base64, options.ask, signal);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
      }
      if (coords) {
        const click: ControlAction = {
          action: 'mouse_left_click',
          x: coords.x,
          y: coords.y,
          reasoning: a.reasoning,
        };
        actions[i] = click;
        emit({
          type: 'action-update',
          id: ids[i],
          label: describeAction(click),
          detail: `Resolved "${a.text}" → (${coords.x}, ${coords.y})`,
        });
      } else {
        emit({
          type: 'notice',
          level: 'warning',
          message: `Could not resolve "${a.text}" to coordinates`,
        });
      }
    }

    if (!options.autoConfirm) {
      const message =
        actions.length === 1 ? `Execute ${describeAction(actions[0])}?` : `Execute ${actions.length} actions?`;
      const ok = await options.confirm({ id: ids[ids.length - 1], message });
      if (!ok || signal.aborted) {
        for (const id of ids) {
          emit({ type: 'action-update', id, status: 'skipped' });
        }
        return { outcome: signal.aborted ? 'aborted' : 'stopped', rounds: round };
      }
      await wait(options.afterConfirmDelayMs ?? 0, signal);
    }

    lastRoundEntries = [];
    for (let i = 0; i < actions.length; i++) {
      if (signal.aborted) {
        return { outcome: 'aborted', rounds: round + 1 };
      }
      await io.executeControlAction(actions[i], shot.width, shot.height, signal);
      const entry: ControlHistoryEntry = {
        round: round + 1,
        description: describeAction(actions[i]),
        reasoning: actions[i].reasoning,
        screenChanged: true,
      };
      session.history.push(entry);
      lastRoundEntries.push(entry);
      emit({ type: 'action-update', id: ids[i], status: 'ok' });
    }
  }

  emit({ type: 'max-rounds', maxRounds });
  return { outcome: 'max-rounds', rounds: maxRounds };
}

/** Browser control: drives a Puppeteer page from screenshots. */
export async function runBrowserAgent(options: BrowserAgentOptions): Promise<ControlAgentResult> {
  const { task, maxRounds, signal, page, emit } = options;
  let nextId = 1;

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) {
      return { outcome: 'aborted', rounds: round };
    }
    const roundId = nextId++;
    emit({ type: 'round-start', id: roundId, round: round + 1, maxRounds });

    const image = await takePageScreenshot(page);
    const currentUrl = page.url();
    emit({ type: 'screenshot', id: roundId, image, note: currentUrl });

    const prompt =
      round === 0
        ? `Task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and determine the next action.`
        : `Continuing task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and return the next action or DONE.`;
    const raw = await options.ask(buildBrowserSystemPrompt(), prompt, image, signal);
    if (signal.aborted) {
      return { outcome: 'aborted', rounds: round };
    }
    emit({ type: 'round-end', id: roundId });

    const parsed = parseBrowserResponse(raw);
    if (!parsed) {
      emit({ type: 'parse-error', raw });
      return { outcome: 'parse-error', rounds: round };
    }
    if (parsed.type === 'done') {
      emit({ type: 'done', reasoning: parsed.reasoning });
      return { outcome: 'complete', rounds: round };
    }

    for (const action of parsed.actions) {
      if (signal.aborted) {
        return { outcome: 'aborted', rounds: round };
      }
      const id = nextId++;
      const label = describeBrowserAction(action);
      emit({ type: 'action-planned', id, label, reasoning: action.reasoning });

      if (!options.autoConfirm) {
        const ok = await options.confirm({ id, message: `Execute ${label}?` });
        if (!ok || signal.aborted) {
          emit({ type: 'action-update', id, status: 'skipped' });
          return { outcome: signal.aborted ? 'aborted' : 'stopped', rounds: round };
        }
      }

      try {
        await executeBrowserAction(action, page);
        emit({ type: 'action-update', id, status: 'ok' });
      } catch (error) {
        // A failed step (missing selector, blocked URL) is reported and the
        // model sees the resulting page in the next round
        const message = error instanceof Error ? error.message : 'Unknown error';
        emit({
          type: 'action-update',
          id,
          status: 'error',
          detail: `${action.reasoning}\nFailed: ${message}`.trim(),
        });
      }
    }
  }

  emit({ type: 'max-rounds', maxRounds });
  return { outcome: 'max-rounds', rounds: maxRounds };
}
