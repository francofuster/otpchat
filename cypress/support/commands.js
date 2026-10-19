// Comandos de los e2e de v2. El navegador es un nodo con su cuenta en IndexedDB; la otra
// persona es un bot (cypress.config.js) que corre en Node con el mismo nucleo.

// Carga la app desde cero: sin cuenta, sin chats, con el aviso legal aceptado y sin el
// protector de pantalla (Cypress dispara blur al cambiar de foco y taparia la vista).
Cypress.Commands.add('visitLimpio', (path = '/', { userAgent, privacidad = false } = {}) => {
  cy.visit(path, {
    onBeforeLoad(win) {
      win.indexedDB.deleteDatabase('otpchat-node');
      win.localStorage.clear();
      win.localStorage.setItem('otpchat_disclaimer_accepted', '1');
      if (!privacidad) win.localStorage.setItem('otpchat_privacy_shield', 'off');
      if (userAgent) Object.defineProperty(win.navigator, 'userAgent', { value: userAgent });
    }
  });
});

Cypress.Commands.add('crearCuenta', (nombre, opciones) => {
  cy.visitLimpio('/', opciones);
  cy.get('input[name="name"]').type(nombre);
  cy.contains('button', 'Empezar').click();
  cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
  cy.get('.net.on', { timeout: 15000 }).should('exist');
});

Cypress.Commands.add('abrirConfiguracion', () => {
  cy.get('.sidebar header button[title="Configuración"]').click();
  cy.contains('.sheet h2', 'Configuración').should('be.visible');
});

Cypress.Commands.add('abrirAcciones', () => {
  cy.get('.chat-tools button[title="Más acciones"]').click();
  cy.contains('.sheet h2', 'Acciones').should('be.visible');
});

Cypress.Commands.add('linkDeInvitacion', () =>
  cy.get('.sheet .copy-link input').should('not.have.value', '').invoke('val')
);

// El navegador muestra su QR de contacto y el bot lo acepta, como si lo escaneara.
Cypress.Commands.add('invitarAlBot', (botId) => {
  cy.get('.sidebar header button[title="Agregar contacto"]').click();
  cy.contains('.sheet h2', 'Invitación de contacto').should('be.visible');
  cy.linkDeInvitacion().then((link) => cy.task('bot:accept', { id: botId, link }));
});

// El bot muestra su QR y el navegador abre el link y acepta.
Cypress.Commands.add('aceptarInvitacionDe', (botId, kind = 'contact', chatId) => {
  cy.task('bot:invite', { id: botId, kind, chatId }).then((link) => {
    cy.visit(link);
    cy.contains('.box button', 'Aceptar', { timeout: 15000 }).click();
    cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
  });
});

Cypress.Commands.add('enviarMensaje', (texto) => {
  cy.get('.composer textarea').clear().type(texto);
  cy.get('.composer button.send').click();
  cy.get('.composer textarea').should('have.value', '');
});

Cypress.Commands.add('badgeDe', (nombreChat) => cy.contains('.item', nombreChat).find('.unread'));
