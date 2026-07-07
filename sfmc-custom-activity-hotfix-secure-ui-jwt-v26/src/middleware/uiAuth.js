const crypto = require('crypto');
const { AppError } = require('./errorHandler');

function boolFromEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'si', 'sí', 'on'].includes(String(value).trim().toLowerCase());
}

function isUiApiAuthEnabled() {
  return boolFromEnv(process.env.UI_API_AUTH_ENABLED, false);
}

function getSessionSecret() {
  return (
    process.env.UI_SESSION_SECRET ||
    process.env.SFMC_JWT_SECRET ||
    process.env.JWT_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    ''
  ).trim();
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(payload) {
  const secret = getSessionSecret();
  if (!secret) {
    throw new AppError(
      'UI_API_AUTH_ENABLED=true, pero no se ha configurado UI_SESSION_SECRET o SFMC_JWT_SECRET.',
      500,
      undefined,
      'UI_SESSION_SECRET_MISSING'
    );
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  const secret = getSessionSecret();
  if (!secret) {
    throw new AppError(
      'UI_API_AUTH_ENABLED=true, pero no se ha configurado UI_SESSION_SECRET o SFMC_JWT_SECRET.',
      500,
      undefined,
      'UI_SESSION_SECRET_MISSING'
    );
  }

  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expected = signPayload(encodedPayload, secret);

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_err) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;

  return payload;
}

function extractPostmongerToken(body = {}) {
  const candidates = [
    body.fuel2token,
    body.fuel2Token,
    body.accessToken,
    body.access_token,
    body.token,
    body.legacyToken,
    body.legacytoken,
    body.tokens?.fuel2token,
    body.tokens?.fuel2Token,
    body.tokens?.accessToken,
    body.tokens?.access_token,
    body.tokens?.token
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  return '';
}

function sanitizeTokenContext(context) {
  if (!context || typeof context !== 'object') return {};

  return {
    organizationId: context.organizationId || context.orgId || context.enterpriseId || context.eid || null,
    memberId: context.memberId || context.accountId || context.mid || context.businessUnitId || null,
    userId: context.userId || context.uid || context.user?.id || null,
    userName: context.userName || context.username || context.user?.name || null,
    accountType: context.accountType || null
  };
}

async function validateSfmcUserToken(postmongerToken) {
  if (!postmongerToken) {
    throw new AppError(
      'No se ha recibido token de sesión de Journey Builder. Abre la actividad desde Journey Builder.',
      401,
      undefined,
      'POSTMONGER_TOKEN_MISSING'
    );
  }

  const restBaseUrl = String(process.env.SFMC_REST_BASE_URL || '').replace(/\/+$/, '');
  if (!restBaseUrl) {
    throw new AppError(
      'SFMC_REST_BASE_URL no está configurado. No se puede validar la sesión de UI.',
      500,
      undefined,
      'SFMC_REST_BASE_URL_MISSING'
    );
  }

  const validationPath = process.env.UI_AUTH_TOKEN_CONTEXT_PATH || '/platform/v1/tokenContext';
  const validationUrl = validationPath.startsWith('http')
    ? validationPath
    : `${restBaseUrl}${validationPath.startsWith('/') ? validationPath : `/${validationPath}`}`;

  const timeoutMs = Number(process.env.UI_AUTH_TOKEN_VALIDATION_TIMEOUT_MS || 10000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let data = {};
  try {
    response = await fetch(validationUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${postmongerToken}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_err) {
      data = { raw: text };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AppError(
        'Timeout validando la sesión de UI contra SFMC.',
        504,
        { timeoutMs },
        'UI_TOKEN_VALIDATION_TIMEOUT'
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new AppError(
      'Token de UI no válido para consultar SFMC. La sesión debe abrirse desde Journey Builder.',
      401,
      {
        status: response.status,
        sfmcMessage: data.message || data.error_description || data.error || null
      },
      'UI_TOKEN_INVALID'
    );
  }

  return sanitizeTokenContext(data);
}

function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
    maxAge: Number(process.env.UI_SESSION_TTL_SECONDS || 1800) * 1000
  };
}

function readSessionToken(req) {
  const headerToken = String(
    req.get('x-ca-ui-session') ||
    req.get('X-CA-UI-Session') ||
    ''
  ).trim();

  if (headerToken) return headerToken;

  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)ca_ui_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function isBypassedApiPath(req) {
  const path = req.path || req.originalUrl || '';

  // La ruta que crea la sesión debe ser pública, pero valida el token de SFMC.
  if (path === '/ui-session' || path === '/ui-auth/diagnostics') return true;

  // Los previews se crean desde una llamada autenticada a /api/preview y usan IDs aleatorios
  // temporales. Permitirlos evita problemas de cookies de terceros dentro del iframe.
  if (req.method === 'GET' && /^\/preview-frame\//.test(path)) return true;

  return false;
}

async function createUiSession(req, res, next) {
  try {
    if (!isUiApiAuthEnabled()) {
      res.json({
        success: true,
        authEnabled: false,
        message: 'UI API auth desactivada.'
      });
      return;
    }

    const postmongerToken = extractPostmongerToken(req.body || {});
    const context = await validateSfmcUserToken(postmongerToken);

    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(process.env.UI_SESSION_TTL_SECONDS || 1800);
    const payload = {
      typ: 'ca-ui-session',
      iat: now,
      exp: now + ttl,
      sid: crypto.randomUUID(),
      memberId: context.memberId || null,
      userId: context.userId || null
    };

    const sessionToken = createSessionToken(payload);

    res.cookie('ca_ui_session', sessionToken, sessionCookieOptions());

    res.json({
      success: true,
      authEnabled: true,
      sessionToken,
      expiresIn: ttl,
      context
    });
  } catch (err) {
    next(err);
  }
}

function requireUiSession(req, _res, next) {
  try {
    if (!isUiApiAuthEnabled()) return next();
    if (isBypassedApiPath(req)) return next();

    const token = readSessionToken(req);
    const session = verifySessionToken(token);

    if (!session) {
      throw new AppError(
        'Sesión de UI no válida o caducada. Abre la Custom Activity desde Journey Builder.',
        401,
        {
          requiredAction: 'Abrir el modal desde Journey Builder para que Postmonger entregue un token de sesión válido.',
          path: req.originalUrl
        },
        'UI_SESSION_REQUIRED'
      );
    }

    req.uiSession = session;
    return next();
  } catch (err) {
    return next(err);
  }
}

function diagnostics(_req, res) {
  res.json({
    success: true,
    uiApiAuthEnabled: isUiApiAuthEnabled(),
    uiSessionSecretConfigured: Boolean(getSessionSecret()),
    tokenValidationPath: process.env.UI_AUTH_TOKEN_CONTEXT_PATH || '/platform/v1/tokenContext',
    protectedApiEndpoints: [
      '/api/assets',
      '/api/assets/:id',
      '/api/sfmc/token-status',
      '/api/relay/diagnostics',
      '/api/preview',
      '/api/test-send'
    ],
    publicApiEndpoints: [
      '/api/ui-session',
      '/api/ui-auth/diagnostics',
      '/api/preview-frame/:id'
    ]
  });
}

module.exports = {
  createUiSession,
  requireUiSession,
  diagnostics,
  isUiApiAuthEnabled
};
