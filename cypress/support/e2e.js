import './commands';

// La app guarda llaves de chat y preferencias en localStorage. Cada test arranca limpio.
beforeEach(() => {
  cy.clearLocalStorage();
});
