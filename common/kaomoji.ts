export const kaomojis = [
  '(◕‿◕)',
  'ヽ(´▽`)/',
  '(｡◕‿◕｡)',
  '(づ｡◕‿‿◕｡)づ',
  'ʕ•ᴥ•ʔ',
  '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
  '(◕ᴗ◕✿)',
  '(｡♥‿♥｡)',
  '♪(┌・。・)┌',
  '(ﾉ´ヮ`)ﾉ*: ･ﾟ',
  '(￣▽￣)ノ',
  '(◠‿◠)',
  '(•‿•)',
  '╰(*°▽°*)╯',
  '(≧◡≦)',
  '(☞ﾟヮﾟ)☞',
  '(づ￣ ³￣)づ',
  'ヾ(⌐■_■)ノ♪',
  '(ง •̀_•́)ง',
  '(╯°□°）╯︵ ┻━┻',
  '┬─┬ ノ( ゜-゜ノ)',
  '( •_•)>⌐■-■',
  '(⌐■_■)',
  '¯\\_(ツ)_/¯',
  '( ͡° ͜ʖ ͡°)',
  'ಠ_ಠ',
];

export const thinkingKaomojis = ['(๑•﹏•)', '(・_・ヾ', '( ˘ω˘ )', '(´-ω-`)', '( ´ ▽ ` )'];

export function getRandomKaomoji(): string {
  return kaomojis[Math.floor(Math.random() * kaomojis.length)];
}

export function getRandomThinkingKaomoji(): string {
  return thinkingKaomojis[Math.floor(Math.random() * thinkingKaomojis.length)];
}
