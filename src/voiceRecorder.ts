import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  buildFfmpegCandidates,
  buildVoiceRecordArgs,
  parseDshowAudioDevices,
  parseEbur128Momentary,
  lufsToLevel,
  pickVoiceDevice,
  VOICE_MAX_SECONDS,
} from '@common/voice';

/**
 * Microphone capture for ASKII Note voice input. VS Code webviews cannot use
 * `getUserMedia`, so we spawn ffmpeg in the extension host: it records 16 kHz
 * mono Opus/WebM to a file under global storage and prints ebur128 momentary
 * loudness on stderr ~10x/second, which we parse and forward to the webview
 * as normalized 0..1 levels for the live volume meter.
 */

export interface VoiceRecording {
  /** Gracefully stop (finalizes the container) and return the audio file path. */
  stop(): Promise<string>;
  /** Stop and delete the recording without transcribing it. */
  cancel(): Promise<void>;
  /** Notified when ffmpeg exits on its own (duration cap reached, device lost). */
  onAutoEnd(cb: () => void): void;
}

// ── ffmpeg resolution ────────────────────────────────────────────────────────

let ffmpegPathCache: string | undefined;
let dshowDeviceCache: string | undefined;

interface RunResult {
  code: number | null;
  stderr: string;
}

/** Runs ffmpeg to completion, collecting stderr (device listing exits non-zero by design). */
function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function probeFfmpeg(bin: string): Promise<boolean> {
  try {
    const { code } = await runFfmpeg(bin, ['-version'], 8000);
    return code === 0;
  } catch {
    return false;
  }
}

export async function resolveFfmpeg(): Promise<string> {
  if (ffmpegPathCache) return ffmpegPathCache;
  const configured = vscode.workspace.getConfiguration('askii').get<string>('ffmpegPath') || '';
  const candidates = configured
    ? [configured, ...buildFfmpegCandidates(process.platform, process.env)]
    : buildFfmpegCandidates(process.platform, process.env);
  for (const candidate of candidates) {
    if (await probeFfmpeg(candidate)) {
      ffmpegPathCache = candidate;
      return candidate;
    }
  }
  throw new Error(
    'ffmpeg was not found — voice input needs it to capture the microphone. ' +
      'Install it (e.g. `winget install ffmpeg`) or set askii.ffmpegPath.',
  );
}

/** Windows needs an exact DirectShow device name; list once and cache it. */
async function resolveDshowDevice(ffmpeg: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  if (dshowDeviceCache) return dshowDeviceCache;
  const { stderr } = await runFfmpeg(
    ffmpeg,
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    10_000,
  );
  const device = pickVoiceDevice(parseDshowAudioDevices(stderr));
  if (!device) {
    throw new Error(
      'No microphone was found. Connect an input device (or check Windows sound settings) and try again.',
    );
  }
  // The moniker is stable across locale / device renames; fall back to the name.
  dshowDeviceCache = device.alt ?? device.name;
  return dshowDeviceCache;
}

// ── Recording ────────────────────────────────────────────────────────────────

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.finally(() => clearTimeout(timer));
  });
}

/**
 * Starts a dictation recording. Resolves once the mic is confirmed live (the
 * first ebur128 loudness line arrived, or a short warm-up elapsed) so device
 * failures reject here instead of surfacing on stop.
 */
export async function startVoiceRecording(
  context: vscode.ExtensionContext,
  onLevel: (level: number) => void,
): Promise<VoiceRecording> {
  const ffmpeg = await resolveFfmpeg();
  const device = await resolveDshowDevice(ffmpeg);

  const dir = path.join(context.globalStorageUri.fsPath, 'notes-voice');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`);

  const proc = spawn(
    ffmpeg,
    buildVoiceRecordArgs(process.platform, device, file, VOICE_MAX_SECONDS),
    {
      // stdin ignored: we stop via SIGTERM (ffmpeg's graceful signal), and on
      // Windows ffmpeg only reads interactive 'q' commands from a console anyway.
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );

  let stderrTail = '';
  let stopped = false;
  let sawAudio = false;
  let autoEndCb: (() => void) | undefined;
  let warmResolve: (() => void) | undefined;
  let warmReject: ((err: Error) => void) | undefined;

  const exited = new Promise<number | null>((resolveExit) => {
    proc.on('exit', (code) => {
      resolveExit(code);
      if (!stopped && !sawAudio && warmReject) {
        warmReject(
          new Error(
            `Microphone capture failed: ${sanitizeTail(stderrTail) || `ffmpeg exited with code ${code}`}`,
          ),
        );
      } else if (!stopped && autoEndCb) {
        autoEndCb();
      }
    });
  });

  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
    for (const line of chunk.split(/\r?\n/)) {
      const momentary = parseEbur128Momentary(line);
      if (momentary !== null) {
        if (!sawAudio) {
          sawAudio = true;
          warmResolve?.();
        }
        onLevel(lufsToLevel(momentary));
      }
    }
  });
  proc.on('error', (err) => warmReject?.(new Error(`Could not start ffmpeg: ${err.message}`)));

  // Warm-up: resolve on the first loudness line (audio confirmed flowing),
  // reject on an early exit (device failure), or resolve after a timeout with
  // the process still alive. Settled promises make later warm callbacks no-ops.
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => clearTimeout(timer);
      warmResolve = () => {
        settle();
        resolve();
      };
      warmReject = (err: Error) => {
        settle();
        reject(err);
      };
      timer = setTimeout(resolve, 2500);
    });
  } catch (err) {
    // Device failure before any audio — drop the (empty/partial) file.
    await fsp.rm(file, { force: true }).catch(() => undefined);
    throw err;
  }

  async function finalize(): Promise<string> {
    if (proc.exitCode === null) {
      // SIGTERM is a graceful stop for ffmpeg on POSIX — its signal handler
      // finalizes the container (writes the WebM trailer). On Windows Node can
      // only hard-kill, which truncated WebM files survive (no trailer needed).
      proc.kill('SIGTERM');
      await withTimeout(exited, 3000);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await exited.catch(() => undefined);
      }
    }
    const stat = await fsp.stat(file).catch(() => undefined);
    if (!stat || stat.size < 1024) {
      await fsp.rm(file, { force: true });
      throw new Error(
        'No audio was captured — the recording was too short or the microphone produced silence.',
      );
    }
    return file;
  }

  return {
    stop: () => {
      stopped = true;
      onLevel(0);
      return finalize();
    },
    cancel: async () => {
      stopped = true;
      try {
        const f = await finalize();
        await fsp.rm(f, { force: true });
      } catch {
        await fsp.rm(file, { force: true }).catch(() => undefined);
      }
    },
    onAutoEnd: (cb) => {
      autoEndCb = cb;
    },
  };
}

function sanitizeTail(tail: string): string {
  return tail
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]\s*/g, '').trim())
    .filter((l) => l && !/^t:/.test(l) && !/LUFS/.test(l))
    .slice(-2)
    .join(' — ');
}
