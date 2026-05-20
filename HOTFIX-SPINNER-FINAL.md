# Hotfix spinner Journey Builder

Este hotfix cambia la integración Postmonger para que Journey Builder no deje el modal gris bloqueado.

Cambios:
- Se deja de usar `public/app/postmonger.js` como wrapper casero.
- Se sirve Postmonger oficial desde el paquete npm `postmonger` en `/vendor/postmonger.js`.
- `index.html` carga `/vendor/postmonger.js?v=official-local-v1`.
- `main.js` envía `connection.trigger('ready')` una sola vez.
- `requestTokens` y `requestEndpoints` se piden después de recibir `initActivity`.
- El `configModal.url` queda en `/index.html?v=official-local-v1`.

Pasos:
1. Sustituye archivos.
2. `git add . && git commit -m "fix: use local official Postmonger for JB modal" && git push`
3. En Render: Manual Deploy > Clear build cache & deploy.
4. Abre `/config.json` y confirma `index.html?v=official-local-v1`.
5. En SFMC, cambia temporalmente el endpoint del Installed Package a:
   `https://sfmc-custom-activity-mensajeria-email.onrender.com/config.json?v=official-local-v1`
6. Borra la actividad del canvas y arrástrala de nuevo.
