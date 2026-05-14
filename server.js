import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const APPLICATION_EXTENSION_KEY = process.env.APPLICATION_EXTENSION_KEY || process.env.SFMC_APPLICATION_EXTENSION_KEY || '';
const APP_VERSION = '2026-05-13-restdecision-category-icon-v19';
const CUSTOM_ACTIVITY_CATEGORY = (process.env.CUSTOM_ACTIVITY_CATEGORY || 'message').trim() || 'message';

function numberFromEnv(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
}

/*
  BITMessage / Fundació BIT

  Endpoint real según documentación:
  https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send

  Nota: en algunos documentos el path aparece partido como "envios/ mensaje/send".
  La URL no debe contener espacios.
*/
const BITMESSAGE_API_URL = (
  process.env.BITMESSAGE_API_URL ||
  process.env.EXTERNAL_API_URL ||
  'https://bitmessage.fundaciobit.org/bitmessage/api/v1/envios/mensaje/send'
).trim();

const BITMESSAGE_CAMPANYA_REFERENCIA = (process.env.BITMESSAGE_CAMPANYA_REFERENCIA || '').trim();

/*
  Timeout de Journey Builder frente a timeout del proveedor.

  La Custom Activity debe contestar a Journey Builder antes de que venza
  arguments.execute.timeout. Por eso el timeout hacia BITMessage se mantiene
  por debajo del timeout de ejecución de SFMC.

  Valores recomendados:
  SFMC_EXECUTE_TIMEOUT_MS=60000
  BITMESSAGE_API_TIMEOUT_MS=25000
*/
const SFMC_EXECUTE_TIMEOUT_MS = numberFromEnv(process.env.SFMC_EXECUTE_TIMEOUT_MS, 60000);
const SFMC_EXECUTE_RETRY_COUNT = Math.max(0, Math.floor(numberFromEnv(process.env.SFMC_EXECUTE_RETRY_COUNT, 0)));
const SFMC_EXECUTE_RETRY_DELAY_MS = numberFromEnv(process.env.SFMC_EXECUTE_RETRY_DELAY_MS, 5000);

const RAW_BITMESSAGE_API_TIMEOUT_MS = numberFromEnv(
  process.env.BITMESSAGE_API_TIMEOUT_MS || process.env.EXTERNAL_API_TIMEOUT_MS,
  25000
);

const BITMESSAGE_API_TIMEOUT_MS = Math.min(
  RAW_BITMESSAGE_API_TIMEOUT_MS,
  Math.max(1000, SFMC_EXECUTE_TIMEOUT_MS - 5000)
);

/*
  Autenticación configurable porque la documentación recibida solo indica
  "usuario autorizado", pero no especifica el mecanismo exacto.

  Valores soportados:
  - none
  - basic
  - bearer
  - custom

  Para basic:
  BITMESSAGE_AUTH_TYPE=basic
  BITMESSAGE_USERNAME=usuario
  BITMESSAGE_PASSWORD=password

  Para bearer:
  BITMESSAGE_AUTH_TYPE=bearer
  BITMESSAGE_API_KEY=token

  Para custom:
  BITMESSAGE_AUTH_TYPE=custom
  BITMESSAGE_AUTH_HEADER_NAME=X-API-Key
  BITMESSAGE_AUTH_HEADER_VALUE=valor
*/
const BITMESSAGE_AUTH_TYPE = (
  process.env.BITMESSAGE_AUTH_TYPE ||
  (process.env.BITMESSAGE_USERNAME && process.env.BITMESSAGE_PASSWORD ? 'basic' : '') ||
  (process.env.BITMESSAGE_API_KEY || process.env.EXTERNAL_API_KEY ? 'bearer' : '') ||
  'none'
).toLowerCase();

const BITMESSAGE_USERNAME = process.env.BITMESSAGE_USERNAME || '';
const BITMESSAGE_PASSWORD = process.env.BITMESSAGE_PASSWORD || '';
const BITMESSAGE_API_KEY = process.env.BITMESSAGE_API_KEY || process.env.EXTERNAL_API_KEY || '';
const BITMESSAGE_AUTH_HEADER_NAME = process.env.BITMESSAGE_AUTH_HEADER_NAME || '';
const BITMESSAGE_AUTH_HEADER_VALUE = process.env.BITMESSAGE_AUTH_HEADER_VALUE || '';

// =========================
// Debug / observabilidad
// =========================
//
// Estas opciones están pensadas para diagnosticar el enrutado real en Journey Builder.
// No se registran credenciales ni headers de Authorization.
const DEBUG_EXECUTE_LOGS = String(process.env.DEBUG_EXECUTE_LOGS || 'true').toLowerCase() !== 'false';
const DEBUG_LOG_FULL_MESSAGE = String(process.env.DEBUG_LOG_FULL_MESSAGE || 'true').toLowerCase() === 'true';
const DEBUG_LOG_FULL_PROVIDER_RESPONSE = String(process.env.DEBUG_LOG_FULL_PROVIDER_RESPONSE || 'true').toLowerCase() === 'true';
const DEBUG_LOG_FULL_SFMC_PAYLOAD = String(process.env.DEBUG_LOG_FULL_SFMC_PAYLOAD || 'false').toLowerCase() === 'true';
const DEBUG_ACCESS_TOKEN = process.env.DEBUG_ACCESS_TOKEN || '';
const DEBUG_MAX_EXECUTIONS = Math.max(1, Math.floor(numberFromEnv(process.env.DEBUG_MAX_EXECUTIONS, 50)));
const DEBUG_FORCE_BITMESSAGE_RESULT = String(process.env.DEBUG_FORCE_BITMESSAGE_RESULT || '').trim().toLowerCase();
// Valores soportados para DEBUG_FORCE_BITMESSAGE_RESULT: '', timeout, error, sent
const executionDebugStore = [];

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sha256Short(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function safeLogMessage(message) {
  const text = String(message || '');
  if (DEBUG_LOG_FULL_MESSAGE) {
    return text;
  }

  return {
    preview: truncate(text, 80),
    length: text.length,
    sha256: sha256Short(text)
  };
}

function safeProviderResponse(responseText) {
  const text = String(responseText || '');
  if (DEBUG_LOG_FULL_PROVIDER_RESPONSE) {
    return truncate(text, 3900);
  }

  return {
    preview: truncate(text, 250),
    length: text.length,
    sha256: sha256Short(text)
  };
}

function safeSfmcPayload(payload) {
  if (DEBUG_LOG_FULL_SFMC_PAYLOAD) {
    return payload;
  }

  const args = mergeInArguments(payload?.inArguments || payload?.arguments?.execute?.inArguments || []);
  return {
    keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    hasInArguments: Boolean(payload?.inArguments || payload?.arguments?.execute?.inArguments),
    inArguments: {
      contactKey: args.contactKey || '',
      to: args.to || '',
      campanyaReferencia: args.campanyaReferencia || '',
      message: safeLogMessage(args.message)
    }
  };
}

function debugLog(eventName, data = {}) {
  if (!DEBUG_EXECUTE_LOGS) return;

  const logPayload = {
    ts: new Date().toISOString(),
    appVersion: APP_VERSION,
    event: eventName,
    ...data
  };

  console.log(`[debug:${eventName}] ${stableStringify(logPayload)}`);
}

function saveExecutionTrace(trace) {
  executionDebugStore.unshift({
    ...trace,
    updatedAt: new Date().toISOString()
  });

  while (executionDebugStore.length > DEBUG_MAX_EXECUTIONS) {
    executionDebugStore.pop();
  }
}

function updateExecutionTrace(requestId, patch) {
  const existing = executionDebugStore.find((item) => item.requestId === requestId);
  if (!existing) {
    saveExecutionTrace({
      requestId,
      ...patch
    });
    return;
  }

  Object.assign(existing, patch, {
    updatedAt: new Date().toISOString()
  });
}

function assertDebugAccess(req, res) {
  if (!DEBUG_ACCESS_TOKEN) {
    res.status(403).json({
      success: false,
      error: 'DEBUG_ACCESS_TOKEN_NOT_CONFIGURED',
      message: 'Configura DEBUG_ACCESS_TOKEN en Render para consultar este endpoint.'
    });
    return false;
  }

  const providedToken = req.get('x-debug-token') || req.query.token || '';
  if (providedToken !== DEBUG_ACCESS_TOKEN) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_DEBUG_ACCESS'
    });
    return false;
  }

  return true;
}


app.disable('x-powered-by');

// Servimos Postmonger desde el mismo dominio para evitar bloqueos de CDNs externos dentro del iframe de Journey Builder.
app.get('/vendor/postmonger.js', (req, res) => {
  try {
    const resolvedPath = require.resolve('postmonger');
    return res
      .type('application/javascript')
      .set('Cache-Control', 'public, max-age=86400')
      .sendFile(resolvedPath);
  } catch (error) {
    const candidatePaths = [
      path.join(__dirname, 'node_modules', 'postmonger', 'postmonger.js'),
      path.join(__dirname, 'node_modules', 'postmonger', 'dist', 'postmonger.js'),
      path.join(__dirname, 'node_modules', 'postmonger', 'dist', 'postmonger.min.js'),
      path.join(__dirname, 'node_modules', 'postmonger', 'lib', 'postmonger.js')
    ];

    const existingPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
    if (existingPath) {
      return res
        .type('application/javascript')
        .set('Cache-Control', 'public, max-age=86400')
        .sendFile(existingPath);
    }

    return res
      .status(500)
      .type('application/javascript')
      .send('console.error("No se encontró el paquete postmonger. Ejecuta npm install y redeploy.");');
  }
});

// Render/SFMC health check.
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'sfmc-bitmessage-custom-activity',
    version: APP_VERSION,
    provider: 'BITMessage Fundacio BIT',
    baseUrl: BASE_URL,
    nodeEnv: process.env.NODE_ENV || '',
    timestamp: new Date().toISOString()
  });
});

app.get('/debug/version', (req, res) => {
  res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json({
      version: APP_VERSION,
      type: 'RestDecision',
      category: CUSTOM_ACTIVITY_CATEGORY,
      executeUseJwt: true,
      executeResponseFormat: 'top-level-json',
      routingContract: 'official-RestDecision-top-level-branchResult',
      keyFix: 'UI no reescribe outcomes; se dejan intactos los vínculos internos del canvas',
      branchResultValues: {
        sent: 'sent',
        notSent: 'notSent'
      },
      visualTopBranch: 'Enviado / branchResult sent',
      visualBottomBranch: 'No enviado / branchResult notSent',
      timeoutBranch: 'No enviado / branchResult notSent',
      applicationExtensionKeyConfigured: Boolean(APPLICATION_EXTENSION_KEY),
      debug: {
        executeLogs: DEBUG_EXECUTE_LOGS,
        logFullMessage: DEBUG_LOG_FULL_MESSAGE,
        logFullProviderResponse: DEBUG_LOG_FULL_PROVIDER_RESPONSE,
        logFullSfmcPayload: DEBUG_LOG_FULL_SFMC_PAYLOAD,
        hasDebugAccessToken: Boolean(DEBUG_ACCESS_TOKEN),
        maxExecutionsStored: DEBUG_MAX_EXECUTIONS,
        forceBitmessageResult: DEBUG_FORCE_BITMESSAGE_RESULT || ''
      },
      timestamp: new Date().toISOString()
    });
});

// Ruta explícita para Journey Builder. Evita ambigüedad con `/` en iframes.
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ui', (req, res) => {
  res.redirect('/index.html');
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html']
}));

function buildConfig() {
  /*
    RestDecision contract used intentionally:

    - outcomes[].arguments.branchResult are strings.
    - /execute returns the same string at top level: { "branchResult": "sent" | "notSent" }.
    - The UI must not rewrite outcomes when the activity is saved. Journey Builder owns
      the canvas connections for each outcome.

    Visual order:
    1. Enviado
    2. No enviado
  */
  return {
    workflowApiVersion: '1.1',
    type: 'RestDecision',
    metaData: {
      icon: `${BASE_URL}/images/icon.png?v=19`,
      iconSmall: `${BASE_URL}/images/icon.png?v=19`,
      category: CUSTOM_ACTIVITY_CATEGORY,
      isConfigured: false
    },
    lang: {
      'es-ES': {
        name: 'BitMessage',
        description: 'Envía un SMS con BITMessage/Fundació BIT y enruta el contacto según el resultado.'
      },
      'en-US': {
        name: 'BitMessage',
        description: 'Sends an SMS through BITMessage/Fundacio BIT and routes the contact based on the result.'
      }
    },
    userInterfaces: {
      configModal: {
        url: `${BASE_URL}/index.html`,
        height: 760,
        width: 1000,
        fullscreen: false
      }
    },
    arguments: {
      execute: {
        inArguments: [
          { contactKey: '{{Contact.Key}}' },
          { to: '' },
          { message: '' },
          { campanyaReferencia: '' }
        ],
        outArguments: [
          { branchResult: '' },
          { messageStatus: '' },
          { providerMessageId: '' },
          { providerOperatorCode: '' },
          { errorCode: '' },
          { errorMessage: '' },
          { providerResponse: '' },
          { phoneSent: '' },
          { campaignReference: '' },
          { sentAt: '' },
          { debugRequestId: '' }
        ],
        url: `${BASE_URL}/execute`,
        verb: 'POST',
        body: '',
        header: '',
        format: 'json',
        useJwt: true,
        timeout: SFMC_EXECUTE_TIMEOUT_MS,
        retryCount: SFMC_EXECUTE_RETRY_COUNT,
        retryDelay: SFMC_EXECUTE_RETRY_DELAY_MS
      }
    },
    configurationArguments: {
      applicationExtensionKey: APPLICATION_EXTENSION_KEY || undefined,
      save: {
        url: `${BASE_URL}/save`,
        verb: 'POST',
        useJwt: false,
        body: '',
        header: ''
      },
      validate: {
        url: `${BASE_URL}/validate`,
        verb: 'POST',
        useJwt: false,
        body: '',
        header: ''
      },
      publish: {
        url: `${BASE_URL}/publish`,
        verb: 'POST',
        useJwt: false,
        body: '',
        header: ''
      },
      stop: {
        url: `${BASE_URL}/stop`,
        verb: 'POST',
        useJwt: false,
        body: '',
        header: ''
      }
    },
    outcomes: [
      {
        arguments: {
          branchResult: 'sent'
        },
        metaData: {
          label: 'Enviado'
        }
      },
      {
        arguments: {
          branchResult: 'notSent'
        },
        metaData: {
          label: 'No enviado'
        }
      }
    ],
    wizardSteps: [
      {
        label: 'Configurar mensaje',
        key: 'messageConfig'
      }
    ],
    schema: {
      arguments: {
        execute: {
          inArguments: [
            {
              contactKey: {
                dataType: 'Text',
                isNullable: false,
                direction: 'in'
              },
              to: {
                dataType: 'Text',
                isNullable: false,
                direction: 'in'
              },
              message: {
                dataType: 'Text',
                isNullable: false,
                direction: 'in'
              },
              campanyaReferencia: {
                dataType: 'Text',
                isNullable: false,
                direction: 'in'
              }
            }
          ],
          outArguments: [
            {
              branchResult: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              messageStatus: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              providerMessageId: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              providerOperatorCode: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              errorCode: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              errorMessage: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              providerResponse: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              phoneSent: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              campaignReference: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              sentAt: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            },
            {
              debugRequestId: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              }
            }
          ]
        }
      }
    }
  };
}

app.get('/config.json', (req, res) => {
  res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .send(JSON.stringify(buildConfig(), null, 2));
});

app.get('/debug/routing-contract', (req, res) => {
  const config = buildConfig();
  const notSent = buildExecuteResponse('notSent', {
    messageStatus: 'ERROR',
    errorCode: 'TIMEOUT',
    errorMessage: 'Ejemplo de timeout: debe ir por No enviado.',
    phoneSent: '34644614672',
    campaignReference: 'PRE-IBSALUT',
    sentAt: new Date().toISOString(),
    debugRequestId: 'sample-timeout'
  });
  const sent = buildExecuteResponse('sent', {
    messageStatus: 'ENVIADO',
    providerMessageId: 'sample-id',
    providerOperatorCode: 'sample-operator-code',
    phoneSent: '34644614672',
    campaignReference: 'PRE-IBSALUT',
    sentAt: new Date().toISOString(),
    debugRequestId: 'sample-sent'
  });

  res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json({
      version: APP_VERSION,
      type: config.type,
      officialContract: 'RestDecision + outcomes[].arguments.branchResult + execute response { branchResult: value }',
      outcomes: config.outcomes,
      executeUseJwt: config.arguments.execute.useJwt,
      executeUrl: config.arguments.execute.url,
      expectedTimeoutResponse: notSent,
      expectedSentResponse: sent
    });
});

app.get('/debug/config', (req, res) => {
  res
    .type('text/plain')
    .send([
      `APP_VERSION=${APP_VERSION}`,
      `activity.type=RestDecision`,
      `routing.outcomeLabels=Enviado,No enviado`,
      `routing.branchResult.sent=sent`,
      `routing.branchResult.notSent=notSent`,
      `BASE_URL=${BASE_URL}`,
      `configModal.url=${BASE_URL}/index.html`,
      `execute.url=${BASE_URL}/execute`,
      `execute.useJwt=true`,
      `execute.responseFormat=top-level-json branchResult=sent|notSent`,
      `applicationExtensionKey.configured=${Boolean(APPLICATION_EXTENSION_KEY)}`,
      `provider=BITMessage Fundacio BIT`,
      `sfmc.executeTimeoutMs=${SFMC_EXECUTE_TIMEOUT_MS}`,
      `sfmc.executeRetryCount=${SFMC_EXECUTE_RETRY_COUNT}`,
      `sfmc.executeRetryDelayMs=${SFMC_EXECUTE_RETRY_DELAY_MS}`,
      `bitmessage.url=${BITMESSAGE_API_URL}`,
      `bitmessage.rawTimeoutMs=${RAW_BITMESSAGE_API_TIMEOUT_MS}`,
      `bitmessage.effectiveTimeoutMs=${BITMESSAGE_API_TIMEOUT_MS}`,
      `bitmessage.authType=${BITMESSAGE_AUTH_TYPE}`,
      `bitmessage.hasUsername=${Boolean(BITMESSAGE_USERNAME)}`,
      `bitmessage.hasPassword=${Boolean(BITMESSAGE_PASSWORD)}`,
      `bitmessage.hasApiKey=${Boolean(BITMESSAGE_API_KEY)}`,
      `bitmessage.hasCustomHeaderName=${Boolean(BITMESSAGE_AUTH_HEADER_NAME)}`,
      `bitmessage.hasCustomHeaderValue=${Boolean(BITMESSAGE_AUTH_HEADER_VALUE)}`,
      `bitmessage.hasDefaultCampanyaReferencia=${Boolean(BITMESSAGE_CAMPANYA_REFERENCIA)}`,
      `has.JWT_SECRET=${Boolean(JWT_SECRET)}`,
      `DEBUG_EXECUTE_LOGS=${DEBUG_EXECUTE_LOGS}`,
      `DEBUG_LOG_FULL_MESSAGE=${DEBUG_LOG_FULL_MESSAGE}`,
      `DEBUG_LOG_FULL_PROVIDER_RESPONSE=${DEBUG_LOG_FULL_PROVIDER_RESPONSE}`,
      `DEBUG_LOG_FULL_SFMC_PAYLOAD=${DEBUG_LOG_FULL_SFMC_PAYLOAD}`,
      `DEBUG_FORCE_BITMESSAGE_RESULT=${DEBUG_FORCE_BITMESSAGE_RESULT || ''}`,
      `DEBUG_ACCESS_TOKEN.configured=${Boolean(DEBUG_ACCESS_TOKEN)}`,
      `NODE_ENV=${process.env.NODE_ENV || ''}`
    ].join('\n'));
});


app.get('/debug/executions', (req, res) => {
  if (!assertDebugAccess(req, res)) return;

  res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json({
      success: true,
      count: executionDebugStore.length,
      executions: executionDebugStore
    });
});

app.get('/debug/executions/:requestId', (req, res) => {
  if (!assertDebugAccess(req, res)) return;

  const execution = executionDebugStore.find((item) => item.requestId === req.params.requestId);
  if (!execution) {
    return res.status(404).json({
      success: false,
      error: 'EXECUTION_NOT_FOUND',
      requestId: req.params.requestId
    });
  }

  return res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json({
      success: true,
      execution
    });
});

app.get('/debug/sample-execute-response', (req, res) => {
  const branch = ['sent', 'enviado'].includes(String(req.query.branch || 'notSent')) ? 'sent' : 'notSent';

  const sample = buildExecuteResponse(branch, branch === 'sent'
    ? {
        messageStatus: 'ENVIADO',
        providerMessageId: 'sample-id',
        providerOperatorCode: 'sample-operator-code',
        phoneSent: '34644614672',
        campaignReference: 'PRE-IBSALUT',
        sentAt: new Date().toISOString()
      }
    : {
        messageStatus: 'ERROR',
        errorCode: 'TIMEOUT',
        errorMessage: 'Respuesta de ejemplo para probar que branchResult se devuelve correctamente.',
        phoneSent: '34644614672',
        campaignReference: 'PRE-IBSALUT',
        sentAt: new Date().toISOString()
      });

  res
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .send(JSON.stringify(sample, null, 2));
});

const rawBodyParser = express.text({
  type: '*/*',
  limit: '2mb'
});

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeJwtOrPlainPayload(rawBody, options = {}) {
  const {
    allowUnsignedJson = false,
    allowInvalidJwt = false
  } = options;

  const trimmed = String(rawBody || '').trim();
  const parsed = parseMaybeJson(trimmed);

  let token = null;
  if (parsed && typeof parsed === 'object') {
    token = parsed.jwt || parsed.JWT || parsed.token || null;
  }

  if (!token && trimmed && trimmed.split('.').length === 3) {
    token = trimmed;
  }

  if (token) {
    if (!JWT_SECRET) {
      if (allowInvalidJwt) {
        return parsed || {};
      }

      throw new Error('JWT_SECRET no está configurado en el servidor.');
    }

    try {
      return jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256']
      });
    } catch (error) {
      if (allowInvalidJwt) {
        return parsed || {};
      }

      throw new Error(`JWT inválido o firmado con otro secret: ${error.message}`);
    }
  }

  /*
    Permite pruebas locales con payload JSON sin JWT.
    En producción, /execute mantiene JWT obligatorio.
    Los endpoints de configuración (/save, /validate, /publish, /stop)
    pueden aceptar JSON sin JWT porque Journey Builder puede validarlos
    antes de que el JWT_SECRET esté corregido en Render.
  */
  if ((process.env.NODE_ENV !== 'production' || allowUnsignedJson) && parsed) {
    return parsed;
  }

  if (allowInvalidJwt) {
    return parsed || {};
  }

  throw new Error('No se recibió JWT válido desde Journey Builder.');
}

function decodeConfigurationPayload(rawBody) {
  try {
    return {
      payload: decodeJwtOrPlainPayload(rawBody, {
        allowUnsignedJson: true,
        allowInvalidJwt: true
      }),
      warning: ''
    };
  } catch (error) {
    return {
      payload: {},
      warning: error.message
    };
  }
}

function mergeInArguments(inArguments = []) {
  return inArguments.reduce((acc, item) => {
    if (item && typeof item === 'object') {
      Object.assign(acc, item);
    }
    return acc;
  }, {});
}

function truncate(value, maxLength = 3900) {
  const text = value == null ? '' : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeTelefono(value) {
  let telefono = String(value || '').trim();

  // Eliminamos espacios, guiones, paréntesis y otros separadores habituales.
  // Conservamos '+' solo si viene al inicio para convertirlo a formato 00.
  telefono = telefono.replace(/[^\d+]/g, '');

  if (telefono.startsWith('+')) {
    telefono = `00${telefono.slice(1)}`;
  }

  telefono = telefono.replace(/[^\d]/g, '');

  // Si llega un móvil/teléfono español de 9 dígitos sin prefijo, añadimos 34.
  // Ejemplo: 654162543 -> 34654162543
  if (/^[679]\d{8}$/.test(telefono)) {
    telefono = `34${telefono}`;
  }

  return telefono;
}

function isValidBitmessageTelefono(telefono) {
  if (!/^\d+$/.test(telefono)) return false;

  // España: 34 + número. Internacional: 00 + prefijo internacional + número.
  return telefono.startsWith('34') || telefono.startsWith('00');
}

function getBitmessageAuthHeaders() {
  switch (BITMESSAGE_AUTH_TYPE) {
    case 'none':
      return {};

    case 'basic': {
      if (!BITMESSAGE_USERNAME || !BITMESSAGE_PASSWORD) {
        const error = new Error('BITMESSAGE_AUTH_TYPE=basic requiere BITMESSAGE_USERNAME y BITMESSAGE_PASSWORD.');
        error.code = 'AUTH_CONFIG_ERROR';
        throw error;
      }

      const credentials = Buffer.from(`${BITMESSAGE_USERNAME}:${BITMESSAGE_PASSWORD}`).toString('base64');
      return {
        Authorization: `Basic ${credentials}`
      };
    }

    case 'bearer': {
      if (!BITMESSAGE_API_KEY) {
        const error = new Error('BITMESSAGE_AUTH_TYPE=bearer requiere BITMESSAGE_API_KEY.');
        error.code = 'AUTH_CONFIG_ERROR';
        throw error;
      }

      return {
        Authorization: `Bearer ${BITMESSAGE_API_KEY}`
      };
    }

    case 'custom': {
      if (!BITMESSAGE_AUTH_HEADER_NAME || !BITMESSAGE_AUTH_HEADER_VALUE) {
        const error = new Error('BITMESSAGE_AUTH_TYPE=custom requiere BITMESSAGE_AUTH_HEADER_NAME y BITMESSAGE_AUTH_HEADER_VALUE.');
        error.code = 'AUTH_CONFIG_ERROR';
        throw error;
      }

      return {
        [BITMESSAGE_AUTH_HEADER_NAME]: BITMESSAGE_AUTH_HEADER_VALUE
      };
    }

    default: {
      const error = new Error(`BITMESSAGE_AUTH_TYPE no soportado: ${BITMESSAGE_AUTH_TYPE}. Usa none, basic, bearer o custom.`);
      error.code = 'AUTH_CONFIG_ERROR';
      throw error;
    }
  }
}

function validateServerConfiguration() {
  const errors = [];

  if (!BITMESSAGE_API_URL) {
    errors.push('BITMESSAGE_API_URL no está configurado.');
  }

  if (BITMESSAGE_AUTH_TYPE === 'basic' && (!BITMESSAGE_USERNAME || !BITMESSAGE_PASSWORD)) {
    errors.push('BITMESSAGE_AUTH_TYPE=basic requiere BITMESSAGE_USERNAME y BITMESSAGE_PASSWORD.');
  }

  if (BITMESSAGE_AUTH_TYPE === 'bearer' && !BITMESSAGE_API_KEY) {
    errors.push('BITMESSAGE_AUTH_TYPE=bearer requiere BITMESSAGE_API_KEY.');
  }

  if (BITMESSAGE_AUTH_TYPE === 'custom' && (!BITMESSAGE_AUTH_HEADER_NAME || !BITMESSAGE_AUTH_HEADER_VALUE)) {
    errors.push('BITMESSAGE_AUTH_TYPE=custom requiere BITMESSAGE_AUTH_HEADER_NAME y BITMESSAGE_AUTH_HEADER_VALUE.');
  }

  return errors;
}

function normalizeRoutingKey(value) {
  const cleanValue = String(value || '').trim().toLowerCase();

  if (value === true || ['true', 'sent', 'enviado', 'enviada', 'enviado_ok', 'ok', 'enviado_correcto', 'enviado_correctamente', 'enviado/success', 'success', 'enviado-confirmado', 'confirmado', 'enviado_confirmado', 'enviado / confirmado', 'enviado o confirmado', 'enviado_confirmado'].includes(cleanValue)) {
    return 'sent';
  }

  if (['enviado', 'confirmado'].includes(String(value || '').trim().toUpperCase())) {
    return 'sent';
  }

  return 'notSent';
}

function branchResultBooleanFromRoutingKey(routingKey) {
  return routingKey === 'sent';
}

function buildExecuteResponse(branchResult, values = {}) {
  /*
    Routing contract:
    sent    => Enviado
    notSent => No enviado

    No boolean, no numeric values. Journey Builder compares this string against
    outcomes[].arguments.branchResult.
  */
  const routingKey = normalizeRoutingKey(branchResult);
  const branchResultValue = routingKey === 'sent' ? 'sent' : 'notSent';

  return {
    branchResult: branchResultValue,
    messageStatus: values.messageStatus || (routingKey === 'sent' ? 'ENVIADO' : 'ERROR'),
    providerMessageId: values.providerMessageId || '',
    providerOperatorCode: values.providerOperatorCode || '',
    errorCode: values.errorCode || '',
    errorMessage: values.errorMessage || '',
    providerResponse: values.providerResponse || '',
    phoneSent: values.phoneSent || '',
    campaignReference: values.campaignReference || '',
    sentAt: values.sentAt || new Date().toISOString(),
    debugRequestId: values.debugRequestId || ''
  };
}

function sendExecuteResponse(res, payload, reason = '') {
  const responsePayload = {
    ...payload
  };

  const debugSummary = {
    appVersion: APP_VERSION,
    responseFormat: 'official-restdecision-top-level-json',
    httpStatusReturnedToSfmc: 200,
    contentTypeReturnedToSfmc: 'application/json',
    branchResult: responsePayload.branchResult,
    messageStatus: responsePayload.messageStatus,
    errorCode: responsePayload.errorCode,
    reason,
    sfmcResponsePayload: responsePayload
  };

  console.log('[execute-response]', JSON.stringify(debugSummary));
  debugLog('sfmc-response', debugSummary);

  if (responsePayload.debugRequestId) {
    updateExecutionTrace(responsePayload.debugRequestId, {
      sfmcResponse: debugSummary,
      completedAt: new Date().toISOString()
    });
  }

  return res
    .status(200)
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json(responsePayload);
}

function providerErrorPayload(error, fallbackCode = 'BITMESSAGE_ERROR') {
  return buildExecuteResponse('notSent', {
    messageStatus: error.providerStatus || 'ERROR',
    providerMessageId: error.providerMessageId || '',
    providerOperatorCode: error.providerOperatorCode || '',
    errorCode: error.code || fallbackCode,
    errorMessage: truncate(error.message || 'Error desconocido al enviar el mensaje.'),
    providerResponse: truncate(error.providerResponse || ''),
    phoneSent: error.phoneSent || '',
    campaignReference: error.campaignReference || '',
    sentAt: new Date().toISOString(),
    debugRequestId: error.debugRequestId || ''
  });
}

async function sendBitmessage({ to, message, campanyaReferencia, debugRequestId }) {
  if (!BITMESSAGE_API_URL) {
    const error = new Error('BITMESSAGE_API_URL no está configurado.');
    error.code = 'CONFIG_ERROR';
    throw error;
  }

  const telefono = normalizeTelefono(to);

  if (!telefono) {
    const error = new Error('El campo destino/teléfono llegó vacío después de normalizarlo.');
    error.code = 'MISSING_TELEFONO';
    throw error;
  }

  if (!isValidBitmessageTelefono(telefono)) {
    const error = new Error('El teléfono debe empezar por 34 para España o por 00 para teléfonos internacionales.');
    error.code = 'INVALID_TELEFONO';
    error.phoneSent = telefono;
    throw error;
  }

  const texto = String(message || '').trim();
  if (!texto) {
    const error = new Error('El texto del mensaje llegó vacío.');
    error.code = 'MISSING_TEXTO';
    error.phoneSent = telefono;
    throw error;
  }

  const campaignReference = String(campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim();
  if (!campaignReference) {
    const error = new Error('La referencia de campaña de BITMessage es obligatoria.');
    error.code = 'MISSING_CAMPANYA_REFERENCIA';
    error.phoneSent = telefono;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BITMESSAGE_API_TIMEOUT_MS);

  const requestBody = {
    telefono,
    texto,
    campanyaReferencia: campaignReference
  };

  const providerRequestDebug = {
    requestId: debugRequestId,
    method: 'POST',
    url: BITMESSAGE_API_URL,
    timeoutMs: BITMESSAGE_API_TIMEOUT_MS,
    authType: BITMESSAGE_AUTH_TYPE,
    hasAuthorizationHeader: BITMESSAGE_AUTH_TYPE !== 'none',
    body: {
      telefono,
      texto: safeLogMessage(texto),
      textoLength: texto.length,
      campanyaReferencia: campaignReference
    }
  };

  debugLog('bitmessage-request', providerRequestDebug);
  if (debugRequestId) {
    updateExecutionTrace(debugRequestId, {
      bitmessageRequest: providerRequestDebug
    });
  }

  if (DEBUG_FORCE_BITMESSAGE_RESULT) {
    debugLog('bitmessage-forced-result', {
      requestId: debugRequestId,
      forcedResult: DEBUG_FORCE_BITMESSAGE_RESULT
    });

    if (DEBUG_FORCE_BITMESSAGE_RESULT === 'timeout') {
      const timeoutError = new Error(`Timeout simulado llamando a BITMessage después de ${BITMESSAGE_API_TIMEOUT_MS} ms.`);
      timeoutError.code = 'TIMEOUT';
      timeoutError.phoneSent = telefono;
      timeoutError.campaignReference = campaignReference;
      throw timeoutError;
    }

    if (DEBUG_FORCE_BITMESSAGE_RESULT === 'error') {
      const responseBody = {
        telefono,
        texto,
        estado: 'ERROR',
        infoError: 'DEBUG_FORCED_ERROR',
        campanyaReferencia: campaignReference
      };
      const responseText = JSON.stringify(responseBody);
      const forcedError = new Error('Error simulado de BITMessage.');
      forcedError.code = 'DEBUG_FORCED_ERROR';
      forcedError.providerStatus = 'ERROR';
      forcedError.providerResponse = responseText;
      forcedError.phoneSent = telefono;
      forcedError.campaignReference = campaignReference;
      debugLog('bitmessage-response', {
        requestId: debugRequestId,
        forced: true,
        httpStatus: 200,
        ok: true,
        estado: 'ERROR',
        infoError: 'DEBUG_FORCED_ERROR',
        responseBody
      });
      throw forcedError;
    }

    if (DEBUG_FORCE_BITMESSAGE_RESULT === 'sent') {
      const responseBody = {
        id: 'debug-sent-id',
        codigoExternoOperadora: 'debug-operator-code',
        fechaEnvio: new Date().toISOString(),
        telefono,
        texto,
        estado: 'ENVIADO',
        campanyaReferencia: campaignReference
      };
      const responseText = JSON.stringify(responseBody);
      debugLog('bitmessage-response', {
        requestId: debugRequestId,
        forced: true,
        httpStatus: 200,
        ok: true,
        estado: 'ENVIADO',
        responseBody
      });
      return {
        providerMessageId: 'debug-sent-id',
        providerOperatorCode: 'debug-operator-code',
        providerStatus: 'ENVIADO',
        providerResponse: responseText,
        phoneSent: telefono,
        campaignReference,
        sentAt: responseBody.fechaEnvio
      };
    }
  }

  const providerStart = Date.now();

  try {
    const response = await fetch(BITMESSAGE_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getBitmessageAuthHeaders()
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const responseText = await response.text();

    let responseBody = {};
    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseBody = { raw: responseText };
    }

    const providerElapsedMs = Date.now() - providerStart;
    const estadoDebug = String(responseBody.estado || '').toUpperCase();
    const providerResponseDebug = {
      requestId: debugRequestId,
      httpStatus: response.status,
      ok: response.ok,
      elapsedMs: providerElapsedMs,
      estado: estadoDebug || '',
      infoError: responseBody.infoError || '',
      responseBody,
      responseText: safeProviderResponse(responseText)
    };

    debugLog('bitmessage-response', providerResponseDebug);
    if (debugRequestId) {
      updateExecutionTrace(debugRequestId, {
        bitmessageResponse: providerResponseDebug
      });
    }

    if (!response.ok) {
      const error = new Error(
        responseBody.message ||
        responseBody.error_description ||
        responseBody.error ||
        `BITMessage respondió HTTP ${response.status}.`
      );
      error.code = `HTTP_${response.status}`;
      error.providerResponse = responseText;
      error.phoneSent = telefono;
      error.campaignReference = campaignReference;
      throw error;
    }

    /*
      BITMessage devuelve HTTP 200 tanto para enviados como para errores funcionales.
      Por eso no basta con response.ok: hay que revisar el campo estado.
    */
    const estado = String(responseBody.estado || '').toUpperCase();

    if (estado === 'ERROR') {
      const error = new Error(responseBody.infoError || 'BITMessage devolvió estado ERROR.');
      error.code = responseBody.infoError || 'BITMESSAGE_ESTADO_ERROR';
      error.providerStatus = 'ERROR';
      error.providerMessageId = responseBody.id ? String(responseBody.id) : '';
      error.providerOperatorCode = responseBody.codigoExternoOperadora || '';
      error.providerResponse = responseText;
      error.phoneSent = responseBody.telefono || telefono;
      error.campaignReference = responseBody.campanyaReferencia || campaignReference;
      throw error;
    }

    if (estado && !['ENVIADO', 'CONFIRMADO'].includes(estado)) {
      const error = new Error(`BITMessage devolvió un estado no esperado: ${estado}.`);
      error.code = 'BITMESSAGE_ESTADO_NO_ESPERADO';
      error.providerStatus = estado;
      error.providerMessageId = responseBody.id ? String(responseBody.id) : '';
      error.providerOperatorCode = responseBody.codigoExternoOperadora || '';
      error.providerResponse = responseText;
      error.phoneSent = responseBody.telefono || telefono;
      error.campaignReference = responseBody.campanyaReferencia || campaignReference;
      throw error;
    }

    if (!estado) {
      const error = new Error('BITMessage no devolvió el campo estado en la respuesta.');
      error.code = 'BITMESSAGE_RESPUESTA_INVALIDA';
      error.providerResponse = responseText;
      error.phoneSent = telefono;
      error.campaignReference = campaignReference;
      throw error;
    }

    return {
      providerMessageId: responseBody.id ? String(responseBody.id) : '',
      providerOperatorCode: responseBody.codigoExternoOperadora || '',
      providerStatus: estado,
      providerResponse: responseText,
      phoneSent: responseBody.telefono || telefono,
      campaignReference: responseBody.campanyaReferencia || campaignReference,
      sentAt: responseBody.fechaEnvio || new Date().toISOString()
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Timeout llamando a BITMessage después de ${BITMESSAGE_API_TIMEOUT_MS} ms.`);
      timeoutError.code = 'TIMEOUT';
      timeoutError.phoneSent = telefono;
      timeoutError.campaignReference = campaignReference;

      const timeoutDebug = {
        requestId: debugRequestId,
        timeoutMs: BITMESSAGE_API_TIMEOUT_MS,
        elapsedMs: Date.now() - providerStart,
        errorCode: timeoutError.code,
        errorMessage: timeoutError.message
      };

      debugLog('bitmessage-timeout', timeoutDebug);
      if (debugRequestId) {
        updateExecutionTrace(debugRequestId, {
          bitmessageError: timeoutDebug
        });
      }

      throw timeoutError;
    }

    const errorDebug = {
      requestId: debugRequestId,
      elapsedMs: Date.now() - providerStart,
      errorCode: error.code || error.name || 'BITMESSAGE_ERROR',
      errorName: error.name || '',
      errorMessage: error.message || '',
      providerResponse: safeProviderResponse(error.providerResponse || '')
    };

    debugLog('bitmessage-error', errorDebug);
    if (debugRequestId) {
      updateExecutionTrace(debugRequestId, {
        bitmessageError: errorDebug
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/save', rawBodyParser, (req, res) => {
  const decoded = decodeConfigurationPayload(req.body);

  return res.status(200).json({
    success: true,
    warning: decoded.warning || undefined
  });
});

app.post('/validate', rawBodyParser, (req, res) => {
  const decoded = decodeConfigurationPayload(req.body);
  const payload = decoded.payload || {};
  const args = mergeInArguments(payload?.arguments?.execute?.inArguments || payload?.inArguments || []);
  const errors = [];

  /*
    No devolvemos HTTP 400 en /validate porque Journey Builder muestra el error
    genérico "publishes to a valid endpoint" y no enseña el detalle al usuario.
    La validación visible ya se hace en la UI antes de pulsar Done.
    Si falta configuración de BITMessage, /execute enviará el contacto por la rama No enviado
    con errorCode/errorMessage para poder auditarlo.
  */
  if (Object.keys(args).length) {
    if (!args.to) {
      errors.push('Selecciona el campo destino/teléfono.');
    }

    if (!args.message || !String(args.message).trim()) {
      errors.push('El mensaje no puede estar vacío.');
    }

    if (!String(args.campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim()) {
      errors.push('Indica la referencia de campaña de BITMessage.');
    }
  }

  return res.status(200).json({
    success: true,
    valid: errors.length === 0,
    errors,
    warning: decoded.warning || undefined
  });
});

app.post('/publish', rawBodyParser, (req, res) => {
  const decoded = decodeConfigurationPayload(req.body);

  return res.status(200).json({
    success: true,
    warning: decoded.warning || undefined
  });
});

app.post('/stop', rawBodyParser, (req, res) => {
  const decoded = decodeConfigurationPayload(req.body);

  return res.status(200).json({
    success: true,
    warning: decoded.warning || undefined
  });
});


function createExecuteResponder(res) {
  let responded = false;

  return {
    hasResponded() {
      return responded || res.headersSent;
    },
    send(payload, reason) {
      if (responded || res.headersSent) {
        console.warn('[execute-response-skipped]', JSON.stringify({
          appVersion: APP_VERSION,
          reason,
          branchResult: payload?.branchResult
        }));
        return;
      }

      responded = true;
      return sendExecuteResponse(res, payload, reason);
    }
  };
}

app.post('/execute', rawBodyParser, async (req, res) => {
  const executeStart = Date.now();
  const requestId = String(req.get('x-request-id') || randomUUID());
  const executeResponder = createExecuteResponder(res);

  saveExecutionTrace({
    requestId,
    startedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    path: '/execute',
    httpRequest: {
      method: req.method,
      contentType: req.get('content-type') || '',
      contentLength: req.get('content-length') || '',
      userAgent: req.get('user-agent') || '',
      sfmcRequestId: req.get('x-request-id') || ''
    },
    state: 'started'
  });

  debugLog('execute-start', {
    requestId,
    contentType: req.get('content-type') || '',
    contentLength: req.get('content-length') || '',
    executeTimeoutMs: SFMC_EXECUTE_TIMEOUT_MS,
    bitmessageTimeoutMs: BITMESSAGE_API_TIMEOUT_MS,
    forceBitmessageResult: DEBUG_FORCE_BITMESSAGE_RESULT || ''
  });

  /*
    Último cinturón de seguridad:
    Si por cualquier motivo el proceso tarda demasiado, respondemos antes a SFMC
    con No enviado. Así evitamos perder al contacto por Hard Error cuando Render
    sí recibió la llamada.
  */
  const safetyTimeoutMs = Math.max(1000, Math.min(SFMC_EXECUTE_TIMEOUT_MS - 5000, BITMESSAGE_API_TIMEOUT_MS + 2000));
  const safetyTimer = setTimeout(() => {
    const safetyPayload = buildExecuteResponse('notSent', {
      messageStatus: 'ERROR',
      errorCode: 'EXECUTE_SAFETY_TIMEOUT',
      errorMessage: `La Custom Activity agotó el tiempo seguro de ejecución (${safetyTimeoutMs} ms) y enruta a No enviado.`,
      sentAt: new Date().toISOString(),
      debugRequestId: requestId
    });

    updateExecutionTrace(requestId, {
      state: 'responded-safety-timeout',
      routingDecision: {
        reason: 'execute-safety-timeout',
        branchResult: safetyPayload.branchResult,
        messageStatus: safetyPayload.messageStatus,
        errorCode: safetyPayload.errorCode,
        elapsedMs: Date.now() - executeStart
      }
    });

    executeResponder.send(safetyPayload, 'execute-safety-timeout');
  }, safetyTimeoutMs);

  let payload;

  try {
    /*
      En producción /execute debe venir firmado por SFMC.
      Si el JWT falta o no valida, NO enviamos SMS. Devolvemos No enviado para
      preservar el flujo y dejar trazabilidad del fallo.
    */
    payload = decodeJwtOrPlainPayload(req.body, {
      allowUnsignedJson: false,
      allowInvalidJwt: false
    });

    debugLog('sfmc-payload-decoded', {
      requestId,
      payload: safeSfmcPayload(payload)
    });

    updateExecutionTrace(requestId, {
      state: 'sfmc-payload-decoded',
      sfmcPayload: safeSfmcPayload(payload)
    });
  } catch (error) {
    clearTimeout(safetyTimer);
    error.code = 'JWT_ERROR';
    error.debugRequestId = requestId;

    debugLog('execute-decision', {
      requestId,
      reason: 'jwt-error',
      decision: 'No enviado',
      branchResult: 'notSent',
      errorCode: error.code,
      errorMessage: error.message,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-jwt-error',
      routingDecision: {
        reason: 'jwt-error',
        branchResult: 'notSent',
        decision: 'No enviado',
        errorCode: error.code,
        errorMessage: error.message,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(providerErrorPayload(error, 'JWT_ERROR'), 'jwt-error');
  }

  const args = mergeInArguments(payload.inArguments || payload?.arguments?.execute?.inArguments || []);
  const to = String(args.to || '').trim();
  const message = String(args.message || '').trim();
  const campanyaReferencia = String(args.campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim();
  const normalizedTelefono = normalizeTelefono(to);

  const extractedArgumentsDebug = {
    requestId,
    contactKey: args.contactKey || '',
    telefonoRaw: to,
    telefonoNormalizado: normalizedTelefono,
    campanyaReferencia,
    mensaje: safeLogMessage(message),
    mensajeLength: message.length
  };

  debugLog('execute-arguments', extractedArgumentsDebug);
  updateExecutionTrace(requestId, {
    state: 'arguments-extracted',
    executeArguments: extractedArgumentsDebug
  });

  if (!to) {
    clearTimeout(safetyTimer);
    const error = Object.assign(new Error('El campo destino/teléfono llegó vacío.'), {
      code: 'MISSING_TO',
      debugRequestId: requestId
    });

    debugLog('execute-decision', {
      requestId,
      reason: 'missing-to',
      decision: 'No enviado',
      branchResult: 'notSent',
      errorCode: error.code,
      errorMessage: error.message,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-missing-to',
      routingDecision: {
        reason: 'missing-to',
        branchResult: 'notSent',
        decision: 'No enviado',
        errorCode: error.code,
        errorMessage: error.message,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(providerErrorPayload(error), 'missing-to');
  }

  if (!message) {
    clearTimeout(safetyTimer);
    const error = Object.assign(new Error('El mensaje llegó vacío.'), {
      code: 'MISSING_MESSAGE',
      phoneSent: normalizedTelefono,
      campaignReference: campanyaReferencia,
      debugRequestId: requestId
    });

    debugLog('execute-decision', {
      requestId,
      reason: 'missing-message',
      decision: 'No enviado',
      branchResult: 'notSent',
      errorCode: error.code,
      errorMessage: error.message,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-missing-message',
      routingDecision: {
        reason: 'missing-message',
        branchResult: 'notSent',
        decision: 'No enviado',
        errorCode: error.code,
        errorMessage: error.message,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(providerErrorPayload(error), 'missing-message');
  }

  if (!campanyaReferencia) {
    clearTimeout(safetyTimer);
    const error = Object.assign(new Error('La referencia de campaña de BITMessage llegó vacía.'), {
      code: 'MISSING_CAMPANYA_REFERENCIA',
      phoneSent: normalizedTelefono,
      debugRequestId: requestId
    });

    debugLog('execute-decision', {
      requestId,
      reason: 'missing-campanya-referencia',
      decision: 'No enviado',
      branchResult: 'notSent',
      errorCode: error.code,
      errorMessage: error.message,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-missing-campaign',
      routingDecision: {
        reason: 'missing-campanya-referencia',
        branchResult: 'notSent',
        decision: 'No enviado',
        errorCode: error.code,
        errorMessage: error.message,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(providerErrorPayload(error), 'missing-campanya-referencia');
  }

  try {
    const result = await sendBitmessage({
      to,
      message,
      campanyaReferencia,
      debugRequestId: requestId
    });

    clearTimeout(safetyTimer);
    const sfmcPayload = buildExecuteResponse('sent', {
      messageStatus: result.providerStatus || 'ENVIADO',
      providerMessageId: result.providerMessageId,
      providerOperatorCode: result.providerOperatorCode,
      errorCode: '',
      errorMessage: '',
      providerResponse: truncate(result.providerResponse),
      phoneSent: result.phoneSent,
      campaignReference: result.campaignReference,
      sentAt: result.sentAt || new Date().toISOString(),
      debugRequestId: requestId
    });

    debugLog('execute-decision', {
      requestId,
      reason: 'bitmessage-enviado',
      decision: 'Enviado',
      branchResult: sfmcPayload.branchResult,
      messageStatus: sfmcPayload.messageStatus,
      errorCode: sfmcPayload.errorCode,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-sent',
      routingDecision: {
        reason: 'bitmessage-enviado',
        branchResult: sfmcPayload.branchResult,
        decision: 'Enviado',
        messageStatus: sfmcPayload.messageStatus,
        errorCode: sfmcPayload.errorCode,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(sfmcPayload, 'bitmessage-enviado');
  } catch (error) {
    clearTimeout(safetyTimer);
    error.debugRequestId = requestId;

    const sfmcPayload = providerErrorPayload(error);
    sfmcPayload.debugRequestId = requestId;

    debugLog('execute-decision', {
      requestId,
      reason: error.code || 'bitmessage-error',
      decision: 'No enviado',
      branchResult: sfmcPayload.branchResult,
      messageStatus: sfmcPayload.messageStatus,
      errorCode: sfmcPayload.errorCode,
      errorMessage: sfmcPayload.errorMessage,
      elapsedMs: Date.now() - executeStart
    });

    updateExecutionTrace(requestId, {
      state: 'responded-not-sent',
      routingDecision: {
        reason: error.code || 'bitmessage-error',
        branchResult: sfmcPayload.branchResult,
        decision: 'No enviado',
        messageStatus: sfmcPayload.messageStatus,
        errorCode: sfmcPayload.errorCode,
        errorMessage: sfmcPayload.errorMessage,
        elapsedMs: Date.now() - executeStart
      }
    });

    return executeResponder.send(sfmcPayload, error.code || 'bitmessage-error');
  }
});


app.use((error, req, res, next) => {
  console.error('[unhandled-error]', JSON.stringify({
    appVersion: APP_VERSION,
    path: req.path,
    message: error?.message,
    code: error?.code,
    stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
  }));

  if (req.path === '/execute' && !res.headersSent) {
    return sendExecuteResponse(res, providerErrorPayload(
      Object.assign(new Error(error?.message || 'Error inesperado en /execute.'), {
        code: error?.code || 'UNHANDLED_EXECUTE_ERROR'
      })
    ), 'unhandled-execute-error');
  }

  if (!res.headersSent) {
    return res.status(500).json({
      success: false,
      error: 'UNHANDLED_ERROR',
      message: error?.message || 'Error inesperado.'
    });
  }

  return next(error);
});

app.listen(PORT, () => {
  console.log(`SFMC BitMessage Custom Activity escuchando en ${BASE_URL}`);
});
