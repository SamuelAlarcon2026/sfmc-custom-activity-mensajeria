# Hotfix: modal abre pero queda cargando

Cambios incluidos:

1. `configModal.url` apunta explícitamente a `/index.html`.
2. El frontend corta peticiones colgadas tras 30 segundos y muestra error legible.
3. Las llamadas backend a SFMC OAuth/REST tienen timeout configurable con `SFMC_TIMEOUT_MS` opcional.
4. Esto evita que el modal quede con spinner infinito cuando SFMC OAuth, Asset API o permisos fallan.

Pruebas rápidas:

- `/api/sfmc/token-status`
- `/api/assets?page=1&pageSize=5&assetType=all`

Si `/api/sfmc/token-status` falla, revisa credenciales y URLs SFMC.
Si `/api/sfmc/token-status` funciona pero `/api/assets` falla, revisa permisos `assets_read` / Content Builder Assets Read.
