import { Component, HostListener, OnInit, inject } from '@angular/core';
import { AskiiStateService } from '../../core/askii-state.service';
import { HistoryDrawerComponent } from '../history-drawer/history-drawer.component';
import { PrintPaperComponent } from '../print-paper/print-paper.component';
import { SetupMorphComponent } from '../setup-morph/setup-morph.component';
import { SpotlightInputComponent } from '../spotlight-input/spotlight-input.component';

@Component({
  selector: 'app-askii-shell',
  standalone: true,
  imports: [
    SpotlightInputComponent,
    SetupMorphComponent,
    PrintPaperComponent,
    HistoryDrawerComponent,
  ],
  templateUrl: './askii-shell.component.html',
  styleUrl: './askii-shell.component.scss',
})
export class AskiiShellComponent implements OnInit {
  readonly state = inject(AskiiStateService);

  ngOnInit(): void {
    void this.state.init();
  }

  @HostListener('window:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    event.preventDefault();
    void this.state.handleEscape();
  }

  onStageClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      void this.state.handleBackdropClick();
    }
  }
}
