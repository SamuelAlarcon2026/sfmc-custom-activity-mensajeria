# Hotfix v17 - UI de mappings y aclaración Preview/Test

Cambios:
- Sustituye la tabla de variables por tarjetas responsive SLDS.
- Acorta visualmente expresiones largas `{{Event.DEAudience-...Campo}}` sin perder el valor real.
- Añade aviso: Journey/Contact Data se resuelve solo en ejecución real del Journey.
- Preview y Test usan `Valor test/preview`.
- Mantiene el campo manual para expresiones que SFMC no exponga en el schema.

Importante:
Los valores reales de una Data Extension de entrada no existen dentro del modal de configuración.
Journey Builder solo resuelve esas expresiones cuando un contacto pasa por la actividad y llama a `/execute`.
