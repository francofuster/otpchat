import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toasts = signal<string[]>([]);

  toast(message: string) {
    this.toasts.update((items) => [...items.slice(-2), message]);
    setTimeout(() => this.toasts.update((items) => items.filter((item) => item !== message)), 3500);
  }
}
