// Chat cifrado: el contenido se cifra en el navegador con AES-GCM y una clave derivada
// del TOTP mas el secreto del chat. El servidor guarda el resultado y nunca ve el texto.

describe('chat cifrado', () => {
  it('el servidor guarda el mensaje cifrado, nunca el texto', () => {
    const texto = 'reunion en el muelle a las 9';
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.enviarMensaje(texto);
      cy.contains('.bubble p', texto).should('be.visible');

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        expect(mensajes, 'llego un mensaje al servidor').to.have.length(1);
        const { encrypted, crudo } = mensajes[0];

        expect(crudo, 'el texto no aparece por ningun lado en lo guardado').to.not.include(texto);
        expect(encrypted.ciphertext, 'el ciphertext no es el texto').to.not.include(texto);
        const descodificado = Buffer.from(encrypted.ciphertext, 'base64').toString('utf8');
        expect(descodificado, 'base64 no es cifrado: descodificarlo no devuelve el texto').to.not.include(texto);

        // Las piezas que hacen falta para poder descifrar despues.
        expect(encrypted.iv, 'iv').to.be.a('string').and.not.be.empty;
        expect(encrypted.salt, 'salt').to.be.a('string').and.not.be.empty;
        expect(encrypted.keyStep, 'paso de TOTP con el que se cifro').to.be.a('number');
        expect(encrypted.keyVersion, 'version de la llave').to.equal(1);
      });
    });
  });

  it('el texto se vuelve a leer despues de recargar', () => {
    const texto = 'esto tiene que sobrevivir al refresh';
    cy.abrirChatCifrado().then(({ anfitrion }) => {
      cy.enviarMensaje(texto);
      cy.contains('.bubble p', texto).should('be.visible');

      // Al recargar no queda nada en memoria: el texto sale de descifrar lo del servidor
      // con la llave que quedo en el navegador.
      cy.reload();
      cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
      cy.contains('.item', anfitrion).click();
      cy.contains('.bubble p', texto).should('be.visible');
    });
  });

  it('sin la llave local el mensaje no se puede leer', () => {
    const texto = 'contenido reservado';
    cy.abrirChatCifrado().then(({ anfitrion, invitado }) => {
      cy.enviarMensaje(texto);
      cy.contains('.bubble p', texto).should('be.visible');

      // El anfitrion nunca recibio la llave en este navegador, asi que ve el aviso.
      cy.salir();
      cy.entrarComo(anfitrion);
      cy.contains('.item', invitado).click();
      cy.contains('.bubble p', 'Falta la llave local para descifrar').should('be.visible');
      cy.contains('.bubble p', texto).should('not.exist');
    });
  });

  it('sin la llave tampoco se puede escribir', () => {
    cy.abrirChatCifrado().then(({ anfitrion, invitado }) => {
      cy.salir();
      cy.entrarComo(anfitrion);
      cy.contains('.item', invitado).click();

      cy.get('.composer textarea').type('intento sin llave');
      cy.get('.composer button.send').click();
      cy.contains('.toast', 'Falta la llave local de este chat').should('be.visible');
    });
  });

  it('renovar la clave avisa en el chat y no rompe los mensajes viejos', () => {
    const viejo = 'mensaje de antes de renovar';
    cy.abrirChatCifrado().then(() => {
      cy.enviarMensaje(viejo);
      cy.contains('.bubble p', viejo).should('be.visible');

      cy.abrirAcciones();
      cy.contains('.sheet button', 'Renovar clave').click();

      cy.contains('.bubble p', 'Clave del chat renovada').should('be.visible');
      // Lo de antes se sigue leyendo: la llave vieja queda guardada por version.
      cy.contains('.bubble p', viejo).should('be.visible');
    });
  });

  // Al recargar, el control de rotacion vuelve del servidor con una version que YA
  // tenemos guardada. Ese camino se saltea el guardado, pero igual tiene que mostrar el
  // aviso: antes caia al texto crudo y la burbuja publicaba el secreto del chat.
  it('al recargar, el aviso de clave renovada no filtra el JSON con el secreto', () => {
    cy.abrirChatCifrado().then(({ anfitrion, conversationId }) => {
      cy.abrirAcciones();
      cy.contains('.sheet button', 'Renovar clave').click();
      cy.contains('.bubble p', 'Clave del chat renovada').should('be.visible');

      cy.window().then((win) => {
        const guardado = JSON.parse(win.localStorage.getItem(`otpchat_secret:contact:${conversationId}`));
        const secreto = guardado.versions[String(guardado.currentVersion)];
        expect(guardado.currentVersion, 'la rotacion dejo la version 2').to.equal(2);
        expect(secreto, 'el secreto nuevo quedo guardado').to.be.a('string').and.not.be.empty;

        // Con el refresh se pierde la burbuja optimista: este texto sale de descifrar el
        // mensaje de control guardado en el servidor.
        cy.reload();
        cy.get('.sidebar', { timeout: 15000 }).should('be.visible');
        cy.contains('.item', anfitrion).click();
        cy.contains('.bubble p', 'Clave del chat renovada').should('be.visible');

        cy.get('.messages').should('not.contain', 'otpchatControl');
        cy.get('.messages').should('not.contain', 'key-rotation');
        cy.get('.messages').invoke('text').should((texto) => {
          expect(texto, 'el secreto del chat no se renderiza nunca').to.not.include(secreto);
        });

        // El guard anti-downgrade sigue en pie: volver a leer el mismo control no reescribe nada.
        cy.window().then((despues) => {
          const relectura = JSON.parse(despues.localStorage.getItem(`otpchat_secret:contact:${conversationId}`));
          expect(relectura.currentVersion, 'la version no se movio').to.equal(2);
          expect(relectura.versions['2'], 'el secreto de la version 2 no se reescribio').to.equal(secreto);
        });
      });
    });
  });

  it('despues de renovar, los mensajes nuevos usan la version siguiente', () => {
    const antes = 'antes de rotar';
    const despues = 'despues de rotar';
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.enviarMensaje(antes);
      cy.contains('.bubble p', antes).should('be.visible');

      cy.abrirAcciones();
      cy.contains('.sheet button', 'Renovar clave').click();
      cy.contains('.bubble p', 'Clave del chat renovada').should('be.visible');

      cy.enviarMensaje(despues);
      cy.contains('.bubble p', despues).should('be.visible');

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        const versiones = mensajes.map((m) => m.encrypted.keyVersion);
        expect(versiones, 'el primero con la llave 1 y el ultimo con la 2').to.deep.equal([1, 1, 2]);
        mensajes.forEach((m) => {
          expect(m.crudo).to.not.include(antes);
          expect(m.crudo).to.not.include(despues);
        });
      });
    });
  });

  it('cada mensaje se cifra distinto aunque el texto se repita', () => {
    const texto = 'texto repetido';
    cy.abrirChatCifrado().then(({ invitado, conversationId }) => {
      cy.enviarMensaje(texto);
      cy.contains('.bubble p', texto).should('be.visible');
      cy.enviarMensaje(texto);
      cy.get('.bubble p').filter(`:contains("${texto}")`).should('have.length', 2);

      cy.task('mensajesCrudosDe', { username: invitado, targetId: conversationId }).then((mensajes) => {
        const [uno, dos] = mensajes;
        expect(uno.encrypted.iv, 'iv distinto por mensaje').to.not.equal(dos.encrypted.iv);
        expect(uno.encrypted.salt, 'salt distinto por mensaje').to.not.equal(dos.encrypted.salt);
        expect(uno.encrypted.ciphertext, 'mismo texto, cifrado distinto').to.not.equal(dos.encrypted.ciphertext);
      });
    });
  });
});
