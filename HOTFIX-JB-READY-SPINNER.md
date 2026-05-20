# Hotfix Journey Builder spinner gris

Este hotfix aborda el caso en el que la Custom Activity carga el HTML dentro del modal, pero Journey Builder mantiene la capa gris con spinner.

Cambios:
- `configModal.url` usa `/index.html?v=jb-ready-v5` para evitar caché de SFMC.
- `index.html` carga JS/CSS con query string de versión.
- `server.js` sirve `/app/*` y `index.html` sin caché.
- `postmonger.js` envía mensajes en formato oficial `{ method: 'trigger', args: [...] }` y fallback `{ key, data }`.
- `main.js` reenvía `ready` varias veces y con fallback directo `window.parent.postMessage`.

Después de desplegar:
1. Abre `/config.json` y comprueba que `configModal.url` acaba en `index.html?v=jb-ready-v5`.
2. En Journey Builder, elimina la actividad del canvas y arrástrala de nuevo.
3. Haz un hard refresh del navegador antes de abrir Journey Builder.
