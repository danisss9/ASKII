/**
 * Pure (runtime-agnostic) subset of the screen-control module: types, the
 * system prompt, response parsers, zoom-precision prompts, the action
 * describer, and per-action delays.
 *
 * Node-only execution (PowerShell/AppleScript/xdotool dispatch, screenshot
 * capture, SystemInfo probing, coordinate refinement via Jimp) lives in the
 * companion `common/control` module which re-exports the pure API here.
 */

export type ControlAction =
  | { action: 'mouse_move'; x: number; y: number; reasoning: string }
  | { action: 'mouse_left_click'; x: number; y: number; reasoning: string }
  | { action: 'mouse_right_click'; x: number; y: number; reasoning: string }
  | { action: 'mouse_double_click'; x: number; y: number; reasoning: string }
  | {
      action: 'mouse_drag';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      reasoning: string;
    }
  | {
      action: 'mouse_scroll';
      x: number;
      y: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount: number;
      reasoning: string;
    }
  | { action: 'keyboard_input'; text: string; reasoning: string }
  | { action: 'key_press'; key: string; reasoning: string }
  | { action: 'click_text'; text: string; reasoning: string }
  | { action: 'DONE'; reasoning: string };

export type ControlResponse =
  | { type: 'done'; reasoning: string }
  | { type: 'actions'; actions: Exclude<ControlAction, { action: 'DONE' }>[] };

export interface ControlHistoryEntry {
  round: number;
  description: string;
  reasoning: string;
  screenChanged: boolean;
}

export interface Monitor {
  id: string | number | undefined;
  name: string;
}

export interface SystemInfo {
  os: string;
  activeWindow?: string;
  openWindows?: string[];
  screenWidth?: number;
  screenHeight?: number;
  locale?: string;
  currentTime?: string;
}

// === ZOOM / CROP ===

/** Half-size of the zoom crop box in pixels. Exported for the Node companion. */
export const ZOOM_RADIUS = 200;
/** Magnification factor for the zoom crop. Exported for the Node companion. */
export const ZOOM_SCALE = 2;

// === SYSTEM PROMPT ===

export function buildControlSystemPrompt(
  width: number,
  height: number,
  systemInfo?: SystemInfo,
  history?: ControlHistoryEntry[],
): string {
  const historySection =
    history && history.length > 0
      ? '\n\nActions taken so far:\n' +
        history
          .map(
            (h) =>
              `  Round ${h.round}: ${h.description} — ${h.reasoning}${h.screenChanged ? '' : ' [WARNING: screen did not change after this action]'}`,
          )
          .join('\n')
      : '';

  const sysLines: string[] = [];
  if (systemInfo) {
    sysLines.push(`- OS: ${systemInfo.os}`);
    if (systemInfo.locale) sysLines.push(`- Locale: ${systemInfo.locale}`);
    if (systemInfo.currentTime) sysLines.push(`- Current date/time: ${systemInfo.currentTime}`);
    if (systemInfo.activeWindow) sysLines.push(`- Active window: ${systemInfo.activeWindow}`);
    if (systemInfo.openWindows && systemInfo.openWindows.length > 0) {
      sysLines.push(`- Open windows: ${systemInfo.openWindows.join(', ')}`);
    }
    if (systemInfo.screenWidth && systemInfo.screenHeight) {
      const isScaled = systemInfo.screenWidth !== width || systemInfo.screenHeight !== height;
      sysLines.push(
        isScaled
          ? `- Screen resolution: ${systemInfo.screenWidth}x${systemInfo.screenHeight} (screenshot scaled to ${width}x${height})`
          : `- Screen resolution: ${systemInfo.screenWidth}x${systemInfo.screenHeight}`,
      );
    } else {
      sysLines.push(`- Screenshot resolution: ${width}x${height}`);
    }
  }
  const systemSection =
    sysLines.length > 0 ? `\n\nSystem information:\n${sysLines.join('\n')}` : '';

  return `You are a computer control assistant. You will receive a screenshot (${width}x${height} pixels) and must determine the next single action to take to complete the given instruction.${systemSection}

Respond with ONLY a valid JSON object (no markdown, no extra text) in one of these formats:
{"action": "mouse_move", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_left_click", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_right_click", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_double_click", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_drag", "fromX": number, "fromY": number, "toX": number, "toY": number, "reasoning": "explanation"}
{"action": "mouse_scroll", "x": number, "y": number, "direction": "up"|"down"|"left"|"right", "amount": number, "reasoning": "explanation"}
{"action": "keyboard_input", "text": "text to type", "reasoning": "explanation"}
{"action": "key_press", "key": "key name or combo", "reasoning": "explanation"}
{"action": "click_text", "text": "visible text of the element", "reasoning": "explanation"}
{"action": "DONE", "reasoning": "explanation of what was accomplished"}

x and y are pixel coordinates within the screenshot image: x ranges from 0 to ${width - 1} (left to right), y ranges from 0 to ${height - 1} (top to bottom). Be as precise as possible.

IMPORTANT: Prefer keyboard shortcuts and keyboard_input over mouse actions whenever possible. Use key_press for common shortcuts (e.g., Ctrl+S to save, Ctrl+C/V to copy/paste, Ctrl+Z to undo, Alt+F4 to close, Alt+Tab to switch windows, Win+D to show desktop, Win to open Start Menu, Win+E for File Explorer, Win+R for Run dialog, Tab/Shift+Tab to navigate between fields, Enter to confirm). Only use mouse actions when keyboard alternatives are not available or practical.

For key_press, supported keys: Enter, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, Win (Windows key), F1-F12. For combos use + separator: Ctrl+C, Ctrl+V, Ctrl+Z, Ctrl+S, Ctrl+A, Ctrl+X, Ctrl+W, Alt+Tab, Shift+Tab, Ctrl+Shift+Z, Win+D, Win+E, Win+R, Win+L, etc.
For click_text, provide the exact visible label text of the button, link, or menu item. The system will find and click it for you — prefer this over mouse_left_click when you can clearly read the target text on screen.
For mouse_scroll, amount is 1-10 scroll clicks.

You may return a SINGLE action object OR a JSON array of actions to execute in sequence when you are confident about multiple consecutive steps:
[{"action": "...", ...}, {"action": "...", ...}]
Use sequences for common patterns like clicking a field then typing, or typing then pressing Enter. Do NOT include DONE in an array.
Return {"action": "DONE", "reasoning": "..."} (not in an array) only when the instruction is fully completed.${historySection}`;
}

// === PARSE ===

export function parseControlAction(response: string): ControlAction | null {
  try {
    const clean = response
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.action === 'string') return parsed as ControlAction;
  } catch {
    const match = response.match(/\{[\s\S]*?\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed.action === 'string') return parsed as ControlAction;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export function parseControlResponse(response: string): ControlResponse | null {
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
      (a): a is Exclude<ControlAction, { action: 'DONE' }> =>
        !!a && typeof (a as any).action === 'string' && (a as any).action !== 'DONE',
    );
    return actions.length > 0 ? { type: 'actions', actions } : null;
  }

  if (parsed && typeof (parsed as any).action === 'string') {
    const obj = parsed as ControlAction;
    if (obj.action === 'DONE') return { type: 'done', reasoning: obj.reasoning };
    return { type: 'actions', actions: [obj as Exclude<ControlAction, { action: 'DONE' }>] };
  }

  return null;
}

// === ZOOM PROMPTS ===

/** Build the system prompt for the zoom/precision phase. */
export function buildZoomPrompt(
  action: ControlAction,
  boxX1: number,
  boxY1: number,
  boxX2: number,
  boxY2: number,
  zoomedW: number,
  zoomedH: number,
): string {
  return `You are refining click precision for a computer control action.

The image is a ${zoomedW}x${zoomedH} px zoomed view (${ZOOM_SCALE}x magnification) of the screen region (${boxX1}, ${boxY1}) to (${boxX2}, ${boxY2}) from the original screenshot.

Planned action: ${describeAction(action)}

Look carefully at the zoomed image and find the MOST PRECISE location for this action.
Respond with ONLY valid JSON (no markdown):
{"x": number, "y": number, "reasoning": "brief explanation"}
x: 0–${zoomedW - 1}, y: 0–${zoomedH - 1} in the ZOOMED image coordinates.`;
}

/** Parse zoom refinement response. */
export function parseZoomResponse(response: string): { x: number; y: number } | null {
  const clean = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const tryParse = (s: string) => {
    try {
      const p = JSON.parse(s);
      if (typeof p?.x === 'number' && typeof p?.y === 'number')
        return { x: p.x as number, y: p.y as number };
    } catch {
      /* ignore */
    }
    return null;
  };
  return tryParse(clean) ?? tryParse(clean.match(/\{[\s\S]*?\}/)?.[0] ?? '');
}

// === DESCRIBE ===

export function describeAction(action: ControlAction): string {
  switch (action.action) {
    case 'mouse_move':
      return `Move mouse to (${action.x}, ${action.y})`;
    case 'mouse_left_click':
      return `Left click at (${action.x}, ${action.y})`;
    case 'mouse_right_click':
      return `Right click at (${action.x}, ${action.y})`;
    case 'mouse_double_click':
      return `Double click at (${action.x}, ${action.y})`;
    case 'mouse_drag':
      return `Drag from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY})`;
    case 'mouse_scroll':
      return `Scroll ${action.direction} ×${action.amount} at (${action.x}, ${action.y})`;
    case 'keyboard_input':
      return `Type: "${action.text}"`;
    case 'key_press':
      return `Press: ${action.key}`;
    case 'click_text':
      return `Click element with text: "${action.text}"`;
    case 'DONE':
      return 'DONE';
  }
}

// === DELAY ===

const DEFAULT_ACTION_DELAYS: Record<string, number> = {
  mouse_move: 300,
  mouse_left_click: 1500,
  mouse_right_click: 1500,
  mouse_double_click: 1500,
  mouse_drag: 1000,
  mouse_scroll: 500,
  keyboard_input: 1000,
  key_press: 1000,
  click_text: 1500,
};

export function getActionDelay(action: ControlAction, baseDelay?: number): number {
  if (action.action === 'DONE') return 0;
  if (baseDelay !== undefined) return baseDelay;
  return DEFAULT_ACTION_DELAYS[action.action] ?? 1000;
}