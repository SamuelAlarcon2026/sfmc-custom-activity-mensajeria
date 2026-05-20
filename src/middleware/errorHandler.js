class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
    Error.captureStackTrace?.(this, AppError);
  }
}

function safeErrorDetails(details) {
  if (!details) return undefined;

  if (Array.isArray(details)) return details.slice(0, 20);

  if (typeof details === 'object') {
    const clone = {};
    for (const [key, value] of Object.entries(details)) {
      const lowered = key.toLowerCase();

      if (
        lowered.includes('secret') ||
        lowered.includes('token') ||
        lowered.includes('apikey') ||
        lowered.includes('api_key') ||
        lowered.includes('authorization')
      ) {
        clone[key] = '[redacted]';
      } else if (typeof value === 'string' && value.length > 1000) {
        clone[key] = `${value.slice(0, 1000)}…`;
      } else if (value && typeof value === 'object') {
        clone[key] = safeErrorDetails(value);
      } else {
        clone[key] = value;
      }
    }
    return clone;
  }

  return details;
}

function notFoundHandler(req, _res, next) {
  next(new AppError(`Ruta no encontrada: ${req.method} ${req.path}`, 404, undefined, 'NOT_FOUND'));
}

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const isServerError = statusCode >= 500;
  const isAppError = err instanceof AppError || err.name === 'AppError';

  const payload = {
    success: false,
    error: {
      code: err.code || (isServerError ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: isServerError && !isAppError ? 'Error interno del servidor.' : err.message,
      correlationId: req.correlationId
    }
  };

  const details = safeErrorDetails(err.details);
  if (details) {
    payload.error.details = details;
  }

  const logPayload = {
    correlationId: req.correlationId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    code: payload.error.code,
    message: err.message
  };

  if (isServerError) {
    console.error('[error]', logPayload, err.stack);
  } else {
    console.warn('[warn]', logPayload);
  }

  res.status(statusCode).json(payload);
}

module.exports = {
  AppError,
  notFoundHandler,
  errorHandler
};
