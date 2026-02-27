import { mouse, keyboard, Button, Point } from '@nut-tree-fork/nut-js';
import screenshot from 'screenshot-desktop';

export type ControlAction =
  | { action: 'mouse_move'; x: number; y: number; reasoning: string }
  | { action: 'mouse_left_click'; x: number; y: number; reasoning: string }
  | { action: 'mouse_right_click'; x: number; y: number; reasoning: string }
  | { action: 'keyboard_input'; text: string; reasoning: string }
  | { action: 'DONE'; reasoning: string };

export const CONTROL_SYSTEM_PROMPT = `You are a computer control assistant. You will receive a screenshot and must determine the next single action to take to complete the given instruction.

Respond with ONLY a valid JSON object (no markdown, no extra text) in one of these formats:
{"action": "mouse_move", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_left_click", "x": number, "y": number, "reasoning": "explanation"}
{"action": "mouse_right_click", "x": number, "y": number, "reasoning": "explanation"}
{"action": "keyboard_input", "text": "text to type", "reasoning": "explanation"}
{"action": "DONE", "reasoning": "explanation of what was accomplished"}

x and y are screen coordinates in pixels from the top-left corner. Return DONE only when the instruction is fully completed.`;

export function parseControlAction(response: string): ControlAction | null {
  try {
    const clean = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed.action === 'string') return parsed as ControlAction;
  } catch {
    // try to extract JSON object from the response
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

export async function takeScreenshot(): Promise<string> {
  const img = await screenshot({ format: 'png' });
  return img.toString('base64');
}

export function describeAction(action: ControlAction): string {
  switch (action.action) {
    case 'mouse_move':
      return `Move mouse to (${action.x}, ${action.y})`;
    case 'mouse_left_click':
      return `Left click at (${action.x}, ${action.y})`;
    case 'mouse_right_click':
      return `Right click at (${action.x}, ${action.y})`;
    case 'keyboard_input':
      return `Type: "${action.text}"`;
    case 'DONE':
      return 'DONE';
  }
}

export async function executeControlAction(action: ControlAction): Promise<void> {
  if (action.action === 'DONE') return;

  if (action.action === 'mouse_move') {
    await mouse.setPosition(new Point(action.x, action.y));
  } else if (action.action === 'mouse_left_click') {
    await mouse.setPosition(new Point(action.x, action.y));
    await mouse.click(Button.LEFT);
  } else if (action.action === 'mouse_right_click') {
    await mouse.setPosition(new Point(action.x, action.y));
    await mouse.click(Button.RIGHT);
  } else if (action.action === 'keyboard_input') {
    await keyboard.type(action.text);
  }

  // Brief pause to let the screen update before the next screenshot
  await new Promise((r) => setTimeout(r, 500));
}
