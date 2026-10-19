// El servidor no ve contenido: lo que guarda para un nodo desconectado es un sobre opaco, y
// se borra apenas el destino confirma la entrega.

describe('servidor ciego', () => {
  it('lo que espera en el buzón está sellado y desaparece al entregarse', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana');
      cy.invitarAlBot(bot);
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      cy.task('bot:offline', { id: bot });
      const secreto = 'texto-que-el-servidor-no-debe-ver';
      cy.enviarMensaje(secreto);
      cy.task('bot:device', { id: bot }).then((deviceId) => {
        const delBot = (mailboxes) => mailboxes.filter((m) => m.deviceId === deviceId);
        cy.task('relay:dump').then(({ mailboxes }) => {
          const crudo = JSON.stringify(mailboxes);
          const suyos = delBot(mailboxes);
          expect(suyos.length, 'hay un sobre esperando').to.eq(1);
          expect(crudo).not.to.include(secreto);
          expect(crudo).not.to.include('Ana');
          const sobre = suyos[0].items[0].data;
          expect(Object.keys(sobre).sort()).to.deep.equal(['ct', 'epk', 'iv', 'pk']);
        });
        cy.task('bot:online', { id: bot });
        cy.task('bot:waitMessage', { id: bot, text: secreto });
        cy.wait(500);
        cy.task('relay:dump').then(({ mailboxes }) => expect(delBot(mailboxes), 'entregado y borrado del servidor').to.have.length(0));
      });
    });
  });

  it('la cuenta y los chats solo existen en este dispositivo', () => {
    cy.crearCuenta('Ana');
    cy.window().then(async (win) => {
      const dbs = await win.indexedDB.databases();
      expect(dbs.map((d) => d.name)).to.include('otpchat-node');
      expect(win.localStorage.getItem('otpchat_token')).to.eq(null);
    });
  });
});
