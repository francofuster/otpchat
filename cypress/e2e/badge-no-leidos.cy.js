// Cubre el badge de mensajes no leidos de la lista de chats.
// Nada de esto toca la base real: el backend de E2E corre contra otpchat_e2e,
// que se recrea vacia en cada corrida (ver scripts/e2e-db.mjs).

describe('badge de mensajes no leidos', () => {
  it('no muestra badge cuando no hay mensajes', () => {
    cy.task('crearChat', { mensajes: 0 }).then(({ usuarioA, usuarioB }) => {
      cy.entrarComo(usuarioA);
      cy.itemDe(usuarioB).should('exist');
      cy.itemDe(usuarioB).find('.unread').should('not.exist');
    });
  });

  it('muestra la cantidad exacta de no leidos', () => {
    cy.task('crearChat', { mensajes: 3 }).then(({ usuarioA, usuarioB }) => {
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should('have.text', '3');
    });
  });

  it('lo dibuja como circulo rojo con texto blanco', () => {
    cy.task('crearChat', { mensajes: 5 }).then(({ usuarioA, usuarioB }) => {
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should(($b) => {
        const estilo = getComputedStyle($b[0]);
        const caja = $b[0].getBoundingClientRect();
        expect(estilo.color, 'texto blanco').to.equal('rgb(255, 255, 255)');
        expect(estilo.backgroundColor, 'fondo rojo').to.match(/^rgb\((2[0-9]{2}), (2[0-9]|3[0-9]|4[0-9]), /);
        expect(estilo.borderRadius, 'totalmente redondeado').to.equal('999px');
        expect(Math.round(caja.width), 'con 1 digito es un circulo').to.equal(Math.round(caja.height));
      });
    });
  });

  it('se estira a capsula con dos digitos', () => {
    cy.task('crearChat', { mensajes: 42 }).then(({ usuarioA, usuarioB }) => {
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should('have.text', '42');
      cy.badgeDe(usuarioB).should(($b) => {
        const caja = $b[0].getBoundingClientRect();
        expect(caja.width, 'mas ancho que alto').to.be.greaterThan(caja.height);
      });
    });
  });

  it('recorta a +99 cuando hay 100 o mas', () => {
    cy.task('crearChat', { mensajes: 100 }).then(({ usuarioA, usuarioB, conversationId }) => {
      cy.task('noLeidosSegunServidor', { username: usuarioA, conversationId }).should('equal', 100);
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should('have.text', '+99');
    });
  });

  it('con exactamente 99 todavia muestra el numero', () => {
    cy.task('crearChat', { mensajes: 99 }).then(({ usuarioA, usuarioB }) => {
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should('have.text', '99');
    });
  });

  it('se limpia al abrir el chat y sigue limpio despues de recargar', () => {
    cy.task('crearChat', { mensajes: 7 }).then(({ usuarioA, usuarioB, conversationId }) => {
      cy.entrarComo(usuarioA);
      cy.badgeDe(usuarioB).should('have.text', '7');

      cy.itemDe(usuarioB).click();
      cy.itemDe(usuarioB).find('.unread').should('not.exist');

      // Lo que importa: que el "leido" quedo en el servidor, no solo en memoria.
      cy.task('noLeidosSegunServidor', { username: usuarioA, conversationId }).should('equal', 0);
      cy.reload();
      cy.get('.sidebar').should('be.visible');
      cy.itemDe(usuarioB).find('.unread').should('not.exist');
    });
  });

  it('los mensajes propios no cuentan como no leidos', () => {
    cy.task('crearChat', { mensajes: 0 }).then(({ usuarioA, usuarioB, conversationId }) => {
      cy.task('enviarComo', { username: usuarioA, conversationId, mensajes: 4 });
      cy.entrarComo(usuarioA);
      cy.itemDe(usuarioB).find('.unread').should('not.exist');
    });
  });

  it('no acumula no leidos mientras el chat esta abierto en pantalla', () => {
    cy.task('crearChat', { mensajes: 2 }).then(({ usuarioA, usuarioB, conversationId }) => {
      cy.entrarComo(usuarioA);
      cy.itemDe(usuarioB).click();
      cy.itemDe(usuarioB).find('.unread').should('not.exist');

      // Si lo estas mirando, ya lo leiste: el badge no debe reaparecer.
      cy.task('enviarComo', { username: usuarioB, conversationId, mensajes: 3 });
      cy.contains('.bubble', 'Falta la llave', { timeout: 10000 }).should('exist');
      cy.itemDe(usuarioB).find('.unread').should('not.exist');
      cy.task('noLeidosSegunServidor', { username: usuarioA, conversationId }).should('equal', 0);
    });
  });

  it('en mobile vuelve a contar despues de volver a la lista', () => {
    cy.viewport('iphone-x');
    cy.task('crearChat', { mensajes: 2 }).then(({ usuarioA, usuarioB, conversationId }) => {
      cy.entrarComo(usuarioA);
      cy.itemDe(usuarioB).click();
      cy.itemDe(usuarioB).find('.unread').should('not.exist');

      // Con el boton atras el chat deja de estar visible, asi que lo que llegue
      // despues tiene que volver a contar como no leido.
      cy.get('.chat-head .back').click();
      cy.task('enviarComo', { username: usuarioB, conversationId, mensajes: 3 });
      cy.badgeDe(usuarioB).should('have.text', '3');
    });
  });

});
