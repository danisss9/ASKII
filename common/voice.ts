import * as path from 'path';

/**
 * Pure helpers for ASKII Note voice input. VS Code webviews cannot use
 * `getUserMedia` (the webview iframe carries no `allow="microphone"` and the
 * Electron permission handler denies media for `vscode-webview://` origins),
 * so the microphone is captured by an `ffmpeg` child process in the extension
 * host. These helpers build the command line and parse its output — all
 * platform-parametric and free of `vscode` imports so they stay testable and
 * reusable from the CLI.
 */

/** Hard cap for a single dictation, in seconds (safety valve for runaway recordings). */
export const VOICE_MAX_SECONDS = 600;

/** Momentary loudness mapped to 0 at this LUFS floor (quiet room noise sits below it). */
export const VOICE_LUFS_FLOOR = -50;

export interface DshowAudioDevice {
  /** Friendly device name as printed by ffmpeg (`-list_devices true`). */
  name: string;
  /** Stable DirectShow moniker (`@device_cm_...`), preferred over the name. */
  alt?: string;
}

/**
 * ffmpeg input args that select the platform microphone. On Windows `device`
 * is the DirectShow audio device (name or moniker); macOS uses AVFoundation
 * audio index 0 (default input) and Linux uses the PulseAudio default source.
 */
export function buildVoiceInputArgs(platform: NodeJS.Platform, device?: string): string[] {
  if (platform === 'win32') {
    return ['-f', 'dshow', '-rtbufsize', '64M', '-i', `audio=${device ?? 'Microphone'}`];
  }
  if (platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', ':0'];
  }
  return ['-f', 'pulse', '-i', 'default'];
}

/**
 * Full ffmpeg argv for a dictation recording: 16 kHz mono Opus in WebM with
 * the `ebur128` loudness filter in the chain. The filter passes audio through
 * unchanged but prints momentary-loudness lines on stderr roughly every
 * 100 ms — the host parses those for the live volume meter and forwards them
 * to the webview as normalized levels.
 *
 * WebM/Opus survives a hard kill without a trailer the way mp4 does not, and
 * is accepted by OpenAI-compatible `/audio/transcriptions` endpoints.
 */
export function buildVoiceRecordArgs(
  platform: NodeJS.Platform,
  device: string | undefined,
  outFile: string,
  maxSeconds: number,
): string[] {
  return [
    '-y',
    '-hide_banner',
    ...buildVoiceInputArgs(platform, device),
    '-vn',
    '-af',
    'ebur128',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libopus',
    '-b:a',
    '32k',
    '-t',
    String(Math.max(1, Math.floor(maxSeconds))),
    '-f',
    'webm',
    outFile,
  ];
}

/**
 * Extracts the momentary loudness (LUFS) from one stderr line of the ebur128
 * filter, e.g.:
 * `[Parsed_ebur128_0 @ 0x...] t: 1.2 TARGET:-23 LUFS    M: -18.5 S: -20.1 I: ...`
 * Returns `-Infinity` for digital silence (`-inf`) and `null` when the line
 * carries no momentary value.
 */
export function parseEbur128Momentary(line: string): number | null {
  const m = /(?:^|[\s[])M:\s*(-?\d+(?:\.\d+)?|-?inf)/.exec(line);
  if (!m) return null;
  if (m[1].endsWith('inf')) return -Infinity;
  const value = parseFloat(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** Maps a momentary LUFS value to a 0..1 meter level using {@link VOICE_LUFS_FLOOR}. */
export function lufsToLevel(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0;
  const t = (lufs - VOICE_LUFS_FLOOR) / -VOICE_LUFS_FLOOR;
  return Math.min(1, Math.max(0, t));
}

/**
 * Parses the "DirectShow audio devices" section of ffmpeg's
 * `-list_devices true -f dshow -i dummy` stderr output. Video devices listed
 * above the audio section are ignored.
 */
export function parseDshowAudioDevices(stderr: string): DshowAudioDevice[] {
  const header = stderr.indexOf('DirectShow audio devices');
  if (header === -1) return [];
  const section = stderr.slice(header);
  const devices: DshowAudioDevice[] = [];
  const re =
    /\[dshow[^\]]*\]\s+"([^"\r\n]+)"(?:\s*\r?\n\[dshow[^\]]*\]\s+Alternative name\s+"([^"\r\n]+)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    devices.push({ name: m[1], alt: m[2] });
  }
  return devices;
}

/** Picks the most likely dictation device: an explicit microphone, else the first. */
export function pickVoiceDevice(devices: DshowAudioDevice[]): DshowAudioDevice | undefined {
  if (devices.length === 0) return undefined;
  return devices.find((d) => /microphone|mic\b|headset/i.test(d.name)) ?? devices[0];
}

/**
 * ffmpeg executable candidates in preference order (like the browser
 * detection in common/browser.ts). Pure and platform-parametric — never use
 * the host `path.join` here, tests assert exact strings per platform.
 */
export function buildFfmpegCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  const candidates: string[] = [];
  if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
  candidates.push('ffmpeg'); // resolved from PATH by the OS
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env['ProgramFiles(x86)'];
    const chocolatey = env.ChocolateyInstall;
    if (local) {
      candidates.push(path.win32.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    }
    if (chocolatey) candidates.push(path.win32.join(chocolatey, 'bin', 'ffmpeg.exe'));
    candidates.push('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe');
    if (programFiles) candidates.push(path.win32.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    if (programFilesX86) {
      candidates.push(path.win32.join(programFilesX86, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  } else if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  }
  return candidates;
}
