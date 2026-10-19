import { Routes } from '@angular/router';
import { ShellComponent } from './shell.component';
import { InviteComponent } from './invite.component';

export const routes: Routes = [
  { path: '', component: ShellComponent },
  { path: 'i/:payload', component: InviteComponent },
  // Links de la version anterior: se explica que ya no sirven.
  { path: 'invite/:code', component: InviteComponent },
  { path: '**', redirectTo: '' }
];
