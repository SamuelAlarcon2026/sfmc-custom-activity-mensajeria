# Hotfix Postmonger / Journey Builder spinner

Este hotfix corrige el caso en el que la Custom Activity abre dentro de Journey Builder,
pero el modal queda en gris con un spinner de Salesforce.

Causa:
- El wrapper local de Postmonger enviaba los eventos con una forma demasiado simple.
- Journey Builder espera el envelope compatible con Postmonger oficial:
  `{ method: 'trigger', args: ['ready', payload] }`.
- Si Journey Builder no reconoce `ready`, mantiene el overlay de carga aunque el HTML
  de la actividad ya esté visible.

Cambios:
- `public/app/postmonger.js` ahora envía `method: 'trigger'` y `args`.
- `public/app/main.js` envía `ready`, `requestTokens` y `requestEndpoints` varias veces
  para evitar problemas de timing del iframe.
- `configModal.url` queda apuntando explícitamente a `/index.html`.

Después de desplegar:
1. Abre `/config.json` y confirma que `userInterfaces.configModal.url` termina en `/index.html`.
2. En Journey Builder, elimina la actividad del canvas y arrástrala de nuevo.
3. Abre la actividad.
