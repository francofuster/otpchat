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

// Cierra la sesion del navegador. Tambien borra las llaves locales de los chats, que es
// justamente lo que pasa cuando la otra persona entra desde otro dispositivo.
Cypress.Commands.add('salir', () => {
  cy.clearLocalStorage();
});

// Abre la hoja de configuracion desde el boton de engranaje de la barra lateral.
Cypress.Commands.add('abrirConfiguracion', () => {
  cy.get('.sidebar header button[title="Configuracion"]').click();
  cy.get('.sheet').should('be.visible');
});

// Abre la hoja de acciones del chat que este abierto.
Cypress.Commands.add('abrirAcciones', () => {
  cy.get('.chat-tools button[title="Mas acciones"]').click();
  cy.contains('.sheet h2', 'Acciones').should('be.visible');
});

// Crea un grupo por la UI. Hace falta cuando despues se necesita el link de invitacion,
// porque generarlo exige tener la llave del grupo en este navegador.
Cypress.Commands.add('crearGrupoEnLaUi', (nombre) => {
  cy.abrirConfiguracion();
  cy.contains('.sheet button', 'Crear grupo').click();
  cy.get('.sheet input[placeholder="Nombre del grupo"]').type(nombre);
  cy.contains('.sheet button', 'Crear').click();
  cy.get('.sheet').should('not.exist');
  cy.contains('.item', nombre).should('exist');
});

// Devuelve el link de invitacion que quedo visible en la hoja abierta.
Cypress.Commands.add('linkDeInvitacion', () =>
  cy.get('.sheet .copy-link input').should('not.have.value', '').invoke('val')
);

// Deja al navegador dentro de un chat 1 a 1 con la llave local ya guardada, que es la
// unica forma de poder cifrar y descifrar. Acepta la invitacion desde el link, igual que
// lo haria una persona. Devuelve el contexto para poder consultar el servidor despues.
Cypress.Commands.add('abrirChatCifrado', () =>
  cy.task('crearInvitacionConLlave').then(({ anfitrion, invitado, link }) => {
    cy.entrarComo(invitado);
    cy.visit(link);
    cy.contains('.box button', 'Aceptar').click();
    cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
    cy.contains('.item', anfitrion).click();
    cy.get('.composer textarea').should('be.visible');

    return cy.window().then((win) => {
      const clave = Object.keys(win.localStorage).find((k) => k.startsWith('otpchat_secret:contact:'));
      expect(clave, 'la llave del chat quedo guardada en el navegador').to.be.a('string');
      return { anfitrion, invitado, conversationId: clave.replace('otpchat_secret:contact:', '') };
    });
  })
);

// Escribe y manda un mensaje por la caja de texto del chat abierto.
Cypress.Commands.add('enviarMensaje', (texto) => {
  cy.get('.composer textarea').clear().type(texto);
  cy.get('.composer button.send').click();
  cy.get('.composer textarea').should('have.value', '');
});
