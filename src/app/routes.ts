import { Routes } from '@angular/router';
import { ShellComponent } from './shell.component';
import { InviteComponent } from './invite.component';

export const routes: Routes = [
  { path: '', component: ShellComponent },
  { path: 'invite/:code', component: InviteComponent },
  { path: 'admin', component: ShellComponent },
  { path: '**', redirectTo: '' }
];
