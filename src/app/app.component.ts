import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UiService } from './ui.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    <div class="toasts" role="status" aria-live="polite">
      @for (toast of ui.toasts(); track toast) {
        <div class="toast">{{ toast }}</div>
      }
    </div>
  `,
  styles: [`
    .toasts { position: fixed; right: 16px; bottom: 16px; left: 16px; display: grid; justify-items: end; gap: 8px; z-index: 40; pointer-events: none; }
    .toast { background: #10233f; color: #fff; padding: 10px 12px; border-radius: 8px; box-shadow: 0 12px 30px #0003; max-width: 100%; }
  `]
})
export class AppComponent {
  constructor(public ui: UiService) {}
}
