import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { AskiiStateService } from '../../core/askii-state.service';
import { renderSafeMarkdown } from '../../core/markdown';

@Component({
  selector: 'app-print-paper',
  standalone: true,
  templateUrl: './print-paper.component.html',
  styleUrl: './print-paper.component.scss',
})
export class PrintPaperComponent {
  readonly state = inject(AskiiStateService);
  private readonly scrollBody = viewChild<ElementRef<HTMLDivElement>>('paperScroll');
  readonly copied = signal(false);

  readonly renderedTurns = computed(() =>
    this.state.conversation().map((turn) => ({
      ...turn,
      html: renderSafeMarkdown(turn.answer),
    })),
  );

  readonly latestTurn = computed(() => {
    const list = this.state.conversation();
    return list.length > 0 ? list[list.length - 1] : null;
  });

  readonly slipCode = computed(() => String(this.state.slipNumber()).padStart(2, '0'));

  constructor() {
    effect(() => {
      const turns = this.state.conversation();
      const totalChars = turns.reduce((acc, t) => acc + t.answer.length, 0);
      if (totalChars > 0) {
        queueMicrotask(() => {
          const el = this.scrollBody()?.nativeElement;
          if (el) {
            el.scrollTop = el.scrollHeight;
          }
        });
      }
    });
  }

  async copyLatest(): Promise<void> {
    const turns = this.state.conversation();
    if (turns.length === 0) {
      return;
    }
    const text =
      turns.length === 1
        ? turns[0].answer
        : turns.map((t) => `Q: ${t.question}\n\n${t.answer}`).join('\n\n---\n\n');

    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      this.state.showToast('Could not access clipboard');
    }
  }

  async onMarkdownClick(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement | null;
    const btn = target?.closest<HTMLButtonElement>('button[data-copy-code]');
    if (!btn) {
      return;
    }
    const wrap = btn.closest('.code-block-wrap');
    const codeText = wrap?.querySelector('pre code')?.textContent ?? '';
    if (!codeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(codeText);
      const prev = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => {
        btn.textContent = prev || 'Copy';
      }, 1400);
    } catch {
      this.state.showToast('Could not copy code block');
    }
  }
}
