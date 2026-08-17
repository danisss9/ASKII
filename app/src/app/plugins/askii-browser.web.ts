import type { AskiiBrowserPlugin, BrowserExecuteOptions, BrowserScreenshot } from './askii-browser.plugin';

/** Web fallback — the browser agent needs a native WebView; not available in a browser. */
export class AskiiBrowserWeb implements AskiiBrowserPlugin {
  async execute(_opts: BrowserExecuteOptions): Promise<void> {
    throw new Error('AskiiBrowser requires the Android native plugin (not available on web).');
  }
  async screenshot(): Promise<BrowserScreenshot> {
    throw new Error('AskiiBrowser requires the Android native plugin (not available on web).');
  }
  async reset(): Promise<void> {
    /* no-op */
  }
}