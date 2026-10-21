import { existsSync } from 'fs';
import { platform } from 'os';
import * as path from 'path';
import type { Page } from 'puppeteer-core';
import { parseJsonFromModel } from './utils';

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

type BrowserStep = Exclude<BrowserAction, { action: 'DONE' }>;

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Validates one model-proposed browser action. Returns null when a required
 * field is missing or malformed so it is never executed.
 */
export function normalizeBrowserAction(raw: unknown): BrowserStep | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const a = raw as Record<string, unknown>;
  const reasoning = typeof a.reasoning === 'string' ? a.reasoning : '';
  switch (a.action) {
    case 'goto': {
      const url = asNonEmptyString(a.url);
      return url ? { action: 'goto', url, reasoning } : null;
    }
    case 'click':
    case 'wait_for': {
      const selector = asNonEmptyString(a.selector);
      return selector ? { action: a.action, selector, reasoning } : null;
    }
    case 'type': {
      const selector = asNonEmptyString(a.selector);
      return selector && typeof a.text === 'string'
        ? { action: 'type', selector, text: a.text, reasoning }
        : null;
    }
    case 'back':
    case 'forward':
      return { action: a.action, reasoning };
    case 'scroll': {
      const direction = typeof a.direction === 'string' ? a.direction.toLowerCase() : '';
      if (direction !== 'up' && direction !== 'down') {
        return null;
      }
      const n = typeof a.amount === 'number' ? a.amount : Number(a.amount);
      const amount = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3;
      return { action: 'scroll', direction, amount, reasoning };
    }
    case 'click_text': {
      const text = asNonEmptyString(a.text);
      return text ? { action: 'click_text', text, reasoning } : null;
    }
    default:
      return null;
  }
}

function isActionLike(value: unknown): boolean {
  return (
    Array.isArray(value) ||
    (!!value && typeof value === 'object' && typeof (value as { action?: unknown }).action === 'string')
  );
}

/**
 * Parses the model's reply into DONE or a list of validated actions. A
 * sequence with any malformed action is rejected as a whole.
 */
export function parseBrowserResponse(response: string): BrowserResponse | null {
  const parsed = parseJsonFromModel(response, isActionLike);
  if (parsed === undefined) {
    return null;
  }

  if (Array.isArray(parsed)) {
    const steps = parsed.filter((a) => (a as { action?: unknown } | null)?.action !== 'DONE');
    const actions = steps.map(normalizeBrowserAction);
    if (actions.length === 0 || actions.some((a) => a === null)) {
      return null;
    }
    return { type: 'actions', actions: actions as BrowserStep[] };
  }

  const obj = parsed as { action: string; reasoning?: unknown };
  if (obj.action === 'DONE') {
    return { type: 'done', reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' };
  }
  const action = normalizeBrowserAction(parsed);
  return action ? { type: 'actions', actions: [action] } : null;
}

// === DESCRIBE ===

export function describeBrowserAction(action: BrowserAction): string {
  switch (action.action) {
    case 'goto':
      return `Navigate to ${action.url}`;
    case 'click':
      return `Click "${action.selector}"`;
    case 'type':
      // Don't echo what looks like a password into the log / timeline
      return SECRET_FIELD.test(action.selector)
        ? `Type ${'•'.repeat(Math.min(8, Math.max(4, action.text.length)))} into "${action.selector}"`
        : `Type "${action.text}" into "${action.selector}"`;
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

  // host:port without a scheme ("myapp.local:5173/x", "dev-box:8080") — the
  // scheme check below would otherwise read "myapp.local:" as a scheme
  if (/^(?!(?:tel|sms|mailto|about|data|javascript|file):)[^\s/?#:]+:\d{1,5}(?:[/?#]|$)/i.test(raw)) {
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

/**
 * Only web pages may be opened by the model: file: would let it screenshot
 * (and later exfiltrate) local files, javascript: runs script in the current
 * page, and chrome:/edge: pages expose browser settings.
 */
export function isAllowedNavigateUrl(url: string): boolean {
  if (url === 'about:blank') {
    return true;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Chromium launch flags. The sandbox stays on; it is only disabled where
 * Chromium refuses to start with it — as root on Linux (e.g. in containers).
 */
export function browserLaunchArgs(): string[] {
  const args = ['--start-maximized'];
  const isRootOnLinux = platform() === 'linux' && process.getuid?.() === 0;
  if (isRootOnLinux) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  return args;
}

const SECRET_FIELD = /pass(word|wd)?|pwd|secret|token|otp|pin\b|cvv|card/i;

export async function executeBrowserAction(action: BrowserAction, page: Page): Promise<void> {
  switch (action.action) {
    case 'goto': {
      const url = normalizeNavigateUrl(action.url, page.url());
      if (!isAllowedNavigateUrl(url)) {
        throw new Error(
          `Blocked navigation to ${url} — ASKII Control only opens http(s) pages (no file:, javascript:, chrome: …)`,
        );
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }
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
    case 'click_text': {
      const clicked = await page.evaluate((targetText: string) => {
        const matches = (e: Element) =>
          e.textContent?.trim() === targetText ||
          (e as HTMLInputElement).value?.trim() === targetText;
        // Interactive elements first. Otherwise take the deepest match (last in
        // document order): a wrapper <li>/<div> with the same text comes first,
        // and clicking it would not trigger the link/button inside.
        const el =
          Array.from(
            document.querySelectorAll('button, a, input, [role="button"], [role="link"], label'),
          ).find(matches) ??
          Array.from(document.querySelectorAll('body *'))
            .filter(matches)
            .pop();
        if (!el) {
          return false;
        }
        (el as HTMLElement).click();
        return true;
      }, action.text);
      if (!clicked) {
        throw new Error(`No element with text "${action.text}" found on the page`);
      }
      break;
    }
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
