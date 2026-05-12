# SFMC Journey Builder Custom Activity: Mensaje externo

Custom Activity para Salesforce Marketing Cloud Journey Builder que:

- Se conecta a un proveedor externo de mensajería vía API.
- Permite configurar el mensaje desde una caja de texto.
- Muestra variables disponibles desde la Data Extension de entrada de la Journey.
- Inserta variables en formato de Journey Builder, por ejemplo `{{Event.<EventDefinitionKey>.<Campo>}}`.
- Expone dos ramas: `Enviado` y `No enviado`.
- Devuelve outArguments para registrar resultado, error y respuesta del proveedor.

## Estructura

```text
.
├── public/
│   ├── index.html
│   ├── customActivity.js
│   ├── styles.css
│   └── images/icon.svg
├── server.js
├── package.json
└── .env.example
```

## Instalación local

```bash
npm install
cp .env.example .env
npm run dev
```

Para probar desde Journey Builder, la app debe estar disponible por HTTPS público. En local puedes usar un túnel HTTPS solo para desarrollo.

## Variables de entorno

```env
BASE_URL=https://tu-dominio-publico.com
JWT_SECRET=el_mismo_jwt_signing_secret_del_installed_package
EXTERNAL_API_URL=https://api.proveedor.com/messages
EXTERNAL_API_KEY=token_del_proveedor
EXTERNAL_API_TIMEOUT_MS=10000
PORT=3000
```

## Configuración en SFMC

1. Crea un Installed Package en Salesforce Marketing Cloud.
2. Agrega un componente de tipo Journey Builder Activity.
3. Configura la URL del endpoint como:

```text
https://tu-dominio-publico.com/config.json
```

4. Usa el mismo `JWT Signing Secret` del paquete como `JWT_SECRET` en el servidor.
5. Publica la app en un hosting con HTTPS.

## Cómo funciona el ruteo

El `config.json` define dos outcomes:

```json
{
  "key": "enviado",
  "arguments": { "branchResult": "enviado" }
}
```

```json
{
  "key": "no_enviado",
  "arguments": { "branchResult": "no_enviado" }
}
```

El endpoint `/execute` devuelve `branchResult` como outArgument:

```json
{
  "branchResult": "enviado",
  "messageStatus": "ENVIADO",
  "providerMessageId": "abc123",
  "errorCode": "",
  "errorMessage": "",
  "providerResponse": "...",
  "sentAt": "2026-05-12T00:00:00.000Z"
}
```

o, si falla:

```json
{
  "branchResult": "no_enviado",
  "messageStatus": "NO_ENVIADO",
  "providerMessageId": "",
  "errorCode": "HTTP_400",
  "errorMessage": "Número inválido",
  "providerResponse": "...",
  "sentAt": "2026-05-12T00:00:00.000Z"
}
```

> Importante: el endpoint `/execute` responde HTTP 200 incluso cuando el proveedor falla. Esto permite que Journey Builder continúe por la rama `No enviado`. Si respondes 500, Journey Builder puede tratarlo como fallo técnico de actividad en lugar de enrutar al contacto.

## Adaptar payload del proveedor externo

En `server.js`, modifica la función `sendExternalMessage()`:

```js
body: JSON.stringify({
  to,
  message,
  contactKey
})
```

Sustitúyelo por el formato requerido por tu proveedor, por ejemplo:

```js
body: JSON.stringify({
  recipient: to,
  text: message,
  channel: 'whatsapp',
  metadata: {
    contactKey
  }
})
```

## Registro de errores

La actividad devuelve estos campos como `outArguments`:

- `messageStatus`
- `providerMessageId`
- `errorCode`
- `errorMessage`
- `providerResponse`
- `sentAt`

En la rama `No enviado`, puedes agregar una actividad posterior para registrar el error en una Data Extension de auditoría, o extender `server.js` para hacer el insert/upsert directamente en una DE de log usando la REST API de SFMC.

## Troubleshooting en Render / Journey Builder

Después de desplegar, prueba estas URLs:

```text
https://tu-servicio.onrender.com/health
https://tu-servicio.onrender.com/index.html
https://tu-servicio.onrender.com/config.json
https://tu-servicio.onrender.com/debug/config
```

En el Installed Package de SFMC, la URL debe ser:

```text
https://tu-servicio.onrender.com/config.json
```

Dentro de `config.json`, `userInterfaces.configModal.url` debe responder como:

```text
https://tu-servicio.onrender.com/index.html
```

Si `/index.html` abre en el navegador pero no dentro de Journey Builder, revisa:

- `BASE_URL` en Render debe ser exactamente el dominio público HTTPS de Render, sin slash final.
- El servicio no debe estar dormido por inactividad en el momento de abrir la Custom Activity.
- Revisa que `https://tu-servicio.onrender.com/vendor/postmonger.js` abra en navegador. La UI usa Postmonger local para evitar bloqueos de CDNs externos dentro de Journey Builder.
- Revisa logs de Render cuando haces clic en la actividad desde Journey Builder.
- Evita configurar headers `X-Frame-Options: DENY` o `SAMEORIGIN` mediante proxies externos.
- Después de cambiar `config.json`, elimina y vuelve a agregar el componente Journey Builder Activity en el Installed Package o refresca la actividad en Journey Builder.


## Nota para Render

Esta versión usa `postmonger` `^0.0.16`. Si Render había fallado antes con `postmonger@0.0.14`,
vuelve a desplegar usando **Clear build cache & deploy** para forzar un `npm install` limpio.
