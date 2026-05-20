const crypto = require('crypto');

const DEFAULT_TTL_MS = Number(process.env.PREVIEW_TTL_MS || 10 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.PREVIEW_MAX_ENTRIES || 100);

const store = new Map();

function now() {
  return Date.now();
}

function cleanup() {
  const current = now();

  for (const [id, item] of store.entries()) {
    if (!item || item.expiresAt <= current) {
      store.delete(id);
    }
  }

  while (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) break;
    store.delete(oldestKey);
  }
}

function putPreview(rendered) {
  cleanup();

  const id = crypto.randomUUID();
  const createdAt = now();

  store.set(id, {
    id,
    createdAt,
    expiresAt: createdAt + DEFAULT_TTL_MS,
    subject: rendered.subject || '',
    preheader: rendered.preheader || '',
    html: rendered.html || '',
    text: rendered.text || '',
    diagnostics: rendered.diagnostics || {}
  });

  return id;
}

function getPreview(id) {
  cleanup();

  const item = store.get(String(id || ''));
  if (!item) return null;

  if (item.expiresAt <= now()) {
    store.delete(item.id);
    return null;
  }

  return item;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripDangerousHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*'\s*javascript:[^']*'/gi, " $1=\"#\"");
}

function ensurePreviewDocument(html, options = {}) {
  const mode = options.mode || 'desktop';
  let value = stripDangerousHtml(String(html || ''));

  if (!value.trim()) {
    value = '<div style="font-family:Arial,sans-serif;padding:24px;color:#3e3e3c;">No hay HTML renderizable para este asset.</div>';
  }

  const injectedHead = [
    '<base target="_blank">',
    '<meta name="preview-mode" content="', escapeHtml(mode), '">',
    '<style>',
    'html,body{min-height:100%;background:#fff;}',
    'img{max-width:100%;height:auto;}',
    'a{cursor:pointer;}',
    mode === 'mobile'
      ? 'body{max-width:390px!important;margin:0 auto!important;overflow-x:auto!important;}'
      : 'body{margin:0 auto!important;overflow-x:auto!important;}',
    '</style>'
  ].join('');

  if (/<head\b[^>]*>/i.test(value)) {
    value = value.replace(/<head\b([^>]*)>/i, '<head$1>' + injectedHead);
  } else if (/<html\b[^>]*>/i.test(value)) {
    value = value.replace(/<html\b([^>]*)>/i, '<html$1><head>' + injectedHead + '</head>');
  } else {
    value = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      injectedHead,
      '</head>',
      '<body>',
      value,
      '</body>',
      '</html>'
    ].join('');
  }

  if (!/<meta\s+charset=/i.test(value)) {
    value = value.replace(/<head\b([^>]*)>/i, '<head$1><meta charset="utf-8">');
  }

  if (!/<meta\s+name=["']viewport["']/i.test(value)) {
    value = value.replace(
      /<head\b([^>]*)>/i,
      '<head$1><meta name="viewport" content="width=device-width, initial-scale=1">'
    );
  }

  return value;
}

function htmlDiagnostics(html) {
  const value = String(html || '');
  const withoutScripts = stripDangerousHtml(value);
  const visibleText = withoutScripts
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const imgCount = (value.match(/<img\b/gi) || []).length;
  const tableCount = (value.match(/<table\b/gi) || []).length;

  return {
    htmlLength: value.length,
    visibleTextLength: visibleText.length,
    imgCount,
    tableCount,
    hasHtmlTag: /<html[\s>]/i.test(value),
    hasBodyTag: /<body[\s>]/i.test(value),
    startsWith: value.trim().slice(0, 120)
  };
}

module.exports = {
  putPreview,
  getPreview,
  ensurePreviewDocument,
  htmlDiagnostics
};
