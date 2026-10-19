import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsAr from '@angular/common/locales/es-AR';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withHashLocation } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/routes';

registerLocaleData(localeEsAr);

bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes, withHashLocation()), { provide: LOCALE_ID, useValue: 'es-AR' }]
}).catch((err) => console.error(err));
