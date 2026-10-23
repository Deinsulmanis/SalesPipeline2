'use strict';

// Anthropic accepts structure/enums, but not these V1 length/range constraints.
// Keep them as formatting guidance on the wire AND enforce the original schema
// locally. Do not use SDK 0.107's default transformer: it demotes enums to prose.
function providerFormat(schema) {
  function convert(node) {
    const result = structuredClone(node);
    const constraints = [];
    for (const key of ['maxLength', 'maxItems', 'minimum', 'maximum']) {
      if (Object.hasOwn(result, key)) {
        constraints.push(`${key}: ${JSON.stringify(result[key])}`);
        delete result[key];
      }
    }
    if (constraints.length) result.description = [result.description, constraints.join('; ')].filter(Boolean).join('\n');
    if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, convert(value)]));
    if (result.items) result.items = convert(result.items);
    return result;
  }
  return { type: 'json_schema', schema: convert(schema) };
}

module.exports = { providerFormat };
