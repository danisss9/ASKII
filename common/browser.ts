import type { Page } from 'puppeteer-core';

// === TYPES ===

export type BrowserAction =
  | { action: 'goto'; url: string; reasoning: string }
  | { action: 'click'; selector: string; reasoning: string }
  | { action: 'type'; selector: string; text: string; reasoning: string }
  | { action: 'wait_for'; selector: string; reasoning: string }
  | { action: 'back'; reasoning: string }
  | { action: 'forward'; reasoning: string }
  | { action: 'DONE'; reasoning: string };

// === SYSTEM PROMPT ===

export function buildBrowserSystemPrompt(): string {
  return `You are a browser automation assistant. You will receive a screenshot of the current browser page and its URL. Determine the single next action to take to complete the given task.

Respond with ONLY a valid JSON object (no markdown, no extra text) in one of these formats:
{"action": "goto", "url": "https://...", "reasoning": "explanation"}
{"action": "click", "selector": "CSS selector", "reasoning": "explanation"}
{"action": "type", "selector": "CSS selector", "text": "text to type", "reasoning": "explanation"}
{"action": "wait_for", "selector": "CSS selector", "reasoning": "explanation"}
{"action": "back", "reasoning": "explanation"}
{"action": "forward", "reasoning": "explanation"}
{"action": "DONE", "reasoning": "explanation of what was accomplished"}

Action descriptions:
- goto: Navigate to a URL (absolute or relative)
- click: Click the element matching the CSS selector
- type: Type text into the element matching the CSS selector (clears existing value first)
- wait_for: Wait until the CSS selector appears in the DOM
- back: Navigate back in browser history
- forward: Navigate forward in browser history
- DONE: Return this when the task is fully completed

For CSS selectors, prefer specific selectors like: input[name="q"], button[type="submit"], a[href*="example"], #id, .class.
Return {"action": "DONE", "reasoning": "..."} only when the instruction is fully completed.`;
}

// === PARSE ===

export function parseBrowserAction(response: string): BrowserAction | null {
  try {
    const clean = response
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.action === 'string') return parsed as BrowserAction;
  } catch {
    const match = response.match(/\{[\s\S]*?\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed.action === 'string') return parsed as BrowserAction;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

// === DESCRIBE ===

export function describeBrowserAction(action: BrowserAction): string {
  switch (action.action) {
    case 'goto':
      return `Navigate to ${action.url}`;
    case 'click':
      return `Click "${action.selector}"`;
    case 'type':
      return `Type "${action.text}" into "${action.selector}"`;
    case 'wait_for':
      return `Wait for "${action.selector}"`;
    case 'back':
      return 'Navigate back';
    case 'forward':
      return 'Navigate forward';
    case 'DONE':
      return 'Done';
  }
}

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
    case 'DONE':
      break;
  }
}

// === SCREENSHOT ===

export async function takePageScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ encoding: 'base64', type: 'png', fullPage: false });
  return buffer as string;
}
