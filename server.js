import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || '';
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || '';
const EXTERNAL_API_TIMEOUT_MS = Number(process.env.EXTERNAL_API_TIMEOUT_MS || 10000);

app.disable('x-powered-by');

// Render/SFMC health check.
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'sfmc-external-message-custom-activity',
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
        name: 'Mensaje externo',
        description: 'Envía un mensaje mediante una API externa y enruta el contacto según el resultado.'
      },
      'en-US': {
        name: 'External message',
        description: 'Sends a message through an external API and routes the contact based on the result.'
      }
    },
    userInterfaces: {
      configModal: {
        url: `${BASE_URL}/index.html`,
        height: 720,
        width: 1000,
        fullscreen: false
      }
    },
    arguments: {
      execute: {
        inArguments: [
          { contactKey: '{{Contact.Key}}' },
          { to: '' },
          { message: '' }
        ],
        outArguments: [
          { branchResult: '' },
          { messageStatus: '' },
          { providerMessageId: '' },
          { errorCode: '' },
          { errorMessage: '' },
          { providerResponse: '' },
          { sentAt: '' }
        ],
        url: `${BASE_URL}/execute`,
        verb: 'POST',
        body: '',
        header: '',
        format: 'json',
        useJwt: true,
        timeout: EXTERNAL_API_TIMEOUT_MS
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
      `has.JWT_SECRET=${Boolean(JWT_SECRET)}`,
      `has.EXTERNAL_API_URL=${Boolean(EXTERNAL_API_URL)}`,
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

function providerErrorPayload(error, fallbackCode = 'PROVIDER_ERROR') {
  return {
    branchResult: 'no_enviado',
    messageStatus: 'NO_ENVIADO',
    providerMessageId: '',
    errorCode: error.code || fallbackCode,
    errorMessage: truncate(error.message || 'Error desconocido al enviar el mensaje.'),
    providerResponse: truncate(error.providerResponse || ''),
    sentAt: new Date().toISOString()
  };
}

async function sendExternalMessage({ to, message, contactKey }) {
  if (!EXTERNAL_API_URL) {
    const error = new Error('EXTERNAL_API_URL no está configurado.');
    error.code = 'CONFIG_ERROR';
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_API_TIMEOUT_MS);

  try {
    const response = await fetch(EXTERNAL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(EXTERNAL_API_KEY ? { Authorization: `Bearer ${EXTERNAL_API_KEY}` } : {})
      },
      body: JSON.stringify({
        to,
        message,
        contactKey
      }),
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
        `El proveedor respondió HTTP ${response.status}.`
      );
      error.code = `HTTP_${response.status}`;
      error.providerResponse = responseText;
      throw error;
    }

    return {
      providerMessageId:
        responseBody.messageId ||
        responseBody.id ||
        responseBody.sid ||
        '',
      providerResponse: responseText
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Timeout después de ${EXTERNAL_API_TIMEOUT_MS} ms.`);
      timeoutError.code = 'TIMEOUT';
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

    if (!EXTERNAL_API_URL) {
      errors.push('El servidor no tiene configurado EXTERNAL_API_URL.');
    }

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
  const contactKey =
    args.contactKey ||
    payload.contactKey ||
    payload.keyValue ||
    payload.subscriberKey ||
    '';

  const to = String(args.to || '').trim();
  const message = String(args.message || '').trim();

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

  try {
    const result = await sendExternalMessage({ to, message, contactKey });

    return res.status(200).json({
      branchResult: 'enviado',
      messageStatus: 'ENVIADO',
      providerMessageId: result.providerMessageId,
      errorCode: '',
      errorMessage: '',
      providerResponse: truncate(result.providerResponse),
      sentAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(200).json(providerErrorPayload(error));
  }
});

app.listen(PORT, () => {
  console.log(`SFMC Custom Activity escuchando en ${BASE_URL}`);
});
