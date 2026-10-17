'use strict';
const { AGENT, VERSION, MODE } = require('./config');
const CLASSIFICATIONS = ['HIGH', 'MEDIUM', 'ICP_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'RETRIEVAL_FAILURE'];
const string = { type: 'string', maxLength: 4000 };
const strings = { type: 'array', maxItems: 40, items: string };
const confidence = { type: 'number', minimum: 0, maximum: 1 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const FACT_FIELDS = ['companyName', 'domain', 'companyType', 'industriesServed', 'rolesStaffed', 'geographies', 'services', 'targetCustomers', 'summary'];
const researchSchema = object({
  companyName: string, domain: string, companyType: string,
  industriesServed: strings, rolesStaffed: strings, geographies: strings, services: strings, targetCustomers: strings, summary: string,
  evidence: { type: 'array', maxItems: 120, items: object({
    claim: string, field: { ...string, enum: FACT_FIELDS }, source: string,
    sourceType: { ...string, enum: ['website', 'existing_data'] }, quote: string, confidence,
  }) },
});
const fitSchema = object({ campaignId: string, classification: { ...string, enum: CLASSIFICATIONS },
  confidence, reasons: strings, disqualifiers: strings, evidenceIndexes: { type: 'array', maxItems: 120, items: { type: 'integer', minimum: 0 } } });
const outputSchema = object({ agent: { const: AGENT }, version: { const: VERSION }, mode: { const: MODE },
  companyResearch: researchSchema, campaignFit: fitSchema, warnings: strings });

function validate(value, schema, path = '$') {
  const fail = () => { throw new Error(`INVALID_OUTPUT:${path}`); };
  if ('const' in schema && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    if (Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) fail();
    for (const k of schema.required) {
      if (!Object.hasOwn(value, k)) fail();
      validate(value[k], schema.properties[k], `${path}.${k}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail();
    value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > schema.maxLength) fail();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))
      || value < schema.minimum || (schema.maximum !== undefined && value > schema.maximum)) fail();
  }
  return value;
}
function parseMessage(message, schema) {
  const reject = (code, stage) => { throw Object.assign(new Error(code), { stage }); };
  if (message?.stop_reason !== 'end_turn' || !Array.isArray(message.content)
    || !message.content.length || message.content.some(c => c?.type !== 'text' || typeof c.text !== 'string')) {
    reject('INVALID_MODEL_RESPONSE', 'response_envelope');
  }
  let text = message.content.map(c => c.text).join('\n').trim();
  // Only an entire, known Markdown wrapper is recoverable. Never extract a JSON
  // substring from prose, combine objects, repair syntax or invent field values.
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fence) text = fence[1];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { reject('MALFORMED_MODEL_JSON', 'json_parse'); }
  try { return validate(parsed, schema); }
  catch (error) { error.stage = 'schema_validation'; throw error; }
}
function validateResearch(research, sources) {
  validate(research, researchSchema);
  for (const e of research.evidence) {
    const source = sources.find(s => s.id === e.source && s.sourceType === e.sourceType);
    if (!source || !e.quote.trim() || !source.text.includes(e.quote) || !e.claim.trim()) throw new Error('UNSUPPORTED_EVIDENCE');
    const values = Array.isArray(research[e.field]) ? research[e.field] : [research[e.field]];
    if (!values.includes(e.claim)) throw new Error('UNLINKED_EVIDENCE');
  }
  for (const field of FACT_FIELDS) {
    const values = Array.isArray(research[field]) ? research[field] : [research[field]];
    if (values.filter(Boolean).some(claim => !research.evidence.some(e => e.field === field && e.claim === claim))) {
      throw new Error('UNCITED_RESEARCH_CLAIM');
    }
  }
  return research;
}
function validateFit(fit, campaignId, research) {
  validate(fit, fitSchema);
  if (fit.campaignId !== campaignId || fit.evidenceIndexes.some(i => i >= research.evidence.length)) throw new Error('INVALID_FIT_REFERENCE');
  if (['HIGH', 'MEDIUM', 'ICP_MISMATCH'].includes(fit.classification) && (!fit.evidenceIndexes.length || !fit.reasons.length)) throw new Error('UNEVIDENCED_FIT');
  if (fit.classification === 'ICP_MISMATCH' && !fit.disqualifiers.length) throw new Error('UNEVIDENCED_MISMATCH');
  if (fit.classification === 'HIGH' && !fit.evidenceIndexes.some(i => research.evidence[i].sourceType === 'website')) throw new Error('HIGH_REQUIRES_WEBSITE');
  return fit;
}
function emptyResearch() {
  return { companyName: '', domain: '', companyType: '', industriesServed: [], rolesStaffed: [], geographies: [], services: [], targetCustomers: [], summary: '', evidence: [] };
}
module.exports = { CLASSIFICATIONS, researchSchema, fitSchema, outputSchema, validate, parseMessage, validateResearch, validateFit, emptyResearch };
