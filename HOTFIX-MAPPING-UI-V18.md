# Hotfix mapping UI v18

Corrige el colapso visual del selector de Journey Data / Contact Data dentro de Journey Builder.

Cambios:
- Elimina la dependencia visual de tabla para variables dinámicas.
- Muestra cada variable como una tarjeta responsive.
- El desplegable usa etiquetas cortas y deja la expresión completa en el input inferior.
- Añade CSS para impedir overflow horizontal causado por expresiones largas `{{Event.DEAudience-...}}`.
- Cache-buster: `mapping-ui-v18`.

Nota:
Preview y Test no pueden resolver valores reales de Journey Data porque no hay un contacto ejecutándose dentro del modal. Para preview/test se usa `Valor test/preview`. Los valores reales se resuelven cuando Journey Builder llama a `/execute`.
