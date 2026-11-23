import { Component, ElementRef, HostListener, effect, inject, viewChild } from '@angular/core';
import { AskiiStateService } from '../../core/askii-state.service';
import { AutocompleteSuggestion } from '../../core/models';

@Component({
  selector: 'app-spotlight-input',
  standalone: true,
  templateUrl: './spotlight-input.component.html',
  styleUrl: './spotlight-input.component.scss',
})
export class SpotlightInputComponent {
  readonly state = inject(AskiiStateService);
  readonly pipSlots = [1, 2, 3, 4, 5] as const;
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('promptInput');
  private readonly petAnchorEl = viewChild<ElementRef<HTMLElement>>('petAnchor');

  constructor() {
    effect(() => {
      this.state.focusTick();
      if (this.state.mode() !== 'setup') {
        queueMicrotask(() => {
          const el = this.inputEl()?.nativeElement;
          el?.focus();
        });
      }
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.state.petMenuOpen()) {
      return;
    }
    const anchor = this.petAnchorEl()?.nativeElement;
    if (anchor && event.target instanceof Node && !anchor.contains(event.target)) {
      this.state.closePetMenu();
    }
  }

  @HostListener('document:contextmenu', ['$event'])
  onDocumentContextMenu(event: MouseEvent): void {
    if (!this.state.petMenuOpen()) {
      return;
    }
    const anchor = this.petAnchorEl()?.nativeElement;
    if (anchor && event.target instanceof Node && !anchor.contains(event.target)) {
      this.state.closePetMenu();
    }
  }

  onPetClick(event: MouseEvent): void {
    event.stopPropagation();
    this.state.petAskii();
  }

  onPetContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.state.togglePetMenu();
  }

  get affectionLevel(): number {
    return Math.max(0, Math.min(5, Math.round(this.state.petAffection() / 20)));
  }

  get energyLevel(): number {
    return Math.max(0, Math.min(5, Math.round(this.state.petEnergy() / 20)));
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.state.setInput(value);
  }

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          event.preventDefault();
          void this.state.attachPastedImage(blob);
          return;
        }
      }
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    const suggestions = this.state.visibleSuggestions();
    const hasDropdown = this.state.showAutocompleteDropdown();

    if (event.ctrlKey && event.key === 'Enter' && this.state.mode() === 'paper') {
      event.preventDefault();
      void this.state.insertLatestReply();
      return;
    }

    if (event.key === 'Tab') {
      if (this.state.acceptGhostCompletion()) {
        event.preventDefault();
        return;
      }
      if (hasDropdown && suggestions.length > 0) {
        event.preventDefault();
        const chosen = suggestions[this.state.selectedSuggestionIndex()] ?? suggestions[0];
        if (chosen.kind === 'mention') {
          void this.state.applyMentionToken(chosen.value);
        } else {
          const needsTrailingSpace =
            chosen.kind === 'recipe' ||
            chosen.value === '/screen' ||
            chosen.value === '/browser' ||
            chosen.value === '/remember' ||
            chosen.value === '/model';
          this.state.setInput(needsTrailingSpace ? `${chosen.value} ` : chosen.value);
        }
        return;
      }
    }

    if (
      event.key === 'ArrowRight' &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length &&
      this.state.autocomplete().ghostSuffix
    ) {
      if (this.state.acceptGhostCompletion()) {
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'ArrowDown' && hasDropdown) {
      event.preventDefault();
      this.state.moveSelection(1);
      return;
    }

    if (event.key === 'ArrowUp' && hasDropdown) {
      event.preventDefault();
      this.state.moveSelection(-1);
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (hasDropdown && suggestions.length > 0) {
        const chosen = suggestions[this.state.selectedSuggestionIndex()] ?? suggestions[0];
        if (
          chosen.kind === 'command' ||
          chosen.kind === 'recipe' ||
          chosen.kind === 'mention' ||
          chosen.kind === 'instant' ||
          chosen.kind === 'model'
        ) {
          void this.selectSuggestion(chosen);
          return;
        }
      }
      void this.state.submitCurrentInput();
    }
  }

  async selectSuggestion(item: AutocompleteSuggestion): Promise<void> {
    if (item.kind === 'model' && item.modelProfile) {
      await this.state.switchModelProfile(item.modelProfile.provider, item.modelProfile.model);
      return;
    }
    if (item.kind === 'instant' && item.instantItem) {
      await this.state.executeInstantItem(item.instantItem);
      return;
    }
    if (item.kind === 'mention') {
      await this.state.applyMentionToken(item.value);
      return;
    }
    if (item.kind === 'command' || item.kind === 'recipe') {
      await this.state.executeSlashCommand(item.value);
      return;
    }
    this.state.setInput(item.value);
    this.state.dropdownDismissed.set(true);
    this.state.triggerFocus();
  }

  get placeholderText(): string {
    if (this.state.attachments().length > 0) {
      return 'Ask about attached context, or /fix /explain /summarize…';
    }
    if (this.state.conversation().length > 0) {
      return 'Ask a follow-up, type @ for context, or / for commands…';
    }
    return 'Ask ASKII anything… (@ for context, / for commands)';
  }
}
