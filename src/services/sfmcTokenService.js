const { AppError } = require('../middleware/errorHandler');

const TOKEN_SAFETY_WINDOW_SECONDS = 120;
const DEFAULT_SFMC_TIMEOUT_MS = 20000;

let cachedToken = null;

function sfmcTimeoutMs() {
  const value = Number.parseInt(process.env.SFMC_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SFMC_TIMEOUT_MS;
}

async function fetchWithTimeout(url, options = {}, label = 'SFMC') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), sfmcTimeoutMs());

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new AppError(
        `${label} no respondió dentro de ${sfmcTimeoutMs()} ms.`,
        504,
        { url: String(url).replace(/client_secret=[^&]+/gi, 'client_secret=[redacted]') },
        'SFMC_TIMEOUT'
      );
    }

    throw new AppError(
      `No se pudo conectar con ${label}.`,
      502,
      { message: err.message },
      'SFMC_NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timeout);
  }
}


function trimTrailingSlash(value) {
  return (value || '').replace(/\/+$/, '');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new AppError(`Variable de entorno requerida no configurada: ${name}`, 500, undefined, 'ENV_MISSING');
  }
  return value.trim();
}

function getSfmcRestBaseUrl() {
  return trimTrailingSlash(requireEnv('SFMC_REST_BASE_URL'));
}

function resetTokenCache() {
  cachedToken = null;
}

function isTokenUsable(token) {
  if (!token || !token.accessToken || !token.expiresAt) return false;
  return Date.now() < token.expiresAt - TOKEN_SAFETY_WINDOW_SECONDS * 1000;
}

async function requestSfmcToken() {
  const authBaseUrl = trimTrailingSlash(requireEnv('SFMC_AUTH_BASE_URL'));
  const url = `${authBaseUrl}/v2/token`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: requireEnv('SFMC_CLIENT_ID'),
      client_secret: requireEnv('SFMC_CLIENT_SECRET')
    })
  }, 'SFMC OAuth');

  const rawText = await response.text();
  let body;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch (_err) {
    body = { raw: rawText.slice(0, 1000) };
  }

  if (!response.ok) {
    throw new AppError(
      'No se pudo obtener token OAuth de SFMC.',
      response.status,
      { status: response.status, body },
      'SFMC_AUTH_ERROR'
    );
  }

  if (!body.access_token) {
    throw new AppError('La respuesta OAuth de SFMC no incluyó access_token.', 502, undefined, 'SFMC_AUTH_INVALID_RESPONSE');
  }

  const expiresInSeconds = Number(body.expires_in || 1080);
  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    restInstanceUrl: trimTrailingSlash(body.rest_instance_url || process.env.SFMC_REST_BASE_URL)
  };

  return cachedToken;
}

async function getAccessToken() {
  if (isTokenUsable(cachedToken)) {
    return cachedToken.accessToken;
  }

  const token = await requestSfmcToken();
  return token.accessToken;
}

async function getSfmcBaseUrl() {
  if (isTokenUsable(cachedToken) && cachedToken.restInstanceUrl) {
    return cachedToken.restInstanceUrl;
  }

  return getSfmcRestBaseUrl();
}

async function sfmcFetch(path, options = {}, retryOnUnauthorized = true) {
  const token = await getAccessToken();
  const baseUrl = await getSfmcBaseUrl();
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const response = await fetchWithTimeout(url, {
    ...options,
    headers
  }, 'SFMC REST API');

  if (response.status === 401 && retryOnUnauthorized) {
    resetTokenCache();
    return sfmcFetch(path, options, false);
  }

  return response;
}

module.exports = {
  getAccessToken,
  getSfmcBaseUrl,
  sfmcFetch,
  resetTokenCache
};