# Hotfix v19 · Relay Microsoft Graph

Este hotfix adapta el envío de test y ejecución real a Microsoft Graph `sendMail`.

## Variables nuevas en Render

```txt
RELAY_PROVIDER=microsoft-graph
RELAY_AUTH_URL=https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token
RELAY_CLIENT_ID=<azure_app_client_id>
RELAY_CLIENT_SECRET=<azure_app_client_secret>
RELAY_SCOPE=https://graph.microsoft.com/.default
RELAY_API_URL=https://graph.microsoft.com/v1.0/users/<mailbox>/sendMail
RELAY_GRAPH_SAVE_TO_SENT_ITEMS=true
RELAY_TIMEOUT_MS=15000
```

`RELAY_API_KEY` ya no se usa en modo Microsoft Graph.

## Seguridad

Si alguna vez se pega un `client_secret` real en un chat, ticket o documento, hay que rotarlo en Azure App Registration y actualizar Render con el nuevo valor.

## Diagnóstico

```txt
GET /api/relay/diagnostics
```

Valida que la configuración existe y que el backend puede obtener token OAuth. No devuelve el token.

## Limitación de From

Microsoft Graph `POST /users/{mailbox}/sendMail` envía desde el buzón indicado en la URL. No permite sobrescribir libremente el From con un campo del payload.
