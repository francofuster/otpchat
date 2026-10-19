// Grupos: alta, ingreso por QR, permisos que hace cumplir cada nodo y expulsion.

describe('grupos', () => {
  function crearGrupoEnLaUi(nombre) {
    cy.abrirConfiguracion();
    cy.contains('.sheet button', 'Crear grupo').click();
    cy.get('.sheet input[placeholder="Nombre del grupo"]').type(nombre);
    cy.contains('.sheet button', 'Crear').click();
    cy.get('.chat-head').should('contain.text', nombre);
  }

  function invitarBotAlGrupo(bot) {
    cy.abrirAcciones();
    cy.contains('.sheet button', 'QR del grupo').click();
    cy.contains('.sheet h2', 'QR del grupo').should('be.visible');
    cy.linkDeInvitacion().then((link) => cy.task('bot:accept', { id: bot, link }));
    cy.get('.sheet .close').click();
  }

  it('crea un grupo y queda como admin principal', () => {
    cy.crearCuenta('Ana');
    crearGrupoEnLaUi('Equipo Alfa');
    cy.contains('.item', 'Equipo Alfa').find('small').should('have.text', 'Admin principal');
  });

  it('el bot entra con el QR del grupo y ve los mensajes nuevos', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      crearGrupoEnLaUi('Equipo Beta');
      invitarBotAlGrupo(bot);
      cy.contains('.system-line', 'Beto se unió al grupo', { timeout: 15000 }).should('exist');
      cy.enviarMensaje('bienvenido');
      cy.task('bot:waitMessage', { id: bot, text: 'bienvenido' });
      cy.task('bot:send', { id: bot, text: 'gracias' });
      cy.contains('.bubble', 'gracias').should('contain.text', 'Beto');
    });
  });

  it('con el candado puesto el miembro no puede escribir', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      crearGrupoEnLaUi('Equipo Gamma');
      invitarBotAlGrupo(bot);
      cy.contains('.system-line', 'Beto se unió', { timeout: 15000 });
      cy.abrirAcciones();
      cy.contains('.toggle-row', 'Los miembros pueden escribir').find('input').uncheck();
      cy.get('.sheet .close').click();
      cy.task('bot:chats', { id: bot }).then(() => {});
      cy.wait(500);
      cy.task('bot:chats', { id: bot }).then((chats) => {
        const grupo = chats.find((c) => c.kind === 'group');
        expect(grupo.membersCanWrite).to.eq(false);
        cy.task('bot:trySend', { id: bot, chatId: grupo.id, text: 'no debería' }).should('match', /permiso/);
      });
      cy.contains('.bubble p', 'no debería').should('not.exist');
    });
  });

  it('el navegador como miembro ve el aviso de solo administradores', () => {
    cy.task('bot:create', { name: 'Dueño' }).then((bot) => {
      cy.task('bot:createGroup', { id: bot, name: 'Grupo del bot' }).then((groupId) => {
        cy.crearCuenta('Ana');
        cy.aceptarInvitacionDe(bot, 'group', groupId);
        cy.contains('.item', 'Grupo del bot', { timeout: 15000 }).click();
        cy.task('bot:settings', { id: bot, chatId: groupId, settings: { membersCanWrite: false } });
        cy.contains('.composer-locked', 'Solo administradores pueden enviar mensajes').should('be.visible');
        cy.task('bot:setRole', { id: bot, chatId: groupId, memberName: 'Ana', role: 'subadmin' });
        cy.get('.composer textarea').should('be.visible');
      });
    });
  });

  it('al ser expulsado el grupo desaparece de la lista', () => {
    cy.task('bot:create', { name: 'Dueño' }).then((bot) => {
      cy.task('bot:createGroup', { id: bot, name: 'Se va' }).then((groupId) => {
        cy.crearCuenta('Ana');
        cy.aceptarInvitacionDe(bot, 'group', groupId);
        cy.contains('.item', 'Se va', { timeout: 15000 }).should('exist');
        cy.task('bot:remove', { id: bot, chatId: groupId, memberName: 'Ana' });
        cy.contains('.item', 'Se va').should('not.exist');
      });
    });
  });

  it('el admin ve a los miembros y puede nombrar un subadmin', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      crearGrupoEnLaUi('Equipo Delta');
      invitarBotAlGrupo(bot);
      cy.contains('.system-line', 'Beto se unió', { timeout: 15000 });
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Miembros').click();
      cy.contains('.member-list label', 'Beto').find('input').check();
      cy.contains('.toolbar button', 'Subadmin').click();
      cy.contains('.member-list label', 'Beto').should('contain.text', 'Subadmin');
      cy.task('bot:chats', { id: bot }).its('0.role').should('eq', 'subadmin');
    });
  });
});
