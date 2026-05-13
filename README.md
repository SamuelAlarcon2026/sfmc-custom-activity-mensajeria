# SFMC Journey Builder Custom Activity: BITMessage / Fundació BIT

Custom Activity para Salesforce Marketing Cloud Journey Builder que envía SMS mediante el endpoint de BITMessage / Fundació BIT:

```text
https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send
```

La actividad:

- Muestra una interfaz de configuración dentro de Journey Builder.
- Permite seleccionar el campo teléfono desde la Data Extension de entrada.
- Permite escribir el mensaje con variables de la Entry Source.
- Permite configurar `campanyaReferencia`.
- Envía el SMS mediante `POST` JSON a BITMessage.
- Evalúa el campo `estado` de BITMessage, no solo el HTTP status.
- Enruta al contacto por dos ramas:
  - `Enviado`
  - `No enviado`
- Devuelve outArguments firmados por JWT para registrar errores y respuesta del proveedor.


## Diferencia entre Success y Enviado

En Journey Builder, el contador `Successes` significa que el endpoint `/execute` respondió correctamente a SFMC con HTTP 200. No significa necesariamente que BITMessage haya enviado el SMS.

La decisión real de la rama se devuelve mediante el outArgument `branchResult`.

Como `execute.useJwt=true`, Journey Builder espera que la respuesta con los `outArguments` esté firmada con el mismo `JWT_SECRET` del Installed Package. Por eso `/execute` devuelve un JWT firmado cuyo payload interno es:

```json
{
  "outArguments": [
    {
      "branchResult": "no_enviado",
      "outcome": "no_enviado",
      "messageStatus": "ERROR",
      "errorCode": "TIMEOUT"
    }
  ]
}
```

o:

```json
{
  "outArguments": [
    {
      "branchResult": "enviado",
      "outcome": "enviado",
      "messageStatus": "ENVIADO"
    }
  ]
}
```

Esto evita el error `Can't parse returned data required for the REST activity` cuando SFMC espera una respuesta JWT y recibe JSON plano.

## Payload enviado a BITMessage

La actividad llama a BITMessage con `POST` y este body:

```json
{
  "telefono": "34654162543",
  "texto": "Mensaje de prueba",
  "campanyaReferencia": "SOIB"
}
```

Se usa `POST` en lugar de `GET` para evitar exponer el texto del mensaje en la URL y para manejar mejor caracteres especiales.

## Respuesta de BITMessage

BITMessage puede devolver HTTP 200 tanto para éxito como para error funcional. Por eso el backend revisa el campo `estado`.

Éxito esperado:

```json
{
  "id": 16312,
  "codigoExternoOperadora": "vasadpt1-mm7ext@3056@20210527140700907@02006377",
  "fechaEnvio": "2021-05-27T14:06:54.748658",
  "telefono": "605697182",
  "texto": "Hola10",
  "estado": "ENVIADO",
  "campanyaReferencia": "SOIB"
}
```

Error esperado:

```json
{
  "telefono": "605697182",
  "texto": "Hola10",
  "estado": "ERROR",
  "infoError": "ERROR_CAMPANYA_NO_EXISTE",
  "campanyaReferencia": "SOIB2"
}
```

Si `estado` es `ERROR`, el contacto sale por la rama `No enviado`.

## Normalización del teléfono

Antes de llamar a BITMessage, el backend normaliza el teléfono:

```text
654162543      -> 34654162543
+33123456789   -> 0033123456789
0033123456789  -> 0033123456789
34654162543    -> 34654162543
```

Después de normalizar, el teléfono debe empezar por:

```text
34
```

o por:

```text
00
```

## Variables de entorno

```env
BASE_URL=https://tu-servicio.onrender.com
JWT_SECRET=el_jwt_signing_secret_del_installed_package

BITMESSAGE_API_URL=https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send

SFMC_EXECUTE_TIMEOUT_MS=60000
SFMC_EXECUTE_RETRY_COUNT=0
SFMC_EXECUTE_RETRY_DELAY_MS=5000
BITMESSAGE_API_TIMEOUT_MS=25000

BITMESSAGE_CAMPANYA_REFERENCIA=

BITMESSAGE_AUTH_TYPE=basic
BITMESSAGE_USERNAME=
BITMESSAGE_PASSWORD=

BITMESSAGE_API_KEY=
BITMESSAGE_AUTH_HEADER_NAME=
BITMESSAGE_AUTH_HEADER_VALUE=
```

## Timeouts y hard errors en Journey Builder

Journey Builder puede marcar la actividad como hard error si `/execute` tarda demasiado en contestar. Para evitarlo, esta versión separa dos tiempos:

```env
SFMC_EXECUTE_TIMEOUT_MS=60000
BITMESSAGE_API_TIMEOUT_MS=25000
```

`SFMC_EXECUTE_TIMEOUT_MS` es el tiempo máximo que declaramos a Journey Builder para la ejecución de la actividad.

`BITMESSAGE_API_TIMEOUT_MS` es el tiempo máximo que esperamos a BITMessage. Debe ser menor que `SFMC_EXECUTE_TIMEOUT_MS`. Si BITMessage no responde dentro de ese tiempo, la Custom Activity devuelve HTTP 200 a SFMC y enruta el contacto por `No enviado` con `errorCode=TIMEOUT`, en lugar de provocar un hard error.

Los reintentos de Journey Builder están disponibles mediante:

```env
SFMC_EXECUTE_RETRY_COUNT=0
SFMC_EXECUTE_RETRY_DELAY_MS=5000
```

Para SMS se recomienda empezar con `SFMC_EXECUTE_RETRY_COUNT=0`, porque un retry del endpoint `/execute` podría duplicar un mensaje si el proveedor lo procesó pero la respuesta no llegó a tiempo. Sube a `1` solo si aceptas ese riesgo o si tienes un mecanismo de idempotencia externo.

### Autenticación

La documentación recibida indica que el endpoint se invoca con un usuario autorizado, pero no concreta el mecanismo de autenticación. Por eso el desarrollo soporta varios modos.

#### Basic Auth

```env
BITMESSAGE_AUTH_TYPE=basic
BITMESSAGE_USERNAME=usuario
BITMESSAGE_PASSWORD=password
```

Envía:

```text
Authorization: Basic base64(usuario:password)
```

#### Bearer Token

```env
BITMESSAGE_AUTH_TYPE=bearer
BITMESSAGE_API_KEY=token
```

Envía:

```text
Authorization: Bearer token
```

#### Header personalizado

```env
BITMESSAGE_AUTH_TYPE=custom
BITMESSAGE_AUTH_HEADER_NAME=X-API-Key
BITMESSAGE_AUTH_HEADER_VALUE=valor
```

#### Sin cabecera de autenticación

```env
BITMESSAGE_AUTH_TYPE=none
```

Úsalo solo si el acceso está autorizado por otro mecanismo, por ejemplo IP allowlist, VPN o proxy.

## Configuración en Render

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Variables mínimas en Render:

```env
BASE_URL=https://tu-servicio.onrender.com
JWT_SECRET=valor_del_jwt_signing_secret_de_sfmc
BITMESSAGE_API_URL=https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send
SFMC_EXECUTE_TIMEOUT_MS=60000
SFMC_EXECUTE_RETRY_COUNT=0
SFMC_EXECUTE_RETRY_DELAY_MS=5000
BITMESSAGE_API_TIMEOUT_MS=25000
BITMESSAGE_AUTH_TYPE=basic
BITMESSAGE_USERNAME=tu_usuario_bitmessage
BITMESSAGE_PASSWORD=tu_password_bitmessage
NODE_ENV=production
```

No pongas `/` al final de `BASE_URL`.

Correcto:

```text
https://tu-servicio.onrender.com
```

Incorrecto:

```text
https://tu-servicio.onrender.com/
```

## Configuración en SFMC

En el Installed Package de Salesforce Marketing Cloud, el componente `Journey Builder Activity` debe apuntar a:

```text
https://tu-servicio.onrender.com/config.json
```

No apuntes a `/index.html`.

## URLs de diagnóstico

Después del deploy, prueba:

```text
https://tu-servicio.onrender.com/health
https://tu-servicio.onrender.com/index.html
https://tu-servicio.onrender.com/vendor/postmonger.js
https://tu-servicio.onrender.com/config.json
https://tu-servicio.onrender.com/debug/config
```

`/debug/config` no muestra secretos, pero indica si están configurados.

## OutArguments disponibles

La actividad devuelve estos campos:

```text
branchResult
messageStatus
providerMessageId
providerOperatorCode
errorCode
errorMessage
providerResponse
phoneSent
campaignReference
sentAt
```

Ejemplo de éxito:

```json
{
  "branchResult": "enviado",
  "messageStatus": "ENVIADO",
  "providerMessageId": "16312",
  "providerOperatorCode": "vasadpt1-mm7ext@3056@20210527140700907@02006377",
  "errorCode": "",
  "errorMessage": "",
  "providerResponse": "{...}",
  "phoneSent": "34654162543",
  "campaignReference": "SOIB",
  "sentAt": "2021-05-27T14:06:54.748658"
}
```

Ejemplo de error:

```json
{
  "branchResult": "no_enviado",
  "messageStatus": "ERROR",
  "providerMessageId": "",
  "providerOperatorCode": "",
  "errorCode": "ERROR_CAMPANYA_NO_EXISTE",
  "errorMessage": "ERROR_CAMPANYA_NO_EXISTE",
  "providerResponse": "{...}",
  "phoneSent": "34654162543",
  "campaignReference": "SOIB2",
  "sentAt": "2026-05-12T00:00:00.000Z"
}
```

## Prueba local de `/execute`

En local y con `NODE_ENV` distinto de `production`, puedes probar sin JWT con un payload JSON:

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{
    "inArguments": [
      { "to": "654162543" },
      { "message": "Mensaje de prueba" },
      { "campanyaReferencia": "SOIB" }
    ]
  }'
```

En producción Journey Builder enviará JWT porque `config.json` tiene `useJwt: true`.


## Fix de validación/publicación en Journey Builder

Esta versión evita el error genérico de Salesforce Marketing Cloud:

```text
A custom activity or entry source failed validation. Check to ensure that the activity or entry source publishes to a valid endpoint.
```

Cambios aplicados:

- `/save`, `/validate`, `/publish` y `/stop` responden siempre HTTP 200 si el endpoint está vivo.
- Los endpoints de configuración ya no requieren JWT (`useJwt: false`), porque no ejecutan envíos ni acciones sensibles.
- `/execute` mantiene JWT obligatorio (`useJwt: true`) para proteger la ejecución real del envío.
- La configuración incompleta de BITMessage ya no rompe la publicación de la Journey; si en ejecución falta algo, el contacto se enruta por `No enviado` con `errorCode` y `errorMessage`.

Después de subir esta versión a Render, usa **Manual Deploy > Clear build cache & deploy** y vuelve a arrastrar la actividad al canvas para que Journey Builder lea el nuevo `config.json`.


## Nota sobre ramas y errores de envío

Esta versión usa `branchResult` como `outArgument` obligatorio en un único objeto dentro de `outArguments`:

```json
{
  "branchResult": "no_enviado",
  "outArguments": [
    {
      "branchResult": "no_enviado",
      "messageStatus": "ERROR",
      "errorCode": "TIMEOUT"
    }
  ]
}
```

Regla de negocio implementada:

- `ENVIADO` o `CONFIRMADO` desde BITMessage -> rama `Enviado`.
- `ERROR` desde BITMessage -> rama `No enviado`.
- Timeout, error HTTP, JWT inválido, teléfono vacío, campaña vacía o cualquier excepción -> rama `No enviado`.

Para verificar que Render tiene esta versión desplegada:

```text
https://TU-SERVICIO.onrender.com/debug/version
https://TU-SERVICIO.onrender.com/debug/sample-execute-response?branch=no_enviado
```


## Versión 2026-05-12-routing-contract-v3

Esta versión corrige el contrato de respuesta de `/execute` para Journey Builder:

- `/execute` devuelve siempre HTTP 200.
- La respuesta es JSON plano, con `execute.useJwt=false`.
- `branchResult` siempre se devuelve dentro de `outArguments[0].branchResult`.
- Cualquier error, timeout, credenciales inválidas, teléfono inválido o respuesta ERROR de BITMessage se enruta como `no_enviado`.
- Solo `estado=ENVIADO` o `estado=CONFIRMADO` de BITMessage se enruta como `enviado`.

Ejemplo de respuesta en timeout:

```json
{
  "outArguments": [
    {
      "branchResult": "no_enviado",
      "outcome": "no_enviado",
      "messageStatus": "ERROR",
      "errorCode": "TIMEOUT",
      "errorMessage": "Timeout llamando a BITMessage después de 3000 ms.",
      "providerMessageId": "",
      "providerOperatorCode": "",
      "providerResponse": "",
      "phoneSent": "34644614672",
      "campaignReference": "PRE-IBSALUT",
      "sentAt": "2026-05-12T00:00:00.000Z"
    }
  ]
}
```

Después de desplegar esta versión, elimina la actividad del canvas de Journey Builder y vuelve a arrastrarla para que SFMC lea el nuevo `config.json`.


## Versión JWT Secure v4

`/execute` usa `useJwt: true`. Journey Builder firma la petición con el JWT Signing Secret del Installed Package. La respuesta sigue siendo JSON plano con `outArguments`, incluyendo siempre `branchResult`. Cualquier error funcional, timeout de BITMessage o error de proveedor enruta a `no_enviado`; solo `ENVIADO` o `CONFIRMADO` enruta a `enviado`.


## Endpoints de diagnóstico

```text
/health
/debug/version
/debug/config
/debug/sample-execute-response?branch=no_enviado
/debug/sample-execute-response.jwt?branch=no_enviado
```

`/debug/sample-execute-response` muestra el payload JSON antes de firmarlo.

`/debug/sample-execute-response.jwt` muestra el JWT firmado que usa el mismo contrato de respuesta que `/execute`.
