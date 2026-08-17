import type { Page } from 'puppeteer-core';
import type { BrowserAction } from '@shared/browser';

// Pure types / prompt / parser / describer now live in @shared/browser so the
// Android app can import them without pulling puppeteer. Re-exported here for
// back-compat with existing @common/browser importers.
export {
  buildBrowserSystemPrompt,
  parseBrowserAction,
  describeBrowserAction,
  type BrowserAction,
} from '@shared/browser';

// === EXECUTE ===

// === EXECUTE ===

export async function executeBrowserAction(action: BrowserAction, page: Page): Promise<void> {
  switch (action.action) {
    case 'goto':
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    case 'click':
      await page.click(action.selector);
      break;
    case 'type':
      await page.click(action.selector, { clickCount: 3 }); // select all first
      await page.type(action.selector, action.text);
      break;
    case 'wait_for':
      await page.waitForSelector(action.selector, { timeout: 15000 });
      break;
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      break;
    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      break;
    case 'scroll':
      await page.evaluate(
        (dir: string, amt: number) => window.scrollBy(0, dir === 'down' ? amt * 100 : -amt * 100),
        action.direction,
        action.amount,
      );
      break;
    case 'click_text':
      await page.evaluate((targetText: string) => {
        const el = Array.from(document.querySelectorAll('button, a, input, [role="button"], label, *')).find(
          (e) =>
            e.textContent?.trim() === targetText ||
            (e as HTMLInputElement).value?.trim() === targetText,
        );
        if (el) { (el as HTMLElement).click(); }
      }, action.text);
      break;
    case 'DONE':
      break;
  }
}

// === SCREENSHOT ===

export async function takePageScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: false });
  return buffer as string;
}
