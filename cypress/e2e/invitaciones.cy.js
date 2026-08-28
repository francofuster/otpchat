// Flujo de invitaciones de contacto por link.
// El link lleva la llave de cifrado en el hash (#/invite/CODE?key=...&kv=1), asi que
// aceptar desde otro navegador es lo unico que deja el chat en condiciones de descifrar.

describe('invitaciones de contacto', () => {
  it('genera un link con QR y la llave en el hash', () => {
    cy.task('crearUsuario').then(({ username }) => {
      cy.entrarComo(username);
      cy.abrirConfiguracion();
      cy.contains('.sheet button', 'Agregar contacto').click();

      cy.contains('.sheet h2', 'Invitacion de contacto').should('be.visible');
      cy.get('.sheet img[alt="QR de invitacion"]').should('have.attr', 'src').and('match', /^data:image\/png/);
      cy.linkDeInvitacion().should((link) => {
        expect(link, 'apunta a la ruta de invitacion').to.include('/#/invite/');
        expect(link, 'lleva la llave').to.match(/[?&]key=[^&]+/);
        expect(link, 'lleva la version de llave').to.match(/[?&]kv=1/);
      });
    });
  });

  it('quien acepta queda como contacto de las dos partes', () => {
    cy.task('crearUsuario').as('anfitrion');
    cy.task('crearUsuario').as('invitado');

    cy.get('@anfitrion').then(({ username: anfitrion }) => {
      cy.get('@invitado').then(({ username: invitado }) => {
        cy.entrarComo(anfitrion);
        cy.abrirConfiguracion();
        cy.contains('.sheet button', 'Agregar contacto').click();
        cy.linkDeInvitacion().then((link) => {
          cy.salir();
          cy.entrarComo(invitado);
          cy.visit(link);

          cy.contains('.box h1', `${anfitrion} te invita a chatear`).should('be.visible');
          cy.contains('.box p', 'Chat privado 1 a 1 cifrado').should('be.visible');
          cy.contains('.box button', 'Aceptar').click();

          // El invitado vuelve al shell con el chat ya abierto.
          cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
          cy.contains('.item', anfitrion).should('exist');

          // Y del otro lado tambien quedo el contacto.
          cy.task('estadoDe', { username: anfitrion }).its('contactos').should('include', invitado);
        });
      });
    });
  });

  it('si el invitado rechaza, no queda contacto para nadie', () => {
    cy.task('crearUsuario').as('anfitrion');
    cy.task('crearUsuario').as('invitado');

    cy.get('@anfitrion').then(({ username: anfitrion }) => {
      cy.get('@invitado').then(({ username: invitado }) => {
        cy.entrarComo(anfitrion);
        cy.abrirConfiguracion();
        cy.contains('.sheet button', 'Agregar contacto').click();
        cy.linkDeInvitacion().then((link) => {
          cy.salir();
          cy.entrarComo(invitado);
          cy.visit(link);
          cy.contains('.box button', 'Rechazar').click();

          cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
          cy.contains('.item', anfitrion).should('not.exist');
          cy.task('estadoDe', { username: anfitrion }).its('contactos').should('not.include', invitado);
        });
      });
    });
  });

  it('una invitacion cancelada ya no se puede aceptar', () => {
    cy.task('crearUsuario').as('anfitrion');
    cy.task('crearUsuario').as('invitado');

    cy.get('@anfitrion').then(({ username: anfitrion }) => {
      cy.get('@invitado').then(({ username: invitado }) => {
        cy.entrarComo(anfitrion);
        cy.abrirConfiguracion();
        cy.contains('.sheet button', 'Agregar contacto').click();
        cy.linkDeInvitacion().then((link) => {
          cy.contains('.sheet button', 'Cancelar invitacion').click();

          cy.salir();
          cy.entrarComo(invitado);
          cy.visit(link);

          // La pantalla avisa y devuelve al shell sin crear nada.
          cy.contains('.box', 'La invitacion vencio, fue cancelada o no existe').should('be.visible');
          cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
          cy.contains('.item', anfitrion).should('not.exist');
        });
      });
    });
  });

  it('un codigo que no existe no rompe la app', () => {
    cy.task('crearUsuario').then(({ username }) => {
      cy.entrarComo(username);
      cy.visit('/#/invite/codigoinventado123');
      cy.contains('.box', 'La invitacion vencio, fue cancelada o no existe').should('be.visible');
      cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
    });
  });

  it('rechaza aceptar un link al que le falta la llave de cifrado', () => {
    cy.task('crearUsuario').as('anfitrion');
    cy.task('crearUsuario').as('invitado');

    cy.get('@anfitrion').then(({ username: anfitrion }) => {
      cy.get('@invitado').then(({ username: invitado }) => {
        cy.entrarComo(anfitrion);
        cy.abrirConfiguracion();
        cy.contains('.sheet button', 'Agregar contacto').click();
        cy.linkDeInvitacion().then((link) => {
          // Un link recortado, como el que quedaria si alguien copia solo hasta el codigo.
          const sinLlave = link.split('?')[0];
          cy.salir();
          cy.entrarComo(invitado);
          cy.visit(sinLlave);

          cy.contains('.box button', 'Aceptar').click();
          cy.contains('.box', 'no trae llave de cifrado').should('be.visible');
          cy.task('estadoDe', { username: anfitrion }).its('contactos').should('not.include', invitado);
        });
      });
    });
  });
});
