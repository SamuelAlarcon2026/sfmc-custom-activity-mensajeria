const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');

function normalizeOriginList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, configuredOrigins) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    const sfmcHosts = [
      '.exacttarget.com',
      '.marketingcloudapps.com',
      '.salesforce.com',
      '.force.com',
      '.salesforce-setup.com'
    ];

    if (sfmcHosts.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
      return true;
    }

    return configuredOrigins.includes(origin);
  } catch (_err) {
    return false;
  }
}

function requestContext(req, res, next) {
  const incoming = req.headers['x-correlation-id'];
  req.correlationId = typeof incoming === 'string' && incoming.trim()
    ? incoming.trim().slice(0, 120)
    : crypto.randomUUID();

  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
}

function securityMiddleware() {
  const configuredOrigins = normalizeOriginList(process.env.ALLOWED_ORIGINS);
  const appBaseUrl = process.env.APP_BASE_URL;

  if (appBaseUrl) {
    configuredOrigins.push(appBaseUrl.replace(/\/$/, ''));
  }

  const corsMiddleware = cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin, configuredOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin no permitido: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    credentials: false,
    maxAge: 86400
  });

  const helmetMiddleware = helmet({
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-src": ["'self'", "about:", "blob:", "data:", "https:"],
        "child-src": ["'self'", "about:", "blob:", "data:", "https:"],
        "frame-ancestors": [
          "'self'",
          "https://*.exacttarget.com",
          "https://*.marketingcloudapps.com",
          "https://*.salesforce.com",
          "https://*.force.com",
          "https://*.salesforce-setup.com",
          "https://*.salesforce-experience.com",
          "https://*.lightning.force.com"
        ],
        "object-src": ["'none'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  });

  return [requestContext, helmetMiddleware, corsMiddleware];
}

module.exports = {
  securityMiddleware,
  requestContext
};