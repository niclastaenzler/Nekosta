// PostgREST-kompatible Schnittstelle (/rest/v1) für supabase-js.
// Übersetzt die Anfragen in SQL und führt sie als Rolle anon/authenticated aus,
// damit die Row-Level-Security-Policies genauso greifen wie in Supabase.
'use strict';

class ApiError extends Error {
  constructor(status, code, message, details, hint) {
    super(message);
    this.status = status; this.code = code; this.details = details || null; this.hint = hint || null;
  }
}

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and', 'not.or', 'not.and']);

// ── Hilfen: Aufteilen auf oberster Ebene (Klammern und Anführungszeichen beachten) ──
function splitTop(s, sep) {
  const out = []; let depth = 0, q = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; } if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out;
}
function unquote(v) {
  v = String(v);
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

// ── select-Parser ────────────────────────────────────────────────────────
function parseSelect(str) {
  str = (str == null || str === '') ? '*' : String(str).replace(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/g, '');
  return splitTop(str, ',').filter(Boolean).map(parseSelectItem);
}
function parseSelectItem(item) {
  const p = item.indexOf('(');
  if (p > 0 && item.endsWith(')')) {
    let head = item.slice(0, p), inner = item.slice(p + 1, -1), alias = null, hint = null, inner_ = false, spread = false;
    if (head.startsWith('...')) { spread = true; head = head.slice(3); }
    const ci = head.indexOf(':'); if (ci > 0) { alias = head.slice(0, ci); head = head.slice(ci + 1); }
    const parts = head.split('!'); const name = parts[0];
    for (const x of parts.slice(1)) { if (x === 'inner') inner_ = true; else if (x === 'left') {} else hint = x; }
    return { kind: 'embed', name, alias: alias || name, hint, inner: inner_, spread, items: parseSelect(inner) };
  }
  if (item === '*') return { kind: 'star' };
  let alias = null, rest = item, cast = null;
  const ci = rest.indexOf(':'); if (ci > 0 && rest[ci + 1] !== ':') { alias = rest.slice(0, ci); rest = rest.slice(ci + 1); }
  const cc = rest.indexOf('::'); if (cc > 0) { cast = rest.slice(cc + 2); rest = rest.slice(0, cc); }
  // JSON-Pfade col->a->>b
  const jm = rest.match(/^([^-]+)((?:->>?[^-]+)+)$/);
  if (jm) {
    const path = []; const re = /(->>?)([^-]+)/g; let m;
    while ((m = re.exec(jm[2]))) path.push({ op: m[1], key: m[2] });
    return { kind: 'col', name: jm[1], path, alias: alias || path[path.length - 1].key, cast };
  }
  return { kind: 'col', name: rest, alias: alias || rest, cast };
}

// ── Filter ───────────────────────────────────────────────────────────────
function parseInList(v) {
  if (!(v.startsWith('(') && v.endsWith(')'))) throw new ApiError(400, 'PGRST100', 'invalid in-list: ' + v);
  const inner = v.slice(1, -1);
  if (inner === '') return [];
  return splitTop(inner, ',').map(unquote);
}

class Query {
  constructor(catalog) { this.catalog = catalog; this.params = []; }
  p(v) { this.params.push(v); return '$' + this.params.length; }
  table(name) {
    const t = this.catalog.tables[name];
    if (!t) throw new ApiError(404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`);
    return t;
  }
  colType(t, col) {
    const ty = t.cols[col];
    if (!ty) throw new ApiError(400, '42703', `column ${t.name}.${col} does not exist`);
    return ty;
  }
  // Ein Filterausdruck "op.wert" (ggf. mit not.) für Spalte col
  cond(t, alias, col, expr) {
    let neg = false;
    if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
    const dot = expr.indexOf('.');
    if (dot < 0) throw new ApiError(400, 'PGRST100', `failed to parse filter (${expr})`);
    let op = expr.slice(0, dot); const val = expr.slice(dot + 1);
    let mod = null; const mm = op.match(/^(\w+)\((any|all)\)$/); if (mm) { op = mm[1]; mod = mm[2]; }
    let colSql, ty;
    const jm = col.match(/^([^-]+)((?:->>?[^-]+)+)$/);
    if (jm) { colSql = `${alias}.${qi(jm[1])}` + jm[2].replace(/(->>?)([^-]+)/g, (_, o, k) => `${o}'${k.replace(/'/g, "''")}'`); this.colType(t, jm[1]); ty = jm[2].includes('->>') ? 'text' : 'jsonb'; }
    else { ty = this.colType(t, col); colSql = `${alias}.${qi(col)}`; }
    const cast = (v) => `${this.p(v)}::${ty}`;
    let sql;
    switch (op) {
      case 'eq': sql = `${colSql} = ${cast(val)}`; break;
      case 'neq': sql = `${colSql} <> ${cast(val)}`; break;
      case 'gt': sql = `${colSql} > ${cast(val)}`; break;
      case 'gte': sql = `${colSql} >= ${cast(val)}`; break;
      case 'lt': sql = `${colSql} < ${cast(val)}`; break;
      case 'lte': sql = `${colSql} <= ${cast(val)}`; break;
      case 'like': case 'ilike': {
        const o = op === 'like' ? 'LIKE' : 'ILIKE';
        if (mod) { const arr = (val.startsWith('{') ? splitTop(val.slice(1, -1), ',') : [val]).map((x) => unquote(x).replace(/\*/g, '%')); sql = `${colSql}::text ${o} ${mod.toUpperCase()}(${this.p(arr)}::text[])`; }
        else sql = `${colSql}::text ${o} ${this.p(unquote(val).replace(/\*/g, '%'))}`;
        break; }
      case 'match': sql = `${colSql}::text ~ ${this.p(val)}`; break;
      case 'imatch': sql = `${colSql}::text ~* ${this.p(val)}`; break;
      case 'is': {
        const v = val.toLowerCase();
        if (!['null', 'true', 'false', 'unknown', 'not_null'].includes(v)) throw new ApiError(400, 'PGRST100', `failed to parse filter (is.${val})`);
        sql = `${colSql} IS ${v === 'not_null' ? 'NOT NULL' : v.toUpperCase()}`; break; }
      case 'isdistinct': sql = `${colSql} IS DISTINCT FROM ${cast(val)}`; break;
      case 'in': sql = `${colSql} = ANY(${this.p(parseInList(val))}::${ty.endsWith('[]') ? 'text' : ty}[])`; break;
      case 'cs': sql = `${colSql} @> ${cast(val)}`; break;
      case 'cd': sql = `${colSql} <@ ${cast(val)}`; break;
      case 'ov': sql = `${colSql} && ${cast(val)}`; break;
      default: throw new ApiError(400, 'PGRST100', `unsupported operator ${op}`);
    }
    return neg ? `NOT (${sql})` : sql;
  }
  // Logikbaum für or=(...)/and=(...)
  logic(t, alias, kind, inner, neg) {
    if (!(inner.startsWith('(') && inner.endsWith(')'))) throw new ApiError(400, 'PGRST100', `failed to parse logic tree (${inner})`);
    const parts = splitTop(inner.slice(1, -1), ',').map((s) => s.trim()).filter(Boolean).map((part) => {
      const lm = part.match(/^(not\.)?(and|or)(\(.*\))$/);
      if (lm) return this.logic(t, alias, lm[2], lm[3], !!lm[1]);
      const d = part.indexOf('.');
      if (d < 0) throw new ApiError(400, 'PGRST100', `failed to parse logic tree (${part})`);
      return this.cond(t, alias, part.slice(0, d), part.slice(d + 1));
    });
    const sql = parts.length ? '(' + parts.join(kind === 'or' ? ' OR ' : ' AND ') + ')' : 'TRUE';
    return neg ? `NOT ${sql}` : sql;
  }
  where(t, alias, sp) {
    const w = [];
    for (const [k, v] of sp) {
      if (k === 'or' || k === 'and') w.push(this.logic(t, alias, k, v, false));
      else if (k === 'not.or' || k === 'not.and') w.push(this.logic(t, alias, k.slice(4), v, true));
      else if (RESERVED.has(k)) continue;
      else if (k.includes('.')) throw new ApiError(400, 'PGRST100', `filters on embedded resources are not supported (${k})`);
      else w.push(this.cond(t, alias, k, v));
    }
    return w;
  }
  orderBy(t, alias, order) {
    if (!order) return '';
    const parts = splitTop(order, ',').filter(Boolean).map((o) => {
      const seg = o.split('.');
      const col = seg[0]; this.colType(t, col);
      let s = `${alias}.${qi(col)}`;
      for (const x of seg.slice(1)) {
        if (x === 'asc') s += ' ASC'; else if (x === 'desc') s += ' DESC';
        else if (x === 'nullsfirst') s += ' NULLS FIRST'; else if (x === 'nullslast') s += ' NULLS LAST';
        else throw new ApiError(400, 'PGRST100', `failed to parse order (${o})`);
      }
      return s;
    });
    return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
  }

  // Relation zwischen parent und eingebetteter Tabelle bestimmen
  relation(parent, emb) {
    const fks = this.catalog.fks;
    const pick = (list) => {
      if (emb.hint) {
        const h = list.filter((f) => f.name === emb.hint || f.src_cols.includes(emb.hint) || f.tgt === emb.hint || f.src === emb.hint);
        if (h.length) return h[0];
      }
      return list[0];
    };
    // Einbettung über den Spaltennamen des Fremdschlüssels (kontakt_id(...))
    const byCol = fks.filter((f) => f.src === parent && f.src_cols.length === 1 && f.src_cols[0] === emb.name);
    if (byCol.length) return { type: 'm2o', fk: byCol[0], target: byCol[0].tgt };
    const target = this.catalog.tables[emb.name] ? emb.name : null;
    if (!target) throw new ApiError(400, 'PGRST200', `Could not find a relationship between '${parent}' and '${emb.name}' in the schema cache`);
    const m2o = fks.filter((f) => f.src === parent && f.tgt === target);
    const o2m = fks.filter((f) => f.src === target && f.tgt === parent);
    if (m2o.length && (!o2m.length || !emb.hint || pick(m2o).name === emb.hint || m2o.some((f) => f.src_cols.includes(emb.hint)))) return { type: 'm2o', fk: pick(m2o), target };
    if (o2m.length) return { type: 'o2m', fk: pick(o2m), target };
    if (m2o.length) return { type: 'm2o', fk: pick(m2o), target };
    throw new ApiError(400, 'PGRST200', `Could not find a relationship between '${parent}' and '${emb.name}' in the schema cache`);
  }

  // Spaltenliste (inkl. eingebetteter Unterabfragen) für alias der Tabelle tname
  columns(tname, alias, items, depth, innerConds) {
    const t = this.table(tname);
    const out = [];
    for (const it of items) {
      if (it.kind === 'star') { out.push(`${alias}.*`); continue; }
      if (it.kind === 'col') {
        this.colType(t, it.name);
        let s = `${alias}.${qi(it.name)}`;
        if (it.path) s += it.path.map((x) => `${x.op}'${x.key.replace(/'/g, "''")}'`).join('');
        if (it.cast) s = `(${s})::${it.cast.replace(/[^a-z0-9_ \[\]]/gi, '')}`;
        out.push(`${s} AS ${qi(it.alias)}`);
        continue;
      }
      const rel = this.relation(tname, it);
      const ca = `_t${depth + 1}_${out.length}`;
      const join = rel.type === 'm2o'
        ? rel.fk.tgt_cols.map((c, i) => `${ca}.${qi(c)} = ${alias}.${qi(rel.fk.src_cols[i])}`).join(' AND ')
        : rel.fk.src_cols.map((c, i) => `${ca}.${qi(c)} = ${alias}.${qi(rel.fk.tgt_cols[i])}`).join(' AND ');
      const sub = `SELECT ${this.columns(rel.target, ca, it.items, depth + 1).join(', ')} FROM public.${qi(rel.target)} ${ca} WHERE ${join}`;
      const sql = rel.type === 'm2o'
        ? `(SELECT row_to_json(_x) FROM (${sub} LIMIT 1) _x)`
        : `(SELECT coalesce(json_agg(_x), '[]'::json) FROM (${sub}) _x)`;
      if (it.inner && innerConds) innerConds.push(`EXISTS (SELECT 1 FROM public.${qi(rel.target)} ${ca} WHERE ${join})`);
      out.push(`${sql} AS ${qi(it.alias)}`);
    }
    return out;
  }
}

function parsePrefer(h) {
  const out = {};
  String(h || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((kv) => { const [k, v] = kv.split('='); out[k.trim()] = (v || '').trim(); });
  return out;
}

// Führt eine REST-Anfrage aus. ctx = { db, catalog, claims, role }
async function handleRest(ctx, req, tableName, sp, bodyJson) {
  const method = req.method;
  const accept = String(req.headers['accept'] || '');
  const wantsObject = accept.includes('application/vnd.pgrst.object');
  const prefer = parsePrefer(req.headers['prefer']);
  const q = new Query(ctx.catalog);
  const t = q.table(tableName);
  const alias = '_t0';
  const select = sp.get('select');
  const items = parseSelect(select);
  const innerConds = [];
  const limit = sp.get('limit'), offset = sp.get('offset');
  const lim = (limit != null ? ` LIMIT ${parseInt(limit, 10) || 0}` : '') + (offset != null ? ` OFFSET ${parseInt(offset, 10) || 0}` : '');

  let sql, cte = '', countSql = null, status = 200;
  const returnRep = prefer['return'] === 'representation';
  if (method === 'GET' || method === 'HEAD') {
    const cols = q.columns(tableName, alias, items, 0, innerConds);
    const where = q.where(t, alias, sp).concat(innerConds);
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    sql = `SELECT ${cols.join(', ')} FROM public.${qi(tableName)} ${alias}${whereSql}${q.orderBy(t, alias, sp.get('order'))}${lim}`;
    if (prefer.count) countSql = `SELECT count(*)::bigint AS n FROM public.${qi(tableName)} ${alias}${whereSql}`;
  } else if (method === 'POST') {
    const rows = Array.isArray(bodyJson) ? bodyJson : [bodyJson || {}];
    let colNames = sp.get('columns') ? splitTop(sp.get('columns'), ',').map(unquote) : [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
    colNames.forEach((c) => q.colType(t, c));
    const missingDefault = prefer.missing === 'default';
    const data = q.p(JSON.stringify(rows));
    let ins;
    if (!colNames.length) ins = `INSERT INTO public.${qi(tableName)} DEFAULT VALUES RETURNING *`;
    else if (missingDefault && rows.some((r) => colNames.some((c) => !(c in (r || {}))))) {
      // NEKOSTA nutzt defaultToNull:false nicht; bewusst klar abweisen statt still NULL zu setzen
      throw new ApiError(400, 'PGRST000', 'missing=default with heterogeneous rows is not supported');
    } else {
      ins = `INSERT INTO public.${qi(tableName)} (${colNames.map(qi).join(',')}) SELECT ${colNames.map(qi).join(',')} FROM jsonb_populate_recordset(null::public.${qi(tableName)}, ${data}::jsonb)`;
      const res = prefer.resolution;
      if (res === 'merge-duplicates' || res === 'ignore-duplicates') {
        const conflict = sp.get('on_conflict') ? splitTop(sp.get('on_conflict'), ',').map((s) => unquote(s.trim())) : (t.pk || []);
        if (!conflict.length) throw new ApiError(400, 'PGRST000', 'upsert requires a primary key or on_conflict');
        const upd = colNames.filter((c) => !conflict.includes(c));
        ins += ` ON CONFLICT (${conflict.map(qi).join(',')}) ` + (res === 'ignore-duplicates' || !upd.length ? 'DO NOTHING' : `DO UPDATE SET ${upd.map((c) => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ')}`);
      }
      ins += ' RETURNING *';
    }
    cte = `WITH _m AS (${ins}) `; sql = `SELECT ${q.columns(tableName, alias, items, 0).join(', ')} FROM _m ${alias}`;
    status = 201;
  } else if (method === 'PATCH') {
    const obj = bodyJson || {};
    const colNames = Object.keys(obj); colNames.forEach((c) => q.colType(t, c));
    if (!colNames.length) throw new ApiError(400, 'PGRST000', 'empty update');
    const where = q.where(t, alias, sp);
    const data = q.p(JSON.stringify(obj));
    const upd = `UPDATE public.${qi(tableName)} ${alias} SET ${colNames.map((c) => `${qi(c)} = _src.${qi(c)}`).join(', ')} FROM jsonb_populate_record(null::public.${qi(tableName)}, ${data}::jsonb) _src${where.length ? ' WHERE ' + where.join(' AND ') : ''} RETURNING ${alias}.*`;
    cte = `WITH _m AS (${upd}) `; sql = `SELECT ${q.columns(tableName, alias, items, 0).join(', ')} FROM _m ${alias}`;
  } else if (method === 'DELETE') {
    const where = q.where(t, alias, sp);
    const del = `DELETE FROM public.${qi(tableName)} ${alias}${where.length ? ' WHERE ' + where.join(' AND ') : ''} RETURNING ${alias}.*`;
    cte = `WITH _m AS (${del}) `; sql = `SELECT ${q.columns(tableName, alias, items, 0).join(', ')} FROM _m ${alias}`;
  } else {
    throw new ApiError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
  }

  const wrapped = `${cte}SELECT coalesce(json_agg(_r), '[]'::json) AS j FROM (${sql}) _r`;
  const result = await runAs(ctx, async (tx) => {
    const r = await tx.query(wrapped, q.params);
    let total = null;
    if (countSql) total = Number((await tx.query(countSql, q.params)).rows[0].n);
    return { rows: r.rows[0].j || [], total };
  });

  let rows = result.rows;
  const headers = {};
  const n = rows.length;
  const total = result.total != null ? result.total : (prefer.count ? n : null);
  const off = parseInt(offset || '0', 10) || 0;
  headers['Content-Range'] = (n ? `${off}-${off + n - 1}` : '*') + '/' + (total != null ? total : '*');

  if (method === 'HEAD') return { status: 200, headers, body: null };
  const mutation = method !== 'GET';
  if (mutation && !returnRep) return { status: method === 'POST' ? 201 : 204, headers, body: null };
  if (wantsObject) {
    if (n !== 1) throw new ApiError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`);
    return { status, headers, body: rows[0] };
  }
  return { status, headers, body: rows };
}

// Transaktion mit Rolle und JWT-Claims – wie PostgREST
async function runAs(ctx, fn) {
  return ctx.db.transaction(async (tx) => {
    if (ctx.role !== 'service_role') {
      const claims = ctx.claims || { role: 'anon' };
      await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true),
        set_config('request.jwt.claim.sub', $3, true), set_config('request.jwt.claim.role', $1, true), set_config('request.jwt.claim.email', $4, true)`,
        [ctx.role, JSON.stringify(claims), claims.sub || '', claims.email || '']);
    }
    return fn(tx);
  });
}

function pgErrorToApi(e) {
  if (e instanceof ApiError) return e;
  const code = e.code || '';
  let status = 400;
  if (code === '23505' || code === '23503') status = 409;
  else if (code === '42501') status = 403;
  else if (code === '42P01') status = 404;
  else if (code === 'P0001') status = 400;
  else if (!code) status = 500;
  return new ApiError(status, code || 'XX000', e.message, e.detail || null, e.hint || null);
}

module.exports = { handleRest, runAs, pgErrorToApi, ApiError, parseSelect, splitTop, parsePrefer };
