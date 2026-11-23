import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AskiiStateService } from '../../core/askii-state.service';

@Component({
  selector: 'app-history-drawer',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="drawer-card">
      <header class="drawer-header">
        <div class="drawer-tabs">
          <button
            type="button"
            class="tab-btn"
            [class.active]="state.mode() === 'history'"
            (click)="state.openHistory()"
          >
            Receipt Archive
          </button>
          <button
            type="button"
            class="tab-btn"
            [class.active]="state.mode() === 'memory'"
            (click)="state.openMemory()"
          >
            Personal Memory ({{ state.memories().length }})
          </button>
        </div>
        <button type="button" class="close-btn" (click)="state.closeDrawer()">✕</button>
      </header>

      @if (state.mode() === 'history') {
        <div class="drawer-search">
          <input
            type="text"
            placeholder="Search saved receipt slips…"
            [ngModel]="searchQuery()"
            (ngModelChange)="onSearch($event)"
          />
        </div>
        <div class="drawer-list">
          @if (state.slipArchive().length === 0) {
            <div class="empty-note">No saved receipt slips yet. Ask ASKII something to archive it automatically.</div>
          } @else {
            @for (slip of state.slipArchive(); track slip.id) {
              <div class="archive-row">
                <button type="button" class="archive-main" (click)="state.reopenSlip(slip.id)">
                  <div class="archive-top">
                    <span class="archive-title">{{ slip.title }}</span>
                    <span class="archive-meta">{{ slip.model }} · {{ slip.turnCount }} turn{{ slip.turnCount === 1 ? '' : 's' }}</span>
                  </div>
                  <div class="archive-preview">{{ slip.preview }}</div>
                </button>
                <div class="archive-actions">
                  <button
                    type="button"
                    class="mini-btn"
                    title="Pop out as floating sticky slip"
                    (click)="state.detachSlipById(slip.id)"
                  >
                    Sticky
                  </button>
                  <button
                    type="button"
                    class="mini-btn danger"
                    title="Delete archived slip"
                    (click)="state.deleteArchivedSlip(slip.id)"
                  >
                    ✕
                  </button>
                </div>
              </div>
            }
          }
        </div>
      } @else {
        <div class="drawer-search">
          <input
            type="text"
            placeholder="Add a personal preference or fact (Enter to save)…"
            [ngModel]="newMemory()"
            (ngModelChange)="newMemory.set($event)"
            (keydown.enter)="saveMemory()"
          />
          <button type="button" class="add-btn" (click)="saveMemory()">Save</button>
        </div>
        <div class="drawer-list">
          @if (state.memories().length === 0) {
            <div class="empty-note">No saved memories yet. Use /remember or add one above.</div>
          } @else {
            @for (mem of state.memories(); track mem.id) {
              <div class="memory-row">
                <span class="memory-text">{{ mem.content }}</span>
                <button type="button" class="mini-btn danger" (click)="state.removeMemory(mem.id)">✕</button>
              </div>
            }
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .drawer-card {
        width: 644px;
        margin-top: 10px;
        border-radius: 20px;
        background: rgba(11, 17, 30, 0.95);
        border: 1px solid rgba(59, 130, 246, 0.36);
        box-shadow: 0 22px 48px rgba(0, 0, 0, 0.52);
        overflow: hidden;
        color: var(--ink-light);
      }
      .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(148, 184, 255, 0.12);
      }
      .drawer-tabs {
        display: flex;
        gap: 8px;
      }
      .tab-btn {
        border: 1px solid rgba(148, 184, 255, 0.16);
        background: rgba(255, 255, 255, 0.04);
        color: var(--ink-muted);
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        &.active {
          background: rgba(29, 78, 216, 0.35);
          border-color: rgba(59, 130, 246, 0.62);
          color: #fff;
        }
      }
      .close-btn {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 1px solid rgba(148, 184, 255, 0.18);
        background: rgba(255, 255, 255, 0.05);
        color: var(--ink-muted);
        cursor: pointer;
      }
      .drawer-search {
        display: flex;
        gap: 8px;
        padding: 10px 16px;
        border-bottom: 1px solid rgba(148, 184, 255, 0.08);
        input {
          flex: 1;
          height: 34px;
          padding: 0 11px;
          border-radius: 9px;
          border: 1px solid rgba(148, 184, 255, 0.18);
          background: rgba(6, 10, 20, 0.78);
          color: var(--ink-light);
          font-size: 12.5px;
          outline: none;
        }
      }
      .add-btn {
        height: 34px;
        padding: 0 14px;
        border-radius: 9px;
        border: none;
        background: #1d4ed8;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .drawer-list {
        max-height: 390px;
        overflow-y: auto;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .empty-note {
        padding: 26px 14px;
        text-align: center;
        color: var(--ink-muted);
        font-size: 12.5px;
      }
      .archive-row,
      .memory-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(148, 184, 255, 0.1);
      }
      .archive-main {
        flex: 1;
        min-width: 0;
        text-align: left;
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        padding: 0;
      }
      .archive-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .archive-title {
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .archive-meta {
        font-family: var(--font-mono);
        font-size: 10px;
        color: #93c5fd;
        flex: 0 0 auto;
      }
      .archive-preview {
        margin-top: 2px;
        font-size: 11.5px;
        color: var(--ink-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .archive-actions {
        display: flex;
        gap: 5px;
        flex: 0 0 auto;
      }
      .memory-text {
        flex: 1;
        font-size: 12.5px;
        line-height: 1.4;
      }
      .mini-btn {
        border: 1px solid rgba(148, 184, 255, 0.22);
        background: rgba(255, 255, 255, 0.05);
        color: var(--ink-light);
        border-radius: 7px;
        padding: 4px 8px;
        font-family: var(--font-mono);
        font-size: 10.5px;
        cursor: pointer;
        &.danger {
          border-color: rgba(255, 107, 129, 0.35);
          color: #fda4af;
        }
      }
    `,
  ],
})
export class HistoryDrawerComponent implements OnInit {
  readonly state = inject(AskiiStateService);
  readonly searchQuery = signal('');
  readonly newMemory = signal('');

  ngOnInit(): void {
    void this.state.refreshSlips();
    void this.state.refreshMemories();
  }

  onSearch(val: string): void {
    this.searchQuery.set(val);
    void this.state.refreshSlips(val);
  }

  async saveMemory(): Promise<void> {
    const text = this.newMemory().trim();
    if (!text) {
      return;
    }
    await this.state.rememberFact(text);
    this.newMemory.set('');
  }
}
