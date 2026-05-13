# SFMC Journey Builder Custom Activity: BITMessage / Fundació BIT

Custom Activity / Custom Split para Salesforce Marketing Cloud Journey Builder que envía SMS mediante BITMessage y enruta al contacto según el resultado real del envío.

## Punto clave de esta versión

Esta versión usa:

```json
"type": "RESTDECISION"
```

No usa `type: "REST"` para el routing, porque en Journey Builder una REST activity estándar puede responder `200` correctamente y aun así caer en el primer branch visual. Para enrutar dinámicamente se usa el contrato de decisión:

```json
{
  "outcome": "notSent",
  "branchResult": "notSent"
}
```

o:

```json
{
  "outcome": "sent",
  "branchResult": "sent"
}
```

Los labels visibles en Journey Builder son:

- `No enviado`
- `Enviado`

El primer outcome es `No enviado` de forma intencionada. Si Journey Builder no pudiera resolver el outcome por caché o configuración antigua, el fallback no debe ser `Enviado`.

## Reglas de routing

```text
BITMessage estado ENVIADO      -> Enviado
BITMessage estado CONFIRMADO   -> Enviado
BITMessage estado ERROR        -> No enviado
Timeout BITMessage             -> No enviado
HTTP error BITMessage          -> No enviado
Teléfono vacío/inválido        -> No enviado
Campaña vacía                  -> No enviado
Error interno controlado       -> No enviado
```

## Success en Journey Builder

`Success` significa que `/execute` respondió HTTP 200 a SFMC. No significa necesariamente que el SMS se haya enviado.

La rama correcta se decide por:

```json
{
  "outcome": "sent"
}
```

o:

```json
{
  "outcome": "notSent"
}
```

`branchResult` se conserva como outArgument para trazabilidad.

## Endpoint BITMessage

```text
https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send
```

La actividad llama por `POST` con JSON:

```json
{
  "telefono": "34654162543",
  "texto": "Mensaje de prueba",
  "campanyaReferencia": "SOIB"
}
```

## Variables de entorno en Render

```env
BASE_URL=https://TU-SERVICIO.onrender.com
JWT_SECRET=JWT_SIGNING_SECRET_DEL_INSTALLED_PACKAGE
NODE_ENV=production

BITMESSAGE_API_URL=https://pre-bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send
BITMESSAGE_AUTH_TYPE=basic
BITMESSAGE_USERNAME=pre-ibsalut
BITMESSAGE_PASSWORD=********
BITMESSAGE_API_TIMEOUT_MS=3000

SFMC_EXECUTE_TIMEOUT_MS=60000
SFMC_EXECUTE_RETRY_COUNT=0
SFMC_EXECUTE_RETRY_DELAY_MS=5000
```

## URLs de diagnóstico

```text
/health
/debug/version
/debug/config
/debug/sample-execute-response?branch=notSent
/debug/sample-execute-response?branch=sent
/config.json
/index.html
```

## Instalación en SFMC

Usa como endpoint del componente Journey Builder Activity:

```text
https://TU-SERVICIO.onrender.com/config.json?v=7
```

Si ya tenías una versión anterior con `type: REST`, lo recomendable es crear un componente nuevo o cambiar la URL con `?v=7`, guardar, crear una nueva versión de la Journey, eliminar la actividad anterior del canvas y arrastrarla de nuevo.
