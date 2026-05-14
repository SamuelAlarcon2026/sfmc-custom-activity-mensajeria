# BitMessage SFMC Custom Activity - v17 RestDecision official contract

Esta versión corrige el contrato de ramas usando exactamente el tipo documentado por Salesforce:

```json
"type": "RestDecision",
"outcomes": [
  {
    "arguments": {
      "branchResult": "sent"
    },
    "metaData": {
      "label": "Enviado"
    }
  },
  {
    "arguments": {
      "branchResult": "notSent"
    },
    "metaData": {
      "label": "No enviado"
    }
  }
]
```

La respuesta de `/execute` para timeout o cualquier error funcional es HTTP 200 con:

```json
{
  "branchResult": "notSent",
  "messageStatus": "ERROR",
  "errorCode": "TIMEOUT"
}
```

La respuesta de `/execute` para envío correcto es:

```json
{
  "branchResult": "sent",
  "messageStatus": "ENVIADO"
}
```

Endpoint de comprobación:

```text
/debug/routing-contract
```

IMPORTANTE: como cambia el tipo exacto de actividad a `RestDecision`, se recomienda crear un componente Journey Builder Activity nuevo en el Installed Package y una Journey nueva de prueba.

---

# SFMC BITMessage Custom Activity - v15 RESTDECISION doc contract

Versión de diagnóstico/corrección que usa branchResult string: sent / notSent y no reescribe outcomes desde la UI.
