# Hotfix v26 - Seguridad UI/API + JWT completo

## Motivo

La URL del modal de la Custom Activity debe ser pública para que Journey Builder pueda cargar `index.html` dentro de un iframe. Sin embargo, eso no significa que las APIs internas deban quedar públicas.

Antes de este hotfix, una persona con la URL podía abrir la UI y, si las variables de entorno estaban configuradas, podía intentar:
- listar assets de Content Builder mediante `/api/assets`;
- recuperar detalle de plantillas mediante `/api/assets/:id`;
- generar previews mediante `/api/preview`;
- enviar pruebas mediante `/api/test-send`;
- consultar diagnósticos técnicos.

Este hotfix separa correctamente:
- **endpoints públicos necesarios para Journey Builder**;
- **endpoints protegidos de UI**;
- **endpoints server-to-server protegidos por JWT de Journey Builder**.

## Endpoints públicos que se mantienen

Estos endpoints siguen públicos por diseño:

- `GET /`
- `GET /index.html`
- `GET /config.json`
- `GET /health`
- estáticos `/app/*`, `/images/*`, `/vendor/postmonger.js`, `/slds/*`
- `POST /api/ui-session`
- `GET /api/ui-auth/diagnostics`
- `GET /api/preview-frame/:id`

`/api/ui-session` es público en cuanto a ruta, pero no concede acceso salvo que reciba un token válido de Journey Builder/Postmonger y lo valide contra SFMC.

## Endpoints de UI protegidos

Si `UI_API_AUTH_ENABLED=true`, quedan protegidos:

- `GET /api/assets`
- `GET /api/assets/:id`
- `GET /api/assets/:id/debug`
- `GET /api/assets/diagnostics`
- `GET /api/sfmc/token-status`
- `GET /api/relay/diagnostics`
- `POST /api/preview`
- `POST /api/test-send`

Para llamarlos se necesita una sesión corta creada desde el modal en Journey Builder.

## Cómo funciona la sesión segura de UI

1. Journey Builder carga `/index.html`.
2. La app inicializa Postmonger.
3. Journey Builder envía `initActivity`.
4. La app solicita `requestTokens`.
5. Journey Builder devuelve `fuel2token`.
6. La app llama a `POST /api/ui-session`.
7. El backend valida ese token contra SFMC usando `/platform/v1/tokenContext`.
8. Si SFMC confirma que el token es válido, el backend genera una sesión corta firmada.
9. Las siguientes llamadas internas mandan `X-CA-UI-Session`.

Si alguien abre la URL fuera de Journey Builder, no tiene Postmonger ni `fuel2token`, por lo que no puede crear sesión y las APIs devuelven `401 UI_SESSION_REQUIRED`.

## Variables de entorno nuevas

```env
UI_API_AUTH_ENABLED=true
UI_SESSION_SECRET=valor_largo_aleatorio_o_mismo_valor_que_SFMC_JWT_SECRET
UI_SESSION_TTL_SECONDS=1800
UI_AUTH_TOKEN_CONTEXT_PATH=/platform/v1/tokenContext
UI_AUTH_TOKEN_VALIDATION_TIMEOUT_MS=10000
```

## JWT Journey Builder

Se mantiene la protección de endpoints lifecycle y ejecución:

```env
SFMC_JWT_VALIDATION_ENABLED=true
SFMC_JWT_USE=true
SFMC_JWT_SECRET=jwt_signing_secret_del_componente_journey_builder_activity
SFMC_JWT_ALGORITHMS=HS256,HS384,HS512
SFMC_JWT_CLOCK_TOLERANCE_SECONDS=60
```

Protege:

- `POST /execute`
- `POST /save`
- `POST /validate`
- `POST /publish`
- `POST /stop`

## Restricción adicional de tests

Opcionalmente puedes limitar los tests a dominios concretos:

```env
TEST_SEND_ALLOWED_DOMAINS=ibsalut.es,goib.es
```

Si queda vacío, no aplica restricción de dominio.

## Diagnóstico

Tras desplegar:

```txt
GET /api/ui-auth/diagnostics
```

Debe mostrar:

```json
{
  "success": true,
  "uiApiAuthEnabled": true,
  "uiSessionSecretConfigured": true
}
```

También revisa:

```txt
GET /security/diagnostics
```

Debe mostrar la parte JWT activada.

## Despliegue

1. Copia el contenido del ZIP encima de la raíz del repo.
2. Configura variables en Render.
3. Haz `Clear build cache & deploy`.
4. Abre `/config.json` y comprueba que el modal apunta a:
   `/index.html?v=secure-ui-v26`
5. En el Installed Package puedes forzar caché con:
   `/config.json?v=secure-ui-v26`
6. Borra la actividad antigua del canvas y arrastra una nueva.

## Pruebas esperadas

### Abrir una API directamente sin sesión

```txt
GET /api/assets
```

Debe devolver:

```json
{
  "success": false,
  "error": {
    "code": "UI_SESSION_REQUIRED"
  }
}
```

### Abrir desde Journey Builder

La UI debe crear sesión automáticamente y permitir:

- buscar assets;
- seleccionar asset;
- generar preview;
- enviar test.

### Llamar a `/execute` manualmente

Sin JWT debe devolver:

```json
{
  "success": false,
  "error": {
    "code": "JWT_MISSING"
  }
}
```
