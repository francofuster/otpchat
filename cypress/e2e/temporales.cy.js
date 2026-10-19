// Mensajes temporales: cada nodo los borra al vencer.

describe('mensajes temporales', () => {
  function chatConBot() {
    return cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.invitarAlBot(bot);
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      return cy.wrap(bot);
    });
  }

  it('al activar el temporizador aparece el aviso en la cabecera', () => {
    chatConBot().then(() => {
      cy.get('.chat-tools select').select('30s');
      cy.contains('.chat-head .banner', 'Tus mensajes temporales: 30s').should('be.visible');
    });
  });

  it('sin temporizador los mensajes no llevan cuenta regresiva', () => {
    chatConBot().then(() => {
      cy.enviarMensaje('para siempre');
      cy.contains('.bubble', 'para siempre').find('.ttl').should('not.exist');
    });
  });

  it('con temporizador el mensaje lleva vencimiento también en el otro nodo', () => {
    chatConBot().then((bot) => {
      cy.get('.chat-tools select').select('30s');
      cy.enviarMensaje('efímero');
      cy.contains('.bubble', 'efímero').find('.ttl').should('be.visible');
      cy.task('bot:waitMessage', { id: bot, text: 'efímero' });
      cy.task('bot:messages', { id: bot }).then((messages) => {
        const m = messages.find((x) => x.text === 'efímero');
        expect(m.expiresAt - Date.now()).to.be.within(1000, 30_000);
      });
    });
  });

  it('el temporizador se recuerda al volver al chat', () => {
    chatConBot().then(() => {
      cy.get('.chat-tools select').select('5min');
      cy.reload();
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      cy.get('.chat-tools select option:selected').should('have.text', '5min');
    });
  });

  it('el mensaje temporal desaparece solo al vencer, en los dos lados', () => {
    chatConBot().then((bot) => {
      cy.get('.chat-tools select').select('30s');
      cy.enviarMensaje('me voy');
      cy.task('bot:waitMessage', { id: bot, text: 'me voy' });
      cy.contains('.bubble p', 'me voy', { timeout: 40_000 }).should('not.exist');
      cy.task('bot:messages', { id: bot }).then((messages) => {
        expect(messages.some((m) => m.text === 'me voy')).to.eq(false);
      });
    });
  });
});
