const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const { getAssetDetail } = require('../services/contentBuilderService');
const { renderEmailTemplate, hasBlockingUnresolved } = require('../services/templateRenderService');
const { buildResolvedDataFromExecute, detectVariables } = require('../services/variableParserService');
const { buildRelayPayload, postToRelay, assertRelayConfigured, isEmail, isMicrosoftGraphRelay } = require('../services/relayService');
const { requireSfmcJwt, shouldUseJwtInConfig, isSfmcJwtEnabled } = require('../middleware/jwtAuth');

const router = express.Router();

function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'https://sfmc-custom-activity-mensajeria-email.onrender.com').replace(/\/+$/, '');
}

function buildConfigJson() {
  const base = appBaseUrl();
  const useJwt = shouldUseJwtInConfig();

  return {
    workflowApiVersion: '1.1',
    metaData: {
      icon: `${base}/images/icon-v22.png?v=icon-v22`,
      category: 'message',
      isConfigured: false
    },
    type: 'REST',
    lang: {
      'en-US': {
        name: 'Email por relay privado',
        description: 'Envía un email seleccionado desde Content Builder usando un relay privado externo.'
      },
      'es-ES': {
        name: 'Email por relay privado',
        description: 'Envía un email seleccionado desde Content Builder usando un relay privado externo.'
      }
    },
    arguments: {
      execute: {
        inArguments: [],
        outArguments: [],
        url: `${base}/execute`,
        verb: 'POST',
        body: '',
        header: '',
        format: 'json',
        useJwt,
        timeout: 10000
      }
    },
    configurationArguments: {
      save: {
        url: `${base}/save`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt
      },
      publish: {
        url: `${base}/publish`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt
      },
      validate: {
        url: `${base}/validate`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt
      },
      stop: {
        url: `${base}/stop`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt
      }
    },
    userInterfaces: {
      configModal: {
        url: `${base}/index.html?v=secure-ui-v26`,
        height: 720,
        width: 980,
        fullscreen: false
      }
    },
    schema: {
      arguments: {
        execute: {
          inArguments: [],
          outArguments: []
        }
      }
    }
  };
}

function mergeInArguments(inArguments) {
  if (Array.isArray(inArguments)) {
    return inArguments.reduce((acc, item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return { ...acc, ...item };
      }
      return acc;
    }, {});
  }

  if (inArguments && typeof inArguments === 'object') return { ...inArguments };

  return {};
}

function findInArguments(payload = {}) {
  const candidates = [
    payload.arguments?.execute?.inArguments,
    payload.activity?.arguments?.execute?.inArguments,
    payload.originalActivity?.arguments?.execute?.inArguments,
    payload.originalDefinition?.arguments?.execute?.inArguments,
    payload.definition?.arguments?.execute?.inArguments,
    payload.config?.inArguments,
    payload.activity?.inArguments,
    payload.inArguments
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return [candidate];
  }

  // Algunos tenants/envíos de Journey Builder envuelven los datos de la actividad
  // más profundo dentro del payload. Buscamos de forma limitada una estructura
  // arguments.execute.inArguments para no depender de un único contrato.
  const visited = new Set();

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6 || visited.has(node)) return null;
    visited.add(node);

    const direct = node.arguments?.execute?.inArguments;
    if (Array.isArray(direct) && direct.length) return direct;

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === 'object') {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(payload) || [];
}

function extractConfigFromPayload(payload = {}) {
  if (Array.isArray(payload)) {
    const mergedArrayPayload = mergeInArguments(payload);
    return mergedArrayPayload.config || mergedArrayPayload || {};
  }

  const args = findInArguments(payload);
  const merged = mergeInArguments(args);

  return merged.config
    || payload.config
    || payload.activity?.config
    || payload.data?.config
    || merged
    || {};
}

function isStrictActivityValidationEnabled() {
  return ['1', 'true', 'yes', 'y', 'si', 'sí'].includes(
    String(process.env.ACTIVITY_VALIDATION_STRICT || '').trim().toLowerCase()
  );
}

function respondConfigurationLifecycle(req, res, next, phase, successMessage, errorCode) {
  try {
    const config = extractConfigFromPayload(req.body || {});
    const errors = validateConfig(config);

    if (errors.length) {
      console.warn('[activity-lifecycle-validation-warning]', {
        correlationId: req.correlationId,
        phase,
        errors
      });
    }

    // Journey Builder suele mostrar "endpoint is invalid" cuando estos endpoints
    // devuelven 4xx/5xx aunque el problema sea una validación de negocio.
    // Por defecto respondemos 200 para confirmar que el endpoint es válido.
    // Si se quiere bloquear publicación desde backend, activar:
    // ACTIVITY_VALIDATION_STRICT=true
    if (errors.length && isStrictActivityValidationEnabled()) {
      throw new AppError(
        `La actividad no supera la validación en fase ${phase}.`,
        400,
        errors,
        errorCode
      );
    }

    res.status(200).json({
      success: true,
      valid: errors.length === 0,
      phase,
      message: errors.length
        ? `${successMessage} Endpoint válido. Existen avisos de configuración; revisa la configuración en el modal.`
        : successMessage,
      warnings: errors
    });
  } catch (err) {
    next(err);
  }
}


function decodeBase64Utf8(value) {
  if (!value) return '';
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch (_err) {
    return '';
  }
}

function decodeStoredConfigContent(config = {}) {
  const decoded = { ...config };
  const encoded = decoded.encodedContent || decoded.templateSnapshotEncoded || null;

  if (encoded && encoded.encoding === 'base64') {
    decoded.subject = decodeBase64Utf8(encoded.subject || encoded.subjectB64 || '');
    decoded.preheader = decodeBase64Utf8(encoded.preheader || encoded.preheaderB64 || '');
    decoded.templateSnapshot = {
      ...(decoded.templateSnapshot || {}),
      html: decodeBase64Utf8(encoded.html || encoded.htmlB64 || ''),
      text: decodeBase64Utf8(encoded.text || encoded.textB64 || '')
    };
  }

  return decoded;
}


function normalizeConfig(config = {}) {
  config = decodeStoredConfigContent(config || {});
  return {
    assetId: config.assetId ? String(config.assetId) : '',
    assetCustomerKey: config.assetCustomerKey ? String(config.assetCustomerKey) : '',
    assetName: config.assetName ? String(config.assetName) : '',
    subject: config.subject ? String(config.subject) : '',
    preheader: config.preheader ? String(config.preheader) : '',
    fromName: config.fromName ? String(config.fromName) : '',
    fromEmail: config.fromEmail ? String(config.fromEmail) : '',
    replyTo: config.replyTo ? String(config.replyTo) : '',
    recipientExpression: config.recipientExpression ? String(config.recipientExpression) : '{{InteractionDefaults.Email}}',
    variableMappings: config.variableMappings && typeof config.variableMappings === 'object' ? config.variableMappings : {},
    sampleData: config.sampleData && typeof config.sampleData === 'object' ? config.sampleData : {},
    requiredVariables: Array.isArray(config.requiredVariables) ? config.requiredVariables : [],
    templateSnapshot: config.templateSnapshot && typeof config.templateSnapshot === 'object' ? config.templateSnapshot : {},
    warnings: Array.isArray(config.warnings) ? config.warnings : []
  };
}

function validateConfig(configInput = {}) {
  const config = normalizeConfig(configInput);
  const errors = [];

  if (!config.assetId) errors.push('Selecciona un asset de Content Builder.');
  if (!config.subject.trim()) errors.push('El subject no puede estar vacío.');

  // En modo Microsoft Graph el remitente real lo define el endpoint /users/{mailbox}/sendMail.
  // El From Email de la UI queda como referencia de negocio y no se usa para sobrescribir el From.
  if (!isMicrosoftGraphRelay() && !isEmail(config.fromEmail)) {
    errors.push('From Email debe tener formato válido.');
  }

  if (isMicrosoftGraphRelay() && config.fromEmail && !isEmail(config.fromEmail)) {
    errors.push('From Email debe tener formato válido si se informa.');
  }

  if (config.replyTo && !isEmail(config.replyTo)) errors.push('Reply-To debe tener formato válido.');
  if (!config.recipientExpression.trim()) errors.push('Configura el email destinatario o un mapping de email del contacto.');

  try {
    assertRelayConfigured();
  } catch (_err) {
    errors.push('El relay privado no está configurado. Revisa las variables RELAY_* en Render.');
  }

  const snapshot = config.templateSnapshot || {};
  const variables = detectVariables([
    config.subject,
    config.preheader,
    snapshot.html,
    snapshot.text
  ].join('\n'));

  for (const variable of variables) {
    const mapping = config.variableMappings?.[variable];
    if (!mapping) {
      errors.push(`Falta mapping para la variable {{${variable}}}.`);
      continue;
    }

    if (mapping.required !== false) {
      if (mapping.type === 'fixed' && !String(mapping.value || '').trim()) {
        errors.push(`La variable obligatoria {{${variable}}} requiere un valor fijo.`);
      }

      if ((mapping.type === 'journeyData' || mapping.type === 'contactData') && !String(mapping.path || '').trim()) {
        errors.push(`La variable obligatoria {{${variable}}} requiere una expresión de Journey/Contact Data.`);
      }
    }
  }

  return errors;
}

router.get('/config.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(buildConfigJson());
});

router.get('/security/diagnostics', (req, res) => {
  res.status(200).json({
    success: true,
    sfmcJwtValidationEnabled: isSfmcJwtEnabled(),
    configJsonUseJwt: shouldUseJwtInConfig(),
    jwtSecretConfigured: Boolean(process.env.SFMC_JWT_SECRET || process.env.JWT_SIGNING_SECRET || process.env.JWT_SECRET),
    protectedEndpoints: ['/execute', '/save', '/validate', '/publish', '/stop']
  });
});


router.post('/save', requireSfmcJwt, (req, res, next) => {
  respondConfigurationLifecycle(
    req,
    res,
    next,
    'save',
    'Configuración recibida por Journey Builder.',
    'ACTIVITY_SAVE_INVALID'
  );
});

router.post('/validate', requireSfmcJwt, (req, res, next) => {
  respondConfigurationLifecycle(
    req,
    res,
    next,
    'validate',
    'Endpoint de validación correcto.',
    'ACTIVITY_VALIDATE_INVALID'
  );
});

router.post('/publish', requireSfmcJwt, (req, res, next) => {
  respondConfigurationLifecycle(
    req,
    res,
    next,
    'publish',
    'Endpoint de publicación correcto.',
    'ACTIVITY_PUBLISH_INVALID'
  );
});

router.post('/stop', requireSfmcJwt, (req, res) => {
  res.json({ success: true, message: 'Stop recibido.' });
});

router.get(['/save', '/validate', '/publish', '/stop', '/execute'], (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Endpoint disponible.',
    path: req.path
  });
});

router.post('/execute', requireSfmcJwt, async (req, res, next) => {
  try {
    const body = req.body || {};
    const inArgs = mergeInArguments(findInArguments(body));
    const config = normalizeConfig(inArgs.config || {});

    const contactKey = inArgs.contactKey || body.keyValue || body.contactKey || '';
    const emailAddress = inArgs.emailAddress || inArgs.to || config.emailAddress || config.recipientExpression || '';
    const resolvedData = buildResolvedDataFromExecute(inArgs);

    let subject = config.subject;
    let preheader = config.preheader;
    let html = config.templateSnapshot?.html || '';
    let text = config.templateSnapshot?.text || '';

    if ((!html && !text) && config.assetId) {
      const asset = await getAssetDetail(config.assetId);
      subject = subject || asset.subject;
      preheader = preheader || asset.preheader;
      html = asset.html;
      text = asset.text;
    }

    const rendered = renderEmailTemplate({
      subject,
      preheader,
      html,
      text,
      variableMappings: config.variableMappings,
      resolvedData,
      warnings: config.warnings
    }, { useSamples: false });

    if (hasBlockingUnresolved(rendered)) {
      throw new AppError(
        'Variables obligatorias sin resolver en ejecución.',
        400,
        rendered.unresolvedVariables,
        'EXECUTE_UNRESOLVED_VARIABLES'
      );
    }

    const relayPayload = buildRelayPayload({
      to: emailAddress,
      fromName: config.fromName,
      fromEmail: config.fromEmail,
      replyTo: config.replyTo,
      subject: rendered.subject,
      preheader: rendered.preheader,
      html: rendered.html,
      text: rendered.text,
      metadata: {
        contactKey,
        journeyId: body.journeyId || body.definitionId || '',
        journeyVersionId: body.journeyVersionId || body.definitionInstanceId || '',
        activityId: body.activityId || body.activityObjectID || '',
        assetId: config.assetId,
        assetCustomerKey: config.assetCustomerKey,
        correlationId: req.correlationId
      }
    });

    const relayResult = await postToRelay(relayPayload, { correlationId: req.correlationId });

    console.info('[execute]', {
      correlationId: req.correlationId,
      contactKey,
      assetId: config.assetId,
      relayStatus: relayResult.relayStatus
    });

    res.status(200).json({
      success: true,
      message: 'Envío aceptado por relay privado.',
      correlationId: req.correlationId
    });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  buildConfigJson,
  validateConfig,
  extractConfigFromPayload
};