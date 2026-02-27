import { execSync, execFileSync } from 'child_process';
import { platform } from 'os';
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
    const clean = response
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
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

export async function takeScreenshot(): Promise<{ base64: string; width: number; height: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const img = await screenshot({ format: 'png' });
  // PNG IHDR chunk: bytes 16-19 = width, bytes 20-23 = height (big-endian uint32)
  const width = img.readUInt32BE(16);
  const height = img.readUInt32BE(20);
  return { base64: img.toString('base64'), width, height };
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

/** Run a PowerShell script safely using base64 encoding to avoid quoting issues. */
function runPowerShell(script: string): void {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execSync(`powershell -NonInteractive -NoProfile -EncodedCommand ${encoded}`, { stdio: 'ignore' });
}

/**
 * Move (and optionally click) using SendInput with MOUSEEVENTF_ABSOLUTE so coordinates are
 * DPI-independent: normX/normY must be in the 0-65535 range computed from physical screen dims.
 * downFlag/upFlag = 0 means move only; pass MOUSEEVENTF_* | MOUSEEVENTF_ABSOLUTE for clicks.
 */
function win32Mouse(normX: number, normY: number, downFlag: number, upFlag: number): void {
  const psLines = [
    '$td = @"',
    'using System; using System.Runtime.InteropServices;',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
    '[StructLayout(LayoutKind.Explicit, Size=40)]',
    'public struct MINPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }',
    'public class W32M {',
    '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, MINPUT[] i, int cb);',
    '    public static void Do(int nx, int ny, uint df, uint uf) {',
    '        int cnt = (df != 0) ? 3 : 1;',
    '        MINPUT[] a = new MINPUT[cnt];',
    '        a[0].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8001 };',
    '        if (cnt > 1) {',
    '            a[1].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=df };',
    '            a[2].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=uf };',
    '        }',
    '        SendInput((uint)cnt, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(MINPUT)));',
    '    }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $td -ErrorAction SilentlyContinue',
    `[W32M]::Do(${normX}, ${normY}, ${downFlag}, ${upFlag})`,
  ];
  runPowerShell(psLines.join('\n'));
}

export async function executeControlAction(
  action: ControlAction,
  physWidth?: number,
  physHeight?: number,
): Promise<void> {
  if (action.action === 'DONE') {
    return;
  }

  const p = platform();

  if (action.action === 'mouse_move') {
    if (p === 'win32') {
      // Normalize to 0-65535 using physical pixel dimensions from the screenshot PNG header.
      // MOUSEEVENTF_ABSOLUTE coords are DPI-independent, unlike SetCursorPos logical coords.
      const normX = Math.round((action.x * 65535) / Math.max((physWidth ?? 1) - 1, 1));
      const normY = Math.round((action.y * 65535) / Math.max((physHeight ?? 1) - 1, 1));
      win32Mouse(normX, normY, 0, 0);
    } else if (p === 'darwin') {
      execSync(
        `osascript -e 'tell application "System Events" to set cursor position to {${action.x}, ${action.y}}'`,
        { stdio: 'ignore' },
      );
    } else {
      execFileSync('xdotool', ['mousemove', String(action.x), String(action.y)]);
    }
  } else if (action.action === 'mouse_left_click' || action.action === 'mouse_right_click') {
    const isLeft = action.action === 'mouse_left_click';
    if (p === 'win32') {
      const normX = Math.round((action.x * 65535) / Math.max((physWidth ?? 1) - 1, 1));
      const normY = Math.round((action.y * 65535) / Math.max((physHeight ?? 1) - 1, 1));
      // MOUSEEVENTF_LEFTDOWN|ABSOLUTE=0x8002, LEFTUP=0x8004, RIGHTDOWN=0x8008, RIGHTUP=0x8010
      const downFlag = isLeft ? 0x8002 : 0x8008;
      const upFlag = isLeft ? 0x8004 : 0x8010;
      win32Mouse(normX, normY, downFlag, upFlag);
    } else if (p === 'darwin') {
      const btn = isLeft ? 'leftClick' : 'rightClick';
      execSync(
        `osascript -e 'tell application "System Events" to ${btn} at {${action.x}, ${action.y}}'`,
        { stdio: 'ignore' },
      );
    } else {
      const btn = isLeft ? '1' : '3';
      execFileSync('xdotool', ['mousemove', String(action.x), String(action.y), 'click', btn]);
    }
  } else if (action.action === 'keyboard_input') {
    if (p === 'win32') {
      // SendInput with KEYEVENTF_UNICODE (0x0004) types each character individually.
      // Text is base64-encoded in JS and decoded in PS to avoid any injection/escaping issues.
      // INPUT struct Size=40 is the correct size on 64-bit Windows.
      const textB64 = Buffer.from(action.text, 'utf8').toString('base64');
      const psLines = [
        '$typeDef = @"',
        'using System; using System.Runtime.InteropServices; using System.Threading;',
        '[StructLayout(LayoutKind.Sequential)]',
        'public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
        '[StructLayout(LayoutKind.Explicit, Size=40)]',
        'public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }',
        'public class KeySender {',
        '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);',
        '    public static void Type(string text, int delayMs) {',
        '        foreach (char c in text) {',
        '            INPUT[] inp = new INPUT[2];',
        '            inp[0] = new INPUT { type=1 }; inp[0].ki = new KEYBDINPUT { wScan=(ushort)c, dwFlags=4 };',
        '            inp[1] = new INPUT { type=1 }; inp[1].ki = new KEYBDINPUT { wScan=(ushort)c, dwFlags=6 };',
        '            SendInput(2, inp, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));',
        '            Thread.Sleep(delayMs);',
        '        }',
        '    }',
        '}',
        '"@',
        'Add-Type -TypeDefinition $typeDef -ErrorAction SilentlyContinue',
        `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textB64}'))`,
        '[KeySender]::Type($t, 50)',
      ];
      runPowerShell(psLines.join('\n'));
    } else if (p === 'darwin') {
      // Single osascript process loops over characters with a 50ms delay each.
      // Text is escaped for AppleScript double-quoted string (backslash and double-quote only).
      const escaped = action.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = [
        'tell application "System Events"',
        `  set t to "${escaped}"`,
        '  repeat with i from 1 to (count t)',
        '    keystroke (character i of t)',
        '    delay 0.05',
        '  end repeat',
        'end tell',
      ].join('\n');
      execFileSync('osascript', [], { input: script });
    } else {
      // xdotool --delay types each character with a 50ms inter-key delay
      execFileSync('xdotool', ['type', '--delay', '50', '--clearmodifiers', '--', action.text]);
    }
  }

  // Wait for the screen to update before the next screenshot
  await new Promise((r) => setTimeout(r, 5000));
}
