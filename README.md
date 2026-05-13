# SFMC Journey Builder Custom Activity: BITMessage / Fundació BIT

Custom Activity / Custom Split para Salesforce Marketing Cloud Journey Builder que envía SMS mediante BITMessage y enruta al contacto según el resultado real del envío.

## Versión

```text
2026-05-13-debug-trace-v14-preserve-outcomes
```

Esta versión está preparada para debuggear el problema de routing en Journey Builder. Registra en los logs de Render:

- argumentos recibidos desde SFMC,
- teléfono raw y teléfono normalizado,
- campaña,
- mensaje,
- request enviado a BITMessage,
- respuesta/error/timeout de BITMessage,
- decisión calculada,
- JSON exacto devuelto a SFMC.


## Cambio crítico v14

Esta versión corrige un problema detectado durante el debug: la UI estaba reemplazando completamente `activityPayload.outcomes` al guardar la actividad. Journey Builder guarda información interna de las ramas dentro de esos outcomes, especialmente `next`, que enlaza cada rama con el siguiente nodo del canvas.

Ahora la UI conserva cualquier propiedad existente de los outcomes y solo actualiza:

```text
key
label/displayName
arguments.branchResult
```

Esto evita que SFMC acepte HTTP 200 pero caiga siempre por la primera rama visual.

También se añade soporte para:

```env
APPLICATION_EXTENSION_KEY=
```

Debe ser el Application Extension Key / External Key del componente Journey Builder Activity del Installed Package.

## Contrato actual

```json
{
  "type": "RESTDECISION"
}
```

Ramas visuales:

```text
Rama superior: Enviado
Rama inferior: No enviado
```

Respuesta esperada para envío correcto:

```json
{
  "branchResult": true,
  "messageStatus": "ENVIADO"
}
```

Respuesta esperada para timeout/error:

```json
{
  "branchResult": false,
  "messageStatus": "ERROR",
  "errorCode": "TIMEOUT"
}
```

## Reglas

```text
BITMessage ENVIADO / CONFIRMADO -> Enviado
BITMessage ERROR                -> No enviado
Timeout BITMessage              -> No enviado
HTTP error BITMessage           -> No enviado
Teléfono vacío/inválido         -> No enviado
Campaña vacía                   -> No enviado
JWT inválido                    -> No enviado, sin enviar SMS
```

## Variables Render recomendadas para debug

```env
BASE_URL=https://TU-SERVICIO.onrender.com
JWT_SECRET=JWT_SIGNING_SECRET_DEL_INSTALLED_PACKAGE
APPLICATION_EXTENSION_KEY=APPLICATION_EXTENSION_KEY_DEL_COMPONENTE_JOURNEY_BUILDER_ACTIVITY
NODE_ENV=production

BITMESSAGE_API_URL=https://pre-bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send
BITMESSAGE_AUTH_TYPE=basic
BITMESSAGE_USERNAME=pre-ibsalut
BITMESSAGE_PASSWORD=********
BITMESSAGE_API_TIMEOUT_MS=3000

SFMC_EXECUTE_TIMEOUT_MS=60000
SFMC_EXECUTE_RETRY_COUNT=0
SFMC_EXECUTE_RETRY_DELAY_MS=5000

DEBUG_EXECUTE_LOGS=true
DEBUG_LOG_FULL_MESSAGE=true
DEBUG_LOG_FULL_PROVIDER_RESPONSE=true
DEBUG_LOG_FULL_SFMC_PAYLOAD=false
DEBUG_ACCESS_TOKEN=pon_un_token_largo_para_consultar_debug
DEBUG_FORCE_BITMESSAGE_RESULT=
DEBUG_MAX_EXECUTIONS=50
```

## Prueba controlada sin llamar a BITMessage

Para aislar si el fallo está en el contrato de respuesta hacia Journey Builder, puedes simular el resultado desde Render.

### Simular timeout

```env
DEBUG_FORCE_BITMESSAGE_RESULT=timeout
```

Debe devolver a SFMC:

```json
{
  "branchResult": false,
  "messageStatus": "ERROR",
  "errorCode": "TIMEOUT"
}
```

La Journey debe ir por `No enviado`.

### Simular enviado

```env
DEBUG_FORCE_BITMESSAGE_RESULT=sent
```

Debe devolver a SFMC:

```json
{
  "branchResult": true,
  "messageStatus": "ENVIADO"
}
```

La Journey debe ir por `Enviado`.

Después de la prueba deja:

```env
DEBUG_FORCE_BITMESSAGE_RESULT=
```

## Logs clave en Render

Busca estos eventos:

```text
[debug:execute-start]
[debug:sfmc-payload-decoded]
[debug:execute-arguments]
[debug:bitmessage-request]
[debug:bitmessage-response]
[debug:bitmessage-timeout]
[debug:execute-decision]
[debug:sfmc-response]
[execute-response]
```

El evento más importante es:

```text
[execute-response]
```

Ahí se ve el HTTP 200 exacto y el body enviado a SFMC.

## Endpoints de diagnóstico

```text
/health
/debug/version
/debug/config
/debug/sample-execute-response?branch=notSent
/debug/sample-execute-response?branch=sent
/config.json
/index.html
```

También puedes consultar las últimas ejecuciones en memoria:

```text
/debug/executions?token=TU_DEBUG_ACCESS_TOKEN
/debug/executions/REQUEST_ID?token=TU_DEBUG_ACCESS_TOKEN
```

Estos endpoints requieren `DEBUG_ACCESS_TOKEN`.

## SFMC

Usa como endpoint del componente Journey Builder Activity:

```text
https://TU-SERVICIO.onrender.com/config.json?v=11
```

Después de cambiarlo:

1. Guarda el Installed Package.
2. Crea una nueva versión de la Journey.
3. Elimina la actividad anterior del canvas.
4. Arrastra la actividad de nuevo.
5. Configura teléfono, campaña y mensaje.
6. Publica/prueba.

