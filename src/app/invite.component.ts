import { Component, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { ApiService } from './api.service';
import { SecretService } from './secret.service';

@Component({
  selector: 'app-invite',
  standalone: true,
  template: `
    <main class="invite">
      @if (!auth.ready()) {
        <section class="box">Cargando invitación...</section>
      } @else if (!auth.user()) {
        <section class="box">
          <h1>Entrá para aceptar</h1>
          <p>Iniciá sesión o registrate. Después volvés automáticamente a esta invitación.</p>
          <a href="/#/">Ir a OTPChat</a>
        </section>
      } @else if (invite()) {
        <section class="box">
          <h1>{{ invite().inviter.username }} te invita a chatear</h1>
          <p>{{ invite().group ? 'Grupo: ' + invite().group.name : 'Chat privado 1 a 1 cifrado' }}</p>
          <div class="actions">
            <button class="primary" (click)="accept()">Aceptar</button>
            <button (click)="reject()">Rechazar</button>
          </div>
        </section>
      } @else {
        <section class="box">{{ error() || 'Buscando invitación...' }}</section>
      }
    </main>
  `,
  styles: [`
    .invite { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
    .box { width: min(440px, 100%); background: white; border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 20px 60px #1232; }
    h1 { margin: 0 0 10px; }
    p { color: var(--muted); }
    .actions { display: flex; gap: 10px; }
    button, a { border-radius: 8px; padding: 11px 14px; background: #e9eef7; color: var(--ink); text-decoration: none; }
    .primary { background: var(--blue); color: white; }
  `]
})
export class InviteComponent implements OnInit {
  invite = signal<any>(null);
  error = signal('');
  private code = '';
  private key = '';
  private readonly pendingInviteKey = 'otpchat_pending_invite';

  constructor(public auth: AuthService, private api: ApiService, private secrets: SecretService, private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    this.code = this.route.snapshot.paramMap.get('code') || '';
    this.key = this.route.snapshot.queryParamMap.get('key') || '';
    const wait = setInterval(async () => {
      if (!this.auth.ready()) return;
      clearInterval(wait);
      if (!this.auth.user()) {
        localStorage.setItem(this.pendingInviteKey, JSON.stringify({ code: this.code, key: this.key }));
        return;
      }
      try { this.invite.set(await this.api.getInvite(this.code)); }
      catch { this.error.set('La invitación venció, fue cancelada o no existe.'); }
    }, 100);
  }

  async accept() {
    if (!this.key) {
      this.error.set('Esta invitacion no trae llave de cifrado. Pide que te envien un nuevo link o QR.');
      return;
    }
    const res = await this.api.acceptInvite(this.code);
    if (res.conversationId) this.secrets.save('contact', res.conversationId, this.key);
    if (res.groupId) this.secrets.save('group', res.groupId, this.key);
    localStorage.removeItem(this.pendingInviteKey);
    await this.router.navigate(['/'], { queryParams: { open: res.conversationId || res.groupId } });
  }

  async reject() {
    await this.api.rejectInvite(this.code);
    localStorage.removeItem(this.pendingInviteKey);
    await this.router.navigate(['/']);
  }
}
