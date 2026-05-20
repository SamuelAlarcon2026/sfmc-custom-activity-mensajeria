const { AppError } = require('../middleware/errorHandler');

let graphTokenCache = {
  accessToken: null,
  expiresAt: 0
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new AppError(`Variable de entorno requerida no configurada: ${name}`, 500, undefined, 'ENV_MISSING');
  }
  return String(value).trim();
}

function optionalEnv(name, fallback = '') {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : fallback;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getRelayProvider() {
  return String(process.env.RELAY_PROVIDER || '').trim().toLowerCase()
    || (process.env.RELAY_AUTH_URL || process.env.RELAY_CLIENT_ID || process.env.RELAY_CLIENT_SECRET
      ? 'microsoft-graph'
      : 'generic-bearer');
}

function isMicrosoftGraphRelay() {
  return getRelayProvider() === 'microsoft-graph' || getRelayProvider() === 'graph';
}

function assertRelayConfigured() {
  requireEnv('RELAY_API_URL');

  if (isMicrosoftGraphRelay()) {
    requireEnv('RELAY_AUTH_URL');
    requireEnv('RELAY_CLIENT_ID');
    requireEnv('RELAY_CLIENT_SECRET');
    requireEnv('RELAY_SCOPE');
    return;
  }

  requireEnv('RELAY_API_KEY');
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'si', 'sí'].includes(String(value).toLowerCase());
}

function parseRecipients(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.email || item?.address || ''))
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateRelayPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Payload inválido.');
    return errors;
  }

  const recipients = parseRecipients(payload.to);
  if (!recipients.length || recipients.some((email) => !isEmail(email))) {
    errors.push('El destinatario no tiene formato de email válido.');
  }

  if (!payload.subject || !String(payload.subject).trim()) errors.push('El subject no puede estar vacío.');
  if (!payload.html && !payload.text) errors.push('Debe existir html o text para enviar.');
  if (payload.replyTo && !isEmail(payload.replyTo)) errors.push('replyTo no tiene formato válido.');

  if (!isMicrosoftGraphRelay()) {
    if (!payload.from || !isEmail(payload.from.email)) errors.push('from.email no tiene formato válido.');
  } else if (payload.from?.email && !isEmail(payload.from.email)) {
    errors.push('from.email no tiene formato válido.');
  }

  return errors;
}

function getTimeoutMs() {
  const timeoutMs = Number.parseInt(process.env.RELAY_TIMEOUT_MS || '15000', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = getTimeoutMs()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AppError('Timeout llamando al relay privado.', 504, { timeoutMs }, 'RELAY_TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseBody(response) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch (_err) {
    return { raw: rawText.slice(0, 1000) };
  }
}

async function getMicrosoftGraphToken() {
  assertRelayConfigured();

  const now = Date.now();
  if (graphTokenCache.accessToken && graphTokenCache.expiresAt > now + 60000) {
    return graphTokenCache.accessToken;
  }

  const authUrl = requireEnv('RELAY_AUTH_URL');
  const form = new URLSearchParams();
  form.set('client_id', requireEnv('RELAY_CLIENT_ID'));
  form.set('client_secret', requireEnv('RELAY_CLIENT_SECRET'));
  form.set('grant_type', optionalEnv('RELAY_GRANT_TYPE', 'client_credentials'));
  form.set('scope', requireEnv('RELAY_SCOPE'));

  const response = await fetchWithTimeout(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: form.toString()
  });

  const responseBody = await parseResponseBody(response);

  if (!response.ok || !responseBody.access_token) {
    throw new AppError(
      'No se pudo obtener token OAuth del relay Microsoft Graph.',
      response.status >= 500 ? 502 : response.status,
      {
        relayAuthStatus: response.status,
        relayAuthResponse: {
          error: responseBody.error,
          error_description: responseBody.error_description,
          error_codes: responseBody.error_codes,
          timestamp: responseBody.timestamp,
          trace_id: responseBody.trace_id,
          correlation_id: responseBody.correlation_id
        }
      },
      'RELAY_AUTH_FAILED'
    );
  }

  const expiresIn = Number.parseInt(responseBody.expires_in || '3599', 10);
  graphTokenCache = {
    accessToken: responseBody.access_token,
    expiresAt: Date.now() + Math.max(expiresIn - 120, 60) * 1000
  };

  return graphTokenCache.accessToken;
}

function injectPreheaderIntoHtml(html, preheader) {
  const body = String(html || '');
  const text = String(preheader || '').trim();

  if (!text) return body;

  const hiddenPreheader = [
    '<div style="display:none!important;visibility:hidden;mso-hide:all;',
    'font-size:1px;color:#ffffff;line-height:1px;max-height:0;',
    'max-width:0;opacity:0;overflow:hidden;">',
    escapeHtml(text),
    '</div>'
  ].join('');

  if (/<body\b[^>]*>/i.test(body)) {
    return body.replace(/<body\b[^>]*>/i, (match) => `${match}${hiddenPreheader}`);
  }

  return `${hiddenPreheader}${body}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMicrosoftGraphSendMailBody(payload) {
  const recipients = parseRecipients(payload.to).map((address) => ({
    emailAddress: { address }
  }));

  const hasHtml = !!String(payload.html || '').trim();
  const contentType = hasHtml ? 'HTML' : 'Text';
  const content = hasHtml
    ? injectPreheaderIntoHtml(payload.html, payload.preheader)
    : String(payload.text || '');

  const message = {
    toRecipients: recipients,
    body: {
      contentType,
      content
    },
    subject: String(payload.subject || '')
  };

  if (payload.replyTo && isEmail(payload.replyTo)) {
    message.replyTo = [
      {
        emailAddress: {
          address: String(payload.replyTo).trim()
        }
      }
    ];
  }

  // Microsoft Graph no permite cambiar libremente el From en /users/{mailbox}/sendMail.
  // El remitente real será el buzón indicado en RELAY_API_URL.
  // fromName/fromEmail se conservan solo como metadatos internos del payload original.
  return {
    saveToSentItems: parseBoolean(process.env.RELAY_GRAPH_SAVE_TO_SENT_ITEMS, true),
    message
  };
}

async function postToMicrosoftGraph(payload, context = {}) {
  const accessToken = await getMicrosoftGraphToken();
  const relayUrl = requireEnv('RELAY_API_URL');

  const graphBody = buildMicrosoftGraphSendMailBody(payload);

  const response = await fetchWithTimeout(relayUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Correlation-Id': context.correlationId || ''
    },
    body: JSON.stringify(graphBody)
  });

  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    throw new AppError(
      'Microsoft Graph rechazó el envío.',
      response.status >= 500 ? 502 : response.status,
      {
        relayStatus: response.status,
        relayResponse: responseBody
      },
      'RELAY_REJECTED'
    );
  }

  return {
    success: true,
    provider: 'microsoft-graph',
    relayStatus: response.status,
    // Graph sendMail suele responder 202 sin body.
    relayResponse: responseBody
  };
}

async function postToGenericBearerRelay(payload, context = {}) {
  const relayUrl = requireEnv('RELAY_API_URL');
  const apiKey = requireEnv('RELAY_API_KEY');

  const response = await fetchWithTimeout(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Correlation-Id': context.correlationId || ''
    },
    body: JSON.stringify(payload)
  });

  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    throw new AppError(
      'El relay privado rechazó el envío.',
      response.status >= 500 ? 502 : response.status,
      {
        relayStatus: response.status,
        relayResponse: responseBody
      },
      'RELAY_REJECTED'
    );
  }

  return {
    success: true,
    provider: 'generic-bearer',
    relayStatus: response.status,
    relayResponse: responseBody
  };
}

async function postToRelay(payload, context = {}) {
  assertRelayConfigured();

  const errors = validateRelayPayload(payload);
  if (errors.length) {
    throw new AppError('Payload no válido para el relay.', 400, errors, 'RELAY_PAYLOAD_INVALID');
  }

  if (isMicrosoftGraphRelay()) {
    return postToMicrosoftGraph(payload, context);
  }

  return postToGenericBearerRelay(payload, context);
}

function buildRelayPayload({
  to,
  fromName,
  fromEmail,
  replyTo,
  subject,
  preheader,
  html,
  text,
  metadata
}) {
  return {
    to: String(to || '').trim(),
    from: {
      name: String(fromName || '').trim(),
      email: String(fromEmail || '').trim()
    },
    replyTo: replyTo ? String(replyTo).trim() : undefined,
    subject: String(subject || ''),
    preheader: String(preheader || ''),
    html: String(html || ''),
    text: String(text || ''),
    metadata: metadata || {}
  };
}

async function getRelayDiagnostics() {
  assertRelayConfigured();

  const provider = isMicrosoftGraphRelay() ? 'microsoft-graph' : 'generic-bearer';

  if (provider === 'microsoft-graph') {
    await getMicrosoftGraphToken();
  }

  return {
    success: true,
    provider,
    relayApiUrlConfigured: !!process.env.RELAY_API_URL,
    relayAuthUrlConfigured: !!process.env.RELAY_AUTH_URL,
    tokenAvailable: provider === 'microsoft-graph' ? !!graphTokenCache.accessToken : undefined,
    tokenExpiresAt: provider === 'microsoft-graph' && graphTokenCache.expiresAt
      ? new Date(graphTokenCache.expiresAt).toISOString()
      : undefined
  };
}

module.exports = {
  postToRelay,
  buildRelayPayload,
  validateRelayPayload,
  assertRelayConfigured,
  isEmail,
  isMicrosoftGraphRelay,
  getRelayDiagnostics
};
