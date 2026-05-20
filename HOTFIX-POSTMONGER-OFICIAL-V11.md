# Hotfix Postmonger oficial v11

Este parche corrige el handshake con Journey Builder usando la librería oficial `postmonger@0.0.16`.

El error anterior era que los bridges locales enviaban mensajes con formatos como:

```js
{ method: 'trigger', args: ['ready'] }
```

pero Postmonger oficial usa el envelope esperado por Journey Builder:

```js
{ e: 'ready' }
```

y para argumentos:

```js
{ e: 'updateActivity', a1: activity }
```

## Pasos

1. Subir estos archivos a GitHub.
2. Render > Manual Deploy > Clear build cache & deploy.
3. Confirmar:
   - `/vendor/postmonger.js?v=postmonger-official-v11` devuelve JS.
   - `/config.json` contiene `/index.html?v=postmonger-official-v11`.
4. En el Installed Package, usar temporalmente:
   `https://sfmc-custom-activity-mensajeria-email.onrender.com/config.json?v=postmonger-official-v11`
5. Refrescar Journey Builder, borrar la actividad del canvas y arrastrarla de nuevo.
