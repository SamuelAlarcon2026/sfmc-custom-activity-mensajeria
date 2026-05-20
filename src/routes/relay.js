const express = require('express');
const { AppError } = require('../middleware/errorHandler');
const { renderEmailTemplate, hasBlockingUnresolved } = require('../services/templateRenderService');
const { buildRelayPayload, postToRelay, isEmail, getRelayDiagnostics } = require('../services/relayService');
const { getAssetDetail } = require('../services/contentBuilderService');
const {
  putPreview,
  getPreview,
  ensurePreviewDocument,
  htmlDiagnostics
} = require('../services/previewStoreService');

const router = express.Router();

function buildPreviewUrls(req, previewId) {
  const basePath = `/api/preview-frame/${encodeURIComponent(previewId)}`;
  return {
    desktop: `${basePath}?device=desktop`,
    mobile: `${basePath}?device=mobile`,
    open: `${basePath}?device=desktop&open=1`,
    raw: `/api/preview-frame/${encodeURIComponent(previewId)}/raw`
  };
}


router.get('/relay/diagnostics', async (req, res, next) => {
  try {
    const diagnostics = await getRelayDiagnostics();
    res.json({
      success: true,
      ...diagnostics
    });
  } catch (err) {
    next(err);
  }
});

router.post('/preview', async (req, res, next) => {
  try {
    const result = renderEmailTemplate(req.body || {}, { useSamples: true });
    const diagnostics = htmlDiagnostics(result.html);
    const previewId = putPreview({
      ...result,
      diagnostics
    });

    res.json({
      success: true,
      ...result,
      previewId,
      previewUrls: buildPreviewUrls(req, previewId),
      diagnostics
    });
  } catch (err) {
    next(err);
  }
});

router.get('/preview-frame/:id', async (req, res, next) => {
  try {
    const item = getPreview(req.params.id);

    if (!item) {
      throw new AppError(
        'Preview caducado o no encontrado. Pulsa “Renderizar preview” de nuevo.',
        404,
        undefined,
        'PREVIEW_NOT_FOUND'
      );
    }

    const device = String(req.query.device || 'desktop').toLowerCase() === 'mobile'
      ? 'mobile'
      : 'desktop';

    const html = ensurePreviewDocument(item.html, { mode: device });

    // Cabeceras específicas para el documento del email. Debe poder cargarse dentro
    // del iframe del modal de Journey Builder y también debe poder cargar imágenes externas.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self' https: data: blob:",
        "script-src 'none'",
        "style-src 'self' 'unsafe-inline' https:",
        "img-src 'self' https: data: blob:",
        "font-src 'self' https: data:",
        "connect-src 'none'",
        "frame-ancestors 'self' https://*.exacttarget.com https://*.marketingcloudapps.com https://*.salesforce.com https://*.force.com https://*.salesforce-setup.com https://*.lightning.force.com",
        "object-src 'none'",
        "base-uri 'self'"
      ].join('; ')
    );

    res.status(200).send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/preview-frame/:id/raw', async (req, res, next) => {
  try {
    const item = getPreview(req.params.id);

    if (!item) {
      throw new AppError(
        'Preview caducado o no encontrado. Pulsa “Renderizar preview” de nuevo.',
        404,
        undefined,
        'PREVIEW_NOT_FOUND'
      );
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(item.html || '');
  } catch (err) {
    next(err);
  }
});

router.post('/test-send', async (req, res, next) => {
  try {
    const body = req.body || {};
    const to = String(body.to || '').trim();

    if (!isEmail(to)) {
      throw new AppError('Email de test inválido.', 400, ['Introduce un email de test válido.'], 'INVALID_TEST_EMAIL');
    }

    let html = body.html || '';
    let text = body.text || '';
    let subject = body.subject || '';
    let preheader = body.preheader || '';

    if ((!html && !text) && body.assetId) {
      const asset = await getAssetDetail(String(body.assetId));
      html = asset.html;
      text = asset.text;
      subject = subject || asset.subject;
      preheader = preheader || asset.preheader;
    }

    const rendered = renderEmailTemplate({
      subject,
      preheader,
      html,
      text,
      variableMappings: body.variableMappings,
      sampleData: body.sampleData,
      warnings: body.warnings
    }, { useSamples: true });

    if (hasBlockingUnresolved(rendered)) {
      throw new AppError(
        'No se puede enviar el test porque hay variables obligatorias sin resolver.',
        400,
        rendered.unresolvedVariables,
        'UNRESOLVED_VARIABLES'
      );
    }

    const relayPayload = buildRelayPayload({
      to,
      fromName: body.fromName,
      fromEmail: body.fromEmail,
      replyTo: body.replyTo,
      subject: rendered.subject,
      preheader: rendered.preheader,
      html: rendered.html,
      text: rendered.text,
      metadata: {
        test: true,
        assetId: body.assetId || null,
        correlationId: req.correlationId
      }
    });

    const relayResult = await postToRelay(relayPayload, { correlationId: req.correlationId });

    res.json({
      success: true,
      message: 'Test aceptado por el relay privado.',
      relay: relayResult,
      rendered: {
        subject: rendered.subject,
        preheader: rendered.preheader,
        resolvedVariables: rendered.resolvedVariables,
        unresolvedVariables: rendered.unresolvedVariables,
        warnings: rendered.warnings
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
