import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { renderSafeMarkdown } from '../../core/markdown';
import { StoredSlip } from '../../core/models';
import { TauriBridgeService } from '../../core/tauri-bridge.service';

@Component({
  selector: 'app-sticky-slip',
  standalone: true,
  template: `
    <article class="sticky-sheet">
      <header class="sticky-head" data-tauri-drag-region>
        <div class="sticky-meta" data-tauri-drag-region>
          <span class="sticky-badge">PINNED SLIP</span>
          <span class="sticky-title">{{ slip()?.title || 'ASKII Sticky Slip' }}</span>
        </div>
        <div class="sticky-actions">
          <button type="button" class="sticky-btn" (click)="copyAll()">
            {{ copied() ? '✓' : 'Copy' }}
          </button>
          <button type="button" class="sticky-btn danger" (click)="close()">✕</button>
        </div>
      </header>

      <div class="sticky-body">
        @if (!slip()) {
          <div class="sticky-empty">Loading slip…</div>
        } @else {
          @for (t of renderedTurns(); track $index) {
            <div class="sticky-turn">
              <div class="sticky-q">&gt; {{ t.question }}</div>
              <div class="paper-markdown" [innerHTML]="t.html"></div>
            </div>
          }
        }
      </div>
    </article>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        padding: 8px;
      }
      .sticky-sheet {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        border-radius: 14px;
        background: #faf6ee;
        color: #172033;
        border: 1px solid rgba(23, 32, 51, 0.22);
        box-shadow: 0 14px 32px rgba(0, 0, 0, 0.38);
        overflow: hidden;
      }
      .sticky-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 12px;
        background: #f0e8d8;
        border-bottom: 1px dashed rgba(23, 32, 51, 0.2);
        cursor: grab;
      }
      .sticky-meta {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .sticky-badge {
        font-family: var(--font-mono);
        font-size: 9.5px;
        font-weight: 800;
        padding: 2px 6px;
        border-radius: 4px;
        background: #1d4ed8;
        color: #fff;
        flex: 0 0 auto;
      }
      .sticky-title {
        font-size: 12px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sticky-actions {
        display: flex;
        gap: 5px;
        flex: 0 0 auto;
      }
      .sticky-btn {
        border: 1px solid rgba(23, 32, 51, 0.18);
        background: rgba(255, 255, 255, 0.7);
        color: #172033;
        border-radius: 6px;
        padding: 2px 8px;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 700;
        cursor: pointer;
        &.danger {
          color: #b41835;
        }
      }
      .sticky-body {
        flex: 1;
        overflow-y: auto;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .sticky-q {
        font-family: var(--font-mono);
        font-size: 11.5px;
        font-weight: 700;
        color: #1e3a8a;
        margin-bottom: 4px;
      }
      .sticky-empty {
        text-align: center;
        padding: 32px;
        color: #5c687f;
        font-size: 12px;
      }
    `,
  ],
})
export class StickySlipComponent implements OnInit {
  private readonly bridge = inject(TauriBridgeService);
  readonly slipId = input.required<string>();
  readonly slip = signal<StoredSlip | null>(null);
  readonly copied = signal(false);

  readonly renderedTurns = computed(() =>
    (this.slip()?.turns ?? []).map((t) => ({
      ...t,
      html: renderSafeMarkdown(t.answer),
    })),
  );

  async ngOnInit(): Promise<void> {
    const loaded = await this.bridge.getSlip(this.slipId());
    this.slip.set(loaded);
  }

  async copyAll(): Promise<void> {
    const s = this.slip();
    if (!s) {
      return;
    }
    const text = s.turns.map((t) => `Q: ${t.question}\n\n${t.answer}`).join('\n\n---\n\n');
    await navigator.clipboard.writeText(text);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1200);
  }

  async close(): Promise<void> {
    await this.bridge.closeCurrentWindow();
  }
}
