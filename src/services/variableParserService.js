const VARIABLE_REGEX = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;

function normalizeVariableName(value) {
  return String(value || '').trim();
}

function detectVariables(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input || '');
  const variables = new Set();

  let match;
  VARIABLE_REGEX.lastIndex = 0;
  while ((match = VARIABLE_REGEX.exec(text)) !== null) {
    const variableName = normalizeVariableName(match[1]);
    if (variableName) variables.add(variableName);
  }

  return Array.from(variables).sort((a, b) => a.localeCompare(b));
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMappingValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function findProtectedRanges(html) {
  const ranges = [];
  const pattern = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isIndexProtected(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function buildValuesFromMappings({ variables = [], variableMappings = {}, sampleData = {}, resolvedData = {}, useSamples = false }) {
  const values = {};
  const resolved = [];
  const unresolved = [];

  for (const variable of variables) {
    const mapping = variableMappings[variable] || {};
    let value;

    if (mapping.type === 'fixed') {
      value = mapping.value;
    } else if (Object.prototype.hasOwnProperty.call(resolvedData, variable)) {
      value = resolvedData[variable];
    } else if (Object.prototype.hasOwnProperty.call(resolvedData, `var_${variable}`)) {
      value = resolvedData[`var_${variable}`];
    } else if (Object.prototype.hasOwnProperty.call(sampleData, variable)) {
      value = sampleData[variable];
    } else if (useSamples && Object.prototype.hasOwnProperty.call(mapping, 'sampleValue')) {
      value = mapping.sampleValue;
    } else if (Object.prototype.hasOwnProperty.call(mapping, 'fallbackValue')) {
      value = mapping.fallbackValue;
    }

    const normalized = normalizeMappingValue(value);

    if (normalized !== '') {
      values[variable] = normalized;
      resolved.push({ variable, value: normalized, source: mapping.type || 'sampleData' });
    } else {
      unresolved.push({
        variable,
        required: mapping.required !== false,
        source: mapping.type || 'unmapped'
      });
    }
  }

  return { values, resolved, unresolved };
}

function renderTemplate(template, values = {}, mode = 'text') {
  const input = String(template || '');
  const unresolved = new Set();
  const resolved = [];
  const protectedRanges = mode === 'html' ? findProtectedRanges(input) : [];

  VARIABLE_REGEX.lastIndex = 0;
  const output = input.replace(VARIABLE_REGEX, (fullMatch, rawName, offset) => {
    const variable = normalizeVariableName(rawName);

    if (mode === 'html' && isIndexProtected(offset, protectedRanges)) {
      unresolved.add(variable);
      return fullMatch;
    }

    if (!Object.prototype.hasOwnProperty.call(values, variable) || values[variable] === '') {
      unresolved.add(variable);
      return fullMatch;
    }

    const rawValue = normalizeMappingValue(values[variable]);
    resolved.push(variable);
    return mode === 'html' ? htmlEscape(rawValue) : rawValue;
  });

  return {
    output,
    resolved: Array.from(new Set(resolved)).sort((a, b) => a.localeCompare(b)),
    unresolved: Array.from(unresolved).sort((a, b) => a.localeCompare(b))
  };
}

function sanitizeVariableMappings(input) {
  if (!input || typeof input !== 'object') return {};
  const result = {};

  for (const [rawKey, rawMapping] of Object.entries(input)) {
    const variable = normalizeVariableName(rawKey);
    if (!variable || !/^[A-Za-z0-9_.-]+$/.test(variable)) continue;

    const mapping = rawMapping && typeof rawMapping === 'object' ? rawMapping : {};
    const type = ['fixed', 'journeyData', 'contactData'].includes(mapping.type) ? mapping.type : 'fixed';

    result[variable] = {
      type,
      value: typeof mapping.value === 'string' ? mapping.value : '',
      path: typeof mapping.path === 'string' ? mapping.path : '',
      sampleValue: typeof mapping.sampleValue === 'string' ? mapping.sampleValue : '',
      fallbackValue: typeof mapping.fallbackValue === 'string' ? mapping.fallbackValue : '',
      required: mapping.required !== false
    };
  }

  return result;
}

function buildResolvedDataFromExecute(inArguments = {}) {
  const resolvedData = {};

  if (inArguments.resolvedData && typeof inArguments.resolvedData === 'object') {
    for (const [key, value] of Object.entries(inArguments.resolvedData)) {
      resolvedData[key] = value;
    }
  }

  for (const [key, value] of Object.entries(inArguments)) {
    if (key.startsWith('var_')) {
      resolvedData[key.slice(4)] = value;
      resolvedData[key] = value;
    }
  }

  return resolvedData;
}

module.exports = {
  VARIABLE_REGEX,
  normalizeVariableName,
  detectVariables,
  htmlEscape,
  buildValuesFromMappings,
  renderTemplate,
  sanitizeVariableMappings,
  buildResolvedDataFromExecute
};