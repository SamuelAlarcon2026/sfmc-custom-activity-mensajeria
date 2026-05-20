# Hotfix preview v14

Este hotfix cambia el renderizado del preview:

- POST `/api/preview` guarda temporalmente el HTML renderizado en memoria.
- Devuelve `previewId` y URLs de preview.
- El modal ya no inyecta HTML con `srcdoc` ni Shadow DOM.
- El preview carga un documento real desde:
  - `/api/preview-frame/:id?device=desktop`
  - `/api/preview-frame/:id?device=mobile`
- Añade botón para abrir el preview en nueva pestaña.
- Añade botón para abrir el HTML bruto.
- Añade diagnósticos: longitud HTML, texto visible, imágenes y tablas.

Después de desplegar:
1. Comprueba `/config.json`.
2. Debe aparecer `/index.html?v=preview-v14`.
3. Cambia temporalmente el endpoint de Installed Package a `/config.json?v=preview-v14`.
4. Borra la actividad vieja del canvas y arrastra una nueva.
