// Dokumentablage (/storage/v1) kompatibel zu supabase-js.
// Metadaten liegen in storage.objects (mit RLS wie in Supabase), die Dateien im Datenordner.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');
const jwt = require('./jwt');
const { runAs, ApiError } = require('./rest');

function storageError(status, error, message) { const e = new ApiError(status, error, message); e.storage = true; return e; }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readUpload(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('multipart/form-data')) return readBody(req, limit).then((buf) => ({ buf, mime: ct || 'application/octet-stream', cacheControl: req.headers['cache-control'] }));
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: limit } });
    const out = { fields: {} };
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => reject(storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size')));
      stream.on('end', () => { out.buf = Buffer.concat(chunks); out.mime = info.mimeType || 'application/octet-stream'; });
    });
    bb.on('field', (name, val) => { out.fields[name] = val; });
    bb.on('close', () => { if (!out.buf) out.buf = Buffer.alloc(0); out.cacheControl = out.fields.cacheControl ? 'max-age=' + out.fields.cacheControl : null; resolve(out); });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

function cleanName(p) {
  const s = decodeURIComponent(p).replace(/^\/+/, '');
  if (!s || s.split('/').some((x) => x === '..' || x === '.')) throw storageError(400, 'InvalidKey', 'Invalid key: ' + s);
  return s;
}

function createStorage({ db, dataDir, secret, publicUrl, maxSize }) {
  const root = path.join(dataDir, 'storage');
  fs.mkdirSync(root, { recursive: true });
  const fileOf = (id) => path.join(root, id.slice(0, 2), id);
  const limit = maxSize || 200 * 1024 * 1024;

  async function upload(ctx, req, bucket, name, upsert) {
    const up = await readUpload(req, limit);
    const meta = { size: up.buf.length, mimetype: up.mime, eTag: '"' + crypto.createHash('md5').update(up.buf).digest('hex') + '"', cacheControl: up.cacheControl || 'max-age=3600', lastModified: new Date().toISOString(), contentLength: up.buf.length, httpStatusCode: 200 };
    const row = await runAs(ctx, async (tx) => {
      const ex = (await tx.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, name])).rows[0];
      if (ex && !upsert) throw storageError(409, 'Duplicate', 'The resource already exists');
      if (ex) return (await tx.query('update storage.objects set metadata=$3::jsonb, updated_at=now() where bucket_id=$1 and name=$2 returning id', [bucket, name, JSON.stringify(meta)])).rows[0];
      return (await tx.query('insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values ($1,$2,$3,$4,$5::jsonb) returning id',
        [bucket, name, (ctx.claims && ctx.claims.sub) || null, (ctx.claims && ctx.claims.sub) || null, JSON.stringify(meta)])).rows[0];
    });
    if (!row) throw storageError(403, 'Unauthorized', 'new row violates row-level security policy');
    const f = fileOf(row.id); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', up.buf); fs.renameSync(f + '.tmp', f);
    return { status: 200, body: { Key: bucket + '/' + name, Id: row.id, id: row.id, path: name, fullPath: bucket + '/' + name } };
  }

  async function findVisible(ctx, bucket, name) {
    return runAs(ctx, async (tx) => (await tx.query('select id, metadata from storage.objects where bucket_id=$1 and name=$2', [bucket, name])).rows[0]);
  }

  function serveFile(res, obj, name, download) {
    const f = fileOf(obj.id);
    if (!fs.existsSync(f)) throw storageError(404, 'not_found', 'Object not found');
    const meta = obj.metadata || {};
    const h = { 'Content-Type': meta.mimetype || 'application/octet-stream', 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'no-cache' };
    if (download != null) {
      const fn = download && download !== 'true' ? download : path.basename(name);
      h['Content-Disposition'] = `attachment; filename="${fn.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fn)}`;
    }
    res.writeHead(200, h);
    fs.createReadStream(f).pipe(res);
    return { streamed: true };
  }

  async function list(ctx, bucket, body) {
    const prefix = String(body.prefix || '').replace(/^\/+|\/+$/g, '');
    const lim = Math.min(parseInt(body.limit || 100, 10), 1000), off = parseInt(body.offset || 0, 10);
    const sort = body.sortBy || { column: 'name', order: 'asc' };
    const search = String(body.search || '');
    const rows = await runAs(ctx, async (tx) => (await tx.query(
      `select id, name, created_at, updated_at, last_accessed_at, metadata from storage.objects where bucket_id=$1 and ($2 = '' or left(name, length($2)+1) = $2 || '/') order by name`,
      [bucket, prefix])).rows);
    const seen = new Map();
    for (const r of rows) {
      const rest = prefix ? r.name.slice(prefix.length + 1) : r.name;
      const i = rest.indexOf('/');
      if (i >= 0) { const folder = rest.slice(0, i); if (!seen.has(folder)) seen.set(folder, { name: folder, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }); }
      else seen.set(rest, { name: rest, id: r.id, updated_at: r.updated_at, created_at: r.created_at, last_accessed_at: r.last_accessed_at, metadata: r.metadata });
    }
    let out = [...seen.values()].filter((x) => !search || x.name.toLowerCase().includes(search.toLowerCase()));
    const col = ['name', 'created_at', 'updated_at', 'last_accessed_at'].includes(sort.column) ? sort.column : 'name';
    out.sort((a, b) => String(a[col] || '').localeCompare(String(b[col] || '')) * (String(sort.order).toLowerCase() === 'desc' ? -1 : 1));
    return { status: 200, body: out.slice(off, off + lim) };
  }

  async function remove(ctx, bucket, body) {
    const names = (body.prefixes || []).map((p) => cleanName(p));
    const rows = await runAs(ctx, async (tx) => (await tx.query('delete from storage.objects where bucket_id=$1 and name = any($2::text[]) returning id, name, bucket_id, metadata, created_at, updated_at', [bucket, names])).rows);
    for (const r of rows) { try { fs.unlinkSync(fileOf(r.id)); } catch (e) {} }
    return { status: 200, body: rows };
  }

  async function handle(ctx, req, res, sub, sp, readJson) {
    const m = req.method;
    let mm;
    if ((mm = sub.match(/^object\/sign\/([^/]+)\/(.+)$/))) {
      const bucket = mm[1], name = cleanName(mm[2]);
      if (m === 'POST') {
        const body = await readJson();
        const obj = await findVisible(ctx, bucket, name);
        if (!obj) throw storageError(400, 'not_found', 'Object not found');
        const exp = Math.floor(Date.now() / 1000) + Math.max(1, parseInt(body.expiresIn || 60, 10));
        const token = jwt.sign({ url: bucket + '/' + name, oid: obj.id, iat: Math.floor(Date.now() / 1000), exp }, secret);
        return { status: 200, body: { signedURL: `/object/sign/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}?token=${token}` } };
      }
      if (m === 'GET') {
        const tok = jwt.verify(sp.get('token'), secret);
        if (!tok || tok.url !== bucket + '/' + name) throw storageError(400, 'InvalidJWT', 'invalid signature');
        const obj = (await ctx.db.query('select id, metadata from storage.objects where id=$1', [tok.oid])).rows[0];
        if (!obj) throw storageError(404, 'not_found', 'Object not found');
        return serveFile(res, obj, name, sp.has('download') ? sp.get('download') : null);
      }
    }
    if ((mm = sub.match(/^object\/list\/([^/]+)$/)) && m === 'POST') return list(ctx, mm[1], await readJson());
    if ((mm = sub.match(/^object\/(?:authenticated\/)?([^/]+)\/(.+)$/))) {
      const bucket = mm[1], name = cleanName(mm[2]);
      if (m === 'POST' || m === 'PUT') return upload(ctx, req, bucket, name, m === 'PUT' || String(req.headers['x-upsert']) === 'true');
      if (m === 'GET' || m === 'HEAD') {
        const obj = await findVisible(ctx, bucket, name);
        if (!obj) throw storageError(400, 'not_found', 'Object not found');
        if (m === 'HEAD') return { status: 200, body: null };
        return serveFile(res, obj, name, sp.has('download') ? sp.get('download') : null);
      }
    }
    if ((mm = sub.match(/^object\/([^/]+)$/)) && m === 'DELETE') return remove(ctx, mm[1], await readJson());
    throw storageError(404, 'not_found', 'Route not supported: ' + m + ' ' + sub);
  }

  return { handle, fileOf };
}

module.exports = { createStorage };
