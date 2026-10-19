import { Component, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NodeService } from './node.service';
import { UiService } from './ui.service';
import { pendingInviteKey } from './shell.component';
import { decodeInvite } from '../core/protocol.js';

// Abre un link de invitacion (#/i/...). La invitacion se resuelve directo con el dispositivo
// de quien la muestra: si ese QR ya no esta en pantalla, no hay a quien pedirle nada.
@Component({
  selector: 'app-invite',
  standalone: true,
  template: `
    <main class="invite">
      <section class="box">
        @switch (step()) {
          @case ('loading') { <p>Buscando la invitación…</p> }
          @case ('legacy') {
            <h1>Link de la versión anterior</h1>
            <p>Este link es de una versión de OTPChat que ya no se usa. Pedí un QR nuevo.</p>
            <a href="/#/">Ir a OTPChat</a>
          }
          @case ('link') {
            <h1>Vincular este dispositivo</h1>
            <p>Vas a recibir la cuenta y los chats del dispositivo que muestra el QR. Hacelo solo con tus propios dispositivos.</p>
            @if (error()) { <p class="error">{{ error() }}</p> }
            <div class="actions">
              <button class="primary" [disabled]="busy()" (click)="acceptLink()">{{ busy() ? 'Vinculando…' : 'Vincular' }}</button>
              <a href="/#/">Cancelar</a>
            </div>
          }
          @case ('ready') {
            <h1>{{ inviterName() }} te invita</h1>
            <p>{{ kind() === 'g' ? 'A un grupo cifrado de punta a punta.' : 'A un chat privado cifrado de punta a punta.' }}</p>
            @if (error()) { <p class="error">{{ error() }}</p> }
            <div class="actions">
              <button class="primary" [disabled]="busy()" (click)="accept()">{{ busy() ? 'Esperando respuesta…' : 'Aceptar' }}</button>
              <button [disabled]="busy()" (click)="reject()">Rechazar</button>
            </div>
          }
          @default {
            <h1>No se pudo abrir</h1>
            <p>{{ error() }}</p>
            <a href="/#/">Ir a OTPChat</a>
          }
        }
      </section>
    </main>
  `,
  styles: [`
    .invite { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
    .box { width: min(440px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 20px 60px var(--shadow); }
    h1 { margin: 0 0 10px; }
    p { color: var(--muted); }
    .error { color: var(--danger); font-weight: 600; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button, a { border-radius: 8px; padding: 11px 14px; background: color-mix(in srgb, var(--panel) 78%, var(--blue) 22%); color: var(--ink); text-decoration: none; border: 0; font: inherit; cursor: pointer; }
    .primary { background: var(--blue); color: white; }
  `]
})
export class InviteComponent implements OnInit {
  step = signal<'loading' | 'ready' | 'link' | 'legacy' | 'error'>('loading');
  inviterName = signal('');
  kind = signal<'c' | 'g' | 'l'>('c');
  error = signal('');
  busy = signal(false);
  private payload = '';

  constructor(private node: NodeService, private ui: UiService, private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    if (this.route.snapshot.paramMap.get('code')) {
      this.step.set('legacy');
      return;
    }
    this.payload = this.route.snapshot.paramMap.get('payload') || '';
    const invite = decodeInvite(this.payload);
    if (!invite) {
      this.error.set('El link de invitación está incompleto o dañado.');
      this.step.set('error');
      return;
    }
    this.kind.set(invite.kind);
    await this.node.start();
    if (invite.kind === 'l') {
      if (this.node.node.hasIdentity()) {
        this.error.set('Este dispositivo ya tiene una cuenta. Para vincularlo, primero borrá la cuenta desde Configuración.');
        this.step.set('error');
        return;
      }
      this.step.set('link');
      return;
    }
    if (!this.node.node.hasIdentity()) {
      // Primero se crea la cuenta; despues el shell vuelve a esta invitacion.
      localStorage.setItem(pendingInviteKey, this.payload);
      this.ui.toast('Creá tu cuenta para aceptar la invitación');
      await this.router.navigate(['/'], { replaceUrl: true });
      return;
    }
    await this.waitConnected();
    try {
      const info = await this.node.node.inspectInvite(this.payload);
      this.inviterName.set(info.inviter.name);
      this.step.set('ready');
    } catch (err: any) {
      this.error.set(err.message || 'La invitación venció.');
      this.step.set('error');
    }
  }

  private async waitConnected() {
    for (let i = 0; i < 80 && !this.node.connected(); i++) await new Promise((r) => setTimeout(r, 100));
  }

  async accept() {
    this.busy.set(true);
    this.error.set('');
    try {
      const chatId = await this.node.node.acceptInvite(this.payload);
      this.node.refresh();
      this.ui.toast(this.kind() === 'g' ? 'Te uniste al grupo' : 'Invitación aceptada');
      await this.router.navigate(['/'], { state: { open: chatId }, replaceUrl: true });
    } catch (err: any) {
      this.error.set(err.message || 'No se pudo aceptar');
    } finally {
      this.busy.set(false);
    }
  }

  async reject() {
    await this.node.node.rejectInvite(this.payload).catch(() => {});
    await this.router.navigate(['/'], { replaceUrl: true });
  }

  async acceptLink() {
    this.busy.set(true);
    this.error.set('');
    await this.waitConnected();
    try {
      await this.node.node.acceptLinkInvite(this.payload);
      this.node.refresh();
      this.node.status.set('ready');
      this.ui.toast('Dispositivo vinculado');
      await this.router.navigate(['/'], { replaceUrl: true });
    } catch (err: any) {
      this.error.set(err.message || 'No se pudo vincular');
    } finally {
      this.busy.set(false);
    }
  }
}
