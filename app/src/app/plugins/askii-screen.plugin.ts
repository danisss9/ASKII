import { registerPlugin } from '@capacitor/core';

/**
 * AskiiScreen — screen-control agent on Android: `MediaProjection` for
 * screenshots + an `AccessibilityService` for gesture / keyboard dispatch.
 *
 * Requires the user to grant (1) screen-capture (MediaProjection) and (2) the
 * Accessibility service, on first use. The TS interface the Angular
 * `ControlModeService` calls; the Kotlin implementation lands in a later
 * phase. On web, methods throw a clear "not available" error.
 */

export type ScreenAction =
  | { action: 'mouse_move'; x: number; y: number; reasoning?: string }
  | { action: 'mouse_left_click'; x: number; y: number; reasoning?: string }
  | { action: 'mouse_drag'; fromX: number; fromY: number; toX: number; toY: number; reasoning?: string }
  | { action: 'mouse_scroll'; x: number; y: number; direction: 'up' | 'down'; amount: number; reasoning?: string }
  | { action: 'keyboard_input'; text: string; reasoning?: string }
  | { action: 'key_press'; key: string; reasoning?: string }
  | { action: 'click_text'; text: string; reasoning?: string }
  | { action: 'tap'; x: number; y: number; reasoning?: string };

export interface ScreenScreenshot {
  /** PNG data URL of the screen. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface AskiiScreenPlugin {
  /** Request the runtime permissions (screen capture + accessibility). */
  requestPermissions(): Promise<{ screenCapture: boolean; accessibility: boolean }>;
  /** Capture the current screen. */
  screenshot(): Promise<ScreenScreenshot>;
  /** Dispatch one action. */
  execute(action: ScreenAction): Promise<void>;
}

export const AskiiScreen = registerPlugin<AskiiScreenPlugin>('AskiiScreen', {
  web: async () => {
    const { AskiiScreenWeb } = await import('./askii-screen.web');
    return new AskiiScreenWeb();
  },
});