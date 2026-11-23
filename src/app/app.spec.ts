import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { SpotlightInputComponent } from './components/spotlight-input/spotlight-input.component';
import { AskiiStateService } from './core/askii-state.service';
import { computeAutocomplete, parseControlCommands } from './core/autocomplete';
import { pickKaomoji } from './core/kaomoji';
import { renderSafeMarkdown } from './core/markdown';
import {
  analyzeLiveTypingTone,
  analyzeUserSentiment,
  classifyDesktopActivity,
  getTalkingFrames,
} from './core/pet-engine';

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

  it('classifies desktop activity for coding, vibing, browsing, and writing apps', () => {
    expect(
      classifyDesktopActivity({
        hwnd: 1,
        processName: 'Code',
        title: 'askii-state.service.ts - Visual Studio Code',
      }).kind,
    ).toBe('coding');
    expect(
      classifyDesktopActivity({
        hwnd: 2,
        processName: 'Spotify',
        title: 'Spotify Premium',
      }).kind,
    ).toBe('vibing');
    expect(
      classifyDesktopActivity({
        hwnd: 3,
        processName: 'chrome',
        title: 'Angular Docs',
      }).kind,
    ).toBe('browsing');
    expect(
      classifyDesktopActivity({
        hwnd: 4,
        processName: 'Obsidian',
        title: 'Daily Notes',
      }).kind,
    ).toBe('writing');
  });

  it('analyzes user sentiment locally and supports hurt-to-forgiven recovery', () => {
    expect(analyzeUserSentiment('thank you, you are awesome!')?.emotion).toBe('loved');
    expect(analyzeUserSentiment('shut up bad askii')?.emotion).toBe('hurt');
    expect(analyzeUserSentiment('sorry my bad', 'hurt')?.emotion).toBe('loved');
    expect(analyzeUserSentiment('ugh I am so tired today')?.emotion).toBe('comforting');
    expect(analyzeUserSentiment('this rust build has a crash error')?.emotion).toBe('determined');
    expect(analyzeUserSentiment('haha tell me a joke')?.emotion).toBe('playful');
    expect(analyzeUserSentiment('how does async work?')?.emotion).toBe('curious');
    expect(analyzeLiveTypingTone('/voice')).toBe('command');
    expect(analyzeLiveTypingTone('why does this happen?')).toBe('curious');
    expect(getTalkingFrames('loved', true).length).toBe(3);
  });

  it('removes the 3 text-box icons, supports left-click petting and right-click pet menu', async () => {
    await TestBed.configureTestingModule({
      imports: [SpotlightInputComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(SpotlightInputComponent);
    const state = TestBed.inject(AskiiStateService);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    // The 3 old icon buttons (voice, clip, screen) must not exist in the text box
    expect(root.querySelectorAll('.icon-btn').length).toBe(0);
    expect(root.textContent).not.toContain('🎙');
    expect(root.textContent).not.toContain('📋');
    expect(root.textContent).not.toContain('📷');

    // /voice command should be available in autocomplete
    const voiceCmd = computeAutocomplete('/voi', []);
    expect(voiceCmd.suggestions[0]?.value).toBe('/voice');

    // Left-click pets ASKII with combo escalation
    const faceBtn = root.querySelector('.askii-face') as HTMLButtonElement;
    expect(faceBtn).toBeTruthy();

    const initialAffection = state.petAffection();
    faceBtn.click();
    fixture.detectChanges();
    expect(state.petEmotion()).toBe('petted');
    expect(state.petAffection()).toBeGreaterThan(initialAffection);

    faceBtn.click();
    fixture.detectChanges();
    expect(state.petEmotion()).toBe('loved');

    // Right-click opens pet-only interaction menu
    const ctxEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    faceBtn.dispatchEvent(ctxEvent);
    fixture.detectChanges();
    expect(ctxEvent.defaultPrevented).toBe(true);
    expect(state.petMenuOpen()).toBe(true);
    const menu = root.querySelector('.pet-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.textContent).toContain('Pet ASKII');
    expect(menu.textContent).toContain('Feed Snack');
    expect(menu.textContent).toContain('Play / Trick');
    expect(menu.textContent).toContain('Nap');

    // Feed snack action closes menu and triggers eating emotion
    state.feedAskii();
    fixture.detectChanges();
    expect(state.petMenuOpen()).toBe(false);
    expect(state.petEmotion()).toBe('eating');

    // Nap & wake on first pet
    state.toggleAskiiNap();
    fixture.detectChanges();
    expect(state.petEmotion()).toBe('napping');
    state.petAskii();
    fixture.detectChanges();
    expect(state.petEmotion()).toBe('waking');
  });

  it('exposes /screen and /browser commands and parses strict control gating', () => {
    const screenAc = computeAutocomplete('/scr', []);
    expect(screenAc.suggestions[0]?.value).toBe('/screen');
    expect(screenAc.ghostFullValue).toBe('/screen');

    const browserAc = computeAutocomplete('/bro', []);
    expect(browserAc.suggestions[0]?.value).toBe('/browser');
    expect(browserAc.ghostFullValue).toBe('/browser');

    expect(parseControlCommands('open chrome and click login')).toBeNull();
    expect(parseControlCommands('/screenplay summary')).toBeNull();

    expect(parseControlCommands('/screen click the Save button')).toEqual({
      enableScreenControl: true,
      enableBrowserControl: false,
      task: 'click the Save button',
    });

    expect(parseControlCommands('/browser go to github.com')).toEqual({
      enableScreenControl: false,
      enableBrowserControl: true,
      task: 'go to github.com',
    });

    expect(parseControlCommands('/screen /browser open example.com')).toEqual({
      enableScreenControl: true,
      enableBrowserControl: true,
      task: 'open example.com',
    });
  });
});
