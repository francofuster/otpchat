import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './auth.service';
import { ApiService } from './api.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    <div class="toasts">
      @for (toast of api.toasts(); track toast) {
        <div class="toast">{{ toast }}</div>
      }
    </div>
  `,
  styles: [`
    .toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 20; }
    .toast { background: #10233f; color: #fff; padding: 10px 12px; border-radius: 8px; box-shadow: 0 12px 30px #0003; }
  `]
})
export class AppComponent implements OnInit {
  constructor(private auth: AuthService, public api: ApiService) {}
  ngOnInit() { void this.auth.boot(); }
}
