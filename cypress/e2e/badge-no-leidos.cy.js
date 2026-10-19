// Mensajes 1 a 1 y badge de no leidos, calculado en el propio dispositivo.

describe('mensajes y no leídos', () => {
  function chatConBot(nombre = 'Beto') {
    return cy.task('bot:create', { name: nombre }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.invitarAlBot(bot);
      cy.contains('.item', nombre, { timeout: 15000 }).should('exist');
      // Al aceptarse el QR el chat se abre solo; recargando se vuelve a la lista sin chat
      // abierto, que es donde se cuentan los no leidos.
      cy.reload();
      cy.contains('.blank', 'Elegí un chat', { timeout: 15000 }).should('be.visible');
      return cy.wrap(bot);
    });
  }

  it('los mensajes viajan en los dos sentidos', () => {
    chatConBot().then((bot) => {
      cy.task('bot:send', { id: bot, text: 'hola desde el bot' });
      cy.contains('.item', 'Beto').click();
      cy.contains('.bubble p', 'hola desde el bot').should('be.visible');
      cy.enviarMensaje('hola desde el navegador');
      cy.task('bot:waitMessage', { id: bot, text: 'hola desde el navegador' });
    });
  });

  it('muestra la cantidad exacta de no leídos y la limpia al abrir', () => {
    chatConBot().then((bot) => {
      for (let i = 1; i <= 3; i++) cy.task('bot:send', { id: bot, text: `mensaje ${i}` });
      cy.badgeDe('Beto').should('have.text', '3');
      cy.contains('.item', 'Beto').click();
      cy.contains('.bubble p', 'mensaje 3').should('be.visible');
      cy.get('.back').click({ force: true });
      cy.contains('.item', 'Beto').find('.unread').should('not.exist');
      cy.reload();
      cy.contains('.item', 'Beto', { timeout: 15000 }).find('.unread').should('not.exist');
    });
  });

  it('recorta a +99 cuando hay 100 o más', () => {
    chatConBot().then((bot) => {
      for (let i = 0; i < 100; i++) cy.task('bot:send', { id: bot, text: `n${i}` }, { log: false });
      cy.contains('.item', 'Beto').find('.unread', { timeout: 20000 }).should('have.text', '+99');
    });
  });

  it('los mensajes propios no cuentan como no leídos', () => {
    chatConBot().then(() => {
      cy.contains('.item', 'Beto').click();
      cy.enviarMensaje('mío');
      cy.get('.back').click({ force: true });
      cy.contains('.item', 'Beto').find('.unread').should('not.exist');
    });
  });

  it('el historial persiste en el dispositivo al recargar', () => {
    chatConBot().then((bot) => {
      cy.task('bot:send', { id: bot, text: 'quedate guardado' });
      cy.contains('.item', 'Beto').click();
      cy.contains('.bubble p', 'quedate guardado').should('be.visible');
      cy.reload();
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      cy.contains('.bubble p', 'quedate guardado').should('be.visible');
    });
  });
});
