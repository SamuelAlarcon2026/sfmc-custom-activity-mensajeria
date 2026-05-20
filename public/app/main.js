(function () {
  'use strict';

  var ENABLE_JB_BUTTON_UPDATES = false; // Evita que Journey Builder reactive el overlay gris del modal.
  var DEBUG_POSTMONGER = false;


  var STEPS = [
    { id: 1, label: 'Plantilla' },
    { id: 2, label: 'Envío' },
    { id: 3, label: 'Preview' },
    { id: 4, label: 'Test' }
  ];

  var DEFAULT_CONFIG = {
    assetId: '',
    assetCustomerKey: '',
    assetName: '',
    subject: '',
    preheader: '',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    recipientExpression: '{{InteractionDefaults.Email}}',
    variableMappings: {},
    sampleData: {},
    requiredVariables: [],
    templateSnapshot: {
      html: '',
      text: ''
    },
    warnings: []
  };

  if (!window.Postmonger || !window.Postmonger.Session) {
    document.getElementById('app').innerHTML = '<div class="slds-notify slds-notify_alert slds-theme_error slds-m-around_medium" role="alert">No se ha podido cargar Postmonger local. Revisa /vendor/postmonger-local.js.</div>';
    return;
  }

  var connection = new Postmonger.Session();
  var state = {
    activity: null,
    tokens: null,
    endpoints: null,
    step: 1,
    loading: false,
    assets: [],
    assetSearch: '',
    selectedAsset: null,
    variables: [],
    preview: null,
    testResult: null,
    errors: [],
    notices: [],
    previewBlobUrls: [],
    jbSchema: {
      loaded: false,
      loading: false,
      error: '',
      fields: [],
      journeyData: [],
      contactData: [],
      requested: false
    },
    postmongerInitialized: false,
    config: clone(DEFAULT_CONFIG)
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function revokePreviewBlobUrls() {
    if (!state || !Array.isArray(state.previewBlobUrls)) return;
    state.previewBlobUrls.forEach(function (url) {
      try { window.URL.revokeObjectURL(url); } catch (_err) {}
    });
    state.previewBlobUrls = [];
  }

  function hydratePreviewFrames() {
    if (!state.preview || state.step !== 3) return;

    var previewUrls = state.preview.previewUrls || {};
    var desktop = $('#preview-frame-desktop');
    var mobile = $('#preview-frame-mobile');
    var cacheBust = '&cb=' + encodeURIComponent(String(Date.now()));

    if (desktop && previewUrls.desktop) {
      desktop.src = previewUrls.desktop + (previewUrls.desktop.indexOf('?') >= 0 ? cacheBust : '?cb=' + Date.now());
    }

    if (mobile && previewUrls.mobile) {
      mobile.src = previewUrls.mobile + (previewUrls.mobile.indexOf('?') >= 0 ? cacheBust : '?cb=' + Date.now());
    }

    var rawTextarea = $('[data-preview-raw]');
    if (rawTextarea) rawTextarea.value = state.preview.html || '';

    var openButton = $('#open-preview-new-tab');
    if (openButton) {
      openButton.onclick = function () {
        if (!previewUrls.open) {
          setErrors(['No hay URL de preview disponible. Pulsa “Renderizar preview” de nuevo.']);
          return;
        }
        window.open(previewUrls.open, '_blank', 'noopener,noreferrer');
      };
    }

    var rawButton = $('#open-preview-raw');
    if (rawButton) {
      rawButton.onclick = function () {
        if (!previewUrls.raw) {
          setErrors(['No hay HTML bruto disponible. Pulsa “Renderizar preview” de nuevo.']);
          return;
        }
        window.open(previewUrls.raw, '_blank', 'noopener,noreferrer');
      };
    }
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function normalizeVariableName(value) {
    return String(value || '').trim();
  }

  function ensureExpression(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (/^{{[\s\S]*}}$/.test(text)) return text;
    return '{{' + text + '}}';
  }

  function cleanSchemaLabel(value) {
    return String(value == null ? '' : value)
      .replace(/^{{\s*|\s*}}$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripExpressionBraces(value) {
    return String(value == null ? '' : value)
      .replace(/^{{\s*/, '')
      .replace(/\s*}}$/, '')
      .trim();
  }

  function inferSchemaSource(text, fallback) {
    var lower = String(text || '').toLowerCase();

    if (
      lower.indexOf('contact.') >= 0 ||
      lower.indexOf('contact data') >= 0 ||
      lower.indexOf('contactdata') >= 0 ||
      lower.indexOf('contactattributes') >= 0 ||
      lower.indexOf('contact attributes') >= 0 ||
      lower.indexOf('profile attribute') >= 0
    ) {
      return 'contactData';
    }

    if (
      lower.indexOf('event.') >= 0 ||
      lower.indexOf('journey') >= 0 ||
      lower.indexOf('entry') >= 0 ||
      lower.indexOf('trigger') >= 0 ||
      lower.indexOf('eventdefinition') >= 0
    ) {
      return 'journeyData';
    }

    return fallback || 'journeyData';
  }

  function normalizeSchemaExpression(rawValue, source) {
    var raw = String(rawValue || '').trim();
    if (!raw) return '';

    if (/^{{[\s\S]*}}$/.test(raw)) return raw;

    raw = stripExpressionBraces(raw);

    if (/^(Event|Contact|InteractionDefaults)\./i.test(raw)) {
      return '{{' + raw + '}}';
    }

    if (source === 'contactData') {
      return '{{Contact.Attribute.' + raw + '}}';
    }

    return '{{Event.' + raw + '}}';
  }

  function schemaFieldSort(a, b) {
    var sourceCompare = String(a.source || '').localeCompare(String(b.source || ''));
    if (sourceCompare !== 0) return sourceCompare;
    return String(a.label || a.expression || '').localeCompare(String(b.label || b.expression || ''));
  }

  function dedupeSchemaFields(fields) {
    var seen = {};
    return (fields || []).filter(function (field) {
      if (!field || !field.expression) return false;
      var key = String(field.expression).toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    }).sort(schemaFieldSort);
  }

  function looksLikeSchemaField(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;

    if (node.expression || node.accessor || node.path) return true;

    var hasName = Boolean(node.name || node.label || node.key || node.fieldName || node.field);
    var hasType = Boolean(node.type || node.dataType || node.fieldType || node.valueType || node.isNullable !== undefined || node.maxLength);
    var hasChildren = Boolean(node.fields || node.items || node.children || node.attributes || node.schema || node.properties);

    return hasName && hasType && !hasChildren;
  }

  function fieldRawValue(node) {
    return node.expression ||
      node.accessor ||
      node.path ||
      node.value ||
      node.key ||
      node.fieldName ||
      node.field ||
      node.name ||
      '';
  }

  function fieldLabel(node, parents, expression) {
    var base = node.label || node.displayName || node.name || node.fieldName || node.field || node.key || cleanSchemaLabel(expression);
    base = cleanSchemaLabel(base);

    var group = (parents || [])
      .map(cleanSchemaLabel)
      .filter(Boolean)
      .filter(function (part) {
        return !/^(schema|fields|items|children|attributes|properties|data|arguments)$/i.test(part);
      })
      .slice(-2)
      .join(' / ');

    return group ? group + ' / ' + base : base;
  }

  function collectSchemaFields(payload, sourceHint) {
    var fields = [];
    var visited = [];

    function walk(node, parents, source, depth) {
      if (node == null || depth > 10) return;

      if (typeof node !== 'object') return;

      if (visited.indexOf(node) >= 0) return;
      visited.push(node);

      if (Array.isArray(node)) {
        node.forEach(function (item) {
          walk(item, parents, source, depth + 1);
        });
        return;
      }

      var textForSource = [
        node.source,
        node.category,
        node.context,
        node.type,
        node.dataType,
        node.name,
        node.label,
        node.key,
        node.path,
        node.expression,
        parents.join('.')
      ].join(' ');

      var inferredSource = inferSchemaSource(textForSource, source || sourceHint || 'journeyData');

      if (looksLikeSchemaField(node)) {
        var raw = fieldRawValue(node);
        var expression = normalizeSchemaExpression(raw, inferredSource);
        var label = fieldLabel(node, parents, expression);

        if (expression && label && !/undefined|null|\[object object\]/i.test(expression)) {
          fields.push({
            label: label,
            expression: expression,
            source: inferredSource,
            type: node.type || node.dataType || node.fieldType || '',
            raw: raw
          });
        }
      }

      Object.keys(node).forEach(function (key) {
        if (/^(configurationArguments|arguments|metaData|lang|userInterfaces|execute|save|validate|publish|stop)$/i.test(key)) return;

        var child = node[key];
        if (child && typeof child === 'object') {
          var nextParents = parents.slice();
          if (!/^(items|children|fields|attributes|properties|schema)$/i.test(key)) {
            nextParents.push(key);
          }
          walk(child, nextParents, inferSchemaSource(key, inferredSource), depth + 1);
        }
      });
    }

    walk(payload, [], sourceHint || 'journeyData', 0);
    return dedupeSchemaFields(fields);
  }

  function mergeSchemaFields(fields) {
    var current = state.jbSchema.fields || [];
    var merged = dedupeSchemaFields(current.concat(fields || []));

    state.jbSchema.fields = merged;
    state.jbSchema.journeyData = merged.filter(function (field) { return field.source !== 'contactData'; });
    state.jbSchema.contactData = merged.filter(function (field) { return field.source === 'contactData'; });
    state.jbSchema.loaded = true;
    state.jbSchema.loading = false;
    state.jbSchema.error = '';

    render();
  }

  function consumeSchemaPayload(payload, sourceHint) {
    if (Array.isArray(payload) && payload.length === 1 && typeof payload[0] === 'object') {
      payload = payload[0];
    }

    var fields = collectSchemaFields(payload, sourceHint);

    if (fields.length) {
      mergeSchemaFields(fields);
      return;
    }

    state.jbSchema.loaded = true;
    state.jbSchema.loading = false;
    state.jbSchema.error = 'Journey Builder respondió, pero no se encontraron campos en el schema recibido. Puedes escribir la expresión manualmente.';
    render();
  }

  function requestJourneyDataSchema(manual) {
    state.jbSchema.requested = true;
    state.jbSchema.loading = true;
    state.jbSchema.error = '';
    if (manual) render();

    try {
      connection.trigger('requestSchema');
      connection.trigger('requestTriggerEventDefinition');
    } catch (err) {
      state.jbSchema.loading = false;
      state.jbSchema.error = 'No se pudo solicitar el schema a Journey Builder: ' + (err.message || String(err));
      render();
      return;
    }

    window.setTimeout(function () {
      if (state.jbSchema.loading && !(state.jbSchema.fields || []).length) {
        state.jbSchema.loading = false;
        state.jbSchema.loaded = true;
        state.jbSchema.error = 'Journey Builder no devolvió schema. Puedes escribir la expresión manualmente.';
        render();
      }
    }, 7000);
  }

  function getSchemaFieldsForType(type) {
    if (type === 'contactData') return state.jbSchema.contactData || [];
    if (type === 'journeyData') return state.jbSchema.journeyData || [];
    return state.jbSchema.fields || [];
  }

  function isLikelyEmailField(field) {
    var text = String((field && (field.label + ' ' + field.expression + ' ' + field.type)) || '').toLowerCase();
    return text.indexOf('email') >= 0 || text.indexOf('e-mail') >= 0 || text.indexOf('mail') >= 0;
  }

  function shortExpression(value) {
    var text = stripExpressionBraces(value || '');
    text = text.replace(/^Event\./i, '');
    text = text.replace(/^Contact\.Attribute\./i, '');
    if (text.length <= 70) return text;
    return text.slice(0, 30) + '…' + text.slice(-32);
  }

  function compactFieldLabel(field) {
    var label = cleanSchemaLabel((field && field.label) || '');
    var expression = String((field && field.expression) || '');
    var fallback = shortExpression(expression);

    // En el <select> no mostramos la expresión completa porque los nombres de Event.DEAudience
    // son larguísimos y rompen el layout dentro del modal de Journey Builder.
    if (!label || /^event\.|^contact\./i.test(label) || label.length > 55) {
      label = fallback;
    }

    label = label.replace(/^DEAudience-[^.]+\./i, '');
    label = label.replace(/^Event\.DEAudience-[^.]+\./i, '');
    label = label.replace(/^Contact\.Attribute\./i, '');

    if (label.length > 48) label = label.slice(0, 45) + '…';

    return label || 'Campo';
  }

  function fieldSourceBadge(field) {
    return field && field.source === 'contactData' ? 'Contact' : 'Journey';
  }

  function renderSchemaSelectOptions(currentValue, type) {
    var current = String(currentValue || '');
    var fields = getSchemaFieldsForType(type);

    if (!fields.length) {
      return '<option value="">Carga campos o escribe la expresión manualmente</option>';
    }

    var html = ['<option value="">Seleccionar campo...</option>'];

    fields.forEach(function (field) {
      var value = field.expression;
      var selected = value === current ? ' selected' : '';
      var display = compactFieldLabel(field) + ' · ' + fieldSourceBadge(field);

      html.push(
        '<option value="', attr(value), '" title="', attr(value), '"', selected, '>',
        escapeHtml(display),
        '</option>'
      );
    });

    return html.join('');
  }

  function renderSchemaTools() {
    var fields = state.jbSchema.fields || [];
    var journeyCount = (state.jbSchema.journeyData || []).length;
    var contactCount = (state.jbSchema.contactData || []).length;
    var emailFields = fields.filter(isLikelyEmailField);

    return [
      '<div class="slds-box slds-theme_shade slds-m-bottom_medium">',
      '<div class="slds-grid slds-gutters slds-wrap slds-grid_vertical-align-end">',
      '<div class="slds-col slds-size_1-of-1 slds-large-size_2-of-3">',
      '<p class="slds-text-title_bold">Campos disponibles del Journey</p>',
      '<p class="slds-text-body_small slds-text-color_weak">',
      fields.length
        ? 'Campos cargados: ' + fields.length + ' · Journey Data: ' + journeyCount + ' · Contact Data: ' + contactCount
        : 'Carga el schema para seleccionar campos desde un desplegable en lugar de escribir expresiones manualmente.',
      '</p>',
      state.jbSchema.error ? '<p class="slds-text-color_error slds-m-top_x-small">' + escapeHtml(state.jbSchema.error) + '</p>' : '',
      '</div>',
      '<div class="slds-col slds-size_1-of-1 slds-large-size_1-of-3 slds-text-align_right">',
      '<button type="button" class="slds-button slds-button_neutral" id="load-schema-fields">',
      state.jbSchema.loading ? 'Cargando campos...' : (fields.length ? 'Recargar campos' : 'Cargar campos del Journey'),
      '</button>',
      '</div>',
      '</div>',
      fields.length ? [
        '<div class="slds-grid slds-gutters slds-wrap slds-m-top_medium">',
        '<div class="slds-col slds-size_1-of-1 slds-large-size_1-of-2">',
        '<label class="slds-form-element__label" for="recipient-field-select">Campo email destinatario sugerido</label>',
        '<select id="recipient-field-select" class="slds-select">',
        '<option value="">No cambiar</option>',
        (emailFields.length ? emailFields : fields).map(function (field) {
          return '<option value="' + attr(field.expression) + '" title="' + attr(field.expression) + '">' + escapeHtml(compactFieldLabel(field) + ' · ' + fieldSourceBadge(field)) + '</option>';
        }).join(''),
        '</select>',
        '</div>',
        '</div>'
      ].join('') : '',
      '</div>'
    ].join('');
  }


  function showNotice(message, variant) {
    state.notices = [{ message: message, variant: variant || 'info' }];
    render();
  }

  function normalizeErrorDetails(details) {
    if (!details) return [];
    if (Array.isArray(details)) {
      return details.map(function (item) {
        return typeof item === 'string' ? item : JSON.stringify(item);
      });
    }
    if (typeof details === 'string') return [details];

    try {
      return [JSON.stringify(details)];
    } catch (_err) {
      return [String(details)];
    }
  }

  function setErrors(errors) {
    state.errors = Array.isArray(errors) ? errors : [String(errors || 'Error desconocido')];
    render();
  }

  async function fetchJson(url, options) {
    var controller = window.AbortController ? new AbortController() : null;
    var timeoutMs = 30000;
    var timeoutId = controller ? window.setTimeout(function () {
      controller.abort();
    }, timeoutMs) : null;

    try {
      var response = await fetch(url, Object.assign({
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller ? controller.signal : undefined
      }, options || {}));

      var body = {};
      var text = await response.text();

      try {
        body = text ? JSON.parse(text) : {};
      } catch (_err) {
        body = { raw: text };
      }

      if (!response.ok) {
        var details = body.error && body.error.details ? body.error.details : [];
        var message = body.error && body.error.message ? body.error.message : 'Error HTTP ' + response.status;
        var error = new Error(message);
        error.details = normalizeErrorDetails(details);
        error.body = body;
        throw error;
      }

      return body;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('La petición tardó más de ' + Math.round(timeoutMs / 1000) + ' segundos. Revisa en Render las variables SFMC_AUTH_BASE_URL, SFMC_REST_BASE_URL, SFMC_CLIENT_ID, SFMC_CLIENT_SECRET y los permisos assets_read.');
      }
      throw err;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  function extractInArgumentConfig(activity) {
    var inArgs = activity
      && activity.arguments
      && activity.arguments.execute
      && activity.arguments.execute.inArguments;

    if (!Array.isArray(inArgs) || !inArgs.length) return null;

    var merged = inArgs.reduce(function (acc, item) {
      if (item && typeof item === 'object') {
        Object.keys(item).forEach(function (key) {
          acc[key] = item[key];
        });
      }
      return acc;
    }, {});

    return merged.config || null;
  }

  function hydrateFromActivity(activity) {
    // Some Postmonger wrappers pass [activity] instead of activity.
    if (Array.isArray(activity)) activity = activity[0];

    state.activity = activity || state.activity || {};

    var existing = extractInArgumentConfig(state.activity);
    if (existing) {
      state.config = Object.assign(clone(DEFAULT_CONFIG), existing, {
        templateSnapshot: Object.assign(clone(DEFAULT_CONFIG.templateSnapshot), existing.templateSnapshot || {})
      });
      state.selectedAsset = {
        id: state.config.assetId,
        customerKey: state.config.assetCustomerKey,
        name: state.config.assetName,
        subject: state.config.subject,
        preheader: state.config.preheader
      };
      state.variables = detectVariablesClient([
        state.config.subject,
        state.config.preheader,
        state.config.templateSnapshot.html,
        state.config.templateSnapshot.text
      ].join('\n'));
      ensureMappingsForVariables();
    }

    render();
    updateJourneyButtons();

    if (!state.jbSchema.requested && window.self !== window.top) {
      window.setTimeout(function () {
        requestJourneyDataSchema(false);
      }, 400);
    }
  }

  function detectVariablesClient(text) {
    var variables = {};
    var regex = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
    var match;

    while ((match = regex.exec(String(text || ''))) !== null) {
      variables[normalizeVariableName(match[1])] = true;
    }

    return Object.keys(variables).sort(function (a, b) { return a.localeCompare(b); });
  }

  function ensureMappingsForVariables() {
    state.config.variableMappings = state.config.variableMappings || {};
    state.config.sampleData = state.config.sampleData || {};

    state.variables.forEach(function (variable) {
      if (!state.config.variableMappings[variable]) {
        state.config.variableMappings[variable] = {
          type: 'fixed',
          value: '',
          path: '',
          sampleValue: '',
          fallbackValue: '',
          required: true
        };
      }
    });
  }

  async function searchAssets() {
    readConfigFromForm();
    state.loading = true;
    state.errors = [];
    render();

    try {
      var query = new URLSearchParams({
        page: '1',
        pageSize: '25',
        search: state.assetSearch || '',
        assetType: 'all'
      });
      var result = await fetchJson('/api/assets?' + query.toString());
      state.assets = result.items || [];
      state.loading = false;
      state.notices = result.fallback
        ? [{ message: 'SFMC no aceptó la query avanzada; se usó listado básico con filtrado local.', variant: 'warning' }]
        : [];
      render();
    } catch (err) {
      state.loading = false;
      setErrors([err.message].concat(err.details || []));
    }
  }

  async function selectAsset(assetId) {
    readConfigFromForm();
    state.loading = true;
    state.errors = [];
    render();

    try {
      var result = await fetchJson('/api/assets/' + encodeURIComponent(assetId));
      var asset = result.asset;
      state.selectedAsset = asset;
      revokePreviewBlobUrls();
      state.preview = null;

      state.config.assetId = String(asset.id || '');
      state.config.assetCustomerKey = asset.customerKey || '';
      state.config.assetName = asset.name || '';
      state.config.subject = asset.subject || state.config.subject || '';
      state.config.preheader = asset.preheader || state.config.preheader || '';
      state.config.templateSnapshot = {
        html: asset.html || '',
        text: asset.text || ''
      };
      state.config.warnings = asset.warnings || [];

      state.variables = asset.variables || detectVariablesClient([
        state.config.subject,
        state.config.preheader,
        state.config.templateSnapshot.html,
        state.config.templateSnapshot.text
      ].join('\n'));

      ensureMappingsForVariables();

      state.loading = false;
      state.step = 2;
      state.notices = [{ message: 'Asset seleccionado y variables detectadas.', variant: 'success' }];
      render();
      updateJourneyButtons();
    } catch (err) {
      state.loading = false;
      setErrors([err.message].concat(err.details || []));
    }
  }

  function readConfigFromForm() {
    var form = $('#activity-form');
    if (!form) return;

    state.assetSearch = ($('#asset-search') || {}).value || state.assetSearch;

    var fieldIds = [
      'subject',
      'preheader',
      'fromName',
      'fromEmail',
      'replyTo',
      'recipientExpression'
    ];

    fieldIds.forEach(function (id) {
      var el = $('#' + id);
      if (el) state.config[id] = el.value;
    });

    state.config.variableMappings = state.config.variableMappings || {};
    state.config.sampleData = {};

    state.variables.forEach(function (variable) {
      var safe = cssSafe(variable);
      var typeEl = $('[data-var-type="' + safe + '"]');
      var valueEl = $('[data-var-value="' + safe + '"]');
      var pathEl = $('[data-var-path="' + safe + '"]');
      var sampleEl = $('[data-var-sample="' + safe + '"]');
      var requiredEl = $('[data-var-required="' + safe + '"]');
      var fieldSelectEl = $('[data-var-field-select="' + safe + '"]');

      var mapping = state.config.variableMappings[variable] || {};
      mapping.type = typeEl ? typeEl.value : mapping.type || 'fixed';
      mapping.value = valueEl ? valueEl.value : mapping.value || '';

      var selectedSchemaField = fieldSelectEl ? fieldSelectEl.value : '';
      mapping.path = selectedSchemaField || (pathEl ? pathEl.value : mapping.path || '');

      mapping.sampleValue = sampleEl ? sampleEl.value : mapping.sampleValue || '';
      mapping.required = requiredEl ? requiredEl.checked : mapping.required !== false;

      state.config.variableMappings[variable] = mapping;
      if (mapping.sampleValue) {
        state.config.sampleData[variable] = mapping.sampleValue;
      }
    });
  }

  function cssSafe(value) {
    return encodeURIComponent(value).replace(/%/g, '_');
  }

  function variableFromSafe(safeValue) {
    var encoded = String(safeValue || '').replace(/_/g, '%');
    try { return decodeURIComponent(encoded); } catch (_err) { return safeValue; }
  }

  function localValidation() {
    readConfigFromForm();
    var errors = [];

    if (!state.config.assetId) errors.push('Selecciona un asset.');
    if (!String(state.config.subject || '').trim()) errors.push('El subject es obligatorio.');
    if (!isEmail(state.config.fromEmail)) errors.push('From Email debe tener formato válido.');
    if (state.config.replyTo && !isEmail(state.config.replyTo)) errors.push('Reply-To debe tener formato válido.');
    if (!String(state.config.recipientExpression || '').trim()) errors.push('Configura el destinatario.');

    state.variables.forEach(function (variable) {
      var mapping = state.config.variableMappings[variable] || {};
      if (mapping.required === false) return;

      if (mapping.type === 'fixed' && !String(mapping.value || '').trim()) {
        errors.push('La variable {{' + variable + '}} requiere valor fijo o cambia su origen.');
      }

      if ((mapping.type === 'journeyData' || mapping.type === 'contactData') && !String(mapping.path || '').trim()) {
        errors.push('La variable {{' + variable + '}} requiere expresión de datos.');
      }
    });

    return errors;
  }

  function canContinue() {
    readConfigFromForm();
    if (state.step === 1) return !!state.config.assetId;
    if (state.step === 2) return localValidation().length === 0;
    if (state.step === 3) return localValidation().length === 0;
    if (state.step === 4) return localValidation().length === 0;
    return true;
  }

  async function generatePreview() {
    readConfigFromForm();
    revokePreviewBlobUrls();
    state.loading = true;
    state.errors = [];
    render();

    try {
      var result = await fetchJson('/api/preview', {
        method: 'POST',
        body: JSON.stringify({
          assetId: state.config.assetId,
          subject: state.config.subject,
          preheader: state.config.preheader,
          html: state.config.templateSnapshot.html,
          text: state.config.templateSnapshot.text,
          variableMappings: state.config.variableMappings,
          sampleData: state.config.sampleData,
          warnings: state.config.warnings
        })
      });

      state.preview = result;
      state.loading = false;
      state.notices = [{ message: 'Preview renderizado.', variant: 'success' }];
      render();
      updateJourneyButtons();
    } catch (err) {
      state.loading = false;
      setErrors([err.message].concat(err.details || []));
    }
  }

  async function sendTest() {
    readConfigFromForm();

    var testEmail = ($('#testEmail') || {}).value || '';
    if (!isEmail(testEmail)) {
      setErrors(['Introduce un email de test válido.']);
      return;
    }

    var errors = localValidation();
    if (errors.length) {
      setErrors(errors);
      return;
    }

    state.loading = true;
    state.errors = [];
    state.testResult = null;
    render();

    try {
      var result = await fetchJson('/api/test-send', {
        method: 'POST',
        body: JSON.stringify({
          to: testEmail,
          fromName: state.config.fromName,
          fromEmail: state.config.fromEmail,
          replyTo: state.config.replyTo,
          subject: state.config.subject,
          preheader: state.config.preheader,
          html: state.config.templateSnapshot.html,
          text: state.config.templateSnapshot.text,
          variableMappings: state.config.variableMappings,
          sampleData: state.config.sampleData,
          warnings: state.config.warnings,
          assetId: state.config.assetId
        })
      });

      state.testResult = result;
      state.loading = false;
      state.notices = [{ message: 'Test enviado al relay privado.', variant: 'success' }];
      render();
    } catch (err) {
      state.loading = false;
      setErrors([err.message].concat(err.details || []));
    }
  }

  function buildInArgument() {
    readConfigFromForm();

    var resolvedData = {};
    var flat = {};

    Object.keys(state.config.variableMappings || {}).forEach(function (variable) {
      var mapping = state.config.variableMappings[variable] || {};
      if (mapping.type === 'journeyData' || mapping.type === 'contactData') {
        var expression = ensureExpression(mapping.path);
        if (expression) {
          resolvedData[variable] = expression;
          flat['var_' + variable] = expression;
        }
      }
    });

    var emailExpression = ensureExpression(state.config.recipientExpression || '{{InteractionDefaults.Email}}');

    return Object.assign({
      config: state.config,
      contactKey: '{{Contact.Key}}',
      emailAddress: emailExpression,
      resolvedData: resolvedData
    }, flat);
  }

  function updateActivity() {
    var errors = localValidation();

    if (errors.length) {
      setErrors(errors);
      updateJourneyButtons();
      return false;
    }

    var activity = state.activity || {};
    activity.arguments = activity.arguments || {};
    activity.arguments.execute = activity.arguments.execute || {};
    activity.arguments.execute.inArguments = [buildInArgument()];

    activity.metaData = activity.metaData || {};
    activity.metaData.isConfigured = true;
    activity.name = activity.name || 'Email por relay privado';

    connection.trigger('updateActivity', activity);
    return true;
  }

  function updateJourneyButtons() {
    /*
     * Hotfix no-spinner-v9:
     * No usamos la API updateButton de Journey Builder durante la carga.
     * En algunos tenants, llamar updateButton antes/después de initActivity reactiva
     * el overlay gris del modal. La UI ya tiene botones locales Atrás/Siguiente
     * y el botón Done nativo sigue siendo capturado por clickedNext.
     */
    if (!ENABLE_JB_BUTTON_UPDATES) return;

    try {
      connection.trigger('updateButton', {
        button: 'back',
        visible: state.step > 1
      });
      connection.trigger('updateButton', {
        button: 'next',
        text: state.step === STEPS.length ? 'Done' : 'Next',
        visible: true,
        enabled: canContinue()
      });
    } catch (_err) {
      // Journey Builder controls these buttons. Ignore when running standalone.
    }
  }

  function gotoStep(step) {
    readConfigFromForm();
    var next = Math.max(1, Math.min(STEPS.length, Number(step) || 1));
    state.step = next;
    state.errors = [];
    render();
    updateJourneyButtons();

    if (state.step === 3 && !state.preview) {
      generatePreview();
    }
  }

  function onClickedNext() {
    readConfigFromForm();

    if (state.step < STEPS.length) {
      var errors = state.step >= 2 ? localValidation() : [];
      if (state.step === 1 && !state.config.assetId) {
        errors.push('Selecciona una plantilla antes de continuar.');
      }

      if (errors.length) {
        setErrors(errors);
        updateJourneyButtons();
        return;
      }

      gotoStep(state.step + 1);
      return;
    }

    updateActivity();
  }

  function render() {
    var app = $('#app');
    app.innerHTML = [
      '<form id="activity-form" class="slds-p-around_medium" novalidate>',
      renderHeader(),
      renderAlerts(),
      renderStepContent(),
      renderLocalFooter(),
      '</form>'
    ].join('');

    bindEvents();
    hydratePreviewFrames();
  }

  function renderHeader() {
    return [
      '<div class="slds-page-header slds-page-header_record-home slds-m-bottom_medium">',
      '<div class="slds-page-header__row">',
      '<div class="slds-page-header__col-title">',
      '<div class="slds-media">',
      '<div class="slds-media__figure"><span class="slds-avatar slds-avatar_medium"><img src="/images/icon.png" alt=""></span></div>',
      '<div class="slds-media__body">',
      '<div class="slds-page-header__name">',
      '<div class="slds-page-header__name-title">',
      '<h1><span>Email por relay privado</span><span class="slds-page-header__title slds-truncate">Journey Builder Custom Activity</span></h1>',
      '</div>',
      '</div>',
      '<p class="slds-page-header__name-meta">Selecciona un email asset de Content Builder, resuelve {{variables}} y envía mediante relay HTTP externo.</p>',
      '</div></div></div></div>',
      renderPath(),
      '</div>'
    ].join('');
  }

  function renderPath() {
    return [
      '<div class="slds-path slds-m-top_medium">',
      '<div class="slds-grid slds-path__track">',
      '<div class="slds-grid slds-path__scroller-container">',
      '<div class="slds-path__scroller" role="application">',
      '<div class="slds-path__scroller_inner">',
      '<ul class="slds-path__nav" role="listbox" aria-orientation="horizontal">',
      STEPS.map(function (step) {
        var cls = step.id === state.step ? 'slds-is-current slds-is-active' : step.id < state.step ? 'slds-is-complete' : 'slds-is-incomplete';
        return [
          '<li class="slds-path__item ', cls, '" role="presentation">',
          '<a aria-selected="', step.id === state.step ? 'true' : 'false', '" class="slds-path__link" href="#" data-step="', step.id, '">',
          '<span class="slds-path__stage"><span class="slds-assistive-text">', escapeHtml(step.label), '</span></span>',
          '<span class="slds-path__title">', escapeHtml(step.label), '</span>',
          '</a></li>'
        ].join('');
      }).join(''),
      '</ul></div></div></div></div></div>'
    ].join('');
  }

  function renderAlerts() {
    var html = [];

    if (state.loading) {
      html.push('<div class="slds-notify slds-notify_alert slds-theme_info slds-m-bottom_small" role="status"><span class="slds-assistive-text">info</span>Procesando...</div>');
    }

    state.notices.forEach(function (notice) {
      var theme = notice.variant === 'success' ? 'slds-theme_success' : notice.variant === 'warning' ? 'slds-theme_warning' : 'slds-theme_info';
      html.push('<div class="slds-notify slds-notify_alert ' + theme + ' slds-m-bottom_small" role="status">' + escapeHtml(notice.message) + '</div>');
    });

    if (state.errors.length) {
      html.push('<div class="slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small" role="alert"><div><strong>Revisa la configuración:</strong><ul class="slds-list_dotted slds-m-left_medium">' + state.errors.map(function (error) {
        return '<li>' + escapeHtml(typeof error === 'string' ? error : JSON.stringify(error)) + '</li>';
      }).join('') + '</ul></div></div>');
    }

    return html.join('');
  }

  function renderStepContent() {
    if (state.step === 1) return renderStepAssets();
    if (state.step === 2) return renderStepConfig();
    if (state.step === 3) return renderStepPreview();
    return renderStepTest();
  }

  function renderStepAssets() {
    return [
      '<div class="slds-card">',
      '<div class="slds-card__header slds-grid">',
      '<header class="slds-media slds-media_center slds-has-flexi-truncate">',
      '<div class="slds-media__body"><h2 class="slds-card__header-title">Paso 1 · Selección de plantilla</h2></div>',
      '</header></div>',
      '<div class="slds-card__body slds-card__body_inner">',
      '<div class="slds-grid slds-gutters slds-m-bottom_medium">',
      '<div class="slds-col slds-size_8-of-12">',
      '<label class="slds-form-element__label" for="asset-search">Buscar por nombre o customerKey</label>',
      '<input id="asset-search" class="slds-input" value="', attr(state.assetSearch), '" placeholder="Ej. bienvenida, confirmacion, customerKey">',
      '</div>',
      '<div class="slds-col slds-size_4-of-12 slds-align-bottom">',
      '<button type="button" class="slds-button slds-button_brand slds-m-top_large" id="search-assets">Buscar assets</button>',
      '</div></div>',
      renderSelectedAssetSummary(),
      renderAssetTable(),
      '</div></div>'
    ].join('');
  }

  function renderAssetTable() {
    if (!state.assets.length) {
      return '<div class="slds-box slds-theme_default">Usa el buscador para listar email assets de Content Builder.</div>';
    }

    return [
      '<div class="slds-scrollable_y asset-table">',
      '<table class="slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped">',
      '<thead><tr><th>Nombre</th><th>CustomerKey</th><th>Tipo</th><th>Modificado</th><th></th></tr></thead>',
      '<tbody>',
      state.assets.map(function (asset) {
        return [
          '<tr>',
          '<td><strong>', escapeHtml(asset.name || ''), '</strong><div class="slds-text-color_weak">ID ', escapeHtml(asset.id || ''), '</div></td>',
          '<td>', escapeHtml(asset.customerKey || ''), '</td>',
          '<td>', escapeHtml(asset.assetTypeName || asset.assetType || ''), '</td>',
          '<td>', escapeHtml(asset.modifiedDate || ''), '</td>',
          '<td><button type="button" class="slds-button slds-button_neutral" data-select-asset="', attr(asset.id), '">Seleccionar</button></td>',
          '</tr>'
        ].join('');
      }).join(''),
      '</tbody></table></div>'
    ].join('');
  }

  function renderSelectedAssetSummary() {
    if (!state.config.assetId) return '';

    return [
      '<div class="slds-box slds-theme_shade slds-m-bottom_medium">',
      '<h3 class="slds-text-heading_small slds-m-bottom_x-small">Asset seleccionado</h3>',
      '<p><strong>', escapeHtml(state.config.assetName || state.config.assetId), '</strong> · ID ', escapeHtml(state.config.assetId), ' · ', escapeHtml(state.config.assetCustomerKey || ''), '</p>',
      renderVariableBadges(),
      '</div>'
    ].join('');
  }

  function renderVariableBadges() {
    if (!state.variables.length) {
      return '<p class="slds-text-color_weak slds-m-top_x-small">No se detectaron variables con sintaxis {{variable}}.</p>';
    }

    return '<div class="slds-m-top_small">' + state.variables.map(function (variable) {
      return '<span class="slds-badge slds-m-right_x-small slds-m-bottom_x-small">{{' + escapeHtml(variable) + '}}</span>';
    }).join('') + '</div>';
  }

  function renderStepConfig() {
    return [
      '<div class="slds-card">',
      '<div class="slds-card__header"><h2 class="slds-card__header-title">Paso 2 · Configuración de envío</h2></div>',
      '<div class="slds-card__body slds-card__body_inner">',
      renderSelectedAssetSummary(),
      '<div class="slds-grid slds-gutters slds-wrap">',
      field('subject', 'Subject', state.config.subject, 'slds-size_1-of-1', true),
      field('preheader', 'Preheader', state.config.preheader, 'slds-size_1-of-1', false),
      field('fromName', 'From Name', state.config.fromName, 'slds-size_1-of-2', false),
      field('fromEmail', 'From Email / buzón remitente esperado', state.config.fromEmail, 'slds-size_1-of-2', true),
      field('replyTo', 'Reply-To', state.config.replyTo, 'slds-size_1-of-2', false),
      field('recipientExpression', 'Email destinatario / expresión Journey Builder', state.config.recipientExpression, 'slds-size_1-of-2', true, '{{InteractionDefaults.Email}}'),
      '</div>',
      '<div class="slds-m-top_large">',
      '<h3 class="slds-text-heading_small slds-m-bottom_small">Variables dinámicas</h3>',
      '<p class="slds-text-body_small slds-text-color_weak slds-m-bottom_small">Puedes mapear cada {{variable}} a un valor fijo, Journey Data o Contact Data. El selector muestra nombres cortos para no romper el modal; la expresión completa queda debajo y puede editarse manualmente.</p><p class="slds-text-body_small slds-text-color_weak slds-m-bottom_small">Nota: en el relay Microsoft Graph, el remitente real lo define el buzón configurado en RELAY_API_URL. From Name/From Email quedan como referencia de configuración.</p>',
      renderSchemaTools(),
      renderMappingsTable(),
      '</div>',
      renderWarnings(),
      '</div></div>'
    ].join('');
  }

  function field(id, label, value, sizeClass, required, placeholder) {
    return [
      '<div class="slds-col ', sizeClass || 'slds-size_1-of-1', ' slds-m-bottom_medium">',
      '<div class="slds-form-element">',
      '<label class="slds-form-element__label" for="', id, '">', required ? '<abbr class="slds-required" title="required">*</abbr>' : '', escapeHtml(label), '</label>',
      '<div class="slds-form-element__control">',
      '<input id="', id, '" class="slds-input" value="', attr(value), '" placeholder="', attr(placeholder || ''), '">',
      '</div></div></div>'
    ].join('');
  }

  function renderMappingsTable() {
    if (!state.variables.length) {
      return '<div class="slds-box slds-theme_default">No hay variables {{}} detectadas en la plantilla.</div>';
    }

    return [
      '<div class="mapping-help slds-notify slds-notify_alert slds-theme_info slds-m-bottom_medium" role="status">',
      '<span>Los campos Journey/Contact Data se resuelven solamente en ejecución real del Journey. Para Preview y Test debes informar “Valor test/preview”.</span>',
      '</div>',
      '<div class="mapping-list">',
      state.variables.map(function (variable) {
        var mapping = state.config.variableMappings[variable] || {};
        var safe = cssSafe(variable);
        var mappingType = mapping.type || 'fixed';
        var selectedPath = mapping.path || '';
        return [
          '<section class="mapping-card slds-box slds-theme_default" data-mapping-card="', safe, '">',
          '<div class="mapping-card__header">',
          '<div>',
          '<div class="slds-text-title_caps">Variable detectada</div>',
          '<div><span class="slds-badge slds-badge_lightest">{{', escapeHtml(variable), '}}</span></div>',
          '</div>',
          '<label class="slds-checkbox mapping-required">',
          '<input type="checkbox" data-var-required="', safe, '" ', mapping.required !== false ? 'checked' : '', '>',
          '<span class="slds-checkbox_faux"></span>',
          '<span class="slds-form-element__label">Obligatoria</span>',
          '</label>',
          '</div>',

          '<div class="slds-grid slds-gutters slds-wrap slds-m-top_small">',
          '<div class="slds-col slds-size_1-of-1 slds-large-size_1-of-4">',
          '<label class="slds-form-element__label">Origen</label>',
          '<select class="slds-select" data-var-type="', safe, '">',
          option('fixed', 'Valor fijo', mappingType),
          option('journeyData', 'Journey Data', mappingType),
          option('contactData', 'Contact Data', mappingType),
          '</select>',
          '</div>',

          '<div class="slds-col slds-size_1-of-1 slds-large-size_3-of-4">',
          mappingType === 'fixed'
            ? [
                '<label class="slds-form-element__label">Valor fijo</label>',
                '<input class="slds-input" data-var-value="', safe, '" value="', attr(mapping.value || ''), '" placeholder="Valor fijo para todos los contactos">'
              ].join('')
            : [
                '<label class="slds-form-element__label">Campo ', mappingType === 'contactData' ? 'Contact Data' : 'Journey Data', '</label>',
                '<select class="slds-select mapping-field-select" data-var-field-select="', safe, '">',
                renderSchemaSelectOptions(selectedPath, mappingType),
                '</select>',
                '<input class="slds-input slds-m-top_x-small mapping-expression-input" data-var-path="', safe, '" value="', attr(selectedPath), '" placeholder="{{Event.Campo}} o {{Contact.Attribute.Grupo.Campo}}">',
                selectedPath ? '<div class="mapping-expression-preview" title="' + attr(selectedPath) + '">' + escapeHtml(shortExpression(selectedPath)) + '</div>' : ''
              ].join(''),
          '</div>',

          '<div class="slds-col slds-size_1-of-1 slds-m-top_small">',
          '<label class="slds-form-element__label">Valor test/preview</label>',
          '<input class="slds-input" data-var-sample="', safe, '" value="', attr(mapping.sampleValue || ''), '" placeholder="Ejemplo usado solo para Preview y Envío de test">',
          '<div class="slds-form-element__help">No se guarda como dato real del contacto. Solo sirve para previsualizar y enviar pruebas.</div>',
          '</div>',
          '</div>',
          '</section>'
        ].join('');
      }).join(''),
      '</div>'
    ].join('');
  }

  function option(value, label, current) {
    return '<option value="' + attr(value) + '" ' + (value === current ? 'selected' : '') + '>' + escapeHtml(label) + '</option>';
  }

  function renderWarnings() {
    if (!state.config.warnings || !state.config.warnings.length) return '';

    return [
      '<div class="slds-notify slds-notify_alert slds-theme_warning slds-m-top_medium" role="status">',
      '<div><strong>Warnings del asset</strong><ul class="slds-list_dotted slds-m-left_medium">',
      state.config.warnings.map(function (warning) {
        return '<li>' + escapeHtml(warning) + '</li>';
      }).join(''),
      '</ul></div></div>'
    ].join('');
  }

  function renderStepPreview() {
    var preview = state.preview;

    return [
      '<div class="slds-card">',
      '<div class="slds-card__header slds-grid">',
      '<header class="slds-media slds-media_center slds-has-flexi-truncate">',
      '<div class="slds-media__body"><h2 class="slds-card__header-title">Paso 3 · Preview</h2></div>',
      '<div><button type="button" class="slds-button slds-button_brand" id="generate-preview">Renderizar preview</button></div>',
      '</header></div>',
      '<div class="slds-card__body slds-card__body_inner">',
      preview ? renderPreviewResult(preview) : '<div class="slds-box slds-theme_default">Pulsa “Renderizar preview” para resolver variables con los valores de test configurados.</div>',
      '</div></div>'
    ].join('');
  }

  function renderPreviewResult(preview) {
    var htmlLength = String(preview.html || '').length;
    var diagnostics = preview.diagnostics || {};
    var visibleTextLength = diagnostics.visibleTextLength == null ? '' : diagnostics.visibleTextLength;
    var imgCount = diagnostics.imgCount == null ? '' : diagnostics.imgCount;
    var tableCount = diagnostics.tableCount == null ? '' : diagnostics.tableCount;

    return [
      '<div class="slds-box slds-theme_shade slds-m-bottom_medium">',
      '<p><strong>Subject:</strong> ', escapeHtml(preview.subject || ''), '</p>',
      '<p><strong>Preheader:</strong> ', escapeHtml(preview.preheader || ''), '</p>',
      '<p class="slds-text-body_small slds-text-color_weak">HTML renderizado: ', escapeHtml(htmlLength), ' caracteres',
      visibleTextLength !== '' ? ' · texto visible detectado: ' + escapeHtml(visibleTextLength) + ' caracteres' : '',
      imgCount !== '' ? ' · imágenes: ' + escapeHtml(imgCount) : '',
      tableCount !== '' ? ' · tablas: ' + escapeHtml(tableCount) : '',
      '</p>',
      '</div>',
      renderPreviewDiagnostics(preview),
      '<div class="slds-m-bottom_medium">',
      '<button type="button" class="slds-button slds-button_neutral" id="open-preview-new-tab">Abrir preview en nueva pestaña</button>',
      '<button type="button" class="slds-button slds-button_neutral" id="open-preview-raw">Abrir HTML bruto</button>',
      '</div>',
      '<div class="slds-grid slds-gutters slds-wrap preview-grid">',
      '<div class="slds-col slds-size_1-of-1 slds-large-size_1-of-2">',
      '<h3 class="slds-text-heading_small slds-m-bottom_small">Desktop</h3>',
      '<div class="preview-frame-shell desktop">',
      '<iframe id="preview-frame-desktop" class="preview-frame desktop" title="Preview desktop" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>',
      '</div>',
      '</div>',
      '<div class="slds-col slds-size_1-of-1 slds-large-size_1-of-2">',
      '<h3 class="slds-text-heading_small slds-m-bottom_small">Mobile</h3>',
      '<div class="preview-frame-shell mobile">',
      '<iframe id="preview-frame-mobile" class="preview-frame mobile" title="Preview mobile" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>',
      '</div>',
      '</div></div>',
      '<details class="slds-m-top_medium">',
      '<summary>Ver HTML renderizado bruto en el modal</summary>',
      '<textarea class="slds-textarea preview-raw" data-preview-raw readonly></textarea>',
      '</details>'
    ].join('');
  }

  function renderPreviewDiagnostics(preview) {
    var resolved = preview.resolvedVariables || [];
    var unresolved = preview.unresolvedVariables || [];
    var warnings = preview.warnings || [];

    return [
      '<div class="slds-grid slds-gutters slds-m-bottom_medium">',
      '<div class="slds-col slds-size_1-of-3">',
      '<div class="slds-box"><strong>Resueltas</strong><div class="slds-m-top_x-small">',
      resolved.length ? resolved.map(function (item) {
        return '<span class="slds-badge slds-m-right_x-small">' + escapeHtml(item.variable) + '</span>';
      }).join('') : '<span class="slds-text-color_weak">Ninguna</span>',
      '</div></div></div>',
      '<div class="slds-col slds-size_1-of-3">',
      '<div class="slds-box"><strong>No resueltas</strong><div class="slds-m-top_x-small">',
      unresolved.length ? unresolved.map(function (item) {
        return '<span class="slds-badge slds-theme_error slds-m-right_x-small">' + escapeHtml(item.variable) + '</span>';
      }).join('') : '<span class="slds-text-color_success">Sin pendientes</span>',
      '</div></div></div>',
      '<div class="slds-col slds-size_1-of-3">',
      '<div class="slds-box"><strong>Warnings</strong><div class="slds-m-top_x-small">',
      warnings.length ? warnings.map(function (warning) {
        return '<div class="slds-text-color_error">• ' + escapeHtml(warning) + '</div>';
      }).join('') : '<span class="slds-text-color_success">Sin warnings</span>',
      '</div></div></div>',
      '</div>'
    ].join('');
  }

  function renderStepTest() {
    return [
      '<div class="slds-card">',
      '<div class="slds-card__header"><h2 class="slds-card__header-title">Paso 4 · Envío de test</h2></div>',
      '<div class="slds-card__body slds-card__body_inner">',
      '<div class="slds-grid slds-gutters">',
      '<div class="slds-col slds-size_8-of-12">',
      '<label class="slds-form-element__label" for="testEmail">Email de test</label>',
      '<input id="testEmail" class="slds-input" placeholder="qa@tu-dominio.com">',
      '</div>',
      '<div class="slds-col slds-size_4-of-12 slds-align-bottom">',
      '<button type="button" id="send-test" class="slds-button slds-button_brand slds-m-top_large">Enviar test</button>',
      '</div></div>',
      state.testResult ? renderTestResult() : '',
      '<div class="slds-box slds-theme_shade slds-m-top_medium">Cuando pulses <strong>Done</strong> en Journey Builder, la configuración se guardará en <code>activity.arguments.execute.inArguments</code>.</div>',
      '</div></div>'
    ].join('');
  }

  function renderTestResult() {
    return [
      '<div class="slds-notify slds-notify_alert slds-theme_success slds-m-top_medium" role="status">',
      '<div><strong>Relay:</strong> ', escapeHtml(state.testResult.message || 'Test aceptado'), '</div>',
      '</div>'
    ].join('');
  }

  function renderLocalFooter() {
    return [
      '<div class="local-footer slds-grid slds-grid_align-spread slds-m-top_medium">',
      '<button type="button" class="slds-button slds-button_neutral" id="local-back" ', state.step === 1 ? 'disabled' : '', '>Atrás</button>',
      '<div>',
      '<button type="button" class="slds-button slds-button_neutral" id="local-preview" ', state.step < 2 ? 'disabled' : '', '>Preview</button>',
      '<button type="button" class="slds-button slds-button_brand" id="local-next">', state.step === STEPS.length ? 'Guardar/Done' : 'Siguiente', '</button>',
      '</div></div>'
    ].join('');
  }

  function bindEvents() {
    var form = $('#activity-form');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        return false;
      });
    }

    $all('[data-step]').forEach(function (el) {
      el.addEventListener('click', function (event) {
        event.preventDefault();
        var targetStep = Number(el.getAttribute('data-step'));
        if (targetStep <= state.step || canContinue()) gotoStep(targetStep);
      });
    });

    var searchButton = $('#search-assets');
    if (searchButton) searchButton.addEventListener('click', searchAssets);

    var assetSearch = $('#asset-search');
    if (assetSearch) {
      assetSearch.addEventListener('change', function () {
        state.assetSearch = assetSearch.value;
      });
      assetSearch.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          state.assetSearch = assetSearch.value;
          searchAssets();
        }
      });
    }

    $all('[data-select-asset]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectAsset(button.getAttribute('data-select-asset'));
      });
    });

    var schemaButton = $('#load-schema-fields');
    if (schemaButton) schemaButton.addEventListener('click', function () {
      readConfigFromForm();
      requestJourneyDataSchema(true);
    });

    var recipientFieldSelect = $('#recipient-field-select');
    if (recipientFieldSelect) {
      recipientFieldSelect.addEventListener('change', function () {
        if (!recipientFieldSelect.value) return;
        var recipientInput = $('#recipientExpression');
        if (recipientInput) recipientInput.value = recipientFieldSelect.value;
        readConfigFromForm();
        state.preview = null;
      });
    }

    $all('[data-var-field-select]').forEach(function (selectEl) {
      selectEl.addEventListener('change', function () {
        var safe = selectEl.getAttribute('data-var-field-select');
        var input = $('[data-var-path="' + safe + '"]');
        if (input && selectEl.value) input.value = selectEl.value;
        readConfigFromForm();
        state.preview = null;
      });
    });

    $all('[data-var-type]').forEach(function (typeEl) {
      typeEl.addEventListener('change', function () {
        readConfigFromForm();
        state.preview = null;
        render();
      });
    });

    var previewButton = $('#generate-preview');
    if (previewButton) previewButton.addEventListener('click', generatePreview);

    var sendButton = $('#send-test');
    if (sendButton) sendButton.addEventListener('click', sendTest);

    var localBack = $('#local-back');
    if (localBack) localBack.addEventListener('click', function () {
      if (state.step > 1) gotoStep(state.step - 1);
    });

    var localNext = $('#local-next');
    if (localNext) localNext.addEventListener('click', onClickedNext);

    var localPreview = $('#local-preview');
    if (localPreview) localPreview.addEventListener('click', function () {
      gotoStep(3);
    });

    $all('input, select, textarea').forEach(function (el) {
      el.addEventListener('change', function () {
        readConfigFromForm();
        state.preview = null;
        updateJourneyButtons();
      });
    });
  }

  var hasReceivedInitActivity = false;

  connection.on('initActivity', function (activity) {
    hasReceivedInitActivity = true;
    state.postmongerInitialized = true;
    if (DEBUG_POSTMONGER && window.console) console.log('[JB] initActivity recibido');

    /*
     * IMPORTANTE:
     * No pedimos requestTokens ni requestEndpoints. Esta Custom Activity usa
     * Server-to-Server OAuth en backend, así que no necesita tokens del iframe.
     * Pedirlos puede dejar algunos tenants con el spinner gris reactivado.
     */
    hydrateFromActivity(activity);
  });

  connection.on('requestedTokens', function (tokens) {
    state.tokens = tokens || null;
  });

  connection.on('requestedEndpoints', function (endpoints) {
    state.endpoints = endpoints || null;
  });

  connection.on('requestedSchema', function (schema) {
    consumeSchemaPayload(schema, 'journeyData');
  });

  connection.on('requestedTriggerEventDefinition', function (definition) {
    consumeSchemaPayload(definition, 'journeyData');
  });

  connection.on('clickedNext', onClickedNext);

  connection.on('clickedBack', function () {
    if (state.step > 1) {
      gotoStep(state.step - 1);
    } else {
      connection.trigger('prevStep');
    }
  });

  connection.on('gotoStep', function (step) {
    if (step && step.key) {
      var match = String(step.key).match(/(\d+)/);
      if (match) gotoStep(Number(match[1]));
      return;
    }

    gotoStep(Number(step));
  });

  render();

  window.addEventListener('error', function (event) {
    state.errors = ['Error JavaScript en el modal: ' + (event.message || 'sin detalle')];
    render();
  });

  /*
   * Handshake Journey Builder:
   * Enviamos "ready" en ráfagas cortas hasta recibir initActivity.
   * No pedimos requestTokens/requestEndpoints y no llamamos updateButton al cargar.
   *
   * La razón: algunos shells de Journey Builder no están listos para escuchar en
   * el primer tick del iframe. Si ready se pierde, el overlay gris se queda encima.
   */
  var readyAttempts = 0;
  var maxReadyAttempts = 24;

  function sendReadyUntilInitActivity() {
    if (hasReceivedInitActivity) return;

    readyAttempts += 1;

    if (DEBUG_POSTMONGER && window.console) {
      console.log('[JB] trigger ready intento', readyAttempts);
    }

    connection.trigger('ready');

    if (!hasReceivedInitActivity && readyAttempts < maxReadyAttempts) {
      window.setTimeout(sendReadyUntilInitActivity, 500);
      return;
    }

    if (!hasReceivedInitActivity) {
      state.notices = [{
        message: 'Journey Builder todavía no ha enviado initActivity. Esta versión usa Postmonger oficial. Revisa que el Installed Package apunte a /config.json?v=mapping-ui-v17 y que SFMC esté cargando /index.html?v=mapping-ui-v17.',
        variant: 'warning'
      }];
      render();
    }
  }

  window.setTimeout(sendReadyUntilInitActivity, 300);

  // Standalone developer convenience.
  if (window.self === window.top) {
    state.notices = [{ message: 'Modo standalone. En Journey Builder se recibirá initActivity vía Postmonger.', variant: 'info' }];
    render();
  }
})();