/**
 * Pure (runtime-agnostic) subset of the browser-agent module: the action
 * type, the system prompt, response parsing, and action description.
 *
 * The Puppeteer execution (`executeBrowserAction`, `takePageScreenshot`)
 * lives in the companion `common/browser` module. The Android app provides
 * its own native execution via `app/src-plugins/askii-browser`.
 */

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
    case 'scroll':
      return `Scroll ${action.direction} by ${action.amount}`;
    case 'click_text':
      return `Click element with text: "${action.text}"`;
    case 'DONE':
      return 'Done';
  }
}