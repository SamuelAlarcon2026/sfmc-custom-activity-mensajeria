/* global Postmonger */
(function () {
  const bootError = document.getElementById('errors');

  function showBootError(message) {
    if (!bootError) return;
    bootError.classList.remove('hidden');
    bootError.innerHTML = `<strong>Error cargando la actividad:</strong><ul><li>${escapeHtml(message)}</li></ul>`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  if (!window.Postmonger || !window.Postmonger.Session) {
    showBootError('No se pudo cargar Postmonger desde /vendor/postmonger.js. Revisa que Render haya ejecutado npm install y que /vendor/postmonger.js abra en el navegador.');
    return;
  }

  const connection = new Postmonger.Session();

  let activityPayload = {};
  let entryFields = [];
  let triggerEventDefinitionKey = '';
  let schemaLoaded = false;
  let initialized = false;

  const recipientField = document.getElementById('recipientField');
  const campaignReferenceInput = document.getElementById('campaignReference');
  const messageInput = document.getElementById('message');
  const charCount = document.getElementById('charCount');
  const fieldList = document.getElementById('fieldList');
  const fieldSearch = document.getElementById('fieldSearch');
  const errors = document.getElementById('errors');

  function setErrors(messages) {
    if (!messages.length) {
      errors.classList.add('hidden');
      errors.innerHTML = '';
      return;
    }

    errors.classList.remove('hidden');
    errors.innerHTML = `<strong>Revisa la configuración:</strong><ul>${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;
  }

  function stripHandlebars(value) {
    return String(value || '').replace(/^\s*\{\{\s*/, '').replace(/\s*\}\}\s*$/, '').trim();
  }

  function toHandlebars(value) {
    const key = stripHandlebars(value);
    return key ? `{{${key}}}` : '';
  }

  function getFieldNameFromKey(key) {
    const clean = stripHandlebars(key);
    const parts = clean.split('.');
    return parts[parts.length - 1] || clean;
  }

  function normalizeSchemaItem(item) {
    if (!item || typeof item !== 'object') return null;

    const rawKey =
      item.key ||
      item.path ||
      item.value ||
      item.expression ||
      item.id ||
      '';

    const key = stripHandlebars(rawKey);
    if (!key) return null;

    const name =
      item.name ||
      item.displayName ||
      item.label ||
      getFieldNameFromKey(key);

    return {
      key,
      binding: toHandlebars(key),
      name,
      dataType: item.type || item.dataType || ''
    };
  }

  function schemaFromPayload(data) {
    if (!data) return [];

    if (Array.isArray(data.schema)) return data.schema;
    if (Array.isArray(data)) return data;

    if (data.arguments && Array.isArray(data.arguments.schema)) {
      return data.arguments.schema;
    }

    if (data.schema && Array.isArray(data.schema.fields)) {
      return data.schema.fields;
    }

    if (data.eventDefinition && Array.isArray(data.eventDefinition.schema)) {
      return data.eventDefinition.schema;
    }

    return [];
  }

  function isEntryDataField(field) {
    const key = stripHandlebars(field.key);

    // Los campos de la DE de entrada suelen venir como Event.<EventDefinitionKey>.<Campo>.
    if (!key.startsWith('Event.')) return false;

    if (!triggerEventDefinitionKey) return true;

    return key.indexOf(`Event.${triggerEventDefinitionKey}.`) === 0 || key.includes(triggerEventDefinitionKey);
  }

  function uniqueFields(fields) {
    const seen = new Set();
    return fields.filter((field) => {
      const key = stripHandlebars(field.key);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function renderRecipientOptions() {
    recipientField.innerHTML = '';

    if (!entryFields.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No se detectaron campos de la DE de entrada';
      recipientField.appendChild(option);
      return;
    }

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = 'Selecciona un campo';
    recipientField.appendChild(emptyOption);

    entryFields.forEach((field) => {
      const option = document.createElement('option');
      option.value = field.binding;
      option.textContent = `${field.name}${field.dataType ? ` (${field.dataType})` : ''}`;
      recipientField.appendChild(option);
    });

    const savedTo = getInArgument('to');
    if (savedTo) {
      recipientField.value = savedTo;
    }
  }

  function renderFieldButtons() {
    const search = fieldSearch.value.trim().toLowerCase();
    const filtered = entryFields.filter((field) => {
      return (
        field.name.toLowerCase().includes(search) ||
        field.key.toLowerCase().includes(search)
      );
    });

    fieldList.innerHTML = '';

    if (!filtered.length) {
      fieldList.innerHTML = '<p class="empty">No hay variables disponibles con ese filtro.</p>';
      return;
    }

    filtered.forEach((field) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fieldButton';
      button.innerHTML = `
        <span class="fieldName">${escapeHtml(field.name)}</span>
        <span class="fieldKey">${escapeHtml(field.binding)}</span>
      `;
      button.addEventListener('click', () => insertAtCursor(messageInput, field.binding));
      fieldList.appendChild(button);
    });
  }

  function insertAtCursor(input, value) {
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const current = input.value;

    input.value = `${current.slice(0, start)}${value}${current.slice(end)}`;
    input.focus();
    input.selectionStart = input.selectionEnd = start + value.length;
    updateCharCount();
  }

  function updateCharCount() {
    charCount.textContent = `${messageInput.value.length} caracteres`;
  }

  function getExecuteInArguments() {
    const args = activityPayload?.arguments?.execute?.inArguments || [];
    return Array.isArray(args) ? args : [];
  }

  function getInArgument(name) {
    const match = getExecuteInArguments().find((item) => Object.prototype.hasOwnProperty.call(item, name));
    return match ? match[name] : '';
  }

  function setExecuteInArguments(newArgs) {
    activityPayload.arguments = activityPayload.arguments || {};
    activityPayload.arguments.execute = activityPayload.arguments.execute || {};
    activityPayload.arguments.execute.inArguments = newArgs;
  }

  function hydrateFormFromPayload() {
    messageInput.value = getInArgument('message') || '';
    recipientField.value = getInArgument('to') || '';
    campaignReferenceInput.value = getInArgument('campanyaReferencia') || '';
    updateCharCount();
  }

  function validateForm() {
    const messages = [];

    if (!recipientField.value) {
      messages.push('Selecciona el campo destino/teléfono.');
    }

    if (!campaignReferenceInput.value.trim()) {
      messages.push('Indica la referencia de campaña BITMessage.');
    }

    if (!messageInput.value.trim()) {
      messages.push('Escribe el mensaje.');
    }

    setErrors(messages);
    return messages.length === 0;
  }


  function applyExecutionContract() {
    const origin = window.location.origin;

    activityPayload.arguments = activityPayload.arguments || {};
    activityPayload.arguments.execute = activityPayload.arguments.execute || {};

    activityPayload.arguments.execute.outArguments = [
      { branchResult: '' },
      { messageStatus: '' },
      { providerMessageId: '' },
      { providerOperatorCode: '' },
      { errorCode: '' },
      { errorMessage: '' },
      { providerResponse: '' },
      { phoneSent: '' },
      { campaignReference: '' },
      { sentAt: '' }
    ];

    activityPayload.arguments.execute.url = activityPayload.arguments.execute.url || `${origin}/execute`;
    activityPayload.arguments.execute.verb = 'POST';
    activityPayload.arguments.execute.body = '';
    activityPayload.arguments.execute.header = '';
    activityPayload.arguments.execute.format = 'json';

    // /execute debe estar firmado por SFMC. La respuesta a SFMC es JSON plano.
    // Para RESTDECISION, "outcome" debe ser "sent" o "notSent".
    // "branchResult" se mantiene como outArgument para trazabilidad.
    activityPayload.arguments.execute.useJwt = true;

    activityPayload.arguments.execute.timeout = activityPayload.arguments.execute.timeout || 60000;
    activityPayload.arguments.execute.retryCount = activityPayload.arguments.execute.retryCount || 0;
    activityPayload.arguments.execute.retryDelay = activityPayload.arguments.execute.retryDelay || 5000;

    activityPayload.type = 'RESTDECISION';

    // Orden visual solicitado:
    // rama superior = Enviado, rama inferior = No enviado.
    // El enrutado real lo decide /execute devolviendo outcome "sent" o "notSent".
    activityPayload.outcomes = [
      {
        key: 'sent',
        displayName: 'Enviado',
        arguments: {
          branchResult: 'sent'
        },
        metaData: {
          label: 'Enviado',
          invalid: false
        }
      },
      {
        key: 'notSent',
        displayName: 'No enviado',
        arguments: {
          branchResult: 'notSent'
        },
        metaData: {
          label: 'No enviado',
          invalid: false
        }
      }
    ];
  }

  function saveActivity() {
    if (!validateForm()) {
      connection.trigger('ready');
      return;
    }

    setExecuteInArguments([
      { contactKey: '{{Contact.Key}}' },
      { to: recipientField.value },
      { message: messageInput.value.trim() },
      { campanyaReferencia: campaignReferenceInput.value.trim() }
    ]);

    applyExecutionContract();

    activityPayload.metaData = activityPayload.metaData || {};
    activityPayload.metaData.isConfigured = true;
    activityPayload.name = activityPayload.name || 'BitMessage';

    connection.trigger('updateActivity', activityPayload);
  }

  function requestJourneyData() {
    try {
      connection.trigger('requestTriggerEventDefinition');
      connection.trigger('requestSchema');
      // Algunos tenants responden mejor si se solicita interaction también.
      connection.trigger('requestInteraction');
    } catch (error) {
      setErrors([`No se pudo solicitar el esquema a Journey Builder: ${error.message}`]);
    }
  }

  function handleSchema(data) {
    const rawFields = schemaFromPayload(data);
    const normalized = rawFields.map(normalizeSchemaItem).filter(Boolean);
    const eventOnly = uniqueFields(normalized.filter(isEntryDataField));

    schemaLoaded = true;
    entryFields = eventOnly;
    renderRecipientOptions();
    renderFieldButtons();
    hydrateFormFromPayload();
  }

  connection.on('initActivity', function (payload) {
    initialized = true;
    activityPayload = payload || {};
    hydrateFormFromPayload();

    requestJourneyData();
    connection.trigger('ready');
  });

  connection.on('requestedTriggerEventDefinition', function (eventDefinition) {
    triggerEventDefinitionKey =
      eventDefinition?.eventDefinitionKey ||
      eventDefinition?.key ||
      eventDefinition?.id ||
      triggerEventDefinitionKey ||
      '';

    connection.trigger('requestSchema');
  });

  connection.on('requestedSchema', handleSchema);

  connection.on('requestedInteraction', function () {
    // No usamos la interaction para pintar campos, pero la pedimos para forzar a JB a completar contexto en algunos tenants.
    if (!schemaLoaded) {
      connection.trigger('requestSchema');
    }
  });

  connection.on('clickedNext', saveActivity);
  connection.on('clickedDone', saveActivity);

  messageInput.addEventListener('input', updateCharCount);
  fieldSearch.addEventListener('input', renderFieldButtons);

  function boot() {
    updateCharCount();
    connection.trigger('ready');

    // Reintentamos por si initActivity tarda en llegar.
    setTimeout(function () {
      if (!initialized) {
        connection.trigger('ready');
      }
      if (!schemaLoaded) {
        requestJourneyData();
      }
    }, 1500);

    setTimeout(function () {
      if (!schemaLoaded) {
        recipientField.innerHTML = '<option value="">No se recibió el esquema desde Journey Builder</option>';
        fieldList.innerHTML = '<p class="empty">Journey Builder no devolvió campos. Cierra la actividad, confirma que la Journey tenga una Entry Source de tipo Data Extension y vuelve a abrirla.</p>';
      }
    }, 9000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
