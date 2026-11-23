import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { computeAutocomplete } from './core/autocomplete';
import { pickKaomoji } from './core/kaomoji';
import { renderSafeMarkdown } from './core/markdown';

describe('ASKII Desktop MVP', () => {
  it('creates the root application shell', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('autocompletes slash commands with ghost text and dropdown', () => {
    const res = computeAutocomplete('/se', []);
    expect(res.ghostSuffix).toBe('tup');
    expect(res.ghostFullValue).toBe('/setup');
    expect(res.showDropdown).toBe(true);
    expect(res.suggestions[0]?.value).toBe('/setup');
  });

  it('autocompletes recent prompt history prefix ghost text', () => {
    const history = [
      'Explain how Windows virtual desktops work',
      'Write a PowerShell script to clean temp files',
    ];
    const res = computeAutocomplete('Explain how', history);
    expect(res.ghostSuffix).toBe(' Windows virtual desktops work');
    expect(res.ghostFullValue).toBe('Explain how Windows virtual desktops work');
    expect(res.showDropdown).toBe(true);
  });

  it('sanitizes dangerous HTML when rendering receipt markdown', () => {
    const html = renderSafeMarkdown('**Hello** <script>alert(1)</script>');
    expect(html).toContain('<strong>Hello</strong>');
    expect(html).not.toContain('<script>');
  });

  it('returns expressive kaomoji for each mood', () => {
    expect(pickKaomoji('idle', 0)).toBe('(⌐■_■)');
    expect(pickKaomoji('thinking', 0)).toBe('(๑•﹏•)');
    expect(pickKaomoji('error', 0)).toContain('┻━┻');
  });

  it('autocompletes @context mentions and prompt recipes', () => {
    const mention = computeAutocomplete('explain @sc', []);
    expect(mention.showDropdown).toBe(true);
    expect(mention.suggestions[0]?.value).toBe('@screen');
    expect(mention.ghostFullValue).toBe('explain @screen ');

    const recipeRes = computeAutocomplete('/fi', [], [
      {
        command: '/fix',
        label: '/fix',
        description: 'Fix grammar',
        systemPrompt: 'Fix it',
        userPrefix: 'Fix:',
        autoAttachClipboard: true,
      },
    ]);
    expect(recipeRes.suggestions[0]?.kind).toBe('recipe');
    expect(recipeRes.suggestions[0]?.value).toBe('/fix');
  });

  it('wraps markdown code blocks with a safe copy button', () => {
    const html = renderSafeMarkdown('```ts\nconst x = 1;\n```');
    expect(html).toContain('data-copy-code="1"');
    expect(html).toContain('const x = 1;');
  });

  it('exposes /autodo and /agent commands and agent kaomoji moods', () => {
    const res = computeAutocomplete('/au', []);
    expect(res.suggestions[0]?.value).toBe('/autodo');
    expect(pickKaomoji('working', 0)).toBe('(ง •̀_•́)ง');
    expect(pickKaomoji('approval', 0)).toBe('(⊙_☉)?');
    expect(pickKaomoji('listening', 0)).toBe('(◉_◉)♪');
  });

  it('supports /model quick switcher and @clip:N clipboard ring mentions', () => {
    const modRes = computeAutocomplete(
      '/model gem',
      [],
      [],
      7,
      [
        { provider: 'gemini', model: 'gemini-2.5-flash' },
        { provider: 'openai', model: 'gpt-4o' },
      ],
    );
    expect(modRes.showDropdown).toBe(true);
    expect(modRes.suggestions.length).toBe(1);
    expect(modRes.suggestions[0]?.kind).toBe('model');
    expect(modRes.suggestions[0]?.modelProfile?.provider).toBe('gemini');

    const clipRes = computeAutocomplete(
      'summarize @clip:2',
      [],
      [],
      7,
      [],
      [
        { index: 1, text: 'first', preview: 'first', capturedAt: 1 },
        { index: 2, text: 'second', preview: 'second', sourceApp: 'Code', capturedAt: 2 },
      ],
    );
    expect(clipRes.showDropdown).toBe(true);
    expect(clipRes.suggestions[0]?.value).toBe('@clip:2');
  });
});
