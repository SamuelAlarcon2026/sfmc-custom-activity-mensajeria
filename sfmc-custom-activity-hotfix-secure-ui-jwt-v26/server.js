require('dotenv').config();

const path = require('path');
const express = require('express');
const { securityMiddleware } = require('./src/middleware/security');
const { notFoundHandler, errorHandler } = require('./src/middleware/errorHandler');
const { router: journeyRouter } = require('./src/routes/journey');
const assetsRouter = require('./src/routes/assets');
const relayRouter = require('./src/routes/relay');
const sfmcAuthRouter = require('./src/routes/sfmcAuth');
const { createUiSession, requireUiSession, diagnostics: uiAuthDiagnostics } = require('./src/middleware/uiAuth');

const app = express();

app.set('trust proxy', 1);

for (const middleware of securityMiddleware()) {
  app.use(middleware);
}

app.use(express.json({ limit: '5mb' }));
// Cuando config.json useJwt=true, Journey Builder puede enviar el JWT como texto plano
// o application/jwt en vez de JSON. Esta capa permite que el middleware JWT lo lea.
app.use(express.text({ type: ['text/plain', 'application/jwt', 'application/jose', 'application/octet-stream'], limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.info('[request]', {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path
    });
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'sfmc-custom-activity-mensajeria-email',
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

app.use('/', journeyRouter);

const publicDir = path.join(__dirname, 'public');
const sldsDir = path.join(__dirname, 'node_modules', '@salesforce-ux', 'design-system', 'assets');

app.use('/slds', express.static(sldsDir, {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0
}));

function findFirstExistingFile(candidates) {
  return candidates.find((candidate) => {
    try {
      return require('fs').existsSync(candidate);
    } catch (_err) {
      return false;
    }
  });
}

app.get('/vendor/postmonger.js', (_req, res) => {
  const candidates = [
    // Preferimos la copia oficial vendorizada para evitar cambios de CDN/npm.
    path.join(__dirname, 'public', 'vendor', 'postmonger.js'),
    path.join(__dirname, 'node_modules', 'postmonger', 'postmonger.js'),
    path.join(__dirname, 'node_modules', 'postmonger', 'postmonger.min.js'),
    path.join(__dirname, 'public', 'vendor', 'postmonger-fallback.js')
  ];

  const filePath = findFirstExistingFile(candidates);

  if (!filePath) {
    res.status(500).type('text/plain').send('Postmonger no está disponible.');
    return;
  }

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(filePath);
});


// Do not cache the Journey Builder modal shell or JS while iterating.
// SFMC/Journey Builder iframes are very sticky with cached static files.
app.use('/app', express.static(path.join(publicDir, 'app'), {
  etag: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

app.use(express.static(publicDir, {
  extensions: ['html'],
  etag: false,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/index\.html$|config\.json$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.post('/api/ui-session', createUiSession);
app.get('/api/ui-auth/diagnostics', uiAuthDiagnostics);

// A partir de este punto, todas las APIs de UI quedan protegidas si UI_API_AUTH_ENABLED=true.
// La URL del modal sigue siendo pública por requisito de Journey Builder, pero no puede listar
// assets ni enviar tests sin una sesión validada con token de Journey Builder/Postmonger.
app.use('/api', requireUiSession);
app.use('/api', sfmcAuthRouter);
app.use('/api', assetsRouter);
app.use('/api', relayRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`SFMC Custom Activity escuchando en puerto ${port}`);
  console.log(`APP_BASE_URL=${process.env.APP_BASE_URL || 'no configurado'}`);
});