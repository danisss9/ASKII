import { Injectable } from '@angular/core';
import { AskiiScreen, type ScreenAction, type ScreenScreenshot } from '../plugins/askii-screen.plugin';
import {
  buildControlSystemPrompt,
  parseControlResponse,
  describeAction,
  getActionDelay,
  type ControlAction,
  type ControlResponse,
  type SystemInfo,
} from '@shared/control';
import { ConfigService } from './config.service';
import { LlmService } from './llm.service';

/** Events emitted by the screen-control agent loop. */
export type ControlEvent =
  | { type: 'round'; round: number; maxRounds: number }
  | { type: 'screenshot'; dataUrl: string; width: number; height: number }
  | { type: 'action'; actionId: string; action: ControlAction; description: string }
  | { type: 'status'; status: 'thinking' | 'executing' | 'done' | 'error'; detail?: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

/**
 * ControlModeService — runs the screen-control agent on Android.
 *
 * Each round: screenshot → LLM (with vision) → parse → dispatch gesture/key →
 * settle. Uses `MediaProjection` for screenshots and `AccessibilityService`
 * for gesture dispatch via the `AskiiScreen` Capacitor plugin.
 *
 * The user must grant both screen-capture and accessibility permissions on
 * first use (via `AskiiScreen.requestPermissions()`).
 */
@Injectable({ providedIn: 'root' })
export class ControlModeService {
  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  /** Ensure permissions are granted. Returns true if both are available. */
  async ensurePermissions(): Promise<{ screenCapture: boolean; accessibility: boolean }> {
    try {
      return await AskiiScreen.requestPermissions();
    } catch {
      return { screenCapture: false, accessibility: false };
    }
  }

  async *run(task: string, maxRounds = 5, signal?: AbortSignal): AsyncGenerator<ControlEvent, void, unknown> {
    // Ensure permissions
    const perms = await this.ensurePermissions();
    if (!perms.screenCapture) {
      yield { type: 'error', message: 'Screen capture permission not granted. Tap "Request Permissions" in Settings.' };
      return;
    }
    if (!perms.accessibility) {
      yield { type: 'error', message: 'Accessibility service not enabled. Open Settings → Accessibility → ASKII to enable it.' };
      return;
    }

    const systemInfo: SystemInfo = {
      os: 'Android',
      currentTime: new Date().toLocaleString(),
    };

    try {
      for (let round = 0; round < maxRounds; round++) {
        if (signal?.aborted) break;

        yield { type: 'round', round: round + 1, maxRounds };

        // Capture the current screen
        let screenshot: ScreenScreenshot;
        try {
          screenshot = await AskiiScreen.screenshot();
        } catch (err) {
          yield { type: 'error', message: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
          break;
        }
        yield { type: 'screenshot', dataUrl: screenshot.dataUrl, width: screenshot.width, height: screenshot.height };

        // Ask the LLM for the next action(s)
        const prompt =
          round === 0
            ? `Instruction to complete: ${task}\n\nAnalyze the screenshot and determine the next action(s).`
            : `Continuing instruction: ${task}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;

        yield { type: 'status', status: 'thinking' };

        let response: string;
        try {
          const base64 = screenshot.dataUrl.split(',')[1] ?? '';
          response = await this.llm.completeWithImage(
            this.config.current,
            buildControlSystemPrompt(screenshot.width, screenshot.height, systemInfo),
            prompt,
            base64,
            signal,
          );
        } catch (err) {
          yield { type: 'error', message: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` };
          break;
        }

        const parsed: ControlResponse | null = parseControlResponse(response);
        if (!parsed) {
          yield { type: 'error', message: `Could not parse AI response: ${response.slice(0, 200)}` };
          break;
        }

        if (parsed.type === 'done') {
          yield { type: 'done', summary: parsed.reasoning };
          break;
        }

        // Execute each action in the sequence
        for (const action of parsed.actions) {
          if (signal?.aborted) break;

          const actionId = `control_r${round}_${action.action}`;
          const desc = describeAction(action as ControlAction);
          yield { type: 'action', actionId, action: action as ControlAction, description: desc };

          yield { type: 'status', status: 'executing' };
          try {
            await AskiiScreen.execute(action as ScreenAction);
          } catch (err) {
            yield { type: 'error', message: `Action failed: ${err instanceof Error ? err.message : String(err)}` };
          }

          // Wait for the screen to settle before the next action
          const delay = getActionDelay(action as ControlAction);
          if (delay > 0) await sleep(delay, signal);
        }
      }

      yield { type: 'status', status: 'done' };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}