// Alta de cuenta e invitaciones por QR/link entre dos dispositivos reales.

describe('cuenta e invitaciones', () => {
  it('crear una cuenta no pide usuario ni contraseña y conecta a la red', () => {
    cy.crearCuenta('Ana');
    cy.get('.account strong').should('have.text', 'Ana');
    cy.contains('.net', 'En red').should('exist');
    cy.abrirConfiguracion();
    cy.contains('.device-list li', 'Este dispositivo').should('exist');
  });

  it('el bot escanea el QR del navegador y quedan como contactos', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.invitarAlBot(bot);
      cy.contains('.item', 'Beto', { timeout: 15000 }).should('exist');
      cy.task('bot:chats', { id: bot }).its('0.title').should('eq', 'Ana');
    });
  });

  it('el navegador acepta la invitación del bot', () => {
    cy.task('bot:create', { name: 'Caro' }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.task('bot:invite', { id: bot }).then((link) => {
        cy.visit(link);
        cy.contains('.box h1', 'Caro te invita').should('be.visible');
        cy.contains('.box button', 'Aceptar').click();
      });
      cy.contains('.item', 'Caro', { timeout: 15000 }).should('exist');
      cy.get('.chat-head').should('contain.text', 'Caro');
    });
  });

  it('un código ya usado no sirve para una segunda persona', () => {
    cy.task('bot:create', { name: 'Beto' }).then((beto) => {
      cy.task('bot:create', { name: 'Intruso' }).then((intruso) => {
        cy.crearCuenta('Ana');
        cy.get('.sidebar header button[title="Agregar contacto"]').click();
        cy.linkDeInvitacion().then((link) => {
          cy.task('bot:accept', { id: beto, link });
          cy.task('bot:tryAccept', { id: intruso, link }, { timeout: 15000 }).should('match', /no respondió/);
        });
      });
    });
  });

  it('el QR de invitación se renueva solo y el anterior deja de servir', () => {
    cy.clock(Date.now(), ['setInterval']);
    cy.crearCuenta('Ana');
    cy.get('.sidebar header button[title="Agregar contacto"]').click();
    cy.linkDeInvitacion().then((primero) => {
      cy.tick(30_000);
      cy.get('.sheet .copy-link input').should('not.have.value', primero);
    });
  });

  it('un link de la versión anterior explica que ya no sirve', () => {
    cy.visitLimpio('/#/invite/codigoviejo123');
    cy.contains('.box h1', 'Link de la versión anterior').should('be.visible');
  });

  it('se puede verificar el código de seguridad con el contacto', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.invitarAlBot(bot);
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Verificar código de seguridad').click();
      cy.get('.safety-code span').should('have.length', 12);
    });
  });
});
