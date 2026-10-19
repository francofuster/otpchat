// Aviso de OTPChat 2.0 para quien todavia tiene la cuenta vieja en el navegador. La
// migracion completa se prueba en tests/migration.test.mjs (necesita la API v1 con base).

// Un JWT v1 de mentira: solo se lee el nombre para el saludo.
const jwtV1 = `x.${btoa(JSON.stringify({ username: 'ana_vieja' }))}.y`;

function conSesionVieja() {
  cy.intercept('GET', '**/api/relay/info', { v: 2, vapidPublicKey: '', legacy: true });
  cy.visit('/', {
    onBeforeLoad(win) {
      win.indexedDB.deleteDatabase('otpchat-node');
      win.localStorage.clear();
      win.localStorage.setItem('otpchat_disclaimer_accepted', '1');
      win.localStorage.setItem('otpchat_privacy_shield', 'off');
      win.localStorage.setItem('otpchat_token', jwtV1);
      win.localStorage.setItem('otpchat_refresh', 'refresh-viejo');
      win.localStorage.setItem('otpchat_fingerprint', 'fp-vieja');
    }
  });
}

describe('aviso de migración', () => {
  it('quien tiene la cuenta vieja ve el resumen de cambios y la invitación a migrar', () => {
    conSesionVieja();
    cy.contains('.v2-notice h2', 'Hola ana_vieja, OTPChat cambió: migrá tu cuenta').should('be.visible');
    cy.get('.v2-notice .notice-list li').should('have.length', 5);
    cy.contains('.v2-notice', 'Sin usuario ni contraseña').should('exist');
    cy.contains('.v2-notice button', 'Crear mi cuenta nueva').should('exist');
  });

  it('"Más tarde" lo cierra y el aviso de la lista sigue ofreciendo migrar', () => {
    conSesionVieja();
    cy.contains('.v2-notice button', 'Más tarde').click();
    cy.get('.v2-notice').should('not.exist');
    cy.get('input[name="name"]').type('Ana');
    cy.contains('button', 'Empezar').click();
    cy.contains('.legacy-banner button', 'Migrar mi cuenta anterior', { timeout: 15000 }).should('be.visible');
  });

  it('sin cuenta vieja en el navegador no aparece', () => {
    cy.intercept('GET', '**/api/relay/info', { v: 2, vapidPublicKey: '', legacy: true });
    cy.visitLimpio('/');
    cy.get('input[name="name"]').should('be.visible');
    cy.get('.v2-notice').should('not.exist');
  });
});
