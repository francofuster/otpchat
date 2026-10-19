import './commands';

// Cada test arranca con bots nuevos: los de un test anterior se desconectan.
afterEach(() => {
  cy.task('bots:stop');
});
