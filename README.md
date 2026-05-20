# SFMC Journey Builder Custom Activity · Email por relay privado

Custom Activity ejecutable para Salesforce Marketing Cloud Engagement / Journey Builder. Permite seleccionar un email asset de Content Builder, detectar variables `{{variable}}`, mapear datos de Journey/Contact Data, previsualizar el HTML final y enviar tests o envíos reales a través de un relay privado HTTP/API externo.

URL base prevista:

```txt
https://sfmc-custom-activity-mensajeria-email.onrender.com
```

## 1. Arquitectura

- **Journey Builder** carga `GET /config.json`.
- El modal de configuración abre `GET /` dentro de iframe.
- El frontend usa **Postmonger** para `ready`, `initActivity`, `clickedNext`, `clickedBack`, `gotoStep`, `requestTokens`, `requestEndpoints` y `updateActivity`.
- El backend usa **Node.js + Express**.
- **Content Builder Asset API** solo se consume desde backend con OAuth `client_credentials`.
- Los secretos de SFMC y relay viven solo en variables de entorno.
- La ejecución por contacto ocurre en `POST /execute`.
- El envío final no usa el motor de envío de SFMC. Se llama a Microsoft Graph `sendMail` usando un token OAuth obtenido con variables `RELAY_*`.
- No se usa almacenamiento persistente. El snapshot de HTML/text del asset queda guardado dentro de `inArguments.config.templateSnapshot`.

## 2. Árbol de archivos

```txt
.
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
├── server.js
├── src
│   ├── middleware
│   │   ├── errorHandler.js
│   │   └── security.js
│   ├── routes
│   │   ├── assets.js
│   │   ├── journey.js
│   │   ├── relay.js
│   │   └── sfmcAuth.js
│   └── services
│       ├── contentBuilderService.js
│       ├── relayService.js
│       ├── sfmcTokenService.js
│       ├── templateRenderService.js
│       └── variableParserService.js
└── public
    ├── config.json
    ├── index.html
    ├── app
    │   ├── main.js
    │   ├── postmonger.js
    │   └── styles.css
    └── images
        └── icon.png
```

## 3. Endpoints

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/config.json` | Configuración de la Custom Activity para Journey Builder. |
| `GET` | `/` | UI de configuración en iframe. |
| `GET` | `/api/assets` | Lista paginada/buscable de email assets de Content Builder. |
| `GET` | `/api/assets/:id` | Detalle del asset, subject, preheader, HTML, texto y variables. |
| `POST` | `/api/preview` | Render de subject/preheader/html/text con sampleData/mappings. |
| `POST` | `/api/test-send` | Envío de prueba vía relay privado. |
| `POST` | `/execute` | Ejecución por contacto desde Journey Builder. |
| `POST` | `/save` | Validación de guardado. |
| `POST` | `/validate` | Validación previa/publicación. |
| `POST` | `/publish` | Validación de publicación. |
| `POST` | `/stop` | Stop de una versión de Journey. |
| `GET` | `/api/relay/diagnostics` | Diagnóstico del relay Microsoft Graph sin exponer secretos. |
| `GET` | `/health` | Healthcheck para Render. |

## 4. Variables de entorno

```txt
PORT=3000
SFMC_CLIENT_ID=...
SFMC_CLIENT_SECRET=...
SFMC_AUTH_BASE_URL=https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com
SFMC_REST_BASE_URL=https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com
# Relay Microsoft Graph
RELAY_PROVIDER=microsoft-graph
RELAY_AUTH_URL=https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token
RELAY_CLIENT_ID=<azure_app_client_id>
RELAY_CLIENT_SECRET=<azure_app_client_secret>
RELAY_SCOPE=https://graph.microsoft.com/.default
RELAY_API_URL=https://graph.microsoft.com/v1.0/users/<mailbox>/sendMail
RELAY_GRAPH_SAVE_TO_SENT_ITEMS=true
RELAY_TIMEOUT_MS=15000

APP_BASE_URL=https://sfmc-custom-activity-mensajeria-email.onrender.com
NODE_ENV=production
```

No configures secretos en frontend ni en `config.json`.


## Relay Microsoft Graph

La integración de relay está adaptada para Microsoft Graph `sendMail` con OAuth client credentials.

Flujo implementado:

1. `POST RELAY_AUTH_URL` con `Content-Type: application/x-www-form-urlencoded`.
2. Se envía `client_id`, `client_secret`, `grant_type=client_credentials` y `scope`.
3. El token se cachea en memoria hasta poco antes de expirar.
4. `POST RELAY_API_URL` con `Authorization: Bearer <access_token>`.
5. El body enviado a Graph tiene esta forma:

```json
{
  "saveToSentItems": true,
  "message": {
    "toRecipients": [
      {
        "emailAddress": {
          "address": "destinatario@dominio.com"
        }
      }
    ],
    "body": {
      "contentType": "HTML",
      "content": "<html>...</html>"
    },
    "subject": "Subject final"
  }
}
```

Si `replyTo` está informado, se añade como `message.replyTo`.

Limitación importante: Microsoft Graph `/users/{mailbox}/sendMail` no permite cambiar libremente el `From` por payload. El remitente real será el buzón indicado en `RELAY_API_URL`. Los campos `From Name` y `From Email` de la UI se mantienen como referencia de configuración, pero el envío real sale del mailbox configurado en Graph.

Endpoint de diagnóstico:

```txt
GET /api/relay/diagnostics
```

Devuelve si la configuración existe y si se puede obtener token OAuth, sin exponer el token.

Permisos habituales necesarios en Azure para envío app-only:

- `Mail.Send` de tipo Application permission en Microsoft Graph.
- Admin consent concedido.
- El buzón de `RELAY_API_URL` debe existir y estar autorizado por la política de la organización.

## 5. Despliegue en Render

1. Sube el proyecto a GitHub.
2. En Render crea un **Web Service**.
3. Configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
4. Añade las variables de entorno indicadas arriba.
5. Verifica:
   - `https://sfmc-custom-activity-mensajeria-email.onrender.com/health`
   - `https://sfmc-custom-activity-mensajeria-email.onrender.com/config.json`
   - `https://sfmc-custom-activity-mensajeria-email.onrender.com/`

También se incluye `render.yaml` para usar Blueprint si prefieres.

## 6. Installed Package en SFMC

Crea un Installed Package con dos componentes:

### 6.1 API Integration · Server-to-Server

Uso: consumir Content Builder Asset API desde backend.

Permisos mínimos recomendados:

- **Content Builder / Assets / Read**
- Scope/API permission equivalente: `assets_read`

El nombre exacto puede variar según la UI del tenant. No se necesita permiso de envío de email de SFMC porque el envío lo hace el relay privado. Tampoco se necesita exponer `client_secret` en frontend.

Configura en Render:

```txt
SFMC_CLIENT_ID=<client id del componente Server-to-Server>
SFMC_CLIENT_SECRET=<client secret del componente Server-to-Server>
SFMC_AUTH_BASE_URL=https://<subdomain>.auth.marketingcloudapis.com
SFMC_REST_BASE_URL=https://<subdomain>.rest.marketingcloudapis.com
```

### 6.2 Journey Builder Activity

Crea un componente **Journey Builder Activity** y usa:

```txt
Endpoint URL:
https://sfmc-custom-activity-mensajeria-email.onrender.com/config.json
```

La actividad aparece como Custom Activity ejecutable porque `config.json` usa:

```json
"type": "REST"
```

No es una `RestDecision` ni una decision split.

## 7. Flujo de UI

1. **Selección de plantilla**
   - Busca assets por nombre/customerKey.
   - Selecciona un email asset.
   - Se detectan variables `{{FirstName}}`, `{{ Email }}`, `{{custom_field}}`.

2. **Configuración de envío**
   - Subject, preheader, From Name, From Email, Reply-To.
   - Recipient mapping, por defecto `{{InteractionDefaults.Email}}`.
   - Cada variable permite:
     - Valor fijo.
     - Journey Data.
     - Contact Data.
     - Valor de test/preview.
   - Para Journey/Contact Data puedes escribir `{{Event.FirstName}}` o `Contact.Attribute.Perfil.FirstName`.

3. **Preview**
   - Renderiza subject, preheader, HTML y text.
   - Muestra desktop y mobile con iframe sandbox.
   - Lista variables resueltas, no resueltas y warnings.

4. **Test**
   - Envía al relay privado con sampleData.
   - Muestra respuesta estructurada.

5. **Done**
   - Guarda todo en `activity.arguments.execute.inArguments`.
   - `metaData.isConfigured = true`.
   - Al reabrir la actividad, se precarga la configuración.

## 8. Contrato del relay

Payload enviado:

```json
{
  "to": "destinatario@email.com",
  "from": {
    "name": "Nombre remitente",
    "email": "remitente@dominio.com"
  },
  "replyTo": "reply@dominio.com",
  "subject": "Subject final",
  "preheader": "Preheader final",
  "html": "<html>...</html>",
  "text": "Texto plano",
  "metadata": {
    "contactKey": "...",
    "journeyId": "...",
    "activityId": "...",
    "assetId": "...",
    "assetCustomerKey": "..."
  }
}
```

Por defecto se usa:

```txt
Authorization: Bearer <RELAY_API_KEY>
```

Si tu relay necesita otro contrato, modifica `src/services/relayService.js` en `buildRelayPayload()` o `postToRelay()`.

## 9. Seguridad

- `helmet` activo.
- CSP con `frame-ancestors` para dominios SFMC/Salesforce.
- CORS restringido a dominios SFMC/Salesforce y `APP_BASE_URL`.
- `client_secret`, OAuth token y relay key nunca se envían al frontend.
- No se loguea HTML completo ni tokens.
- Cada request tiene `X-Correlation-Id`.
- Preview con iframe `sandbox`.
- Sustitución HTML escapa valores.
- No se sustituyen variables dentro de `<script>` o `<style>`.

## 10. Checklist de pruebas en Journey Builder

- [ ] `/config.json` responde HTTP 200 con JSON válido.
- [ ] `/` abre sin errores HTTPS.
- [ ] La Custom Activity aparece en Journey Builder como actividad custom.
- [ ] Al hacer clic abre el modal.
- [ ] La app ejecuta `connection.trigger('ready')`.
- [ ] No aparece “Failed to load custom activity configuration”.
- [ ] `/api/sfmc/token-status` responde `success: true`.
- [ ] `/api/assets` lista assets.
- [ ] Seleccionar asset carga subject/preheader/html/text.
- [ ] Variables `{{}}` aparecen como badges.
- [ ] Se guardan mappings.
- [ ] Preview renderiza valores de prueba.
- [ ] Test send llega al relay.
- [ ] Al pulsar Done, reabrir precarga la configuración.
- [ ] `POST /validate` y `POST /publish` responden success.
- [ ] En un Journey publicado, `POST /execute` recibe contacto y llama al relay.
- [ ] En logs aparece `correlationId` y `contactKey`, sin secretos.

## 11. Limitaciones conocidas

- No se ejecuta AMPscript, SSJS, personalization strings `%%...%%` ni Dynamic Content nativo de SFMC.
- Content Blocks anidados pueden no venir completamente embebidos en Asset API.
- El snapshot HTML se guarda en `inArguments`; emails muy grandes pueden hacer crecer la configuración de la actividad.
- La UI no implementa un selector gráfico nativo de atributos de Journey Builder; permite escribir expresiones de data binding.
- La query avanzada de Asset API puede variar por tenant; el servicio tiene fallback a listado básico con filtrado local.
- `useJwt` está en `false`. Si necesitas verificar JWT de Journey Builder, habilítalo en `config.json` y añade validación backend con la signing key correspondiente.

## 12. Cómo añadir más campos o mappings

1. Añade el campo en `DEFAULT_CONFIG` dentro de `public/app/main.js`.
2. Píntalo en `renderStepConfig()`.
3. Inclúyelo en `readConfigFromForm()`.
4. Añádelo al `config` guardado por `buildInArgument()`.
5. En backend, añade validación en `normalizeConfig()` y `validateConfig()` en `src/routes/journey.js`.
6. Para enviarlo al relay, añade el campo a `buildRelayPayload()` o a `metadata`.

## 13. Ejecución local

```bash
cp .env.example .env
npm install
npm run dev
```

Abre:

```txt
http://localhost:3000/
http://localhost:3000/config.json
```

Para probar Journey Builder necesitas HTTPS público. Render cumple este requisito.

## Hotfix postmonger-v10

El modal de Journey Builder usa `/index.html?v=postmonger-v10` y Postmonger local compatible en `/vendor/postmonger-local.js?v=postmonger-v10`.

