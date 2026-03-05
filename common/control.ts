import { execSync, execFileSync } from 'child_process';
import { platform } from 'os';
import screenshot from 'screenshot-desktop';
import Jimp from 'jimp';

// === TYPES ===

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

// === ZOOM / CROP ===

const ZOOM_RADIUS = 200; // half-size of crop box in pixels
const ZOOM_SCALE = 2; // how much to magnify the crop

/** Crop a region from a PNG buffer and scale it up using jimp. Returns null on failure. */
export async function cropAndScale(
  imgBuffer: Buffer,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Promise<Buffer | null> {
  try {
    const img = await Jimp.read(imgBuffer);
    return await img
      .crop(srcX, srcY, srcW, srcH)
      .resize(outW, outH, Jimp.RESIZE_BICUBIC)
      .getBufferAsync(Jimp.MIME_PNG);
  } catch {
    return null;
  }
}

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

/** Compute zoom box and return refined coordinates, or null if crop failed. */
export async function refineCoordinates(
  imgBuffer: Buffer,
  x: number,
  y: number,
  screenW: number,
  screenH: number,
  action: ControlAction,
  askLLM: (systemPrompt: string, imageBase64: string) => Promise<string>,
): Promise<{ x: number; y: number } | null> {
  const bx1 = Math.max(0, x - ZOOM_RADIUS);
  const by1 = Math.max(0, y - ZOOM_RADIUS);
  const bx2 = Math.min(screenW - 1, x + ZOOM_RADIUS);
  const by2 = Math.min(screenH - 1, y + ZOOM_RADIUS);
  const srcW = bx2 - bx1;
  const srcH = by2 - by1;
  const outW = Math.round(srcW * ZOOM_SCALE);
  const outH = Math.round(srcH * ZOOM_SCALE);

  const zoomedBuf = await cropAndScale(imgBuffer, bx1, by1, srcW, srcH, outW, outH);
  if (!zoomedBuf) return null;

  const raw = await askLLM(
    buildZoomPrompt(action, bx1, by1, bx2, by2, outW, outH),
    zoomedBuf.toString('base64'),
  );

  const refined = parseZoomResponse(raw);
  if (!refined) return null;

  return {
    x: Math.round(bx1 + refined.x / ZOOM_SCALE),
    y: Math.round(by1 + refined.y / ZOOM_SCALE),
  };
}

// === SYSTEM INFO ===

export interface SystemInfo {
  os: string;
  activeWindow?: string;
  openWindows?: string[];
  screenWidth?: number;
  screenHeight?: number;
  locale?: string;
  currentTime?: string;
}

export async function getSystemInfo(physWidth?: number, physHeight?: number): Promise<SystemInfo> {
  const p = platform();
  let osName = p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux';
  let activeWindow: string | undefined;
  let openWindows: string[] | undefined;
  let locale: string | undefined;
  const screenWidth = physWidth;
  const screenHeight = physHeight;
  const currentTime = new Date().toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  try {
    if (p === 'win32') {
      const osVer = runPowerShellCapture(`(Get-CimInstance Win32_OperatingSystem).Caption`);
      if (osVer) osName = osVer;

      const winTitle = runPowerShellCapture(
        `$td = @"
using System; using System.Runtime.InteropServices; using System.Text;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
}
"@
Add-Type -TypeDefinition $td -ErrorAction SilentlyContinue
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[FgWin]::GetWindowText($h, $sb, 512) | Out-Null
$sb.ToString()`,
      );
      if (winTitle) activeWindow = winTitle;

      const allWinRaw = runPowerShellCapture(
        `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle | Select-Object -First 15`,
      );
      if (allWinRaw) {
        openWindows = allWinRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const localeRaw = runPowerShellCapture(`(Get-Culture).Name`);
      if (localeRaw) locale = localeRaw;
    } else if (p === 'darwin') {
      try {
        const macVer = execSync('sw_vers -productVersion', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (macVer) osName = `macOS ${macVer}`;
      } catch {
        /* ignore */
      }
      try {
        const win = execSync(
          `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        if (win) activeWindow = win;
      } catch {
        /* ignore */
      }
      try {
        const allWin = execSync(
          `osascript -e 'tell application "System Events" to get name of every application process whose visible is true'`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        if (allWin)
          openWindows = allWin
            .split(', ')
            .map((s) => s.trim())
            .filter(Boolean);
      } catch {
        /* ignore */
      }
      try {
        const loc = execSync('defaults read -g AppleLocale', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (loc) locale = loc.replace('_', '-');
      } catch {
        /* ignore */
      }
    } else {
      try {
        const rel = execSync(`cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2`, {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (rel) osName = rel;
      } catch {
        /* ignore */
      }
      try {
        const win = execSync('xdotool getactivewindow getwindowname', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (win) activeWindow = win;
      } catch {
        /* ignore */
      }
      try {
        const allWinRaw = execSync(
          `xdotool search --onlyvisible --name '' 2>/dev/null | head -15 | xargs -I{} xdotool getwindowname {} 2>/dev/null`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        if (allWinRaw) {
          openWindows = [
            ...new Set(
              allWinRaw
                .split(/\n/)
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ];
        }
      } catch {
        /* ignore */
      }
      try {
        const loc = execSync(`locale | grep '^LANG=' | cut -d= -f2 | cut -d. -f1 | tr '_' '-'`, {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        if (loc) locale = loc;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  return { os: osName, activeWindow, openWindows, screenWidth, screenHeight, locale, currentTime };
}

// === MONITORS ===

export async function getMonitors(): Promise<Monitor[]> {
  try {
    // Warm up the native tool by taking a screenshot first
    await screenshot({ format: 'png' });
    const displays = await (screenshot as any).listDisplays();
    if (displays && displays.length > 1) {
      return displays.map((d: any, i: number) => ({
        id: d.id,
        name: d.name || `Display ${i + 1}`,
      }));
    }
  } catch {
    // single display or tool unavailable
  }
  return [];
}

// === SCREENSHOT ===

const MAX_SCREENSHOT_WIDTH = 1920;
const MAX_SCREENSHOT_HEIGHT = 1080;

export async function takeScreenshot(monitorId?: string | number): Promise<{
  base64: string;
  width: number;
  height: number;
  physWidth: number;
  physHeight: number;
}> {
  const opts: { format: 'png'; screen?: string | number } = { format: 'png' };
  if (monitorId !== undefined) opts.screen = monitorId;
  let img: Buffer = await screenshot(opts);
  let width = img.readUInt32BE(16);
  let height = img.readUInt32BE(20);
  const physWidth = width;
  const physHeight = height;

  // Downscale to reduce token cost when the display exceeds the max resolution
  if (width > MAX_SCREENSHOT_WIDTH || height > MAX_SCREENSHOT_HEIGHT) {
    try {
      img = await (await Jimp.read(img))
        .scaleToFit(MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_HEIGHT, Jimp.RESIZE_BICUBIC)
        .getBufferAsync(Jimp.MIME_PNG);
      width = img.readUInt32BE(16);
      height = img.readUInt32BE(20);
    } catch {
      // use original if resize fails
    }
  }

  return { base64: img.toString('base64'), width, height, physWidth, physHeight };
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// === WIN32 HELPERS ===

/** Run a PowerShell script safely using base64 encoding to avoid quoting issues. */
function runPowerShell(script: string): void {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execSync(`powershell -NonInteractive -NoProfile -EncodedCommand ${encoded}`, { stdio: 'ignore' });
}

/** Run a PowerShell script and capture its stdout output. Returns empty string on failure. */
function runPowerShellCapture(script: string): string {
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return execSync(`powershell -NonInteractive -NoProfile -EncodedCommand ${encoded}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/**
 * Returns the logical screen size (points on macOS, logical pixels on Linux).
 */
function getLogicalScreenSize(p: string): { width: number; height: number } | null {
  try {
    if (p === 'darwin') {
      const out = execSync(
        `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim();
      const parts = out.split(', ').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        return { width: parts[2], height: parts[3] };
      }
    } else if (p === 'linux') {
      const out = execSync('xdpyinfo | grep dimensions', {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/(\d+)x(\d+) pixels/);
      if (m) return { width: parseInt(m[1]), height: parseInt(m[2]) };
    }
  } catch {
    // fall through — no scaling
  }
  return null;
}

/** Shared C# struct definitions for all Win32 mouse operations. */
const WIN32_MOUSE_STRUCTS = [
  '$td = @"',
  'using System; using System.Runtime.InteropServices; using System.Threading;',
  '[StructLayout(LayoutKind.Sequential)]',
  'public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '[StructLayout(LayoutKind.Explicit, Size=40)]',
  'public struct MINPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }',
].join('\n');

/**
 * Move (and optionally click) using SendInput with MOUSEEVENTF_ABSOLUTE.
 * normX/normY must be in the 0-65535 range.
 * downFlag/upFlag = 0 means move only.
 */
function win32Mouse(normX: number, normY: number, downFlag: number, upFlag: number): void {
  const psLines = [
    WIN32_MOUSE_STRUCTS,
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

function win32DoubleClick(normX: number, normY: number): void {
  const psLines = [
    WIN32_MOUSE_STRUCTS,
    'public class W32DC {',
    '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, MINPUT[] i, int cb);',
    '    public static void DblClick(int nx, int ny) {',
    '        MINPUT[] a = new MINPUT[5];',
    '        a[0].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8001 };',
    '        a[1].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8002 };',
    '        a[2].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8004 };',
    '        Thread.Sleep(50);',
    '        a[3].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8002 };',
    '        a[4].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8004 };',
    '        SendInput(5, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(MINPUT)));',
    '    }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $td -ErrorAction SilentlyContinue',
    `[W32DC]::DblClick(${normX}, ${normY})`,
  ];
  runPowerShell(psLines.join('\n'));
}

function win32Drag(normFromX: number, normFromY: number, normToX: number, normToY: number): void {
  const psLines = [
    WIN32_MOUSE_STRUCTS,
    'public class W32DG {',
    '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, MINPUT[] i, int cb);',
    '    public static void Drag(int nx1, int ny1, int nx2, int ny2) {',
    '        MINPUT[] a = new MINPUT[2];',
    '        a[0].mi = new MOUSEINPUT { dx=nx1, dy=ny1, dwFlags=0x8001 };',
    '        a[1].mi = new MOUSEINPUT { dx=nx1, dy=ny1, dwFlags=0x8002 };',
    '        SendInput(2, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(MINPUT)));',
    '        Thread.Sleep(80);',
    '        MINPUT[] b = new MINPUT[2];',
    '        b[0].mi = new MOUSEINPUT { dx=nx2, dy=ny2, dwFlags=0x8001 };',
    '        b[1].mi = new MOUSEINPUT { dx=nx2, dy=ny2, dwFlags=0x8004 };',
    '        SendInput(2, b, System.Runtime.InteropServices.Marshal.SizeOf(typeof(MINPUT)));',
    '    }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $td -ErrorAction SilentlyContinue',
    `[W32DG]::Drag(${normFromX}, ${normFromY}, ${normToX}, ${normToY})`,
  ];
  runPowerShell(psLines.join('\n'));
}

function win32Scroll(normX: number, normY: number, delta: number, horizontal: boolean): void {
  // MOUSEEVENTF_WHEEL=0x0800, MOUSEEVENTF_HWHEEL=0x01000
  // Positive delta = scroll up/right, negative = scroll down/left
  const wheelFlag = horizontal ? 0x01000 : 0x0800;
  const psLines = [
    WIN32_MOUSE_STRUCTS,
    'public class W32SC {',
    '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, MINPUT[] i, int cb);',
    '    public static void Scroll(int nx, int ny, int delta, uint wf) {',
    '        MINPUT[] a = new MINPUT[2];',
    '        a[0].mi = new MOUSEINPUT { dx=nx, dy=ny, dwFlags=0x8001 };',
    '        a[1].mi = new MOUSEINPUT { mouseData=delta, dwFlags=wf };',
    '        SendInput(2, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(MINPUT)));',
    '    }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $td -ErrorAction SilentlyContinue',
    `[W32SC]::Scroll(${normX}, ${normY}, ${delta}, ${wheelFlag})`,
  ];
  runPowerShell(psLines.join('\n'));
}

// VK code map for key_press on Windows
const VK_CODES: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Win: 0x5b,
  Windows: 0x5b,
  LWin: 0x5b,
  RWin: 0x5c,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};
const VK_MODS: Record<string, number> = {
  Ctrl: 0x11,
  Shift: 0x10,
  Alt: 0x12,
  Win: 0x5b,
  Cmd: 0x5b,
};

function resolveVk(key: string): number {
  if (key in VK_CODES) return VK_CODES[key];
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return -1;
}

function win32KeyPress(key: string): void {
  const parts = key.split('+');
  const mainVk = resolveVk(parts[parts.length - 1]);
  if (mainVk < 0) return;
  const modVks = parts
    .slice(0, -1)
    .map((m) => VK_MODS[m] ?? -1)
    .filter((v) => v >= 0);
  const modArray = modVks.length > 0 ? `@(${modVks.join(', ')})` : '@()';

  const psLines = [
    '$kd = @"',
    'using System; using System.Runtime.InteropServices;',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
    '[StructLayout(LayoutKind.Explicit, Size=40)]',
    'public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }',
    'public class W32K {',
    '    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);',
    '    public static void Press(ushort[] mods, ushort key) {',
    '        int n = mods.Length * 2 + 2;',
    '        INPUT[] a = new INPUT[n]; int i = 0;',
    '        foreach (var m in mods) { a[i].type=1; a[i].ki=new KEYBDINPUT{wVk=m,dwFlags=0}; i++; }',
    '        a[i].type=1; a[i].ki=new KEYBDINPUT{wVk=key,dwFlags=0}; i++;',
    '        a[i].type=1; a[i].ki=new KEYBDINPUT{wVk=key,dwFlags=2}; i++;',
    '        foreach (var m in mods) { a[i].type=1; a[i].ki=new KEYBDINPUT{wVk=m,dwFlags=2}; i++; }',
    '        SendInput((uint)n, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));',
    '    }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $kd -ErrorAction SilentlyContinue',
    `[W32K]::Press(${modArray}, ${mainVk})`,
  ];
  runPowerShell(psLines.join('\n'));
}

// macOS key codes for osascript
const MAC_KEY_CODES: Record<string, number> = {
  Enter: 36,
  Tab: 48,
  Escape: 53,
  Backspace: 51,
  Delete: 117,
  Up: 126,
  Down: 125,
  Left: 123,
  Right: 124,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  Space: 49,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
};
const MAC_MODS: Record<string, string> = {
  Ctrl: 'control down',
  Shift: 'shift down',
  Alt: 'option down',
  Cmd: 'command down',
  Win: 'command down',
};

function macKeyPress(key: string): void {
  const parts = key.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts
    .slice(0, -1)
    .map((m) => MAC_MODS[m])
    .filter(Boolean);
  const usingClause = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';

  let keyExpr: string;
  if (mainKey in MAC_KEY_CODES) {
    keyExpr = `key code ${MAC_KEY_CODES[mainKey]}${usingClause}`;
  } else if (mainKey.length === 1) {
    const escaped = mainKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    keyExpr = `keystroke "${escaped}"${usingClause}`;
  } else {
    return; // unknown key
  }

  const script = `tell application "System Events"\n  ${keyExpr}\nend tell`;
  execFileSync('osascript', [], { input: script, stdio: ['pipe', 'ignore', 'ignore'] });
}

// Linux xdotool key name mapping
const XDOTOOL_KEY_NAMES: Record<string, string> = {
  Enter: 'Return',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  Space: 'space',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
};
const XDOTOOL_MODS: Record<string, string> = {
  Ctrl: 'ctrl',
  Shift: 'shift',
  Alt: 'alt',
  Win: 'super',
  Cmd: 'super',
};

function linuxKeyPress(key: string): void {
  const parts = key.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts
    .slice(0, -1)
    .map((m) => XDOTOOL_MODS[m])
    .filter(Boolean);
  const xKey = XDOTOOL_KEY_NAMES[mainKey] ?? (mainKey.length === 1 ? mainKey : null);
  if (!xKey) return;
  const combo = [...modifiers, xKey].join('+');
  execFileSync('xdotool', ['key', '--clearmodifiers', combo]);
}

// === COORDINATE NORMALIZATION ===

function normalizeWin32(coord: number, physSize: number): number {
  return Math.min(65535, Math.round((coord * 65535) / Math.max(physSize - 1, 1)));
}

function scaleToLogical(
  x: number,
  y: number,
  physWidth: number | undefined,
  physHeight: number | undefined,
  logical: { width: number; height: number } | null,
): { lx: number; ly: number } {
  const scaleX = logical && physWidth ? physWidth / logical.width : 1;
  const scaleY = logical && physHeight ? physHeight / logical.height : 1;
  return { lx: Math.round(x / scaleX), ly: Math.round(y / scaleY) };
}

// === EXECUTE ===

export async function executeControlAction(
  action: ControlAction,
  physWidth?: number,
  physHeight?: number,
  signal?: AbortSignal,
  delay?: number,
): Promise<void> {
  if (action.action === 'DONE' || signal?.aborted) return;

  const p = platform();

  if (action.action === 'mouse_move') {
    if (p === 'win32') {
      win32Mouse(
        normalizeWin32(action.x, physWidth ?? 1),
        normalizeWin32(action.y, physHeight ?? 1),
        0,
        0,
      );
    } else if (p === 'darwin') {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execSync(
        `osascript -e 'tell application "System Events" to set cursor position to {${lx}, ${ly}}'`,
        { stdio: 'ignore' },
      );
    } else {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execFileSync('xdotool', ['mousemove', String(lx), String(ly)]);
    }
  } else if (action.action === 'mouse_left_click' || action.action === 'mouse_right_click') {
    const isLeft = action.action === 'mouse_left_click';
    if (p === 'win32') {
      const nx = normalizeWin32(action.x, physWidth ?? 1);
      const ny = normalizeWin32(action.y, physHeight ?? 1);
      const downFlag = isLeft ? 0x8002 : 0x8008;
      const upFlag = isLeft ? 0x8004 : 0x8010;
      win32Mouse(nx, ny, downFlag, upFlag);
    } else if (p === 'darwin') {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      const btn = isLeft ? 'leftClick' : 'rightClick';
      execSync(`osascript -e 'tell application "System Events" to ${btn} at {${lx}, ${ly}}'`, {
        stdio: 'ignore',
      });
    } else {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execFileSync('xdotool', ['mousemove', String(lx), String(ly), 'click', isLeft ? '1' : '3']);
    }
  } else if (action.action === 'mouse_double_click') {
    if (p === 'win32') {
      win32DoubleClick(
        normalizeWin32(action.x, physWidth ?? 1),
        normalizeWin32(action.y, physHeight ?? 1),
      );
    } else if (p === 'darwin') {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execSync(`osascript -e 'tell application "System Events" to doubleClick at {${lx}, ${ly}}'`, {
        stdio: 'ignore',
      });
    } else {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execFileSync('xdotool', [
        'mousemove',
        String(lx),
        String(ly),
        'click',
        '--repeat',
        '2',
        '--delay',
        '100',
        '1',
      ]);
    }
  } else if (action.action === 'mouse_drag') {
    if (p === 'win32') {
      const nfx = normalizeWin32(action.fromX, physWidth ?? 1);
      const nfy = normalizeWin32(action.fromY, physHeight ?? 1);
      const ntx = normalizeWin32(action.toX, physWidth ?? 1);
      const nty = normalizeWin32(action.toY, physHeight ?? 1);
      win32Drag(nfx, nfy, ntx, nty);
    } else if (p === 'darwin') {
      const logical = getLogicalScreenSize(p);
      const { lx: lfx, ly: lfy } = scaleToLogical(
        action.fromX,
        action.fromY,
        physWidth,
        physHeight,
        logical,
      );
      const { lx: ltx, ly: lty } = scaleToLogical(
        action.toX,
        action.toY,
        physWidth,
        physHeight,
        logical,
      );
      const script = [
        'tell application "System Events"',
        `  drag {${lfx}, ${lfy}} to {${ltx}, ${lty}}`,
        'end tell',
      ].join('\n');
      execFileSync('osascript', [], { input: script, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      const logical = getLogicalScreenSize(p);
      const { lx: lfx, ly: lfy } = scaleToLogical(
        action.fromX,
        action.fromY,
        physWidth,
        physHeight,
        logical,
      );
      const { lx: ltx, ly: lty } = scaleToLogical(
        action.toX,
        action.toY,
        physWidth,
        physHeight,
        logical,
      );
      execFileSync('xdotool', [
        'mousemove',
        String(lfx),
        String(lfy),
        'mousedown',
        '1',
        'mousemove',
        String(ltx),
        String(lty),
        'mouseup',
        '1',
      ]);
    }
  } else if (action.action === 'mouse_scroll') {
    const amount = Math.max(1, Math.min(10, action.amount ?? 3));
    const isHoriz = action.direction === 'left' || action.direction === 'right';
    const isPositive = action.direction === 'up' || action.direction === 'right';
    // WHEEL_DELTA = 120 per click; positive = scroll up/right
    const delta = (isPositive ? 120 : -120) * amount;

    if (p === 'win32') {
      win32Scroll(
        normalizeWin32(action.x, physWidth ?? 1),
        normalizeWin32(action.y, physHeight ?? 1),
        delta,
        isHoriz,
      );
    } else if (p === 'darwin') {
      // Move first, then scroll using Python/Quartz
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      execSync(
        `osascript -e 'tell application "System Events" to set cursor position to {${lx}, ${ly}}'`,
        { stdio: 'ignore' },
      );
      // Use python3 with Quartz to post scroll events
      const wheelAxis = isHoriz ? 2 : 1; // axis 1 = vertical, axis 2 = horizontal
      const pyScript = `import Quartz; [Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, ${isPositive ? amount : -amount})) for _ in range(1)]`;
      try {
        execSync(`python3 -c "${pyScript}"`, { stdio: 'ignore' });
      } catch {
        // python3/Quartz not available — skip scroll
      }
      void wheelAxis; // suppress unused warning
    } else {
      const logical = getLogicalScreenSize(p);
      const { lx, ly } = scaleToLogical(action.x, action.y, physWidth, physHeight, logical);
      // xdotool button 4=scroll up, 5=scroll down, 6=scroll left, 7=scroll right
      const btnMap = { up: '4', down: '5', left: '6', right: '7' };
      const btn = btnMap[action.direction];
      execFileSync('xdotool', [
        'mousemove',
        String(lx),
        String(ly),
        'click',
        '--repeat',
        String(amount),
        btn,
      ]);
    }
  } else if (action.action === 'keyboard_input') {
    if (p === 'win32') {
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
      execFileSync('osascript', [], { input: script, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      execFileSync('xdotool', ['type', '--delay', '50', '--clearmodifiers', '--', action.text]);
    }
  } else if (action.action === 'key_press') {
    if (p === 'win32') {
      win32KeyPress(action.key);
    } else if (p === 'darwin') {
      macKeyPress(action.key);
    } else {
      linuxKeyPress(action.key);
    }
  }

  await sleep(getActionDelay(action, delay), signal);
}

/** Check for required OS-level tools. Returns array of missing tool descriptions. */
export function checkControlDependencies(): string[] {
  const p = platform();
  const missing: string[] = [];
  if (p === 'linux') {
    try {
      execSync('which xdotool', { stdio: 'ignore' });
    } catch {
      missing.push('xdotool (install with: sudo apt install xdotool)');
    }
  } else if (p === 'darwin') {
    try {
      execSync('which osascript', { stdio: 'ignore' });
    } catch {
      missing.push('osascript (should be pre-installed on macOS)');
    }
  }
  return missing;
}
