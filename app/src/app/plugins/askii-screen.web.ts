import type { AskiiScreenPlugin, ScreenAction, ScreenScreenshot } from './askii-screen.plugin';

/** Web fallback — screen control needs Android MediaProjection + AccessibilityService. */
export class AskiiScreenWeb implements AskiiScreenPlugin {
  async requestPermissions(): Promise<{ screenCapture: boolean; accessibility: boolean }> {
    return { screenCapture: false, accessibility: false };
  }
  async screenshot(): Promise<ScreenScreenshot> {
    throw new Error('AskiiScreen requires the Android native plugin (not available on web).');
  }
  async execute(_action: ScreenAction): Promise<void> {
    throw new Error('AskiiScreen requires the Android native plugin (not available on web).');
  }
}