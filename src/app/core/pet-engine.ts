import { PreviousWindowInfo } from './models';

export type PetEmotion =
  | 'content'
  | 'cool'
  | 'happy'
  | 'sleepy'
  | 'napping'
  | 'waking'
  | 'petted'
  | 'loved'
  | 'ecstatic'
  | 'ticklish'
  | 'eating'
  | 'playful'
  | 'attentive'
  | 'command'
  | 'curious'
  | 'inspecting'
  | 'peeking'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'working'
  | 'approval'
  | 'coding'
  | 'opening'
  | 'vibing'
  | 'proud'
  | 'empathetic'
  | 'comforting'
  | 'determined'
  | 'hurt'
  | 'excited'
  | 'error'
  | 'setup';

export type PetAura =
  | 'blue'
  | 'warm'
  | 'pink'
  | 'mint'
  | 'amber'
  | 'indigo'
  | 'cyan'
  | 'coral';

export type PetMotion =
  | 'breathe'
  | 'squish'
  | 'bounce'
  | 'talk'
  | 'peek'
  | 'float'
  | 'wiggle'
  | 'shake'
  | 'shiver'
  | 'flip'
  | 'pulse'
  | 'sway';

export type PetParticleGlyph = '♡' | '✧' | '♪' | 'zZ' | '?' | '!' | '</>';

export interface PetParticle {
  id: number;
  glyph: PetParticleGlyph;
  offsetX: number;
  variant: 'pink' | 'gold' | 'cyan' | 'indigo' | 'coral' | 'mint';
}

export interface PetVisualSpec {
  frames: readonly string[];
  blinkFrame?: string;
  label: string;
  aura: PetAura;
  motion: PetMotion;
  particle?: PetParticleGlyph;
}

export interface PetVisualState {
  emotion: PetEmotion;
  face: string;
  label: string;
  reason: string;
  aura: PetAura;
  motion: PetMotion;
}

export type DesktopActivityKind = 'coding' | 'vibing' | 'browsing' | 'writing' | 'other';

export interface DesktopActivityInfo {
  kind: DesktopActivityKind;
  appName: string;
}

export interface SentimentResult {
  emotion: PetEmotion;
  affectionDelta: number;
  energyDelta: number;
  reason: string;
  particle?: PetParticleGlyph;
}

export const PET_VISUALS: Record<PetEmotion, PetVisualSpec> = {
  cool: {
    frames: ['(⌐■_■)'],
    blinkFrame: '(⌐–_–)',
    label: 'Chilling',
    aura: 'blue',
    motion: 'breathe',
  },
  content: {
    frames: ['(•‿•)'],
    blinkFrame: '(-‿-)',
    label: 'Content',
    aura: 'blue',
    motion: 'breathe',
  },
  happy: {
    frames: ['(◕‿◕)', '(◠‿◠)'],
    blinkFrame: '(◠‿◠)',
    label: 'Happy',
    aura: 'warm',
    motion: 'bounce',
    particle: '✧',
  },
  sleepy: {
    frames: ['(˘ω˘)', '(´-ω-`)'],
    blinkFrame: '(－_－)',
    label: 'Getting sleepy',
    aura: 'indigo',
    motion: 'float',
  },
  napping: {
    frames: ['(－_－) zZ', '(－_－) zzZ'],
    label: 'Taking a nap',
    aura: 'indigo',
    motion: 'float',
    particle: 'zZ',
  },
  waking: {
    frames: ['(つ﹏⊂)', '(•_•)', '(•‿•)'],
    label: 'Waking up',
    aura: 'warm',
    motion: 'squish',
    particle: '✧',
  },
  petted: {
    frames: ['(｡◕‿◕｡)', '(◡‿◡✿)'],
    label: 'Loves the pets',
    aura: 'pink',
    motion: 'squish',
    particle: '♡',
  },
  loved: {
    frames: ['(≧◡≦)♡', '(｡♥‿♥｡)'],
    label: 'Purring happily',
    aura: 'pink',
    motion: 'bounce',
    particle: '♡',
  },
  ecstatic: {
    frames: ['(ﾉ´ヮ`)ﾉ♡', '╰(*°▽°*)╯'],
    label: 'Overjoyed!',
    aura: 'pink',
    motion: 'bounce',
    particle: '✧',
  },
  ticklish: {
    frames: ['(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(＠_＠;)'],
    label: 'Hehe, ticklish!',
    aura: 'warm',
    motion: 'wiggle',
    particle: '♪',
  },
  eating: {
    frames: ['(•o•)', '(っ˘ڡ˘ς)', '(´～`)', '(◕‿◕)✧'],
    label: 'Munching snack',
    aura: 'amber',
    motion: 'squish',
    particle: '✧',
  },
  playful: {
    frames: ['( •_•)>⌐■-■', '(⌐■_■)✧', '╰(*°▽°*)╯'],
    label: 'Feeling playful',
    aura: 'cyan',
    motion: 'flip',
    particle: '♪',
  },
  attentive: {
    frames: ['(•‿•)»'],
    blinkFrame: '(-‿-)»',
    label: 'Listening to you',
    aura: 'blue',
    motion: 'breathe',
  },
  command: {
    frames: ['(☞ﾟヮﾟ)☞'],
    blinkFrame: '(☞-ヮ-)☞',
    label: 'Ready to run',
    aura: 'cyan',
    motion: 'pulse',
  },
  curious: {
    frames: ['(•_•)?', '(◕_◕)?'],
    blinkFrame: '(-_-)?',
    label: 'Curious',
    aura: 'cyan',
    motion: 'breathe',
    particle: '?',
  },
  inspecting: {
    frames: ['(⊙_⊙)', '(◉_◉)'],
    label: 'Ooh, what is that?',
    aura: 'mint',
    motion: 'peek',
    particle: '✧',
  },
  peeking: {
    frames: ['(◎_◎)', '(◉_◉)✧', '(◕‿◕)✧'],
    label: 'Peeking at your screen',
    aura: 'amber',
    motion: 'peek',
    particle: '✧',
  },
  listening: {
    frames: ['(◕_◕)♪', '(◉_◉)♫'],
    label: 'Listening to your voice',
    aura: 'mint',
    motion: 'pulse',
    particle: '♪',
  },
  thinking: {
    frames: ['(・_・)', '(・_・;)', '( ˘•ω•˘ )'],
    label: 'Thinking…',
    aura: 'blue',
    motion: 'pulse',
  },
  talking: {
    frames: ['(•‿•)', '(•o•)', '(•▽•)'],
    label: 'Talking to you',
    aura: 'mint',
    motion: 'talk',
  },
  working: {
    frames: ['(ง •̀_•́)ง', 'ᕦ(ò_óˇ)ᕤ'],
    label: 'On the job!',
    aura: 'amber',
    motion: 'bounce',
    particle: '✧',
  },
  approval: {
    frames: ['(⊙_☉)?', '(・_・;)?'],
    label: 'Waiting for your okay',
    aura: 'amber',
    motion: 'wiggle',
    particle: '?',
  },
  coding: {
    frames: ['(⌐■_■)'],
    blinkFrame: '(⌐–_–)',
    label: 'Coding with you',
    aura: 'cyan',
    motion: 'breathe',
    particle: '</>',
  },
  opening: {
    frames: ['(☞ﾟヮﾟ)☞', '╰(°▽°)╯'],
    label: 'Opening it up!',
    aura: 'mint',
    motion: 'bounce',
    particle: '✧',
  },
  vibing: {
    frames: ['(⌐■_■)♪', '(•‿•)♫'],
    blinkFrame: '(⌐–_–)♪',
    label: 'Vibing along',
    aura: 'cyan',
    motion: 'sway',
    particle: '♪',
  },
  proud: {
    frames: ['(￣▽￣)✧', '(⌐■_■)✧'],
    blinkFrame: '(￣-￣)✧',
    label: 'Feeling proud',
    aura: 'amber',
    motion: 'bounce',
    particle: '✧',
  },
  empathetic: {
    frames: ['(•́︿•̀)', '(´• ω •`)'],
    blinkFrame: '(－︿－)',
    label: 'Here with you',
    aura: 'indigo',
    motion: 'breathe',
  },
  comforting: {
    frames: ['(っ´ω`)っ', '(´• ω •`)♡'],
    blinkFrame: '(っ-ω-)っ',
    label: 'Sending comfort',
    aura: 'warm',
    motion: 'sway',
    particle: '♡',
  },
  determined: {
    frames: ['(ง •̀_•́)ง', '(•̀_•́)و'],
    blinkFrame: '(–̀_–́)و',
    label: 'Let’s fix this!',
    aura: 'amber',
    motion: 'pulse',
    particle: '!',
  },
  hurt: {
    frames: ['(｡•́︿•̀｡)', '(・へ・)'],
    blinkFrame: '(－へ－)',
    label: 'A little pouty…',
    aura: 'indigo',
    motion: 'shiver',
  },
  excited: {
    frames: ['(ﾉ◕ヮ◕)ﾉ✧', '╰(*°▽°*)╯'],
    blinkFrame: '(ﾉ◠ヮ◠)ﾉ✧',
    label: 'Excited!',
    aura: 'amber',
    motion: 'bounce',
    particle: '✧',
  },
  error: {
    frames: ['(╯°□°）╯︵ ┻━┻', '(×_×;)'],
    label: 'Oops, hit a snag',
    aura: 'coral',
    motion: 'shake',
    particle: '!',
  },
  setup: {
    frames: ['(づ｡◕‿‿◕｡)づ', '(⌐■_■)'],
    blinkFrame: '(づ｡-‿‿-｡)づ',
    label: 'Setting things up',
    aura: 'blue',
    motion: 'breathe',
  },
};

export function getTalkingFrames(
  conversationalEmotion: PetEmotion | null,
  shadesOn: boolean,
): readonly string[] {
  switch (conversationalEmotion) {
    case 'loved':
    case 'happy':
    case 'proud':
    case 'excited':
      return ['(◕‿◕)', '(◕o◕)', '(◕▽◕)'];
    case 'playful':
      return ['(≧▽≦)', '(≧o≦)', '(≧◡≦)'];
    case 'comforting':
    case 'empathetic':
      return ['(´• ω •`)', '(´• o •`)', '(´• ‿ •`)'];
    case 'determined':
      return ['(•̀_•́)', '(•̀o•́)', '(•̀▽•́)'];
    case 'hurt':
      return ['(・へ・)', '(・o・)', '(・_・)'];
    case 'coding':
      return shadesOn ? ['(⌐■_■)', '(⌐■o■)', '(⌐■‿■)'] : ['(•̀_•́)', '(•̀o•́)', '(•̀‿•́)'];
    default:
      return shadesOn ? ['(⌐■_■)', '(⌐■o■)', '(⌐■▽■)'] : ['(•‿•)', '(•o•)', '(•▽•)'];
  }
}

export function getParticleVariant(glyph: PetParticleGlyph): PetParticle['variant'] {
  switch (glyph) {
    case '♡':
      return 'pink';
    case '✧':
      return 'gold';
    case '♪':
    case '</>':
    case '?':
      return 'cyan';
    case 'zZ':
      return 'indigo';
    case '!':
      return 'coral';
  }
}

const CODING_PROCESSES = new Set([
  'code',
  'code - insiders',
  'cursor',
  'windsurf',
  'antigravity',
  'devenv',
  'rider64',
  'rider',
  'idea64',
  'webstorm64',
  'pycharm64',
  'clion64',
  'rustrover64',
  'goland64',
  'phpstorm64',
  'zed',
  'nvim',
  'nvim-qt',
  'gvim',
  'sublime_text',
  'notepad++',
  'windowsterminal',
  'wt',
  'powershell',
  'pwsh',
  'cmd',
  'alacritty',
  'wezterm-gui',
  'warp',
  'mintty',
  'githubdesktop',
  'gitkraken',
  'fork',
  'postman',
  'insomnia',
  'dbeaver',
]);

const VIBING_PROCESSES = new Set([
  'spotify',
  'vlc',
  'mpv',
  'music.ui',
  'foobar2000',
  'itunes',
  'tidal',
  'steam',
  'steamwebhelper',
  'epicgameslauncher',
  'discord',
]);

const BROWSING_PROCESSES = new Set([
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'arc',
  'opera',
  'zen',
  'vivaldi',
  'waterfox',
]);

const WRITING_PROCESSES = new Set([
  'winword',
  'obsidian',
  'notion',
  'slack',
  'ms-teams',
  'teams',
  'telegram',
  'whatsapp',
  'notepad',
  'onenote',
]);

export function classifyDesktopActivity(win: PreviousWindowInfo | null): DesktopActivityInfo {
  if (!win) {
    return { kind: 'other', appName: '' };
  }
  const proc = win.processName.trim().toLowerCase().replace(/\.exe$/i, '');
  const title = win.title.toLowerCase();
  const appName = win.processName.trim() || win.title;

  if (
    CODING_PROCESSES.has(proc) ||
    /\b(visual studio|vs code|jetbrains|github|gitlab|pull request|localhost:\d+)\b/i.test(title) ||
    /\.(ts|tsx|js|jsx|rs|py|go|cpp|c|cs|java|scss|html|json|toml|sql)\b/i.test(title)
  ) {
    return { kind: 'coding', appName };
  }

  if (
    VIBING_PROCESSES.has(proc) ||
    /\b(youtube|spotify|twitch|netflix|soundcloud|music)\b/i.test(title)
  ) {
    return { kind: 'vibing', appName };
  }

  if (WRITING_PROCESSES.has(proc)) {
    return { kind: 'writing', appName };
  }

  if (BROWSING_PROCESSES.has(proc)) {
    return { kind: 'browsing', appName };
  }

  return { kind: 'other', appName };
}

const RE_SCOLD =
  /\b(shut up|stupid|dumb|useless|idiot|bad askii|bad bot|hate you|go away|worst|trash|sucks?)\b/i;
const RE_APOLOGY = /\b(sorry|my bad|apologize|forgive me|didn'?t mean)\b/i;
const RE_LOVE_PRAISE =
  /(<3|♥|❤|\b(love you|good boy|good girl|good pet|good job|great job|well done|nice work|thank you|thanks|thx|ty|you'?re (the best|awesome|amazing|cute|sweet|great|helpful)|best assistant|pat pat|headpat)\b)/i;
const RE_GOODNIGHT = /\b(good\s?night|gn|sleep well|going to bed|bedtime)\b/i;
const RE_GREETING =
  /^\s*(hi|hey|hello|yo|sup|howdy|good morning|morning|good afternoon|good evening|hola|what'?s up)\b/i;
const RE_SAD_TIRED =
  /\b(sad|tired|exhausted|stressed|overwhelmed|depressed|anxious|lonely|burned? out|rough day|bad day|exhausting|sigh|ugh|headache)\b/i;
const RE_FRUSTRATED_BUG =
  /\b(bug|bugs|error|errors|crash|crashed|crashing|broken|exception|panic|segfault|failing|failed|doesn'?t work|not working|won'?t work|stuck|wtf|annoying|frustrat(ed|ing)|fix this)\b/i;
const RE_PLAYFUL = /\b(haha+|hehe+|lol|lmao|rofl|joke|funny|meme|pun|xd)\b/i;
const RE_EXCITED =
  /(!!+|\b(whoa|wow|omg|yay|woohoo|awesome|insane|no way|let'?s go|hell yeah|finally worked)\b)/i;
const RE_CODING =
  /\b(code|coding|debug|refactor|typescript|javascript|rust|python|powershell|regex|compile|compiler|git|docker|sql|css|html|angular|tauri|api|endpoint|function|component|script|algorithm)\b/i;
const RE_CURIOUS = /(\?\s*$|^\s*(why|how|what|when|where|who|explain|can you explain)\b)/i;

export function analyzeUserSentiment(
  input: string,
  currentEmotion?: PetEmotion | null,
): SentimentResult | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  if (RE_SCOLD.test(text)) {
    return {
      emotion: 'hurt',
      affectionDelta: -10,
      energyDelta: -3,
      reason: 'Feeling a bit hurt…',
    };
  }

  if (RE_APOLOGY.test(text)) {
    if (currentEmotion === 'hurt') {
      return {
        emotion: 'loved',
        affectionDelta: 12,
        energyDelta: 4,
        reason: 'All forgiven!',
        particle: '♡',
      };
    }
    return {
      emotion: 'comforting',
      affectionDelta: 4,
      energyDelta: 0,
      reason: 'No worries at all',
      particle: '♡',
    };
  }

  if (RE_LOVE_PRAISE.test(text)) {
    return {
      emotion: 'loved',
      affectionDelta: 10,
      energyDelta: 5,
      reason: 'Feeling appreciated!',
      particle: '♡',
    };
  }

  if (RE_GOODNIGHT.test(text)) {
    return {
      emotion: 'sleepy',
      affectionDelta: 4,
      energyDelta: -5,
      reason: 'Wishing you goodnight',
      particle: 'zZ',
    };
  }

  if (RE_SAD_TIRED.test(text)) {
    return {
      emotion: 'comforting',
      affectionDelta: 4,
      energyDelta: 0,
      reason: 'Here to cheer you up',
      particle: '♡',
    };
  }

  if (RE_PLAYFUL.test(text)) {
    return {
      emotion: 'playful',
      affectionDelta: 5,
      energyDelta: 3,
      reason: 'Amused!',
      particle: '♪',
    };
  }

  if (RE_FRUSTRATED_BUG.test(text)) {
    return {
      emotion: 'determined',
      affectionDelta: 2,
      energyDelta: 2,
      reason: 'Ready to squash bugs',
      particle: '!',
    };
  }

  if (RE_EXCITED.test(text)) {
    return {
      emotion: 'excited',
      affectionDelta: 6,
      energyDelta: 6,
      reason: 'Hyped up!',
      particle: '✧',
    };
  }

  if (RE_GREETING.test(text)) {
    return {
      emotion: 'happy',
      affectionDelta: 4,
      energyDelta: 3,
      reason: 'Happy to see you!',
      particle: '✧',
    };
  }

  if (RE_CODING.test(text)) {
    return {
      emotion: 'coding',
      affectionDelta: 2,
      energyDelta: 0,
      reason: 'Locked into code mode',
      particle: '</>',
    };
  }

  if (RE_CURIOUS.test(text)) {
    return {
      emotion: 'curious',
      affectionDelta: 1,
      energyDelta: 0,
      reason: 'Intrigued by your question',
      particle: '?',
    };
  }

  return null;
}

export function analyzeLiveTypingTone(input: string): PetEmotion | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  if (text.startsWith('/') || text.includes('@')) {
    return 'command';
  }
  if (RE_LOVE_PRAISE.test(text)) {
    return 'happy';
  }
  if (RE_SCOLD.test(text)) {
    return 'hurt';
  }
  if (RE_SAD_TIRED.test(text)) {
    return 'empathetic';
  }
  if (RE_PLAYFUL.test(text)) {
    return 'playful';
  }
  if (text.endsWith('?')) {
    return 'curious';
  }
  if (text.endsWith('!')) {
    return 'excited';
  }
  return 'attentive';
}
