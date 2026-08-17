import { registerPlugin } from '@capacitor/core';

/**
 * AskiiBrowser — drives an in-app Android WebView: navigation, CSS-selector
 * clicks/types, scrolling, and per-step screenshots for the browser agent.
 *
 * The TS interface the Angular `BrowserModeService` calls. The native Kotlin
 * implementation lands in a later phase; a stub web implementation lets the
 * type check pass and surfaces a clear "not available" message on web.
 */

export interface BrowserExecuteOptions {
  action:
    | 'goto'
    | 'click'
    | 'type'
    | 'wait_for'
    | 'back'
    | 'forward'
    | 'scroll'
    | 'click_text'
    | 'DONE';
  url?: string;
  selector?: string;
  text?: string;
  direction?: 'up' | 'down';
  amount?: number;
}

export interface BrowserScreenshot {
  /** PNG data URL of the current page. */
  dataUrl: string;
  /** The URL the WebView is currently showing. */
  url: string;
  width: number;
  height: number;
}

export interface AskiiBrowserPlugin {
  /** Apply a single agent action to the embedded WebView. */
  execute(opts: BrowserExecuteOptions): Promise<void>;
  /** Capture the current page. */
  screenshot(): Promise<BrowserScreenshot>;
  /** Reset the WebView to about:blank. */
  reset(): Promise<void>;
}

export const AskiiBrowser = registerPlugin<AskiiBrowserPlugin>('AskiiBrowser', {
  web: async () => {
    const { AskiiBrowserWeb } = await import('./askii-browser.web');
    return new AskiiBrowserWeb();
  },
});