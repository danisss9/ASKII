import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { computeAutocomplete, parseControlCommands } from './autocomplete';
import { KaomojiMood } from './kaomoji';
import {
  PET_VISUALS,
  PetEmotion,
  PetParticle,
  PetParticleGlyph,
  PetVisualState,
  analyzeLiveTypingTone,
  analyzeUserSentiment,
  classifyDesktopActivity,
  getParticleVariant,
  getTalkingFrames,
} from './pet-engine';
import {
  AgentSettings,
  AppConfig,
  ApprovalDecision,
  AskiiMode,
  AutocompleteSuggestion,
  ChatMessage,
  ClipboardHistoryItem,
  ContextAttachment,
  ConversationTurn,
  ImageAttachment,
  InstantResult,
  MemoryEntry,
  PreviousWindowInfo,
  PromptRecipe,
  ProviderDefinition,
  ProviderId,
  SaveSetupRequest,
  SlipSummary,
  StoredSlip,
  ToolActionEntry,
} from './models';
import { TauriBridgeService } from './tauri-bridge.service';

@Injectable({ providedIn: 'root' })
export class AskiiStateService {
  private readonly bridge = inject(TauriBridgeService);

  readonly initialized = signal(false);
  readonly mode = signal<AskiiMode>('pill');
  readonly setupInitialStep = signal<'provider' | 'shortcut' | 'agent'>('provider');

  readonly config = signal<AppConfig>({
    setupCompleted: false,
    provider: 'askiicloud',
    model: 'askii-smart',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    openaiUrl: '',
    shortcut: 'Alt+Space',
    actionShortcut: 'Alt+Shift+Space',
    whisperUrl: '',
    startWithWindows: false,
    clipboardHistoryEnabled: true,
    recentModels: [],
    promptHistory: [],
    recipes: [],
    agent: {
      enabled: true,
      mode: 'confirm',
      autoApproveDesktopControls: true,
      guardDestructiveCommands: true,
      maxSteps: 10,
      mcpServers: [],
    },
  });
  readonly providers = signal<ProviderDefinition[]>([]);
  readonly savedCredentials = signal<Record<string, boolean>>({});
  readonly needsSetup = signal(true);

  readonly inputText = signal('');
  readonly selectedSuggestionIndex = signal(0);
  readonly dropdownDismissed = signal(false);

  readonly previousWindow = signal<PreviousWindowInfo | null>(null);
  readonly attachments = signal<ContextAttachment[]>([]);
  readonly isDragOver = signal(false);

  readonly instantResults = signal<InstantResult[]>([]);
  readonly clipboardHistory = signal<ClipboardHistoryItem[]>([]);
  readonly slipArchive = signal<SlipSummary[]>([]);
  readonly memories = signal<MemoryEntry[]>([]);
  readonly currentSlipId = signal<string>(`slip-${Date.now()}`);
  readonly isRecordingVoice = signal(false);
  readonly isTranscribingVoice = signal(false);

  readonly conversation = signal<ConversationTurn[]>([]);
  readonly slipNumber = signal(1);
  readonly isThinking = signal(false);
  readonly isPrinting = signal(false);
  readonly isTearing = signal(false);
  readonly isPinned = signal(false);
  readonly showHistoryOnly = signal(false);
  readonly toastMessage = signal<string | null>(null);
  readonly errorBanner = signal<string | null>(null);
  readonly focusTick = signal(0);

  readonly petAffection = signal(68);
  readonly petEnergy = signal(86);
  readonly petShadesOn = signal(true);
  readonly petManualNap = signal(false);
  readonly petMenuOpen = signal(false);
  readonly petHovering = signal(false);
  readonly petParticles = signal<PetParticle[]>([]);

  private readonly petReaction = signal<{
    emotion: PetEmotion;
    face?: string;
    reason: string;
  } | null>(null);
  private readonly conversationalEmotion = signal<{
    emotion: PetEmotion;
    reason: string;
  } | null>(null);
  private readonly idleStage = signal<'active' | 'sleepy' | 'napping'>('active');
  private readonly isBlinking = signal(false);
  private readonly activeAnimFrame = signal(0);
  private readonly talkPulse = signal(0);

  private turnSeq = 0;
  private attachSeq = 0;
  private instantQuerySeq = 0;
  private particleSeq = 0;
  private petCombo = 0;
  private lastInteractionAt = Date.now();
  private lastTalkPulseAt = 0;
  private lastActivityProcess = '';
  private ambientTickCount = 0;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private toastTimer?: ReturnType<typeof setTimeout>;
  private petComboTimer?: ReturnType<typeof setTimeout>;
  private petReactionTimers: ReturnType<typeof setTimeout>[] = [];
  private convEmotionTimer?: ReturnType<typeof setTimeout>;
  private blinkTimer?: ReturnType<typeof setTimeout>;
  private blinkEndTimer?: ReturnType<typeof setTimeout>;

  readonly activeProviderDef = computed(() => {
    const id = this.config().provider;
    return this.providers().find((p) => p.id === id);
  });

  readonly isLocalProvider = computed(() => {
    const p = this.config().provider;
    return p === 'ollama' || p === 'lmstudio';
  });

  readonly autocomplete = computed(() =>
    computeAutocomplete(
      this.inputText(),
      this.config().promptHistory,
      this.config().recipes,
      7,
      this.config().recentModels,
      this.clipboardHistory(),
    ),
  );

  readonly visibleSuggestions = computed<AutocompleteSuggestion[]>(() => {
    if (this.dropdownDismissed()) {
      return [];
    }
    const instantMapped: AutocompleteSuggestion[] = this.instantResults().map((item) => ({
      kind: 'instant',
      value: item.id,
      label: item.label,
      description: item.description,
      badge: item.badge,
      instantItem: item,
    }));
    return [...instantMapped, ...this.autocomplete().suggestions].slice(0, 7);
  });

  readonly showAutocompleteDropdown = computed(
    () =>
      this.mode() !== 'setup' &&
      this.mode() !== 'history' &&
      this.mode() !== 'memory' &&
      !this.dropdownDismissed() &&
      (this.autocomplete().showDropdown || this.instantResults().length > 0),
  );

  readonly desiredWindowHeight = computed(() => {
    const mode = this.mode();
    if (mode === 'setup' || mode === 'paper' || mode === 'history' || mode === 'memory') {
      return 680;
    }
    const attachOffset = this.attachments().length > 0 ? 44 : 0;
    if (this.petMenuOpen()) {
      return 396 + attachOffset;
    }
    if (this.showAutocompleteDropdown()) {
      const rows = Math.min(this.visibleSuggestions().length, 7);
      return Math.min(620, 148 + attachOffset + rows * 56);
    }
    if (this.attachments().length > 0 || this.errorBanner() || this.toastMessage()) {
      return 204;
    }
    return 124;
  });

  readonly desktopActivity = computed(() => classifyDesktopActivity(this.previousWindow()));

  readonly isPetSleeping = computed(
    () => this.petManualNap() || this.idleStage() === 'napping',
  );

  readonly petVisual = computed<PetVisualState>(() => {
    const blinking = this.isBlinking();
    const frame = this.activeAnimFrame();
    const shades = this.petShadesOn();

    const makeState = (
      emotion: PetEmotion,
      reason: string,
      opts?: { face?: string; animated?: boolean; aura?: PetVisualState['aura']; motion?: PetVisualState['motion'] },
    ): PetVisualState => {
      const spec = PET_VISUALS[emotion];
      let face = opts?.face;
      if (!face) {
        if (opts?.animated && spec.frames.length > 1) {
          face = spec.frames[Math.abs(frame) % spec.frames.length];
        } else if (blinking && spec.blinkFrame) {
          face = spec.blinkFrame;
        } else {
          face = spec.frames[0];
        }
      }
      return {
        emotion,
        face,
        label: spec.label,
        reason,
        aura: opts?.aura ?? spec.aura,
        motion: opts?.motion ?? spec.motion,
      };
    };

    const reaction = this.petReaction();
    if (reaction) {
      return makeState(reaction.emotion, reaction.reason, { face: reaction.face });
    }

    if (this.errorBanner()) {
      return makeState('error', 'Hit a snag');
    }

    if (this.mode() === 'setup') {
      return makeState('setup', 'Getting set up');
    }

    if (this.isTranscribingVoice()) {
      return makeState('listening', 'Transcribing your voice…', { face: '(・ω・)?' });
    }
    if (this.isRecordingVoice()) {
      return makeState('listening', 'Listening closely…', { animated: true });
    }

    if (this.hasPendingApproval()) {
      return makeState('approval', 'Waiting for your okay', { animated: true });
    }

    if (this.hasRunningTool()) {
      return makeState('working', 'Working on it!', { animated: true });
    }

    if (this.isThinking()) {
      return makeState('thinking', 'Thinking it through…', { animated: true });
    }

    if (this.isPrinting()) {
      const conv = this.conversationalEmotion();
      const talkFrames = getTalkingFrames(conv?.emotion ?? null, shades);
      const face = talkFrames[this.talkPulse() % talkFrames.length];
      const aura = conv ? PET_VISUALS[conv.emotion].aura : 'mint';
      return makeState('talking', conv?.reason || 'Replying to you', { face, aura });
    }

    if (this.isDragOver()) {
      return makeState('inspecting', 'Drop it here!');
    }

    if (this.petManualNap()) {
      return makeState('napping', 'Cozy nap', { animated: true });
    }

    const input = this.inputText();
    if (input.trim().length > 0) {
      const tone = analyzeLiveTypingTone(input) ?? 'attentive';
      const reason =
        tone === 'command'
          ? 'Ready for a command'
          : tone === 'curious'
            ? 'Curious what you’ll ask'
            : 'Listening to you';
      return makeState(tone, reason);
    }

    if (this.attachments().length > 0) {
      return makeState('curious', 'Holding your context', {
        face: blinking ? '(◠‿◠)✎' : '(◕‿◕)✎',
      });
    }

    const conv = this.conversationalEmotion();
    if (conv) {
      return makeState(conv.emotion, conv.reason);
    }

    const idle = this.idleStage();
    const activity = this.desktopActivity();
    if (idle === 'active') {
      if (activity.kind === 'coding') {
        const codingFace = shades
          ? blinking
            ? '(⌐–_–)'
            : '(⌐■_■)'
          : blinking
            ? '(–̀_–́)و'
            : '(•̀_•́)و';
        return makeState('coding', `Coding · ${activity.appName}`, { face: codingFace });
      }
      if (activity.kind === 'vibing') {
        return makeState('vibing', `Vibing · ${activity.appName}`, { animated: true });
      }
    }

    if (idle === 'napping') {
      return makeState('napping', 'Dozed off', { animated: true });
    }

    if (idle === 'sleepy') {
      return makeState('sleepy', 'Getting sleepy');
    }

    if (this.petHovering()) {
      return makeState('happy', 'Ready for pets!', {
        face: blinking ? '(◠‿◠)' : '(◕‿◕)',
        aura: 'warm',
        motion: 'bounce',
      });
    }

    if (shades) {
      return makeState('cool', 'Chilling');
    }
    if (this.petAffection() >= 78) {
      return makeState('happy', 'Feeling loved', {
        face: blinking ? '(◠‿◠)' : '(◕‿◕)',
        aura: 'warm',
        motion: 'breathe',
      });
    }
    return makeState('content', 'Hanging out');
  });

  readonly petEmotion = computed<PetEmotion>(() => this.petVisual().emotion);

  readonly isAutoDo = computed(
    () => this.config().agent.enabled && this.config().agent.mode === 'autoDo',
  );

  readonly hasPendingApproval = computed(() =>
    this.conversation().some((t) =>
      t.toolActions?.some((a) => a.status === 'pendingApproval'),
    ),
  );

  readonly hasRunningTool = computed(() =>
    this.conversation().some((t) => t.toolActions?.some((a) => a.status === 'running')),
  );

  readonly currentMood = computed<KaomojiMood>(() => {
    if (this.errorBanner()) {
      return 'error';
    }
    if (this.mode() === 'setup') {
      return 'setup';
    }
    if (this.isRecordingVoice() || this.isTranscribingVoice()) {
      return 'listening';
    }
    if (this.hasPendingApproval()) {
      return 'approval';
    }
    if (this.hasRunningTool()) {
      return 'working';
    }
    if (this.isThinking()) {
      return 'thinking';
    }
    if (this.isPrinting()) {
      return 'printing';
    }
    const text = this.inputText().trimStart();
    if (text.startsWith('/') || text.includes('@')) {
      return 'command';
    }
    if (text.length > 0 || this.attachments().length > 0) {
      return 'typing';
    }
    return 'idle';
  });

  readonly kaomoji = computed(() => this.petVisual().face);

  constructor() {
    if (typeof window !== 'undefined') {
      setInterval(() => {
        const emotion = this.petEmotion();
        if (
          emotion === 'thinking' ||
          emotion === 'working' ||
          emotion === 'approval' ||
          emotion === 'listening' ||
          emotion === 'napping' ||
          emotion === 'vibing'
        ) {
          this.activeAnimFrame.update((n) => n + 1);
        }
      }, 560);

      setInterval(() => {
        this.ambientTickCount++;
        const busy =
          this.isThinking() ||
          this.isPrinting() ||
          this.isRecordingVoice() ||
          this.isTranscribingVoice() ||
          this.hasPendingApproval() ||
          this.hasRunningTool() ||
          this.inputText().trim().length > 0 ||
          this.petMenuOpen() ||
          this.mode() === 'setup';

        if (!busy) {
          const elapsed = Date.now() - this.lastInteractionAt;
          if (elapsed >= 90_000) {
            this.idleStage.set('napping');
          } else if (elapsed >= 45_000) {
            this.idleStage.set('sleepy');
          } else {
            this.idleStage.set('active');
          }
        }

        if (this.isPetSleeping()) {
          this.adjustEnergy(2);
          if (this.ambientTickCount % 3 === 0) {
            this.spawnParticle('zZ');
          }
        } else if (this.petEmotion() === 'coding' && this.ambientTickCount % 7 === 0) {
          this.spawnParticle('</>');
        } else if (this.petEmotion() === 'vibing' && this.ambientTickCount % 5 === 0) {
          this.spawnParticle('♪');
        }
      }, 2000);

      this.scheduleNextBlink();
    }

    effect(() => {
      const inSetup = this.mode() === 'setup';
      void this.bridge.setInSetup(inSetup);
    });

    effect(() => {
      const h = this.desiredWindowHeight();
      void this.bridge.setWindowHeight(h);
    });
  }

  async init(): Promise<void> {
    const state = await this.bridge.getAppState();
    this.applyAppState(state);
    const prev = await this.bridge.getPreviousWindow();
    if (prev) {
      this.previousWindow.set(prev);
    }
    this.initialized.set(true);

    if (state.needsSetup) {
      this.mode.set('pill');
      setTimeout(() => {
        this.openSetup('provider');
      }, 160);
    } else {
      this.mode.set('pill');
      this.triggerFocus();
    }

    await this.bridge.onWindowShown(({ openSetup, previousWindow, selectionText }) => {
      void this.refreshClipboardHistory();
      this.noteInteraction();
      this.petMenuOpen.set(false);
      if (previousWindow) {
        this.applyDesktopWindow(previousWindow, false);
      }
      if (selectionText && selectionText.trim()) {
        this.addOrReplaceAttachment({
          id: `att-${++this.attachSeq}`,
          kind: 'selection',
          label: `Selection · ${selectionText.trim().length}c`,
          detail: previousWindow?.processName,
          text: selectionText.trim(),
        });
        this.reactToContextAttach('Captured your selection');
        this.showToast(
          `Captured selection${previousWindow ? ` from ${previousWindow.processName}` : ''}`,
        );
      }

      if (openSetup || this.needsSetup()) {
        this.openSetup('provider');
      } else {
        if (this.mode() === 'setup') {
          this.mode.set(this.conversation().length > 0 ? 'paper' : 'pill');
        }
        this.triggerFocus();
      }
    });

    await this.bridge.onActivityChanged((win) => {
      this.applyDesktopWindow(win, true);
    });

    await this.bridge.onFileDrop(
      (paths) => void this.attachFilePaths(paths),
      (hovering) => this.isDragOver.set(hovering),
    );
  }

  private applyAppState(state: {
    config: AppConfig;
    providers: ProviderDefinition[];
    savedCredentials: Record<string, boolean>;
    needsSetup: boolean;
  }): void {
    this.config.set(state.config);
    this.providers.set(state.providers);
    this.savedCredentials.set(state.savedCredentials);
    this.needsSetup.set(state.needsSetup);
  }

  triggerFocus(): void {
    this.focusTick.update((n) => n + 1);
  }

  private scheduleNextBlink(): void {
    clearTimeout(this.blinkTimer);
    const delay = 3400 + Math.floor(Math.random() * 3200);
    this.blinkTimer = setTimeout(() => {
      if (!this.petReaction()) {
        this.isBlinking.set(true);
        clearTimeout(this.blinkEndTimer);
        this.blinkEndTimer = setTimeout(() => {
          this.isBlinking.set(false);
          this.scheduleNextBlink();
        }, 150);
      } else {
        this.scheduleNextBlink();
      }
    }, delay);
  }

  private clampStat(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private adjustAffection(delta: number): void {
    this.petAffection.update((v) => this.clampStat(v + delta));
  }

  private adjustEnergy(delta: number): void {
    this.petEnergy.update((v) => this.clampStat(v + delta));
  }

  private noteInteraction(wakeManualNap = false): void {
    this.lastInteractionAt = Date.now();
    if (this.idleStage() !== 'active') {
      this.idleStage.set('active');
    }
    if (wakeManualNap && this.petManualNap()) {
      this.petManualNap.set(false);
    }
  }

  private clearReactionTimers(): void {
    for (const t of this.petReactionTimers) {
      clearTimeout(t);
    }
    this.petReactionTimers = [];
  }

  private playReactionSequence(
    steps: {
      emotion: PetEmotion;
      face?: string;
      reason: string;
      durationMs: number;
      particle?: PetParticleGlyph;
      particleCount?: number;
    }[],
  ): void {
    this.clearReactionTimers();
    let offset = 0;
    for (const step of steps) {
      const applyStep = () => {
        this.petReaction.set({
          emotion: step.emotion,
          face: step.face,
          reason: step.reason,
        });
        if (step.particle) {
          const count = step.particleCount ?? 1;
          for (let i = 0; i < count; i++) {
            this.spawnParticle(step.particle);
          }
        }
      };
      if (offset === 0) {
        applyStep();
      } else {
        this.petReactionTimers.push(setTimeout(applyStep, offset));
      }
      offset += step.durationMs;
    }
    this.petReactionTimers.push(
      setTimeout(() => {
        this.petReaction.set(null);
      }, offset),
    );
  }

  spawnParticle(glyph: PetParticleGlyph): void {
    const id = ++this.particleSeq;
    const offsetX = Math.round((Math.random() - 0.5) * 56);
    const particle: PetParticle = {
      id,
      glyph,
      offsetX,
      variant: getParticleVariant(glyph),
    };
    this.petParticles.update((list) => [...list.slice(-5), particle]);
    setTimeout(() => {
      this.petParticles.update((list) => list.filter((p) => p.id !== id));
    }, 1050);
  }

  setPetHover(hovering: boolean): void {
    this.petHovering.set(hovering);
    if (hovering) {
      this.lastInteractionAt = Date.now();
    }
  }

  togglePetMenu(): void {
    const next = !this.petMenuOpen();
    this.petMenuOpen.set(next);
    if (next) {
      this.dropdownDismissed.set(true);
      this.noteInteraction(false);
    }
  }

  closePetMenu(): void {
    this.petMenuOpen.set(false);
  }

  petAskii(): void {
    this.petMenuOpen.set(false);
    const wasSleeping = this.isPetSleeping() || this.idleStage() === 'sleepy';
    this.noteInteraction(true);

    if (wasSleeping) {
      this.petCombo = 0;
      this.adjustAffection(5);
      this.playReactionSequence([
        { emotion: 'waking', face: '(つ﹏⊂)', reason: 'Waking up…', durationMs: 520, particle: '✧' },
        { emotion: 'happy', face: '(•‿•)', reason: 'Morning!', durationMs: 700 },
      ]);
      return;
    }

    this.petCombo++;
    clearTimeout(this.petComboTimer);
    this.petComboTimer = setTimeout(() => {
      this.petCombo = 0;
    }, 3600);

    const wasHurt = this.conversationalEmotion()?.emotion === 'hurt';
    if (wasHurt) {
      this.conversationalEmotion.set(null);
    }
    this.adjustAffection(wasHurt ? 16 : 9);
    this.adjustEnergy(2);

    if (this.petCombo === 1) {
      this.playReactionSequence([
        { emotion: 'petted', face: '(｡◕‿◕｡)', reason: 'Loves the pets', durationMs: 650, particle: '♡' },
        { emotion: 'petted', face: '(◡‿◡✿)', reason: 'Feeling cozy', durationMs: 900 },
      ]);
    } else if (this.petCombo <= 3) {
      this.playReactionSequence([
        {
          emotion: 'loved',
          face: '(≧◡≦)♡',
          reason: 'Purring happily',
          durationMs: 700,
          particle: '♡',
          particleCount: 2,
        },
        { emotion: 'loved', face: '(｡♥‿♥｡)', reason: 'So happy!', durationMs: 950 },
      ]);
    } else if (this.petCombo <= 5) {
      this.playReactionSequence([
        {
          emotion: 'ecstatic',
          face: '(ﾉ´ヮ`)ﾉ♡',
          reason: 'Overjoyed!',
          durationMs: 680,
          particle: '✧',
          particleCount: 2,
        },
        { emotion: 'ecstatic', face: '╰(*°▽°*)╯', reason: 'Best pets ever!', durationMs: 980, particle: '♡' },
      ]);
    } else {
      this.playReactionSequence([
        { emotion: 'ticklish', face: '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', reason: 'Hehe, ticklish!', durationMs: 720, particle: '♪' },
        { emotion: 'ticklish', face: '(＠_＠;)', reason: 'Whoa, too fast!', durationMs: 920 },
      ]);
    }
  }

  feedAskii(): void {
    this.petMenuOpen.set(false);
    this.noteInteraction(true);
    this.adjustEnergy(22);
    this.adjustAffection(7);
    if (this.conversationalEmotion()?.emotion === 'hurt') {
      this.conversationalEmotion.set(null);
    }
    this.playReactionSequence([
      { emotion: 'eating', face: '(•o•)', reason: 'Ooh, a snack!', durationMs: 420, particle: '✧' },
      { emotion: 'eating', face: '(っ˘ڡ˘ς)', reason: 'Munching bytes…', durationMs: 780, particle: '♪' },
      { emotion: 'eating', face: '(´～`)', reason: 'Yum!', durationMs: 620 },
      { emotion: 'happy', face: '(◕‿◕)✧', reason: 'Full & energized!', durationMs: 800, particle: '✧' },
    ]);
  }

  playWithAskii(): void {
    this.petMenuOpen.set(false);
    this.noteInteraction(true);
    this.adjustAffection(10);
    this.adjustEnergy(-6);
    if (this.conversationalEmotion()?.emotion === 'hurt') {
      this.conversationalEmotion.set(null);
    }
    this.playReactionSequence([
      { emotion: 'playful', face: '( •_•)>⌐■-■', reason: 'Watch this!', durationMs: 560, particle: '✧' },
      { emotion: 'playful', face: '(⌐■_■)✧', reason: 'Smooth!', durationMs: 680, particle: '♪' },
      { emotion: 'playful', face: '╰(*°▽°*)╯', reason: 'Ta-da!', durationMs: 860, particle: '✧' },
    ]);
  }

  toggleAskiiShades(): void {
    this.petMenuOpen.set(false);
    this.noteInteraction(true);
    const next = !this.petShadesOn();
    this.petShadesOn.set(next);
    if (next) {
      this.playReactionSequence([
        { emotion: 'cool', face: '( •_•)>⌐■-■', reason: 'Shades on', durationMs: 480, particle: '✧' },
        { emotion: 'cool', face: '(⌐■_■)', reason: 'Looking sharp', durationMs: 750 },
      ]);
    } else {
      this.playReactionSequence([
        { emotion: 'happy', face: '( •_•)>⌐■-■', reason: 'Shades off', durationMs: 460 },
        { emotion: 'happy', face: '(◕‿◕)', reason: 'Fresh eyes!', durationMs: 720, particle: '✧' },
      ]);
    }
  }

  toggleAskiiNap(): void {
    this.petMenuOpen.set(false);
    if (this.isPetSleeping()) {
      this.petManualNap.set(false);
      this.noteInteraction(true);
      this.playReactionSequence([
        { emotion: 'waking', face: '(つ﹏⊂)', reason: 'Stretching awake…', durationMs: 550, particle: '✧' },
        { emotion: 'happy', face: '(•‿•)', reason: 'Ready to help!', durationMs: 750 },
      ]);
    } else {
      this.clearReactionTimers();
      this.petReaction.set(null);
      this.petManualNap.set(true);
      this.spawnParticle('zZ');
    }
  }

  pokeAskii(): void {
    this.petAskii();
  }

  private reactToScreenAttach(): void {
    this.noteInteraction(true);
    this.playReactionSequence([
      { emotion: 'peeking', face: '(◎_◎)', reason: 'Taking a peek!', durationMs: 620, particle: '✧' },
      { emotion: 'peeking', face: '(◉_◉)✧', reason: 'Got your screen!', durationMs: 1200 },
    ]);
  }

  private reactToContextAttach(reason: string): void {
    this.noteInteraction(true);
    this.playReactionSequence([
      { emotion: 'inspecting', face: '(◉_◉)', reason, durationMs: 550, particle: '✧' },
      { emotion: 'curious', face: '(◕‿◕)✎', reason, durationMs: 950 },
    ]);
  }

  private reactToOpening(label?: string): void {
    this.noteInteraction(true);
    const reason = label ? `Opening ${label}!` : 'Opening it up!';
    this.playReactionSequence([
      { emotion: 'opening', face: '(☞ﾟヮﾟ)☞', reason, durationMs: 520, particle: '✧' },
      { emotion: 'opening', face: '╰(°▽°)╯', reason, durationMs: 1050 },
    ]);
  }

  private setLingeringEmotion(emotion: PetEmotion, reason: string, durationMs = 28_000): void {
    this.conversationalEmotion.set({ emotion, reason });
    clearTimeout(this.convEmotionTimer);
    this.convEmotionTimer = setTimeout(() => {
      this.conversationalEmotion.set(null);
    }, durationMs);
  }

  private applyDesktopWindow(win: PreviousWindowInfo, isLiveSwitch: boolean): void {
    const prevProc = this.lastActivityProcess;
    const nextProc = win.processName.trim().toLowerCase();
    this.previousWindow.set(win);
    this.lastActivityProcess = nextProc;

    if (!isLiveSwitch || !nextProc || nextProc === prevProc) {
      return;
    }

    const busy =
      this.isThinking() ||
      this.isPrinting() ||
      this.isRecordingVoice() ||
      this.petManualNap() ||
      this.mode() === 'setup';
    if (busy) {
      return;
    }

    const activity = classifyDesktopActivity(win);
    if (activity.kind === 'coding') {
      this.noteInteraction(false);
      this.playReactionSequence([
        {
          emotion: 'coding',
          face: this.petShadesOn() ? '( •_•)>⌐■-■' : '(•̀_•́)و',
          reason: `Coding · ${activity.appName}`,
          durationMs: 520,
          particle: '</>',
        },
        {
          emotion: 'coding',
          face: this.petShadesOn() ? '(⌐■_■)' : '(•̀_•́)و',
          reason: `Coding · ${activity.appName}`,
          durationMs: 1100,
        },
      ]);
    } else if (prevProc) {
      this.reactToOpening(win.processName);
    }
  }

  setInput(value: string): void {
    this.noteInteraction(true);
    this.petMenuOpen.set(false);
    this.inputText.set(value);
    this.selectedSuggestionIndex.set(0);
    this.dropdownDismissed.set(false);
    if (this.errorBanner()) {
      this.errorBanner.set(null);
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      this.instantResults.set([]);
      return;
    }

    if (trimmed.toLowerCase().includes('@clip')) {
      void this.refreshClipboardHistory();
    }

    const seq = ++this.instantQuerySeq;
    void this.bridge.queryInstant(trimmed).then((res) => {
      if (seq === this.instantQuerySeq) {
        this.instantResults.set(res);
      }
    });
  }

  async executeInstantItem(item: InstantResult): Promise<void> {
    try {
      const msg = await this.bridge.executeInstant(item);
      this.inputText.set('');
      this.instantResults.set([]);
      this.dropdownDismissed.set(true);
      if (item.kind === 'app' || item.kind === 'window') {
        this.reactToOpening(item.label);
      } else {
        this.spawnParticle('✧');
      }
      this.showToast(msg);
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async openHistory(): Promise<void> {
    this.dropdownDismissed.set(true);
    this.mode.set('history');
    await this.refreshSlips();
  }

  async openMemory(): Promise<void> {
    this.dropdownDismissed.set(true);
    this.mode.set('memory');
    await this.refreshMemories();
  }

  closeDrawer(): void {
    this.mode.set(this.conversation().length > 0 ? 'paper' : 'pill');
    this.triggerFocus();
  }

  async refreshSlips(query?: string): Promise<void> {
    try {
      const list = await this.bridge.listSlips(query, 40);
      this.slipArchive.set(list);
    } catch {
      this.slipArchive.set([]);
    }
  }

  async refreshMemories(): Promise<void> {
    try {
      const list = await this.bridge.listMemories();
      this.memories.set(list);
    } catch {
      this.memories.set([]);
    }
  }

  async reopenSlip(id: string): Promise<void> {
    const slip = await this.bridge.getSlip(id);
    if (!slip) {
      this.showToast('Slip not found in archive');
      return;
    }
    this.currentSlipId.set(slip.id);
    this.slipNumber.set(slip.slipNumber);
    this.conversation.set(
      slip.turns.map((t, idx) => {
        let toolActions: ToolActionEntry[] | undefined;
        try {
          const parsed = JSON.parse(t.toolActionsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            toolActions = parsed;
          }
        } catch {
          toolActions = undefined;
        }
        return {
          id: ++this.turnSeq + idx,
          question: t.question,
          answer: t.answer,
          timestamp: t.timestamp,
          providerLabel: t.providerLabel,
          model: t.model,
          streaming: false,
          stopped: false,
          truncated: false,
          contextLabels: t.contextLabels.length > 0 ? t.contextLabels : undefined,
          toolActions,
        };
      }),
    );
    this.mode.set('paper');
    this.triggerFocus();
  }

  async deleteArchivedSlip(id: string): Promise<void> {
    await this.bridge.deleteSlip(id);
    await this.refreshSlips();
    this.showToast('Deleted archived slip');
  }

  async saveCurrentSlip(): Promise<void> {
    const turns = this.conversation().filter((t) => !t.streaming && (t.answer.trim() || t.toolActions?.length));
    if (turns.length === 0) {
      return;
    }
    const firstQ = turns[0].question;
    const title = firstQ.length > 64 ? firstQ.slice(0, 64) + '…' : firstQ;
    const nowSec = Math.floor(Date.now() / 1000);
    const slip: StoredSlip = {
      id: this.currentSlipId(),
      slipNumber: this.slipNumber(),
      title,
      provider: this.activeProviderDef()?.label ?? this.config().provider,
      model: this.config().model,
      createdAt: nowSec,
      updatedAt: nowSec,
      turns: turns.map((t) => ({
        question: t.question,
        answer: t.answer,
        timestamp: t.timestamp,
        providerLabel: t.providerLabel,
        model: t.model,
        contextLabels: t.contextLabels ?? [],
        toolActionsJson: JSON.stringify(t.toolActions ?? []),
      })),
    };
    try {
      await this.bridge.saveSlip(slip);
    } catch {
      // Non-fatal persistence error
    }
  }

  async detachCurrentSlip(): Promise<void> {
    await this.saveCurrentSlip();
    await this.detachSlipById(this.currentSlipId());
  }

  async detachSlipById(slipId: string): Promise<void> {
    try {
      await this.bridge.detachSlip(slipId);
      this.showToast('Popped slip into floating sticky window');
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async rememberFact(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    try {
      await this.bridge.addMemory(trimmed);
      await this.refreshMemories();
      this.showToast('Saved to personal memory');
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async removeMemory(id: number): Promise<void> {
    await this.bridge.deleteMemory(id);
    await this.refreshMemories();
  }

  async toggleVoiceRecording(): Promise<void> {
    if (this.isRecordingVoice()) {
      this.mediaRecorder?.stop();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.errorBanner.set('Microphone recording is unavailable in this environment.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recordedChunks = [];
      const recorder = new MediaRecorder(stream);
      this.mediaRecorder = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          this.recordedChunks.push(ev.data);
        }
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        this.isRecordingVoice.set(false);
        const mime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.recordedChunks, { type: mime });
        this.recordedChunks = [];
        if (blob.size === 0) {
          return;
        }
        this.isTranscribingVoice.set(true);
        try {
          const buf = await blob.arrayBuffer();
          const text = await this.bridge.transcribeVoice(new Uint8Array(buf), mime);
          if (text) {
            const cur = this.inputText().trim();
            this.setInput(cur ? `${cur} ${text}` : text);
            this.showToast('Transcribed voice input');
          }
        } catch (err) {
          this.errorBanner.set(err instanceof Error ? err.message : String(err));
        } finally {
          this.isTranscribingVoice.set(false);
          this.triggerFocus();
        }
      };
      this.noteInteraction(true);
      this.isRecordingVoice.set(true);
      this.spawnParticle('♪');
      recorder.start();
      this.showToast('Listening… click Listening pill or /voice to transcribe');
    } catch (err) {
      this.isRecordingVoice.set(false);
      this.errorBanner.set(
        `Microphone access denied: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  acceptGhostCompletion(): boolean {
    const ghost = this.autocomplete().ghostFullValue;
    if (!ghost || ghost === this.inputText()) {
      return false;
    }
    this.inputText.set(ghost);
    this.selectedSuggestionIndex.set(0);
    return true;
  }

  moveSelection(delta: number): void {
    const items = this.visibleSuggestions();
    if (items.length === 0) {
      return;
    }
    const next = (this.selectedSuggestionIndex() + delta + items.length) % items.length;
    this.selectedSuggestionIndex.set(next);
  }

  addOrReplaceAttachment(att: ContextAttachment): void {
    this.attachments.update((list) => {
      if (att.kind === 'selection' || att.kind === 'window' || att.kind === 'clipboard') {
        return [...list.filter((item) => item.kind !== att.kind), att];
      }
      return [...list, att];
    });
  }

  removeAttachment(id: string): void {
    this.attachments.update((list) => list.filter((item) => item.id !== id));
    this.triggerFocus();
  }

  clearAttachments(): void {
    this.attachments.set([]);
  }

  async attachClipboard(): Promise<boolean> {
    try {
      const payload = await this.bridge.captureClipboard();
      if (payload.kind === 'text' && payload.text) {
        const trimmed = payload.text.trim();
        this.addOrReplaceAttachment({
          id: `att-${++this.attachSeq}`,
          kind: 'clipboard',
          label: `Clipboard · ${trimmed.length}c`,
          text: trimmed,
        });
        this.reactToContextAttach('Attached clipboard text');
        this.showToast('Attached Windows clipboard text');
        return true;
      }
      if (payload.kind === 'image' && payload.base64Png) {
        this.addOrReplaceAttachment({
          id: `att-${++this.attachSeq}`,
          kind: 'screenshot',
          label: `Clipboard Image (${payload.width ?? '?'}×${payload.height ?? '?'})`,
          image: { mimeType: 'image/png', dataBase64: payload.base64Png },
        });
        this.reactToScreenAttach();
        this.showToast('Attached clipboard image');
        return true;
      }
      this.showToast('Clipboard is empty');
      return false;
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async attachActiveWindow(): Promise<boolean> {
    const win = this.previousWindow() ?? (await this.bridge.getPreviousWindow());
    if (!win) {
      this.showToast('No active target window detected yet');
      return false;
    }
    this.previousWindow.set(win);
    const summary = `Active Windows App: ${win.processName}\nWindow Title: ${win.title}${
      win.exePath ? `\nExecutable: ${win.exePath}` : ''
    }`;
    this.addOrReplaceAttachment({
      id: `att-${++this.attachSeq}`,
      kind: 'window',
      label: `Window · ${win.processName}`,
      detail: win.title,
      text: summary,
    });
    this.reactToContextAttach(`Looking at ${win.processName}`);
    this.showToast(`Attached window context (${win.processName})`);
    return true;
  }

  async attachScreen(mode: 'full' | 'active_window' = 'full'): Promise<boolean> {
    try {
      const cap = await this.bridge.captureScreen(mode);
      this.addOrReplaceAttachment({
        id: `att-${++this.attachSeq}`,
        kind: 'screenshot',
        label: cap.label,
        image: { mimeType: 'image/png', dataBase64: cap.base64Png },
      });
      this.reactToScreenAttach();
      this.showToast(`Captured ${cap.label}`);
      this.triggerFocus();
      return true;
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async attachFilePaths(paths: string[]): Promise<void> {
    let attachedAny = false;
    for (const path of paths.slice(0, 4)) {
      try {
        const res = await this.bridge.readFileAttachment(path);
        if (res.kind === 'image' && res.base64Png) {
          this.addOrReplaceAttachment({
            id: `att-${++this.attachSeq}`,
            kind: 'file',
            label: res.name,
            detail: `${res.width ?? '?'}×${res.height ?? '?'}`,
            image: { mimeType: 'image/png', dataBase64: res.base64Png },
          });
          attachedAny = true;
        } else if (res.text !== undefined && res.text !== null) {
          this.addOrReplaceAttachment({
            id: `att-${++this.attachSeq}`,
            kind: 'file',
            label: res.name,
            detail: res.truncated ? 'truncated 128KB' : `${res.text.length}c`,
            text: `File: ${res.path}\n\n${res.text}`,
          });
          attachedAny = true;
        }
      } catch (err) {
        this.errorBanner.set(err instanceof Error ? err.message : String(err));
      }
    }
    if (attachedAny) {
      this.reactToContextAttach('Inspecting your file');
    }
    this.triggerFocus();
  }

  async attachPastedImage(blob: Blob): Promise<void> {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read pasted image'));
        reader.readAsDataURL(blob);
      });
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const mimeType = blob.type || 'image/png';
      this.addOrReplaceAttachment({
        id: `att-${++this.attachSeq}`,
        kind: 'screenshot',
        label: 'Pasted Image',
        image: { mimeType, dataBase64: base64 },
      });
      this.reactToScreenAttach();
      this.showToast('Attached pasted image');
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async refreshClipboardHistory(): Promise<void> {
    try {
      const items = await this.bridge.getClipboardHistory();
      this.clipboardHistory.set(items);
    } catch {
      this.clipboardHistory.set([]);
    }
  }

  async switchModelProfile(provider: ProviderId, model: string): Promise<void> {
    try {
      const updated = await this.bridge.switchModelProfile(provider, model);
      this.applyAppState(updated);
      this.inputText.set('');
      this.dropdownDismissed.set(true);
      this.showToast(`Switched to ${provider} / ${model}`);
      this.triggerFocus();
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async setAutostart(enabled: boolean): Promise<void> {
    try {
      const updated = await this.bridge.setAutostart(enabled);
      this.applyAppState(updated);
      this.showToast(enabled ? 'ASKII will start with Windows' : 'Disabled Windows startup');
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async setClipboardHistoryEnabled(enabled: boolean): Promise<void> {
    try {
      const updated = await this.bridge.setClipboardHistoryEnabled(enabled);
      this.applyAppState(updated);
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async applyMentionToken(token: string): Promise<void> {
    const cleaned = this.inputText().replace(/(?:^|\s)@[a-zA-Z0-9:]*$/, '').trimEnd();
    this.inputText.set(cleaned ? `${cleaned} ` : '');
    this.dropdownDismissed.set(true);

    const lower = token.toLowerCase();
    if (lower.startsWith('@clip:')) {
      const idx = Number.parseInt(lower.slice('@clip:'.length), 10);
      if (this.clipboardHistory().length === 0) {
        await this.refreshClipboardHistory();
      }
      const entry = this.clipboardHistory().find((c) => c.index === idx);
      if (entry) {
        this.addOrReplaceAttachment({
          id: `att-${++this.attachSeq}`,
          kind: 'clipboard',
          label: `Clip #${entry.index} · ${entry.text.length}c`,
          detail: entry.sourceApp ?? undefined,
          text: entry.text,
        });
        this.showToast(`Attached clipboard item #${entry.index}`);
      } else {
        this.showToast(`Clipboard item #${idx} not found`);
      }
      this.triggerFocus();
      return;
    }

    switch (lower) {
      case '@clip':
        await this.attachClipboard();
        break;
      case '@window':
        await this.attachActiveWindow();
        break;
      case '@screen':
        await this.attachScreen('full');
        break;
      case '@winscreen':
        await this.attachScreen('active_window');
        break;
    }
    this.triggerFocus();
  }

  openSetup(step: 'provider' | 'shortcut' | 'agent' = 'provider'): void {
    this.setupInitialStep.set(step);
    this.errorBanner.set(null);
    this.dropdownDismissed.set(true);
    this.mode.set('setup');
  }

  async toggleAutoDo(): Promise<void> {
    try {
      const updated = await this.bridge.toggleAutoDo();
      this.applyAppState(updated);
      const on = updated.config.agent.mode === 'autoDo';
      this.showToast(
        on
          ? 'AUTO DO enabled — ASKII will execute OS actions autonomously'
          : 'Confirm mode enabled — ASKII will ask before running actions',
      );
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  async saveAgentSettings(agent: AgentSettings): Promise<void> {
    const updated = await this.bridge.saveAgentSettings(agent);
    this.applyAppState(updated);
    this.showToast(
      agent.enabled
        ? `ASKII Do saved (${agent.mode === 'autoDo' ? 'Auto Do' : 'Confirm'} mode)`
        : 'ASKII Do tools disabled',
    );
  }

  async resolveToolApproval(
    turnId: number,
    callId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.bridge.resolveToolApproval(callId, decision);
    this.updateTurn(turnId, (t) => ({
      ...t,
      toolActions: (t.toolActions ?? []).map((a) =>
        a.callId === callId
          ? { ...a, status: decision === 'deny' ? 'denied' : 'running' }
          : a,
      ),
    }));
  }

  async undoBackup(turnId: number, callId: string, backupId: string): Promise<void> {
    try {
      const msg = await this.bridge.undoToolBackup(backupId);
      this.updateTurn(turnId, (t) => ({
        ...t,
        toolActions: (t.toolActions ?? []).map((a) =>
          a.callId === callId ? { ...a, undone: true } : a,
        ),
      }));
      this.showToast(msg);
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  closeSetup(): void {
    if (this.needsSetup()) {
      this.showToast('Connect an LLM provider to start asking ASKII');
      return;
    }
    this.mode.set(this.conversation().length > 0 ? 'paper' : 'pill');
    this.triggerFocus();
  }

  async saveSetup(req: SaveSetupRequest): Promise<void> {
    const updated = await this.bridge.saveSetup(req);
    this.applyAppState(updated);
    this.mode.set(this.conversation().length > 0 ? 'paper' : 'pill');
    this.pokeAskii();
    this.showToast(`Connected ${this.activeProviderDef()?.label ?? req.provider} · ${req.model}`);
    this.triggerFocus();
  }

  async submitCurrentInput(): Promise<void> {
    let raw = this.inputText().trim();
    if (!raw && this.attachments().length === 0) {
      return;
    }

    // Resolve any inline @context mentions typed directly without clicking autocomplete
    const inlineTokens = raw.match(/@(?:clip|window|screen|winscreen)\b/gi);
    if (inlineTokens) {
      for (const tok of inlineTokens) {
        const lower = tok.toLowerCase();
        if (lower === '@clip') await this.attachClipboard();
        else if (lower === '@window') await this.attachActiveWindow();
        else if (lower === '@screen') await this.attachScreen('full');
        else if (lower === '@winscreen') await this.attachScreen('active_window');
      }
      raw = raw.replace(/@(?:clip|window|screen|winscreen)\b/gi, '').replace(/\s+/g, ' ').trim();
      if (!raw && this.attachments().length > 0) {
        this.inputText.set('');
        this.triggerFocus();
        return;
      }
    }

    if (raw.startsWith('/')) {
      const handled = await this.tryExecuteRecipeOrCommand(raw);
      if (handled) {
        return;
      }
    }

    if (this.needsSetup()) {
      this.openSetup('provider');
      return;
    }

    const questionText = raw || 'Analyze the attached context.';
    await this.askQuestion(questionText);
  }

  private async tryExecuteRecipeOrCommand(rawCommand: string): Promise<boolean> {
    const parts = rawCommand.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = rawCommand.trim().slice(parts[0].length).trim();

    const recipe = this.config().recipes.find((r) => r.command.toLowerCase() === cmd);
    if (recipe) {
      if (this.needsSetup()) {
        this.openSetup('provider');
        return true;
      }
      await this.runRecipe(recipe, rest);
      return true;
    }

    await this.executeSlashCommand(rawCommand);
    return true;
  }

  private async runRecipe(recipe: PromptRecipe, userArgs: string): Promise<void> {
    if (recipe.autoAttachClipboard && this.attachments().length === 0) {
      const hasLongBody = userArgs.length > 40;
      if (!hasLongBody) {
        await this.attachClipboard();
      }
    }

    const displayQuestion = userArgs ? `${recipe.command} ${userArgs}` : recipe.command;
    const composedPrompt = userArgs
      ? `${recipe.userPrefix}\n${userArgs}`
      : recipe.userPrefix;

    await this.askQuestion(displayQuestion, {
      llmUserContent: composedPrompt,
      systemPromptOverride: recipe.systemPrompt,
      modelOverride: recipe.modelOverride ?? undefined,
    });
  }

  async executeSlashCommand(rawCommand: string): Promise<void> {
    const ctrl = parseControlCommands(rawCommand);
    if (ctrl) {
      this.dropdownDismissed.set(true);
      if (!ctrl.task && this.attachments().length === 0) {
        const prefix =
          ctrl.enableScreenControl && ctrl.enableBrowserControl
            ? '/screen /browser '
            : ctrl.enableScreenControl
              ? '/screen '
              : '/browser ';
        this.inputText.set(prefix);
        this.showToast(
          ctrl.enableScreenControl && ctrl.enableBrowserControl
            ? 'Screen & Chrome Puppeteer ready — type your task after the command'
            : ctrl.enableScreenControl
              ? 'Screen control ready — type what you want ASKII to click or type'
              : 'Chrome Puppeteer ready — type what you want ASKII to do in Chrome',
        );
        this.triggerFocus();
        return;
      }
      if (this.needsSetup()) {
        this.openSetup('provider');
        return;
      }
      const extraContextLabels: string[] = [];
      if (ctrl.enableScreenControl) {
        extraContextLabels.push('Screen Control');
      }
      if (ctrl.enableBrowserControl) {
        extraContextLabels.push('Chrome Puppeteer');
      }
      await this.askQuestion(rawCommand.trim(), {
        llmUserContent: ctrl.task || 'Inspect the current state and report what you see.',
        enableScreenControl: ctrl.enableScreenControl,
        enableBrowserControl: ctrl.enableBrowserControl,
        extraContextLabels,
      });
      return;
    }

    const parts = rawCommand.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').toLowerCase();
    this.inputText.set('');
    this.dropdownDismissed.set(true);

    switch (cmd) {
      case '/model':
        if (this.config().recentModels.length > 0) {
          this.setInput('/model ');
          this.triggerFocus();
        } else {
          this.openSetup('provider');
        }
        break;
      case '/autodo':
        await this.toggleAutoDo();
        break;
      case '/agent':
        this.openSetup('agent');
        break;
      case '/snip':
        await this.attachScreen(arg.includes('win') ? 'active_window' : 'full');
        break;
      case '/voice':
        await this.toggleVoiceRecording();
        break;
      case '/setup':
      case '/provider':
        this.openSetup('provider');
        break;
      case '/shortcut':
        this.openSetup('shortcut');
        break;
      case '/clear':
        this.clearAttachments();
        await this.tearOffPaper();
        break;
      case '/history':
        await this.openHistory();
        break;
      case '/memory':
        await this.openMemory();
        break;
      case '/remember': {
        const fact = rawCommand.trim().slice('/remember'.length).trim();
        if (!fact) {
          await this.openMemory();
        } else {
          await this.rememberFact(fact);
        }
        break;
      }
      case '/reindex': {
        const count = await this.bridge.refreshAppIndex();
        this.showToast(`Reindexed ${count} Windows Start Menu apps`);
        break;
      }
      case '/pin':
        await this.togglePin();
        break;
      case '/hide':
        await this.bridge.hideWindow();
        break;
      case '/quit':
        await this.bridge.quitApp();
        break;
      default: {
        const recipe = this.config().recipes.find((r) => r.command.toLowerCase() === cmd);
        if (recipe) {
          if (this.needsSetup()) {
            this.openSetup('provider');
            return;
          }
          await this.runRecipe(recipe, parts.slice(1).join(' '));
          return;
        }
        this.errorBanner.set(`Unknown command "${cmd}". Type / to see available commands.`);
        break;
      }
    }
  }

  async askQuestion(
    question: string,
    options?: {
      llmUserContent?: string;
      systemPromptOverride?: string;
      modelOverride?: string;
      enableScreenControl?: boolean;
      enableBrowserControl?: boolean;
      extraContextLabels?: string[];
    },
  ): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }

    if (this.isThinking() || this.isPrinting()) {
      await this.stopGeneration();
    }

    const activeAttachments = this.attachments();
    const contextBlocks: string[] = [];
    const images: ImageAttachment[] = [];
    const contextLabels: string[] = [...(options?.extraContextLabels ?? [])];

    for (const att of activeAttachments) {
      contextLabels.push(att.label);
      if (att.text) {
        contextBlocks.push(`--- ${att.label} ---\n${att.text}`);
      }
      if (att.image) {
        images.push(att.image);
      }
    }

    const baseContent = options?.llmUserContent ?? trimmed;
    const finalUserContent =
      contextBlocks.length > 0
        ? `${contextBlocks.join('\n\n')}\n\n--- User Request ---\n${baseContent}`
        : baseContent;

    // Build full multi-turn context from completed turns
    const historyMessages: ChatMessage[] = [];
    for (const turn of this.conversation()) {
      if (turn.answer.trim()) {
        historyMessages.push({ role: 'user', content: turn.question });
        historyMessages.push({ role: 'assistant', content: turn.answer });
      }
    }
    historyMessages.push({
      role: 'user',
      content: finalUserContent,
      images: images.length > 0 ? images : undefined,
    });

    this.config.update((cfg) => {
      const nextHistory = [
        trimmed,
        ...cfg.promptHistory.filter((p) => p.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, 100);
      return { ...cfg, promptHistory: nextHistory };
    });

    const turnId = ++this.turnSeq;
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const turn: ConversationTurn = {
      id: turnId,
      question: trimmed,
      answer: '',
      timestamp,
      providerLabel: this.activeProviderDef()?.label ?? this.config().provider,
      model: options?.modelOverride || this.config().model,
      streaming: true,
      stopped: false,
      truncated: false,
      contextLabels: contextLabels.length > 0 ? contextLabels : undefined,
    };

    this.inputText.set('');
    this.attachments.set([]);
    this.dropdownDismissed.set(true);
    this.errorBanner.set(null);
    this.showHistoryOnly.set(false);
    this.isTearing.set(false);

    this.noteInteraction(true);
    this.petMenuOpen.set(false);
    this.clearReactionTimers();
    this.petReaction.set(null);

    const sentiment = analyzeUserSentiment(trimmed, this.conversationalEmotion()?.emotion ?? null);
    if (sentiment) {
      this.setLingeringEmotion(sentiment.emotion, sentiment.reason, 32_000);
      this.adjustAffection(sentiment.affectionDelta);
      this.adjustEnergy(sentiment.energyDelta);
      if (sentiment.particle) {
        this.spawnParticle(sentiment.particle);
      }
    }

    this.conversation.update((list) => [...list, turn]);
    this.mode.set('paper');
    this.isThinking.set(true);
    this.isPrinting.set(false);

    try {
      await this.bridge.askStream(
        trimmed,
        historyMessages,
        (ev) => {
          if (ev.event === 'chunk') {
            this.isThinking.set(false);
            this.isPrinting.set(true);
            const nowMs = Date.now();
            if (nowMs - this.lastTalkPulseAt >= 110) {
              this.lastTalkPulseAt = nowMs;
              this.talkPulse.update((n) => n + 1);
            }
            this.updateTurn(turnId, (t) => ({
              ...t,
              answer: t.answer + ev.data.text,
            }));
          } else if (ev.event === 'toolProposed') {
            this.isThinking.set(false);
            const entry: ToolActionEntry = {
              callId: ev.data.callId,
              name: ev.data.name,
              tier: ev.data.tier,
              summary: ev.data.summary,
              arguments: ev.data.arguments,
              status: ev.data.needsApproval ? 'pendingApproval' : 'running',
              dangerWarning: ev.data.dangerWarning,
            };
            this.updateTurn(turnId, (t) => ({
              ...t,
              toolActions: [...(t.toolActions ?? []), entry],
            }));
          } else if (ev.event === 'toolRunning') {
            if (ev.data.name === 'launch_app' || ev.data.name === 'open_url') {
              this.reactToOpening();
            }
            this.updateTurn(turnId, (t) => ({
              ...t,
              toolActions: (t.toolActions ?? []).map((a) =>
                a.callId === ev.data.callId ? { ...a, status: 'running' } : a,
              ),
            }));
          } else if (ev.event === 'toolResult') {
            this.updateTurn(turnId, (t) => ({
              ...t,
              toolActions: (t.toolActions ?? []).map((a) =>
                a.callId === ev.data.callId
                  ? {
                      ...a,
                      status: ev.data.success ? 'success' : 'error',
                      output: ev.data.output,
                      backupId: ev.data.backupId,
                    }
                  : a,
              ),
            }));
          } else if (ev.event === 'toolDenied') {
            this.updateTurn(turnId, (t) => ({
              ...t,
              toolActions: (t.toolActions ?? []).map((a) =>
                a.callId === ev.data.callId
                  ? { ...a, status: 'denied', output: ev.data.reason }
                  : a,
              ),
            }));
          } else if (ev.event === 'done') {
            this.isThinking.set(false);
            this.isPrinting.set(false);
            this.noteInteraction(false);
            this.updateTurn(turnId, (t) => ({
              ...t,
              streaming: false,
              truncated: ev.data.truncated,
            }));
            void this.saveCurrentSlip();
          } else if (ev.event === 'cancelled') {
            this.isThinking.set(false);
            this.isPrinting.set(false);
            this.updateTurn(turnId, (t) => ({
              ...t,
              streaming: false,
              stopped: true,
            }));
          } else if (ev.event === 'error') {
            this.isThinking.set(false);
            this.isPrinting.set(false);
            this.updateTurn(turnId, (t) => ({
              ...t,
              streaming: false,
              error: ev.data.message,
            }));
          }
        },
        {
          systemPromptOverride: options?.systemPromptOverride,
          modelOverride: options?.modelOverride,
          enableScreenControl: options?.enableScreenControl ?? false,
          enableBrowserControl: options?.enableBrowserControl ?? false,
        },
      );
    } catch (err) {
      this.isThinking.set(false);
      this.isPrinting.set(false);
      const message = err instanceof Error ? err.message : String(err);
      this.updateTurn(turnId, (t) => ({
        ...t,
        streaming: false,
        error: message,
      }));
    } finally {
      this.triggerFocus();
    }
  }

  async insertLatestReply(): Promise<void> {
    const turns = this.conversation();
    if (turns.length === 0) {
      return;
    }
    const latest = turns[turns.length - 1];
    const text = latest.answer.trim();
    if (!text) {
      return;
    }
    try {
      await this.bridge.insertReply(text);
      this.showToast(
        `Inserted into ${this.previousWindow()?.processName ?? 'active app'}`,
      );
    } catch (err) {
      this.errorBanner.set(err instanceof Error ? err.message : String(err));
    }
  }

  private updateTurn(id: number, updater: (t: ConversationTurn) => ConversationTurn): void {
    this.conversation.update((list) => list.map((t) => (t.id === id ? updater(t) : t)));
  }

  async stopGeneration(): Promise<void> {
    await this.bridge.cancelActiveStream();
    this.isThinking.set(false);
    this.isPrinting.set(false);
  }

  async tearOffPaper(): Promise<void> {
    if (this.isThinking() || this.isPrinting()) {
      await this.stopGeneration();
    }
    if (this.mode() !== 'paper') {
      this.conversation.set([]);
      return;
    }
    this.isTearing.set(true);
    await new Promise((r) => setTimeout(r, 320));
    this.conversation.set([]);
    this.slipNumber.update((n) => n + 1);
    this.currentSlipId.set(`slip-${Date.now()}`);
    this.showHistoryOnly.set(false);
    this.isTearing.set(false);
    this.mode.set('pill');
    this.triggerFocus();
  }

  async togglePin(): Promise<void> {
    const next = !this.isPinned();
    this.isPinned.set(next);
    await this.bridge.setPinned(next);
    this.showToast(next ? 'Pinned — stays open on focus change' : 'Unpinned');
  }

  async handleEscape(): Promise<void> {
    if (this.petMenuOpen()) {
      this.petMenuOpen.set(false);
      return;
    }
    if (this.isThinking() || this.isPrinting()) {
      await this.stopGeneration();
      return;
    }
    if (this.showAutocompleteDropdown()) {
      this.dropdownDismissed.set(true);
      return;
    }
    if (this.mode() === 'setup') {
      if (!this.needsSetup()) {
        this.closeSetup();
      } else {
        await this.bridge.hideWindow();
      }
      return;
    }
    if (this.mode() === 'history' || this.mode() === 'memory') {
      this.closeDrawer();
      return;
    }
    if (this.mode() === 'paper') {
      await this.tearOffPaper();
      return;
    }
    if (this.attachments().length > 0) {
      this.clearAttachments();
      return;
    }
    await this.bridge.hideWindow();
  }

  async handleBackdropClick(): Promise<void> {
    if (this.isPinned() || this.mode() === 'setup') {
      return;
    }
    await this.bridge.hideWindow();
  }

  showToast(message: string): void {
    this.toastMessage.set(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastMessage.set(null), 2400);
  }
}
