import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const APP_VERSION = '2026-05-13-top-level-branch-v6';

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
      executeUseJwt: true,
      executeResponseFormat: 'top-level-json',
      outArgumentsShape: 'array:single-object',
      responseContract: 'top-level-json-branchResult',
      requiredBranchResult: true,
      safeFallbackBranch: 'no_enviado',
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
  return {
    workflowApiVersion: '1.1',
    type: 'REST',
    metaData: {
      icon: `${BASE_URL}/images/icon.svg`,
      iconSmall: `${BASE_URL}/images/icon.svg`,
      category: 'message',
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
        /*
          Para outcomes en Journey Builder, branchResult debe declararse como outArgument
          y /execute debe devolverlo a nivel raíz del JSON:
          { "branchResult": "enviado" } o { "branchResult": "no_enviado" }.

          Se declaran como objetos individuales para que SFMC los registre como
          outArguments independientes.
        */
        outArguments: [
          { branchResult: '' },
          { outcome: '' },
          { messageStatus: '' },
          { providerMessageId: '' },
          { providerOperatorCode: '' },
          { errorCode: '' },
          { errorMessage: '' },
          { providerResponse: '' },
          { phoneSent: '' },
          { campaignReference: '' },
          { sentAt: '' }
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
        key: 'enviado',
        displayName: 'Enviado',
        arguments: {
          branchResult: 'enviado'
        },
        metaData: {
          label: 'Enviado',
          invalid: false
        }
      },
      {
        key: 'no_enviado',
        displayName: 'No enviado',
        arguments: {
          branchResult: 'no_enviado'
        },
        metaData: {
          label: 'No enviado',
          invalid: false
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
              outcome: {
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

app.get('/debug/config', (req, res) => {
  res
    .type('text/plain')
    .send([
      `APP_VERSION=${APP_VERSION}`,
      `BASE_URL=${BASE_URL}`,
      `configModal.url=${BASE_URL}/index.html`,
      `execute.url=${BASE_URL}/execute`,
      `execute.useJwt=true`,
      `execute.responseFormat=signed-jwt`,
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
      `NODE_ENV=${process.env.NODE_ENV || ''}`
    ].join('\n'));
});

app.get('/debug/sample-execute-response', (req, res) => {
  const branch = String(req.query.branch || 'no_enviado') === 'enviado' ? 'enviado' : 'no_enviado';

  const sample = buildExecuteResponse(branch, branch === 'enviado'
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

function buildExecuteResponse(branchResult, values = {}) {
  /*
    Contrato usado por Journey Builder para outcomes:
    - /execute devuelve SIEMPRE HTTP 200 para errores funcionales o del proveedor.
    - La respuesta es JSON plano.
    - branchResult va a nivel raíz del JSON, no dentro de outArguments.
    - Solo BITMessage estado ENVIADO/CONFIRMADO => enviado.
    - Timeout, HTTP error, estado ERROR, validaciones y excepciones => no_enviado.

    Ejemplo de timeout:
      {
        "branchResult": "no_enviado",
        "messageStatus": "ERROR",
        "errorCode": "TIMEOUT"
      }
  */
  const normalizedBranchResult = branchResult === 'enviado' ? 'enviado' : 'no_enviado';

  return {
    branchResult: normalizedBranchResult,
    outcome: normalizedBranchResult,
    messageStatus: values.messageStatus || (normalizedBranchResult === 'enviado' ? 'ENVIADO' : 'ERROR'),
    providerMessageId: values.providerMessageId || '',
    providerOperatorCode: values.providerOperatorCode || '',
    errorCode: values.errorCode || '',
    errorMessage: values.errorMessage || '',
    providerResponse: values.providerResponse || '',
    phoneSent: values.phoneSent || '',
    campaignReference: values.campaignReference || '',
    sentAt: values.sentAt || new Date().toISOString()
  };
}

function sendExecuteResponse(res, payload, reason = '') {
  console.log('[execute-response]', JSON.stringify({
    appVersion: APP_VERSION,
    responseFormat: 'top-level-json',
    branchResult: payload.branchResult,
    messageStatus: payload.messageStatus,
    errorCode: payload.errorCode,
    reason
  }));

  return res
    .status(200)
    .type('application/json')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .json(payload);
}

function providerErrorPayload(error, fallbackCode = 'BITMESSAGE_ERROR') {
  return buildExecuteResponse('no_enviado', {
    messageStatus: error.providerStatus || 'ERROR',
    providerMessageId: error.providerMessageId || '',
    providerOperatorCode: error.providerOperatorCode || '',
    errorCode: error.code || fallbackCode,
    errorMessage: truncate(error.message || 'Error desconocido al enviar el mensaje.'),
    providerResponse: truncate(error.providerResponse || ''),
    phoneSent: error.phoneSent || '',
    campaignReference: error.campaignReference || '',
    sentAt: new Date().toISOString()
  });
}

async function sendBitmessage({ to, message, campanyaReferencia }) {
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
      throw timeoutError;
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
  const executeResponder = createExecuteResponder(res);

  /*
    Último cinturón de seguridad:
    Si por cualquier motivo el proceso tarda demasiado, respondemos antes a SFMC
    con No enviado. Así evitamos perder al contacto por Hard Error.
  */
  const safetyTimeoutMs = Math.max(1000, Math.min(SFMC_EXECUTE_TIMEOUT_MS - 5000, BITMESSAGE_API_TIMEOUT_MS + 2000));
  const safetyTimer = setTimeout(() => {
    executeResponder.send(buildExecuteResponse('no_enviado', {
      messageStatus: 'ERROR',
      errorCode: 'EXECUTE_SAFETY_TIMEOUT',
      errorMessage: `La Custom Activity agotó el tiempo seguro de ejecución (${safetyTimeoutMs} ms) y enruta a No enviado.`,
      sentAt: new Date().toISOString()
    }), 'execute-safety-timeout');
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
  } catch (error) {
    clearTimeout(safetyTimer);
    return executeResponder.send(providerErrorPayload(
      Object.assign(error, { code: 'JWT_ERROR' }),
      'JWT_ERROR'
    ), 'jwt-error');
  }

  const args = mergeInArguments(payload.inArguments || payload?.arguments?.execute?.inArguments || []);
  const to = String(args.to || '').trim();
  const message = String(args.message || '').trim();
  const campanyaReferencia = String(args.campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim();

  if (!to) {
    clearTimeout(safetyTimer);
    return executeResponder.send(providerErrorPayload(
      Object.assign(new Error('El campo destino/teléfono llegó vacío.'), { code: 'MISSING_TO' })
    ), 'missing-to');
  }

  if (!message) {
    clearTimeout(safetyTimer);
    return executeResponder.send(providerErrorPayload(
      Object.assign(new Error('El mensaje llegó vacío.'), { code: 'MISSING_MESSAGE' })
    ), 'missing-message');
  }

  if (!campanyaReferencia) {
    clearTimeout(safetyTimer);
    return executeResponder.send(providerErrorPayload(
      Object.assign(new Error('La referencia de campaña de BITMessage llegó vacía.'), { code: 'MISSING_CAMPANYA_REFERENCIA' })
    ), 'missing-campanya-referencia');
  }

  try {
    const result = await sendBitmessage({
      to,
      message,
      campanyaReferencia
    });

    clearTimeout(safetyTimer);
    return executeResponder.send(buildExecuteResponse('enviado', {
      messageStatus: result.providerStatus || 'ENVIADO',
      providerMessageId: result.providerMessageId,
      providerOperatorCode: result.providerOperatorCode,
      errorCode: '',
      errorMessage: '',
      providerResponse: truncate(result.providerResponse),
      phoneSent: result.phoneSent,
      campaignReference: result.campaignReference,
      sentAt: result.sentAt || new Date().toISOString()
    }), 'bitmessage-enviado');
  } catch (error) {
    clearTimeout(safetyTimer);
    return executeResponder.send(providerErrorPayload(error), error.code || 'bitmessage-error');
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
