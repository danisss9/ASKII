import { Component } from '@angular/core';
import { AskiiShellComponent } from './components/askii-shell/askii-shell.component';
import { StickySlipComponent } from './components/sticky-slip/sticky-slip.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [AskiiShellComponent, StickySlipComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly stickySlipId: string | null =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('sticky')
      : null;
}
