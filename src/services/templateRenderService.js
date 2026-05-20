const {
  detectVariables,
  buildValuesFromMappings,
  renderTemplate,
  sanitizeVariableMappings
} = require('./variableParserService');

function uniqueWarnings(warnings) {
  return Array.from(new Set((warnings || []).filter(Boolean)));
}

function renderEmailTemplate(payload = {}, options = {}) {
  const subject = String(payload.subject || '');
  const preheader = String(payload.preheader || '');
  const html = String(payload.html || '');
  const text = String(payload.text || '');

  const variableMappings = sanitizeVariableMappings(payload.variableMappings || {});
  const sampleData = payload.sampleData && typeof payload.sampleData === 'object' ? payload.sampleData : {};
  const resolvedData = payload.resolvedData && typeof payload.resolvedData === 'object' ? payload.resolvedData : {};

  const variables = detectVariables([subject, preheader, html, text].join('\n'));

  const { values, resolved, unresolved } = buildValuesFromMappings({
    variables,
    variableMappings,
    sampleData,
    resolvedData,
    useSamples: options.useSamples !== false
  });

  const renderedSubject = renderTemplate(subject, values, 'text');
  const renderedPreheader = renderTemplate(preheader, values, 'text');
  const renderedHtml = renderTemplate(html, values, 'html');
  const renderedText = renderTemplate(text, values, 'text');

  const unresolvedByRenderer = new Set([
    ...renderedSubject.unresolved,
    ...renderedPreheader.unresolved,
    ...renderedHtml.unresolved,
    ...renderedText.unresolved
  ]);

  const unresolvedFinal = unresolved.map((item) => ({
    ...item,
    inTemplate: unresolvedByRenderer.has(item.variable)
  }));

  for (const variable of unresolvedByRenderer) {
    if (!unresolvedFinal.some((item) => item.variable === variable)) {
      unresolvedFinal.push({ variable, required: true, source: 'protected-or-unresolved', inTemplate: true });
    }
  }

  const warnings = uniqueWarnings([
    ...(payload.warnings || []),
    html.match(/%%\[|%%=|%%[A-Za-z0-9_.-]+%%/) || text.match(/%%\[|%%=|%%[A-Za-z0-9_.-]+%%/)
      ? 'Se detectó AMPscript o personalization strings. No se ejecutan fuera del motor nativo de SFMC.'
      : null,
    renderedHtml.unresolved.length
      ? 'Algunas variables HTML no se resolvieron o estaban dentro de script/style protegidos.'
      : null
  ]);

  return {
    subject: renderedSubject.output,
    preheader: renderedPreheader.output,
    html: renderedHtml.output,
    text: renderedText.output,
    variables,
    resolvedVariables: resolved,
    unresolvedVariables: unresolvedFinal.sort((a, b) => a.variable.localeCompare(b.variable)),
    warnings
  };
}

function hasBlockingUnresolved(renderResult) {
  return (renderResult.unresolvedVariables || []).some((item) => item.required !== false);
}

module.exports = {
  renderEmailTemplate,
  hasBlockingUnresolved
};