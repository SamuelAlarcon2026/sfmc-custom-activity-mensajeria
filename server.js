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
const BITMESSAGE_API_TIMEOUT_MS = Number(
  process.env.BITMESSAGE_API_TIMEOUT_MS ||
  process.env.EXTERNAL_API_TIMEOUT_MS ||
  10000
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
    provider: 'BITMessage Fundacio BIT',
    baseUrl: BASE_URL,
    nodeEnv: process.env.NODE_ENV || '',
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
          { sentAt: '' }
        ],
        url: `${BASE_URL}/execute`,
        verb: 'POST',
        body: '',
        header: '',
        format: 'json',
        useJwt: true,
        timeout: BITMESSAGE_API_TIMEOUT_MS
      }
    },
    configurationArguments: {
      save: {
        url: `${BASE_URL}/save`,
        verb: 'POST',
        useJwt: true,
        body: '',
        header: ''
      },
      validate: {
        url: `${BASE_URL}/validate`,
        verb: 'POST',
        useJwt: true,
        body: '',
        header: ''
      },
      publish: {
        url: `${BASE_URL}/publish`,
        verb: 'POST',
        useJwt: true,
        body: '',
        header: ''
      },
      stop: {
        url: `${BASE_URL}/stop`,
        verb: 'POST',
        useJwt: true,
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
              },
              messageStatus: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              providerMessageId: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              providerOperatorCode: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              errorCode: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              errorMessage: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              providerResponse: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              phoneSent: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              campaignReference: {
                dataType: 'Text',
                direction: 'out',
                access: 'visible'
              },
              sentAt: {
                dataType: 'Date',
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
      `BASE_URL=${BASE_URL}`,
      `configModal.url=${BASE_URL}/index.html`,
      `execute.url=${BASE_URL}/execute`,
      `provider=BITMessage Fundacio BIT`,
      `bitmessage.url=${BITMESSAGE_API_URL}`,
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

function decodeJwtOrPlainPayload(rawBody) {
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
      throw new Error('JWT_SECRET no está configurado en el servidor.');
    }

    return jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256']
    });
  }

  /*
    Permite pruebas locales con payload JSON sin JWT.
    En producción mantén useJwt=true en config.json y define JWT_SECRET.
  */
  if (process.env.NODE_ENV !== 'production' && parsed) {
    return parsed;
  }

  throw new Error('No se recibió JWT válido desde Journey Builder.');
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

function providerErrorPayload(error, fallbackCode = 'BITMESSAGE_ERROR') {
  return {
    branchResult: 'no_enviado',
    messageStatus: error.providerStatus || 'ERROR',
    providerMessageId: error.providerMessageId || '',
    providerOperatorCode: error.providerOperatorCode || '',
    errorCode: error.code || fallbackCode,
    errorMessage: truncate(error.message || 'Error desconocido al enviar el mensaje.'),
    providerResponse: truncate(error.providerResponse || ''),
    phoneSent: error.phoneSent || '',
    campaignReference: error.campaignReference || '',
    sentAt: new Date().toISOString()
  };
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
  try {
    decodeJwtOrPlainPayload(req.body);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/validate', rawBodyParser, (req, res) => {
  try {
    const payload = decodeJwtOrPlainPayload(req.body);
    const args = mergeInArguments(payload?.arguments?.execute?.inArguments || payload?.inArguments || []);
    const errors = [];

    if (!args.to) {
      errors.push('Selecciona el campo destino/teléfono.');
    }

    if (!args.message || !String(args.message).trim()) {
      errors.push('El mensaje no puede estar vacío.');
    }

    if (!String(args.campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim()) {
      errors.push('Indica la referencia de campaña de BITMessage.');
    }

    errors.push(...validateServerConfiguration());

    if (errors.length) {
      return res.status(400).json({
        success: false,
        errors
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/publish', rawBodyParser, (req, res) => {
  try {
    decodeJwtOrPlainPayload(req.body);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/stop', rawBodyParser, (req, res) => {
  try {
    decodeJwtOrPlainPayload(req.body);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(200).json({ success: true, warning: error.message });
  }
});

app.post('/execute', rawBodyParser, async (req, res) => {
  let payload;

  try {
    payload = decodeJwtOrPlainPayload(req.body);
  } catch (error) {
    /*
      Retornamos 200 con branch no_enviado para que Journey Builder pueda enrutar
      el contacto al camino de error. Un 500 puede provocar retry/fallo de actividad
      en lugar de avanzar por la rama.
    */
    return res.status(200).json(providerErrorPayload(error, 'JWT_ERROR'));
  }

  const args = mergeInArguments(payload.inArguments || payload?.arguments?.execute?.inArguments || []);
  const to = String(args.to || '').trim();
  const message = String(args.message || '').trim();
  const campanyaReferencia = String(args.campanyaReferencia || BITMESSAGE_CAMPANYA_REFERENCIA || '').trim();

  if (!to) {
    return res.status(200).json(providerErrorPayload(
      Object.assign(new Error('El campo destino/teléfono llegó vacío.'), { code: 'MISSING_TO' })
    ));
  }

  if (!message) {
    return res.status(200).json(providerErrorPayload(
      Object.assign(new Error('El mensaje llegó vacío.'), { code: 'MISSING_MESSAGE' })
    ));
  }

  if (!campanyaReferencia) {
    return res.status(200).json(providerErrorPayload(
      Object.assign(new Error('La referencia de campaña de BITMessage llegó vacía.'), { code: 'MISSING_CAMPANYA_REFERENCIA' })
    ));
  }

  try {
    const result = await sendBitmessage({
      to,
      message,
      campanyaReferencia
    });

    return res.status(200).json({
      branchResult: 'enviado',
      messageStatus: result.providerStatus || 'ENVIADO',
      providerMessageId: result.providerMessageId,
      providerOperatorCode: result.providerOperatorCode,
      errorCode: '',
      errorMessage: '',
      providerResponse: truncate(result.providerResponse),
      phoneSent: result.phoneSent,
      campaignReference: result.campaignReference,
      sentAt: result.sentAt || new Date().toISOString()
    });
  } catch (error) {
    return res.status(200).json(providerErrorPayload(error));
  }
});

app.listen(PORT, () => {
  console.log(`SFMC BitMessage Custom Activity escuchando en ${BASE_URL}`);
});
