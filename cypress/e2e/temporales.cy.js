// Mensajes temporales: el temporizador es una preferencia POR PERSONA. Marca los mensajes
// que uno manda con una fecha de vencimiento; el cliente los saca de pantalla al vencer y
// el servidor los borra en su limpieza periodica.

describe('mensajes temporales', () => {
  it('al activar el temporizador aparece el aviso en la cabecera', () => {
    cy.abrirChatCifrado().then(() => {
      cy.get('.chat-head .banner').should('not.exist');
      cy.get('.chat-tools select').select('30');
      cy.contains('.chat-head .banner', 'Tus mensajes temporales: 30s').should('be.visible');
    });
  });

  it('sin temporizador los mensajes no llevan cuenta regresiva', () => {
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.enviarMensaje('mensaje permanente');
      cy.contains('.bubble', 'mensaje permanente').find('.ttl').should('not.exist');

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId })
        .its(0).its('expiresAt').should('be.null');
    });
  });

  it('con temporizador el mensaje muestra cuenta regresiva y vence en el servidor', () => {
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.get('.chat-tools select').select('60');
      cy.enviarMensaje('esto se borra solo');

      cy.contains('.bubble', 'esto se borra solo').find('.ttl').should('be.visible').and('not.have.text', '');

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        const { expiresAt, createdAt } = mensajes[0];
        expect(expiresAt, 'quedo con fecha de vencimiento').to.be.a('string');
        const duracion = (new Date(expiresAt) - new Date(createdAt)) / 1000;
        expect(duracion, 'vence about 60s despues de creado').to.be.closeTo(60, 5);
      });
    });
  });

  it('el temporizador solo marca los mensajes propios, no los del otro', () => {
    cy.abrirChatCifrado().then(({ anfitrion, invitado, conversationId }) => {
      cy.get('.chat-tools select').select('30');
      cy.enviarMensaje('el mio vence');
      cy.contains('.bubble', 'el mio vence').find('.ttl').should('be.visible');

      // El anfitrion no configuro nada, asi que lo suyo tiene que quedar permanente.
      cy.task('enviarComo', { username: anfitrion, conversationId, mensajes: 1 });

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        const mios = mensajes.filter((m) => m.remitente === invitado);
        const suyos = mensajes.filter((m) => m.remitente === anfitrion);
        expect(mios[0].expiresAt, 'el mio vence').to.be.a('string');
        expect(suyos[0].expiresAt, 'el suyo no').to.be.null;
      });
    });
  });

  it('cambiar el temporizador no toca los mensajes ya enviados', () => {
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.enviarMensaje('mandado sin temporizador');
      cy.get('.chat-tools select').select('60');
      cy.enviarMensaje('mandado con temporizador');
      cy.contains('.bubble', 'mandado con temporizador').find('.ttl').should('be.visible');

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        expect(mensajes[0].expiresAt, 'el primero sigue siendo permanente').to.be.null;
        expect(mensajes[1].expiresAt, 'el segundo vence').to.be.a('string');
      });
    });
  });

  it('el temporizador se recuerda al volver al chat', () => {
    cy.abrirChatCifrado().then(({ anfitrion }) => {
      cy.get('.chat-tools select').select('300');
      cy.contains('.chat-head .banner', 'Tus mensajes temporales: 5min').should('be.visible');

      cy.reload();
      cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
      cy.contains('.item', anfitrion).click();
      cy.get('.chat-tools select').should('have.value', '300');
      cy.contains('.chat-head .banner', 'Tus mensajes temporales: 5min').should('be.visible');
    });
  });

  // El temporizador mas corto que ofrece la app es de 30s, asi que este test espera de
  // verdad. Es el unico lento de la suite, pero es la unica forma de comprobar que el
  // mensaje se va solo de la pantalla sin que nadie recargue nada.
  it('el mensaje temporal desaparece solo al vencer', () => {
    cy.abrirChatCifrado().then(() => {
      cy.get('.chat-tools select').select('30');
      cy.enviarMensaje('mensaje efimero');
      cy.contains('.bubble', 'mensaje efimero').should('be.visible');

      cy.contains('.bubble p', 'mensaje efimero', { timeout: 45000 }).should('not.exist');
      cy.contains('.toast', 'Un mensaje temporal expiró').should('be.visible');
    });
  });
});
