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
        <section class="box">Cargando invitacion...</section>
      } @else if (!auth.user()) {
        <section class="box">
          <h1>Entra para aceptar</h1>
          <p>Inicia sesion o registrate. Despues volves automaticamente a esta invitacion.</p>
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
        <section class="box">{{ error() || 'Buscando invitacion...' }}</section>
      }
    </main>
  `,
  styles: [`
    .invite { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
    .box { width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 20px 60px var(--shadow); }
    h1 { margin: 0 0 10px; }
    p { color: var(--muted); }
    .actions { display: flex; gap: 10px; }
    button, a { border-radius: 8px; padding: 11px 14px; background: color-mix(in srgb, var(--panel) 78%, var(--blue) 22%); color: var(--ink); text-decoration: none; }
    .primary { background: var(--blue); color: white; }
  `]
})
export class InviteComponent implements OnInit {
  invite = signal<any>(null);
  error = signal('');
  private code = '';
  private key = '';
  private keyVersion = 1;
  private readonly pendingInviteKey = 'otpchat_pending_invite';

  constructor(
    public auth: AuthService,
    private api: ApiService,
    private secrets: SecretService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    this.code = this.route.snapshot.paramMap.get('code') || '';
    this.key = this.route.snapshot.queryParamMap.get('key') || '';
    this.keyVersion = Number(this.route.snapshot.queryParamMap.get('kv') || 1);
    const wait = setInterval(async () => {
      if (!this.auth.ready()) return;
      clearInterval(wait);
      if (!this.auth.user()) {
        localStorage.setItem(this.pendingInviteKey, JSON.stringify({ code: this.code, key: this.key, keyVersion: this.keyVersion }));
        return;
      }
      try {
        this.invite.set(await this.api.getInvite(this.code));
      } catch {
        this.error.set('La invitacion vencio, fue cancelada o no existe.');
        setTimeout(() => void this.router.navigate(['/'], { replaceUrl: true }), 1200);
      }
    }, 100);
  }

  async accept() {
    if (!this.key) {
      this.error.set('Esta invitacion no trae llave de cifrado. Pide que te envien un nuevo link o QR.');
      return;
    }
    const res = await this.api.acceptInvite(this.code);
    if (res.conversationId) this.secrets.save('contact', res.conversationId, this.key, this.keyVersion);
    if (res.groupId) this.secrets.save('group', res.groupId, this.key, Number(res.keyVersion || this.keyVersion));
    localStorage.removeItem(this.pendingInviteKey);
    await this.router.navigate(['/'], { state: { open: res.conversationId || res.groupId }, replaceUrl: true });
  }

  async reject() {
    await this.api.rejectInvite(this.code);
    localStorage.removeItem(this.pendingInviteKey);
    history.replaceState(null, '', '/#/');
    await this.router.navigate(['/'], { replaceUrl: true });
  }
}
