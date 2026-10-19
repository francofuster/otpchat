// Le avisa a la web que corre en la app de escritorio (ahi la ventana ya esta excluida de
// capturas). No expone ninguna API de Node.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('otpchatNative', { platform: 'desktop', contentProtection: true });
