import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const withToken = (req: HttpRequest<unknown>, token: string | null) =>
  token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

// El JWT vence rapido: ante un 401 se renueva una vez con el refresh token y se reintenta.
// Los endpoints de /api/auth/ quedan afuera para no entrar en un bucle con el propio refresh.
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(withToken(req, auth.token())).pipe(
    catchError((err: unknown) => {
      const renovable = err instanceof HttpErrorResponse && err.status === 401 && !req.url.includes('/api/auth/') && !!auth.token();
      if (!renovable) return throwError(() => err);
      return from(auth.refresh()).pipe(
        switchMap((ok) => (ok ? next(withToken(req, auth.token())) : throwError(() => err)))
      );
    })
  );
};
