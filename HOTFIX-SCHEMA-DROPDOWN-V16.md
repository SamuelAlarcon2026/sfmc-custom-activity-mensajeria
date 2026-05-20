# Hotfix schema dropdown v16

Añade desplegables de Journey Data / Contact Data en la configuración de variables dinámicas.

Cambios principales:
- Solicita el schema a Journey Builder con Postmonger después de recibir `initActivity`.
- Escucha `requestedSchema` y `requestedTriggerEventDefinition`.
- Normaliza campos en expresiones `{{Event...}}` y `{{Contact.Attribute...}}`.
- Añade botón "Cargar campos del Journey".
- Añade selector sugerido para el email destinatario.
- Mantiene input manual como fallback si SFMC no devuelve algún campo.

Limitación:
- SFMC no siempre expone todos los atributos de Contact Data según el Entry Source, BU, Data Designer y permisos. Si un campo no aparece, se puede escribir manualmente la expresión en el input.
