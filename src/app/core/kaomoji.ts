export type KaomojiMood =
  | 'idle'
  | 'typing'
  | 'command'
  | 'thinking'
  | 'printing'
  | 'working'
  | 'approval'
  | 'listening'
  | 'setup'
  | 'error'
  | 'happy';

export const KAOMOJI_BANK: Record<KaomojiMood, readonly string[]> = {
  idle: ['(⌐■_■)', '( •_•)>⌐■-■', '(◕‿◕)', '(◠‿◠)'],
  typing: ['(•‿•)', '(｡◕‿◕｡)', '(◕ᴗ◕✿)'],
  command: ['(☞ﾟヮﾟ)☞', 'ヾ(⌐■_■)ノ♪'],
  thinking: ['(๑•﹏•)', '(・_・ヾ', '( ˘ω˘ )', '(´-ω-`)', '( ´ ▽ ` )'],
  printing: ['(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', 'ヽ(´▽`)/', '╰(*°▽°*)╯', '(≧◡≦)'],
  working: ['(ง •̀_•́)ง', 'ᕦ(ò_óˇ)ᕤ', '(ノ°∀°)ノ'],
  approval: ['(⊙_☉)?', '(・_・;)', '(☞ﾟ∀ﾟ)☞'],
  listening: ['(◉_◉)♪', '(◕‿◕)♫', '(◎_◎)♪'],
  setup: ['(⌐■_■)', '(づ｡◕‿‿◕｡)づ'],
  error: ['(╯°□°）╯︵ ┻━┻', 'ಠ_ಠ', '¯\\_(ツ)_/¯'],
  happy: ['(ﾉ´ヮ`)ﾉ*: ･ﾟ', '(￣▽￣)ノ', 'ʕ•ᴥ•ʔ', '(｡♥‿♥｡)'],
};

export function pickKaomoji(mood: KaomojiMood, index = 0): string {
  const list = KAOMOJI_BANK[mood];
  return list[Math.abs(index) % list.length];
}
