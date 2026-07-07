const jwt = require('jsonwebtoken');
const { AppError } = require('./errorHandler');

function boolFromEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'si', 'sí', 'on'].includes(String(value).trim().toLowerCase());
}

function isSfmcJwtEnabled() {
  return boolFromEnv(process.env.SFMC_JWT_VALIDATION_ENABLED, false);
}

function shouldUseJwtInConfig() {
  // Si se habilita la validación, el config.json también debe pedir a Journey Builder
  // que firme save/validate/publish/stop/execute.
  return boolFromEnv(process.env.SFMC_JWT_USE, isSfmcJwtEnabled());
}

function getJwtSecret() {
  return (
    process.env.SFMC_JWT_SECRET ||
    process.env.JWT_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    ''
  ).trim();
}

function jwtAlgorithms() {
  const configured = String(process.env.SFMC_JWT_ALGORITHMS || 'HS256,HS384,HS512')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return configured.length ? configured : ['HS256'];
}

function extractBearerToken(req) {
  const authorization = req.get('authorization') || req.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function extractJwtFromBody(body) {
  if (!body) return '';

  if (typeof body === 'string') {
    const text = body.trim();

    // Journey Builder implementations commonly post the JWT as raw text when useJwt=true.
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return text;

    try {
      const parsed = JSON.parse(text);
      return extractJwtFromBody(parsed);
    } catch (_err) {
      return '';
    }
  }

  if (Buffer.isBuffer(body)) return extractJwtFromBody(body.toString('utf8'));

  if (typeof body === 'object') {
    return String(
      body.jwt ||
      body.token ||
      body.encodedData ||
      body.signedPayload ||
      body.payloadToken ||
      ''
    ).trim();
  }

  return '';
}

function normalizeDecodedPayload(decoded) {
  if (!decoded || typeof decoded !== 'object') return decoded;

  // Depending on the SFMC runtime and library, the original payload can be top-level
  // or nested under common keys. Keep the full decoded object as fallback.
  const candidates = [
    decoded.payload,
    decoded.data,
    decoded.request,
    decoded.body,
    decoded.activity,
    decoded
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      if (
        candidate.arguments ||
        candidate.inArguments ||
        candidate.activity ||
        candidate.keyValue ||
        candidate.contactKey ||
        candidate.config
      ) {
        return candidate;
      }
    }
  }

  return decoded;
}

function requireSfmcJwt(req, _res, next) {
  try {
    if (!isSfmcJwtEnabled()) {
      return next();
    }

    const secret = getJwtSecret();

    if (!secret) {
      throw new AppError(
        'SFMC_JWT_VALIDATION_ENABLED=true, pero no se ha configurado SFMC_JWT_SECRET/JWT_SIGNING_SECRET.',
        500,
        undefined,
        'JWT_SECRET_MISSING'
      );
    }

    const token = extractBearerToken(req) || extractJwtFromBody(req.body);

    if (!token) {
      throw new AppError(
        'Petición rechazada: falta JWT de Journey Builder.',
        401,
        {
          expected: 'Authorization: Bearer <jwt> o body JWT cuando config.json useJwt=true',
          path: req.originalUrl
        },
        'JWT_MISSING'
      );
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: jwtAlgorithms(),
      clockTolerance: Number(process.env.SFMC_JWT_CLOCK_TOLERANCE_SECONDS || 60)
    });

    req.sfmcJwt = decoded;
    req.sfmcJwtValidated = true;

    const normalizedPayload = normalizeDecodedPayload(decoded);
    if (normalizedPayload && typeof normalizedPayload === 'object') {
      req.body = normalizedPayload;
    }

    return next();
  } catch (err) {
    if (err instanceof AppError) return next(err);

    return next(new AppError(
      'Petición rechazada: JWT de Journey Builder inválido o caducado.',
      401,
      {
        reason: err.message,
        name: err.name
      },
      'JWT_INVALID'
    ));
  }
}

module.exports = {
  requireSfmcJwt,
  isSfmcJwtEnabled,
  shouldUseJwtInConfig,
  getJwtSecret
};
