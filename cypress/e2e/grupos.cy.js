// Flujos de grupos: alta, sumar gente por link, moderacion, salida y borrado.

describe('grupos', () => {
  it('crea un grupo y queda en la lista con rol admin', () => {
    cy.task('crearUsuario').then(({ username }) => {
      const nombreGrupo = 'Equipo Alfa';
      cy.entrarComo(username);
      cy.crearGrupoEnLaUi(nombreGrupo);

      cy.contains('.item', nombreGrupo).find('small').should('have.text', 'admin');
      cy.task('estadoDe', { username }).its('grupos').should('deep.include', { nombre: nombreGrupo, rol: 'admin' });
    });
  });

  it('otra persona se suma con el link del grupo', () => {
    cy.task('crearUsuario').as('admin');
    cy.task('crearUsuario').as('invitado');

    cy.get('@admin').then(({ username: admin }) => {
      cy.get('@invitado').then(({ username: invitado }) => {
        const nombreGrupo = 'Equipo Beta';
        cy.entrarComo(admin);
        cy.crearGrupoEnLaUi(nombreGrupo);

        cy.abrirAcciones();
        cy.contains('.sheet button', 'QR del grupo').click();
        cy.contains('.sheet h2', 'QR del grupo').should('be.visible');
        cy.linkDeInvitacion().then((link) => {
          expect(link, 'el link del grupo tambien lleva la llave').to.match(/[?&]key=[^&]+/);

          cy.salir();
          cy.entrarComo(invitado);
          cy.visit(link);
          cy.contains('.box p', `Grupo: ${nombreGrupo}`).should('be.visible');
          cy.contains('.box button', 'Aceptar').click();

          cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
          cy.contains('.item', nombreGrupo).should('exist');
          cy.task('estadoDe', { username: invitado }).its('grupos').should('deep.include', { nombre: nombreGrupo, rol: 'member' });
        });
      });
    });
  });

  it('el admin ve a todos los miembros con su rol', () => {
    cy.task('crearGrupoConMiembros', { miembros: 2 }).then(({ admin, nombreGrupo, miembros }) => {
      cy.entrarComo(admin);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Miembros').click();

      cy.get('.member-list label').should('have.length', 3);
      cy.contains('.member-list label', admin).find('small').should('have.text', 'Admin principal');
      miembros.forEach((m) => {
        cy.contains('.member-list label', m).find('small').should('have.text', 'Miembro');
      });
    });
  });

  it('el admin puede ascender a alguien a subadmin', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ admin, nombreGrupo, miembros }) => {
      const [miembro] = miembros;
      cy.entrarComo(admin);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Miembros').click();

      cy.contains('.member-list label', miembro).find('input[type="checkbox"]').check();
      cy.contains('.toolbar', '1 seleccionados').should('be.visible');
      cy.contains('.toolbar button', 'Subadmin').click();

      cy.contains('.member-list label', miembro).find('small').should('have.text', 'Subadmin');
      cy.task('estadoDe', { username: miembro }).its('grupos').should('deep.include', { nombre: nombreGrupo, rol: 'subadmin' });
    });
  });

  it('el admin no se puede sacar a si mismo de la lista', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ admin, nombreGrupo }) => {
      cy.entrarComo(admin);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Miembros').click();

      cy.contains('.member-list label', admin).find('input[type="checkbox"]').should('be.disabled');
    });
  });

  it('el admin expulsa a un miembro y el grupo le desaparece', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ admin, nombreGrupo, miembros }) => {
      const [miembro] = miembros;
      cy.entrarComo(admin);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Miembros').click();

      cy.contains('.member-list label', miembro).find('input[type="checkbox"]').check();
      cy.contains('.toolbar button', 'Eliminar').click();

      cy.get('.member-list label').should('have.length', 1);
      cy.contains('.member-list label', miembro).should('not.exist');
      cy.task('estadoDe', { username: miembro }).its('grupos').should('be.empty');
    });
  });

  it('un miembro puede abandonar el grupo', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ nombreGrupo, miembros }) => {
      const [miembro] = miembros;
      cy.entrarComo(miembro);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Abandonar grupo').click();

      cy.contains('.item', nombreGrupo).should('not.exist');
      cy.task('estadoDe', { username: miembro }).its('grupos').should('be.empty');
    });
  });

  it('un miembro comun no ve las acciones de moderacion', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ nombreGrupo, miembros }) => {
      cy.entrarComo(miembros[0]);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();

      cy.contains('.sheet button', 'Miembros').should('not.exist');
      cy.contains('.sheet button', 'QR del grupo').should('not.exist');
      cy.contains('.sheet button', 'Eliminar grupo').should('not.exist');
      cy.contains('.sheet button', 'Abandonar grupo').should('exist');
    });
  });

  it('el admin elimina el grupo y desaparece para todos', () => {
    cy.task('crearGrupoConMiembros', { miembros: 1 }).then(({ admin, nombreGrupo, miembros }) => {
      cy.entrarComo(admin);
      cy.contains('.item', nombreGrupo).click();
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Eliminar grupo').click();

      cy.contains('.item', nombreGrupo).should('not.exist');
      cy.task('estadoDe', { username: admin }).its('grupos').should('be.empty');
      cy.task('estadoDe', { username: miembros[0] }).its('grupos').should('be.empty');
    });
  });
});
