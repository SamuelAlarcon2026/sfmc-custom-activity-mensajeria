const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const { getAssetDetail } = require('../services/contentBuilderService');
const { renderEmailTemplate, hasBlockingUnresolved } = require('../services/templateRenderService');
const { buildResolvedDataFromExecute, detectVariables } = require('../services/variableParserService');
const { buildRelayPayload, postToRelay, assertRelayConfigured, isEmail, isMicrosoftGraphRelay } = require('../services/relayService');

const router = express.Router();

function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'https://sfmc-custom-activity-mensajeria-email.onrender.com').replace(/\/+$/, '');
}

function buildConfigJson() {
  const base = appBaseUrl();

  return {
    workflowApiVersion: '1.1',
    metaData: {
      icon: `${base}/images/icon.png`,
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
        useJwt: false,
        timeout: 10000
      }
    },
    configurationArguments: {
      save: {
        url: `${base}/save`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt: false
      },
      publish: {
        url: `${base}/publish`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt: false
      },
      validate: {
        url: `${base}/validate`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt: false
      },
      stop: {
        url: `${base}/stop`,
        verb: 'POST',
        body: '',
        header: '',
        useJwt: false
      }
    },
    userInterfaces: {
      configModal: {
        url: `${base}/index.html?v=graph-relay-v19`,
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

function extractConfigFromPayload(payload = {}) {
  const args = payload.arguments?.execute?.inArguments
    || payload.inArguments
    || payload.config?.inArguments
    || [];

  const merged = mergeInArguments(args);
  return merged.config || payload.config || merged || {};
}

function normalizeConfig(config = {}) {
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

router.post('/save', (req, res, next) => {
  try {
    const config = extractConfigFromPayload(req.body || {});
    const errors = validateConfig(config);

    if (errors.length) {
      throw new AppError('La configuración no es válida.', 400, errors, 'ACTIVITY_SAVE_INVALID');
    }

    res.json({ success: true, message: 'Configuración guardada.' });
  } catch (err) {
    next(err);
  }
});

router.post('/validate', (req, res, next) => {
  try {
    const config = extractConfigFromPayload(req.body || {});
    const errors = validateConfig(config);

    if (errors.length) {
      throw new AppError('La actividad no supera la validación.', 400, errors, 'ACTIVITY_VALIDATE_INVALID');
    }

    res.json({ success: true, message: 'Validación correcta.' });
  } catch (err) {
    next(err);
  }
});

router.post('/publish', (req, res, next) => {
  try {
    const config = extractConfigFromPayload(req.body || {});
    const errors = validateConfig(config);

    if (errors.length) {
      throw new AppError('La actividad no se puede publicar.', 400, errors, 'ACTIVITY_PUBLISH_INVALID');
    }

    res.json({ success: true, message: 'Publicación validada.' });
  } catch (err) {
    next(err);
  }
});

router.post('/stop', (req, res) => {
  res.json({ success: true, message: 'Stop recibido.' });
});

router.post('/execute', async (req, res, next) => {
  try {
    const body = req.body || {};
    const inArgs = mergeInArguments(body.inArguments || body.arguments?.execute?.inArguments || []);
    const config = normalizeConfig(inArgs.config || {});

    const contactKey = inArgs.contactKey || body.keyValue || body.contactKey || '';
    const emailAddress = inArgs.emailAddress || inArgs.to || config.emailAddress || '';
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