// Proteccion de pantalla en la web y descarga de la app solo en Android.

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('privacidad y descarga de la app', () => {
  it('la vista se tapa al perder el foco y vuelve al recuperarlo', () => {
    cy.crearCuenta('Ana', { privacidad: true });
    cy.window().then((win) => win.dispatchEvent(new win.Event('blur')));
    cy.get('.privacy-shield').should('be.visible');
    cy.window().then((win) => win.dispatchEvent(new win.Event('focus')));
    cy.get('.privacy-shield').should('not.exist');
  });

  it('Imprimir pantalla tapa la vista y avisa en el chat abierto', () => {
    cy.task('bot:create', { name: 'Beto' }).then((bot) => {
      cy.crearCuenta('Ana', { privacidad: true });
      cy.invitarAlBot(bot);
      cy.contains('.item', 'Beto', { timeout: 15000 }).click();
      cy.get('body').trigger('keyup', { key: 'PrintScreen' });
      cy.get('.privacy-shield').should('exist');
      cy.task('bot:waitMessage', { id: bot, text: 'Ana sacó una captura de pantalla' });
    });
  });

  it('en Android web ofrece descargar la app en la pantalla de entrada y en configuración', () => {
    cy.visitLimpio('/', { userAgent: ANDROID_UA });
    cy.contains('a.download-app', 'Descargar la app para Android').should('have.attr', 'href').and('match', /releases\/latest\/download\/otpchat-android\.apk$/);
    cy.get('input[name="name"]').type('Ana');
    cy.contains('button', 'Empezar').click();
    cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
    cy.abrirConfiguracion();
    cy.contains('.settings-block', 'Instalar').within(() => {
      cy.contains('button', 'Crear acceso directo').should('exist');
      cy.contains('a', 'Descargar app (Android)').should('exist');
    });
  });

  it('fuera de Android no muestra la descarga', () => {
    cy.visitLimpio('/');
    cy.get('a.download-app').should('not.exist');
    cy.get('input[name="name"]').type('Ana');
    cy.contains('button', 'Empezar').click();
    cy.abrirConfiguracion();
    cy.contains('.settings-block', 'Instalar').find('a').should('not.exist');
  });
});
