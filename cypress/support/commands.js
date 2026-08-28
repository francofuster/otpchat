// Entra a la app pasando por el flujo real: disclaimer y formulario de login.
// El modal de disclaimer tapa el formulario, asi que hay que aceptarlo si o si.
Cypress.Commands.add('entrarComo', (username, password = 'Test-1234') => {
  cy.visit('/');
  cy.contains('.disclaimer-modal button', 'Acepto').click();
  cy.get('input[name="username"]').type(username);
  cy.get('input[name="password"]').type(password, { log: false });
  cy.get('form.auth button.primary').click();
  cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
});

// El badge de no leidos de un chat, buscado por el nombre que se ve en la lista.
Cypress.Commands.add('badgeDe', (nombreChat) =>
  cy.contains('.item', nombreChat).find('.unread')
);

Cypress.Commands.add('itemDe', (nombreChat) => cy.contains('.item', nombreChat));
