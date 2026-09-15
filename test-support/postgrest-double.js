'use strict';
/**
 * A PostgREST stand-in for public.outreach_leads that evaluates requests the way
 * PostgREST does.
 *
 * WHY THIS EXISTS
 *
 * In production every canonical outreach write failed with "lead not found in
 * Supabase". The canonical store sent `lead_id=eq."<id>"`, and PostgREST takes
 * everything after `eq.` as the literal value, so it searched for an id that
 * begins and ends with a quote character and matched nothing. The Stage 3F
 * double answered every GET with the row whatever the filter said, so the suite
 * was green while production could not write a single lead.
 *
 * A double that ignores filters cannot catch a filter bug. This one follows
 * PostgREST's rules:
 *
 *   * the query string is decoded with form semantics: pairs split on `&`, name
 *     and value split at the first `=`, `+` becomes a space, and percent-escapes
 *     are decoded
 *   * a top-level `column=op.value` filter takes the value LITERALLY; quotes are
 *     not stripped
 *   * double quotes are parsed only inside `in.(...)`, with backslash escapes
 *   * filters AND together; an unknown column, an unknown operator or a value
 *     that does not cast to the column type is a 400
 *   * a comparison with NULL selects nothing, negated or not
 *   * PATCH changes exactly the rows the filters match, refuses to run with no
 *     filter at all (Supabase's safeupdate), and returns rows only under
 *     `Prefer: return=representation`
 *   * a POST under `resolution=merge-duplicates` merges on the primary key and
 *     touches only the columns present in the payload; a batch must share one
 *     key set
 *   * email_normalized is GENERATED (never writable), and its partial unique
 *     index is enforced
 *
 * It lives outside test/ on purpose: `node --test` runs every .js file under a
 * test/ directory, and a helper there would be counted as a test file.
 */

const http = require('node:http');

const TABLE = 'outreach_leads';
const PRIMARY_KEY = 'lead_id';
const DEFAULT_SECRET = 'sb_secret_TESTONLY_not_a_real_key';

// public.outreach_leads, from supabase/migrations/20260912000000_outreach_leads.sql
const TEXT_COLUMNS = Object.freeze([
  'lead_id', 'company', 'contact_name', 'email', 'city', 'trade_type', 'website',
  'stage', 'email_status', 'last_emailed_at', 'email_step', 'notes', 'review_count',
  'rating', 'tier', 'site_context', 'campaign', 'campaign_notes', 'enrichment_attempted',
  'lead_niche', 'sender_inbox_id', 'email_template_id', 'routing_required',
  'intended_campaign_version',
]);
const INTEGER_COLUMNS = Object.freeze(['email_step_int', 'sheet_row', 'revision']);
const TIMESTAMP_COLUMNS = Object.freeze(['last_emailed_at_ts', 'created_at', 'updated_at', 'mirrored_at']);
const GENERATED = Object.freeze({
  // lower(btrim(coalesce(email, ''))) — btrim with no argument strips spaces only.
  email_normalized: row => String(row.email === null || row.email === undefined ? '' : row.email)
    .replace(/^ +| +$/g, '').toLowerCase(),
});
const COLUMNS = Object.freeze([
  ...TEXT_COLUMNS, ...Object.keys(GENERATED), ...INTEGER_COLUMNS, ...TIMESTAMP_COLUMNS,
]);
const NOT_NULL = new Set(['lead_id', 'revision', 'created_at', 'updated_at', 'mirrored_at']);
const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is']);

// Row identity survives a commit, so a test holding a row object sees what landed.
const IDENTITY = Symbol('row identity');

class PostgrestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new PostgrestError(status, code, message); };
const isNull = value => value === null || value === undefined;

function assertColumn(column) {
  if (!COLUMNS.includes(column)) fail(400, '42703', `column ${TABLE}.${column} does not exist`);
}

/** Cast a filter literal to the column type, as Postgres would. */
function castLiteral(column, literal) {
  if (INTEGER_COLUMNS.includes(column)) {
    if (!/^[+-]?\d+$/.test(literal)) fail(400, '22P02', `invalid input syntax for type bigint: "${literal}"`);
    return Number(literal);
  }
  if (TIMESTAMP_COLUMNS.includes(column)) {
    const ms = Date.parse(literal);
    if (!Number.isFinite(ms)) fail(400, '22007', `invalid input syntax for type timestamp with time zone: "${literal}"`);
    return ms;
  }
  return literal;
}

function cellValue(column, cell) {
  if (isNull(cell)) return null;
  if (INTEGER_COLUMNS.includes(column)) return Number(cell);
  if (TIMESTAMP_COLUMNS.includes(column)) return Date.parse(cell);
  return String(cell);
}

/**
 * The element list of `in.(...)` — the one place PostgREST parses double quotes
 * in a filter value. A quoted element may hold commas and parentheses; a
 * backslash escapes the next character.
 */
function parseInList(literal) {
  const malformed = () => fail(400, 'PGRST100', `failed to parse filter (in.${literal})`);
  if (!literal.startsWith('(') || !literal.endsWith(')')) malformed();
  const body = literal.slice(1, -1);
  const items = [];
  if (!body.length) return items;
  let i = 0;
  for (;;) {
    let item = '';
    if (body[i] === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\' && i + 1 < body.length) i++;
        item += body[i++];
      }
      if (body[i] !== '"') malformed();
      i++;
      if (i < body.length && body[i] !== ',') malformed();
    } else {
      while (i < body.length && body[i] !== ',') {
        if (body[i] === ')') malformed();
        item += body[i++];
      }
    }
    items.push(item);
    if (i >= body.length) break;
    i++;                                   // the separating comma
    if (i === body.length) { items.push(''); break; }
  }
  return items;
}

function parseFilter(column, expression) {
  assertColumn(column);
  let rest = expression;
  let negate = false;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = dot === -1 ? rest : rest.slice(0, dot);
  if (dot === -1 || !OPERATORS.has(op)) fail(400, 'PGRST100', `failed to parse filter (${expression})`);
  // Everything after the operator is the value, taken LITERALLY. PostgREST does
  // not unquote here: `eq."x"` compares against the three characters "x".
  const literal = rest.slice(dot + 1);
  if (op === 'in') return { column, op, negate, values: parseInList(literal).map(v => castLiteral(column, v)) };
  if (op === 'is') {
    if (literal.toLowerCase() !== 'null') fail(400, 'PGRST100', `failed to parse filter (${expression})`);
    return { column, op, negate, value: null };
  }
  return { column, op, negate, value: castLiteral(column, literal) };
}

function matches(row, filter) {
  const cell = cellValue(filter.column, row[filter.column]);
  if (filter.op === 'is') return filter.negate ? cell !== null : cell === null;
  // SQL three-valued logic: comparing with NULL is unknown, and neither the
  // comparison nor its negation selects the row.
  if (cell === null) return false;
  let result;
  switch (filter.op) {
    case 'eq': result = cell === filter.value; break;
    case 'neq': result = cell !== filter.value; break;
    case 'gt': result = cell > filter.value; break;
    case 'gte': result = cell >= filter.value; break;
    case 'lt': result = cell < filter.value; break;
    case 'lte': result = cell <= filter.value; break;
    case 'in': result = filter.values.includes(cell); break;
    default: result = false;
  }
  return filter.negate ? !result : result;
}

function nonNegative(name, value) {
  if (!/^\d+$/.test(value)) fail(400, 'PGRST100', `failed to parse ${name} (${value})`);
  return Number(value);
}

function readParams(params) {
  const filters = [];
  let select = null;
  let order = null;
  let limit = null;
  let offset = 0;
  for (const [name, value] of params) {
    if (name === 'select') select = value;
    else if (name === 'order') order = value;
    else if (name === 'limit') limit = nonNegative('limit', value);
    else if (name === 'offset') offset = nonNegative('offset', value);
    else if (RESERVED_PARAMS.has(name)) continue;
    else filters.push(parseFilter(name, value));
  }
  return { filters, select, order, limit, offset };
}

function sortRows(rows, order) {
  const keys = order.split(',').map(term => {
    const [column, ...modifiers] = term.split('.');
    assertColumn(column);
    const desc = modifiers.includes('desc');
    const nullsFirst = modifiers.includes('nullsfirst') ? true
      : modifiers.includes('nullslast') ? false : desc;   // Postgres default
    return { column, desc, nullsFirst };
  });
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const x = cellValue(key.column, a[key.column]);
      const y = cellValue(key.column, b[key.column]);
      if (x === y) continue;
      if (x === null) return key.nullsFirst ? -1 : 1;
      if (y === null) return key.nullsFirst ? 1 : -1;
      const cmp = x < y ? -1 : 1;
      return key.desc ? -cmp : cmp;
    }
    return 0;
  });
}

function project(rows, select) {
  if (!select || select === '*') return rows.map(row => ({ ...row }));
  const columns = select.split(',').map(s => s.trim());
  columns.forEach(assertColumn);
  return rows.map(row => Object.fromEntries(columns.map(c => [c, isNull(row[c]) ? null : row[c]])));
}

function validateWrite(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(400, 'PGRST102', 'Invalid body');
  for (const [column, value] of Object.entries(object)) {
    if (!COLUMNS.includes(column)) {
      fail(400, 'PGRST204', `Could not find the '${column}' column of '${TABLE}' in the schema cache`);
    }
    if (Object.prototype.hasOwnProperty.call(GENERATED, column)) {
      fail(400, '428C9', `column "${column}" can only be updated to DEFAULT`);
    }
    if (isNull(value)) {
      if (NOT_NULL.has(column)) fail(400, '23502', `null value in column "${column}" violates not-null constraint`);
      continue;
    }
    if (INTEGER_COLUMNS.includes(column)
      && !(Number.isInteger(value) || (typeof value === 'string' && /^[+-]?\d+$/.test(value)))) {
      fail(400, '22P02', `invalid input syntax for type integer: "${value}"`);
    }
    if (TIMESTAMP_COLUMNS.includes(column) && !Number.isFinite(Date.parse(value))) {
      fail(400, '22007', `invalid input syntax for type timestamp with time zone: "${value}"`);
    }
  }
}

function storeValue(column, value) {
  if (isNull(value)) return null;
  if (INTEGER_COLUMNS.includes(column)) return Number(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function createPostgrestDouble({ rows = [], secret = DEFAULT_SECRET } = {}) {
  const table = new Map();
  const requests = [];
  const hooks = {
    /** async ({ method, row }) => void — runs before a PATCH/POST is evaluated. */
    beforeWrite: null,
    /** async (request) => ({ status, body }) | null — answer a request yourself. */
    intercept: null,
  };
  let identities = 0;

  function newRow(object, now) {
    const row = Object.fromEntries(COLUMNS.map(column => [column, null]));
    Object.assign(row, { revision: 1, created_at: now, updated_at: now, mirrored_at: now });
    for (const [column, value] of Object.entries(object)) row[column] = storeValue(column, value);
    row[IDENTITY] = ++identities;
    return row;
  }

  /** Work on copies so a failed constraint leaves the table untouched. */
  const stage = () => [...table.values()].map(row => ({ ...row }));

  function commit(staged) {
    for (const row of staged) {
      for (const [column, derive] of Object.entries(GENERATED)) row[column] = derive(row);
    }
    const ids = new Set();
    const emails = new Set();
    for (const row of staged) {
      if (isNull(row.lead_id)) fail(400, '23502', 'null value in column "lead_id" violates not-null constraint');
      if (ids.has(row.lead_id)) fail(409, '23505', 'duplicate key value violates unique constraint "outreach_leads_pkey"');
      ids.add(row.lead_id);
      // Partial index: WHERE email_normalized <> ''
      if (row.email_normalized) {
        if (emails.has(row.email_normalized)) {
          fail(409, '23505', 'duplicate key value violates unique constraint "outreach_leads_email_normalized_key"');
        }
        emails.add(row.email_normalized);
      }
    }
    const live = new Map([...table.values()].map(row => [row[IDENTITY], row]));
    table.clear();
    for (const row of staged) {
      const target = live.has(row[IDENTITY]) ? Object.assign(live.get(row[IDENTITY]), row) : row;
      table.set(target.lead_id, target);
    }
  }

  function seed(list) {
    const now = new Date().toISOString();
    const staged = stage();
    for (const object of list) {
      validateWrite(object);
      staged.push(newRow(object, now));
    }
    commit(staged);
  }

  function read(request) {
    const { filters, select, order, limit, offset } = readParams(request.params);
    let selected = [...table.values()].filter(row => filters.every(f => matches(row, f)));
    if (order) selected = sortRows(selected, order);
    const total = selected.length;
    selected = selected.slice(offset, limit === null ? undefined : offset + limit);
    const counted = request.prefer.includes('count=exact') ? total : '*';
    const range = selected.length ? `${offset}-${offset + selected.length - 1}/${counted}` : `*/${counted}`;
    return { rows: project(selected, select), headers: { 'content-range': range } };
  }

  function patch(request) {
    const body = request.body ? parseJson(request.body) : {};
    validateWrite(body);
    const { filters, select } = readParams(request.params);
    if (!filters.length) fail(400, '21000', 'UPDATE requires a WHERE clause');
    const staged = stage();
    const targets = staged.filter(row => filters.every(f => matches(row, f)));
    for (const row of targets) {
      for (const [column, value] of Object.entries(body)) row[column] = storeValue(column, value);
    }
    commit(staged);
    const committed = targets.map(row => table.get(row.lead_id));
    return request.prefer.includes('return=representation')
      ? { status: 200, rows: project(committed, select) }
      : { status: 204 };
  }

  function post(request) {
    const body = parseJson(request.body);
    const objects = Array.isArray(body) ? body : [body];
    objects.forEach(validateWrite);
    // PostgREST derives ONE column list for the whole batch from the payload.
    const keySet = objects.length ? JSON.stringify(Object.keys(objects[0]).sort()) : '';
    if (objects.some(object => JSON.stringify(Object.keys(object).sort()) !== keySet)) {
      fail(400, 'PGRST102', 'All object keys must match');
    }
    const conflictTarget = new Map(request.params).get('on_conflict') || PRIMARY_KEY;
    if (conflictTarget !== PRIMARY_KEY) {
      fail(400, '42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
    }
    const merge = request.prefer.includes('resolution=merge-duplicates');
    const ignore = request.prefer.includes('resolution=ignore-duplicates');
    const now = new Date().toISOString();
    const staged = stage();
    const written = [];
    for (const object of objects) {
      const existing = isNull(object.lead_id) ? null
        : staged.find(row => row.lead_id === String(object.lead_id));
      if (existing) {
        if (ignore) continue;
        if (!merge) fail(409, '23505', 'duplicate key value violates unique constraint "outreach_leads_pkey"');
        for (const [column, value] of Object.entries(object)) existing[column] = storeValue(column, value);
        written.push(existing);
      } else {
        const row = newRow(object, now);
        staged.push(row);
        written.push(row);
      }
    }
    commit(staged);
    const committed = written.map(row => table.get(row.lead_id));
    return request.prefer.includes('return=representation')
      ? { status: 201, rows: project(committed, null) }
      : { status: 201 };
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch { return fail(400, 'PGRST102', 'Empty or invalid json'); }
  }

  function send(res, status, payload, headers = {}) {
    if (payload === undefined) { res.writeHead(status, headers); res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(payload));
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const q = req.url.indexOf('?');
      const request = {
        method: req.method,
        url: req.url,
        pathname: q === -1 ? req.url : req.url.slice(0, q),
        // PostgREST's HTTP layer decodes with form semantics; URLSearchParams
        // implements exactly that, including `+` as a space.
        params: [...new URLSearchParams(q === -1 ? '' : req.url.slice(q + 1)).entries()],
        prefer: String(req.headers.prefer || '').split(',').map(s => s.trim()).filter(Boolean),
        body: raw,
      };
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      requests.push({ ...request, json });
      try {
        if (hooks.intercept) {
          const answer = await hooks.intercept(request);
          if (answer) { send(res, answer.status, answer.body); return; }
        }
        if (req.headers.apikey !== secret) fail(401, 'PGRST301', 'Invalid API key');
        if (request.pathname !== `/rest/v1/${TABLE}`) {
          fail(404, 'PGRST205', `Could not find the table '${request.pathname}' in the schema cache`);
        }
        if ((req.method === 'PATCH' || req.method === 'POST') && hooks.beforeWrite) {
          await hooks.beforeWrite({ method: req.method, row: id => table.get(id) });
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          const { rows: out, headers } = read(request);
          send(res, 200, req.method === 'HEAD' ? undefined : out, headers);
          return;
        }
        if (req.method === 'PATCH') {
          const result = patch(request);
          send(res, result.status, result.rows);
          return;
        }
        if (req.method === 'POST') {
          const result = post(request);
          send(res, result.status, result.rows);
          return;
        }
        fail(405, 'PGRST117', `Unsupported HTTP method: ${req.method}`);
      } catch (error) {
        if (error instanceof PostgrestError) send(res, error.status, { code: error.code, message: error.message });
        else send(res, 500, { message: (error && error.message) || 'double failed' });
      }
    });
  });

  seed(rows);

  return {
    table, requests, hooks, seed,
    row: id => table.get(id),
    async start(extraEnv = {}) {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return {
        SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
        SUPABASE_SECRET_KEY: secret,
        ...extraEnv,
      };
    },
    async stop() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createPostgrestDouble, parseInList, TABLE, COLUMNS, DEFAULT_SECRET };
