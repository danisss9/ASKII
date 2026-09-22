import { existsSync } from 'fs';
import { platform } from 'os';
import * as path from 'path';
import type { Page } from 'puppeteer-core';

// === TYPES ===

export type BrowserAction =
  | { action: 'goto'; url: string; reasoning: string }
  | { action: 'click'; selector: string; reasoning: string }
  | { action: 'type'; selector: string; text: string; reasoning: string }
  | { action: 'wait_for'; selector: string; reasoning: string }
  | { action: 'back'; reasoning: string }
  | { action: 'forward'; reasoning: string }
  | { action: 'scroll'; direction: 'up' | 'down'; amount: number; reasoning: string }
  | { action: 'click_text'; text: string; reasoning: string }
  | { action: 'DONE'; reasoning: string };

export type BrowserResponse =
  | { type: 'done'; reasoning: string }
  | { type: 'actions'; actions: Exclude<BrowserAction, { action: 'DONE' }>[] };

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
{"action": "scroll", "direction": "up"|"down", "amount": 1-10, "reasoning": "explanation"}
{"action": "click_text", "text": "visible text of the element", "reasoning": "explanation"}
{"action": "DONE", "reasoning": "explanation of what was accomplished"}

Action descriptions:
- goto: Navigate to a URL (absolute or relative)
- click: Click the element matching the CSS selector
- type: Type text into the element matching the CSS selector (clears existing value first)
- wait_for: Wait until the CSS selector appears in the DOM
- back: Navigate back in browser history
- forward: Navigate forward in browser history
- scroll: Scroll the page up or down; amount is 1-10 scroll units
- click_text: Click a visible element by its exact text label; prefer over click when you can read the element's text
- DONE: Return this when the task is fully completed

For CSS selectors, prefer specific selectors like: input[name="q"], button[type="submit"], a[href*="example"], #id, .class.
For goto, full URLs including the scheme (https://example.com) are preferred; scheme-less hosts (example.com) and relative paths (/page) are also accepted and resolved automatically.
You may return a SINGLE action object OR a JSON array of actions to execute in sequence when you are confident about multiple consecutive steps (e.g., click a field then type into it):
[{"action": "...", ...}, {"action": "...", ...}]
Do NOT include DONE in an array. Return {"action": "DONE", "reasoning": "..."} (not in an array) only when the task is fully completed.`;
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

export function parseBrowserResponse(response: string): BrowserResponse | null {
  const clean = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Try array first, then object
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        parsed = JSON.parse(arrMatch[0]);
      } catch {
        /* ignore */
      }
    }
    if (!parsed) {
      const objMatch = clean.match(/\{[\s\S]*?\}/);
      if (objMatch) {
        try {
          parsed = JSON.parse(objMatch[0]);
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!parsed) return null;

  if (Array.isArray(parsed)) {
    const actions = (parsed as unknown[]).filter(
      (a): a is Exclude<BrowserAction, { action: 'DONE' }> =>
        !!a && typeof (a as any).action === 'string' && (a as any).action !== 'DONE',
    );
    return actions.length > 0 ? { type: 'actions', actions } : null;
  }

  if (parsed && typeof (parsed as any).action === 'string') {
    const obj = parsed as BrowserAction;
    if (obj.action === 'DONE') return { type: 'done', reasoning: obj.reasoning };
    return { type: 'actions', actions: [obj as Exclude<BrowserAction, { action: 'DONE' }>] };
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
    case 'scroll':
      return `Scroll ${action.direction} by ${action.amount}`;
    case 'click_text':
      return `Click element with text: "${action.text}"`;
    case 'DONE':
      return 'Done';
  }
}

// === EXECUTE ===

/**
 * Normalize a model-provided URL for page.goto(): strip wrapping quotes and
 * markdown link syntax, add a scheme to scheme-less hosts, and resolve
 * relative paths against the current page URL. Pure — never throws.
 */
export function normalizeNavigateUrl(input: string, baseUrl: string): string {
  let raw = input.trim();
  const mdMatch = raw.match(/\]\((\S+?)\)$/); // [label](url)
  if (mdMatch) raw = mdMatch[1];
  raw = raw.replace(/^<|>$/g, '');
  raw = raw.replace(/^["'`]+|["'`]+$/g, '');
  raw = raw.trim();
  if (!raw) return raw;

  // localhost / bare IP without a scheme (before the scheme check —
  // "localhost:3000" otherwise parses as a URI with scheme "localhost")
  if (/^(localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)(?:[/?#]|$)/i.test(raw)) {
    return 'http://' + raw;
  }

  // Already has a scheme (https:, http:, about:, edge://, ...)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;

  // Host-like without scheme (example.com, www.x.org, sub.domain.co/path)
  if (/^([^\s/?#]+\.)[^\s/?#]+/.test(raw)) return 'https://' + raw;

  // Otherwise resolve relative to the current page (/path, foo, //host)
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

export async function executeBrowserAction(action: BrowserAction, page: Page): Promise<void> {
  switch (action.action) {
    case 'goto':
      await page.goto(normalizeNavigateUrl(action.url, page.url()), {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
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
        const el = Array.from(
          document.querySelectorAll('button, a, input, [role="button"], label, *'),
        ).find(
          (e) =>
            e.textContent?.trim() === targetText ||
            (e as HTMLInputElement).value?.trim() === targetText,
        );
        if (el) {
          (el as HTMLElement).click();
        }
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

// === BROWSER DETECTION ===

/**
 * Build an ordered list of well-known Chromium-based browser executables for a
 * platform, in preference order (Chrome, Edge, Chromium, Brave). Pure — no
 * filesystem access — so it is unit-testable on any machine.
 */
export function buildBrowserCandidates(
  plat: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (plat === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    );
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    const candidates: string[] = [];
    for (const rel of rels) {
      for (const root of roots) candidates.push(path.win32.join(root, rel));
    }
    return candidates;
  }

  if (plat === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }

  // Linux (and anything unix-ish): search PATH for known browser binaries.
  const bins = [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'chromium',
    'chromium-browser',
    'brave-browser',
  ];
  const pathDirs = (env.PATH ?? '').split(path.posix.delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const bin of bins) {
    for (const dir of pathDirs) candidates.push(path.posix.join(dir, bin));
  }
  return candidates;
}

/**
 * Find a Chromium-based browser executable for Puppeteer to drive.
 * Honors PUPPETEER_EXECUTABLE_PATH first, then probes well-known install
 * locations for Chrome, Edge, Chromium and Brave. Returns undefined when
 * nothing is found.
 */
export function detectBrowserExecutable(): string | undefined {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return buildBrowserCandidates().find((c) => existsSync(c));
}
