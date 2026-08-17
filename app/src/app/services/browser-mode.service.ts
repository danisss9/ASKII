import { Injectable } from '@angular/core';
import { AskiiBrowser, type BrowserExecuteOptions, type BrowserScreenshot } from '../plugins/askii-browser.plugin';
import { buildBrowserSystemPrompt, parseBrowserAction, describeBrowserAction, type BrowserAction } from '@shared/browser';
import { ConfigService } from './config.service';
import { LlmService } from './llm.service';

/** Events emitted by the browser agent loop (consumed by chat UI + remoting). */
export type BrowserEvent =
  | { type: 'round'; round: number; maxRounds: number }
  | { type: 'screenshot'; dataUrl: string; url: string; width: number; height: number }
  | { type: 'action'; actionId: string; action: BrowserAction; description: string }
  | { type: 'status'; status: 'thinking' | 'executing' | 'done' | 'error'; detail?: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

/**
 * BrowserModeService — runs the in-app WebView browser agent.
 *
 * Each round: screenshot → LLM (with vision) → parse → execute → settle.
 * Yields events as an async generator so both the local chat UI and the
 * RemoteSessionService can consume them uniformly.
 */
@Injectable({ providedIn: 'root' })
export class BrowserModeService {
  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  async *run(task: string, maxRounds = 5, signal?: AbortSignal): AsyncGenerator<BrowserEvent, void, unknown> {
    await AskiiBrowser.reset();

    try {
      for (let round = 0; round < maxRounds; round++) {
        if (signal?.aborted) break;

        yield { type: 'round', round: round + 1, maxRounds };

        // Capture the current page state
        let screenshot: BrowserScreenshot;
        try {
          screenshot = await AskiiBrowser.screenshot();
        } catch (err) {
          yield { type: 'error', message: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
          break;
        }
        yield { type: 'screenshot', dataUrl: screenshot.dataUrl, url: screenshot.url, width: screenshot.width, height: screenshot.height };

        // Ask the LLM for the next action
        const prompt =
          round === 0
            ? `Task: ${task}\n\nCurrent URL: ${screenshot.url}\n\nAnalyze the screenshot and determine the next action.`
            : `Continuing task: ${task}\n\nCurrent URL: ${screenshot.url}\n\nAnalyze the screenshot and return the next action or DONE.`;

        yield { type: 'status', status: 'thinking' };

        let response: string;
        try {
          const base64 = screenshot.dataUrl.split(',')[1] ?? '';
          response = await this.llm.completeWithImage(
            this.config.current,
            buildBrowserSystemPrompt(),
            prompt,
            base64,
            signal,
          );
        } catch (err) {
          yield { type: 'error', message: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` };
          break;
        }

        const action = parseBrowserAction(response);
        if (!action) {
          yield { type: 'error', message: `Could not parse AI response: ${response.slice(0, 200)}` };
          break;
        }

        if (action.action === 'DONE') {
          yield { type: 'done', summary: action.reasoning };
          break;
        }

        const actionId = `browser_r${round}`;
        yield { type: 'action', actionId, action, description: describeBrowserAction(action) };

        // Execute the action
        yield { type: 'status', status: 'executing' };
        try {
          await AskiiBrowser.execute(action as BrowserExecuteOptions);
        } catch (err) {
          yield { type: 'error', message: `Action failed: ${err instanceof Error ? err.message : String(err)}` };
        }

        // Let the page settle before the next screenshot
        await sleep(1500, signal);
      }

      yield { type: 'status', status: 'done' };
    } finally {
      await AskiiBrowser.reset().catch(() => undefined);
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