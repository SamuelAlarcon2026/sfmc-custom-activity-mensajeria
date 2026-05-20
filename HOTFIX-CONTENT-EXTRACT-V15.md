# Hotfix content-extract-v15

Este parche corrige el caso en el que Content Builder Asset API devuelve en `views.html.content`
una maqueta/shell con tablas pero sin texto visible, mientras que el contenido real está en
`slots`, `blocks` o mapas internos.

Cambios:
- Se priorizan candidatos HTML con texto visible e imágenes.
- Se recorren mapas de slots/bloques, no solo arrays.
- Si el HTML principal tiene 0 texto visible y 0 imágenes, se reconstruye desde slots/bloques.
- Se añade endpoint de diagnóstico: `GET /api/assets/:id/debug`.
- Cache-buster del modal: `content-extract-v15`.

Endpoint útil:
`https://sfmc-custom-activity-mensajeria-email.onrender.com/api/assets/33067/debug`

Si el diagnóstico sigue mostrando `visibleTextLength: 0`, el asset seleccionado probablemente es
una plantilla o un email con bloques no embebidos/dinámicos que Asset API no entrega como HTML final.
