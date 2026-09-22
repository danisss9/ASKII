import assert from 'assert';
import test from 'node:test';
import {
  buildFfmpegCandidates,
  buildVoiceInputArgs,
  buildVoiceRecordArgs,
  lufsToLevel,
  parseDshowAudioDevices,
  parseEbur128Momentary,
  pickVoiceDevice,
  VOICE_LUFS_FLOOR,
  VOICE_MAX_SECONDS,
} from '../common/voice';

// ── buildVoiceInputArgs ───────────────────────────────────────────────────────

test('buildVoiceInputArgs uses dshow on win32 with the given device', () => {
  assert.deepStrictEqual(buildVoiceInputArgs('win32', 'Microphone Array (Realtek Audio)'), [
    '-f',
    'dshow',
    '-rtbufsize',
    '64M',
    '-i',
    'audio=Microphone Array (Realtek Audio)',
  ]);
});

test('buildVoiceInputArgs falls back to a default dshow device name on win32', () => {
  assert.deepStrictEqual(buildVoiceInputArgs('win32'), [
    '-f',
    'dshow',
    '-rtbufsize',
    '64M',
    '-i',
    'audio=Microphone',
  ]);
});

test('buildVoiceInputArgs uses avfoundation :0 on macOS and pulse default on linux', () => {
  assert.deepStrictEqual(buildVoiceInputArgs('darwin'), ['-f', 'avfoundation', '-i', ':0']);
  assert.deepStrictEqual(buildVoiceInputArgs('linux'), ['-f', 'pulse', '-i', 'default']);
});

// ── buildVoiceRecordArgs ──────────────────────────────────────────────────────

test('buildVoiceRecordArgs records 16 kHz mono opus/webm with the ebur128 meter', () => {
  const args = buildVoiceRecordArgs('linux', undefined, '/tmp/note.webm', 600);
  assert.strictEqual(args[0], '-y');
  assert.ok(args.includes('ebur128'));
  const arIdx = args.indexOf('-ar');
  assert.strictEqual(args[arIdx + 1], '16000');
  const acIdx = args.indexOf('-ac');
  assert.strictEqual(args[acIdx + 1], '1');
  const codecIdx = args.indexOf('-c:a');
  assert.strictEqual(args[codecIdx + 1], 'libopus');
  const tIdx = args.indexOf('-t');
  assert.strictEqual(args[tIdx + 1], String(VOICE_MAX_SECONDS));
  assert.strictEqual(args[args.length - 3], '-f');
  assert.strictEqual(args[args.length - 2], 'webm');
  assert.strictEqual(args[args.length - 1], '/tmp/note.webm');
});

test('buildVoiceRecordArgs floors fractional and clamps tiny max durations', () => {
  const tValue = (args: string[]) => args[args.indexOf('-t') + 1];
  assert.strictEqual(tValue(buildVoiceRecordArgs('linux', undefined, 'out.webm', 12.9)), '12');
  assert.strictEqual(tValue(buildVoiceRecordArgs('linux', undefined, 'out.webm', 0)), '1');
});

// ── parseEbur128Momentary / lufsToLevel ───────────────────────────────────────

test('parseEbur128Momentary extracts the momentary LUFS value', () => {
  const line =
    '[Parsed_ebur128_0 @ 0000026c4e61d340] t: 1.23456      TARGET:-23 LUFS        M: -18.5 S: -20.1     I: -25.0 LUFS';
  assert.strictEqual(parseEbur128Momentary(line), -18.5);
});

test('parseEbur128Momentary maps digital silence to -Infinity and ignores other lines', () => {
  assert.strictEqual(
    parseEbur128Momentary('[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M: -inf S: -inf'),
    -Infinity,
  );
  assert.strictEqual(parseEbur128Momentary('[dshow @ 0x2] "Microphone Array"'), null);
  assert.strictEqual(parseEbur128Momentary('  Alternative name "@device_cm_{...}"'), null);
  assert.strictEqual(parseEbur128Momentary(''), null);
});

test('lufsToLevel maps LUFS onto a clamped 0..1 scale', () => {
  assert.strictEqual(lufsToLevel(VOICE_LUFS_FLOOR), 0);
  assert.strictEqual(lufsToLevel(0), 1);
  assert.strictEqual(lufsToLevel(-25), 0.5);
  assert.strictEqual(lufsToLevel(-60), 0); // below the floor
  assert.strictEqual(lufsToLevel(10), 1); // above the ceiling
  assert.strictEqual(lufsToLevel(-Infinity), 0); // digital silence
});

// ── parseDshowAudioDevices / pickVoiceDevice ──────────────────────────────────

const DSHOW_STDERR = [
  '[dshow @ 000001f8c5a5e000] DirectShow video devices (some may be both video and audio devices)',
  '[dshow @ 000001f8c5a5e000] "Integrated Webcam"',
  '[dshow @ 000001f8c5a5e000] Alternative name "@device_pnp_\\\\?\\usb#vid_1bcf&pid_28c0"',
  '[dshow @ 000001f8c5a5e000] DirectShow audio devices',
  '[dshow @ 000001f8c5a5e000] "Stereo Mix (Realtek(R) Audio)"',
  '[dshow @ 000001f8c5a5e000] Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{4}"',
  '[dshow @ 000001f8c5a5e000] "Microphone Array (Realtek(R) Audio)"',
  '[dshow @ 000001f8c5a5e000] Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{7}"',
  '[dshow @ 000001f8c5a5e000] "Headset Mic (Jabra Evolve)"',
  '[dshow @ 000001f8c5a5e000]  Some device without a quoted name',
].join('\r\n');

test('parseDshowAudioDevices lists only audio devices with their monikers', () => {
  const devices = parseDshowAudioDevices(DSHOW_STDERR);
  assert.strictEqual(devices.length, 3);
  assert.deepStrictEqual(devices[0], {
    name: 'Stereo Mix (Realtek(R) Audio)',
    alt: '@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{4}',
  });
  assert.strictEqual(devices[1].name, 'Microphone Array (Realtek(R) Audio)');
  assert.strictEqual(devices[2].name, 'Headset Mic (Jabra Evolve)');
  // Video devices above the audio header are excluded.
  assert.ok(!devices.some((d) => d.name === 'Integrated Webcam'));
});

test('parseDshowAudioDevices returns empty when there is no audio section', () => {
  assert.deepStrictEqual(parseDshowAudioDevices('ffmpeg version 7.1'), []);
});

test('pickVoiceDevice prefers a microphone over the first listed device', () => {
  const devices = parseDshowAudioDevices(DSHOW_STDERR);
  const picked = pickVoiceDevice(devices);
  assert.ok(picked);
  assert.strictEqual(picked.name, 'Microphone Array (Realtek(R) Audio)');
});

test('pickVoiceDevice falls back to the first device and handles empty lists', () => {
  assert.strictEqual(pickVoiceDevice([{ name: 'Line In' }])?.name, 'Line In');
  assert.strictEqual(pickVoiceDevice([]), undefined);
});

// ── buildFfmpegCandidates ─────────────────────────────────────────────────────

test('buildFfmpegCandidates puts FFMPEG_PATH and PATH first on win32', () => {
  const env = {
    FFMPEG_PATH: 'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    LOCALAPPDATA: 'C:\\Users\\dani\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
  };
  const candidates = buildFfmpegCandidates('win32', env);
  assert.strictEqual(candidates[0], 'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe');
  assert.strictEqual(candidates[1], 'ffmpeg');
  assert.ok(
    candidates.includes('C:\\Users\\dani\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'),
  );
  assert.ok(candidates.includes('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'));
  assert.ok(candidates.includes('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'));
  assert.ok(candidates.includes('C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'));
});

test('buildFfmpegCandidates probes homebrew paths on darwin', () => {
  const candidates = buildFfmpegCandidates('darwin', {});
  assert.deepStrictEqual(candidates, [
    'ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ]);
});
