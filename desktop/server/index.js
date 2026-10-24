// NEKOSTA-Server: Datenbank-API, Login, Dokumentablage und die Oberfläche selbst.
// Läuft auf dem Server-PC; Arbeitsplätze im Büronetz verbinden sich per http://<server>:<port>.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { openDatabase, loadCatalog } = require('./db');
const { handleRest, pgErrorToApi, ApiError } = require('./rest');
const { createAuth, AuthError } = require('./auth');
const { createStorage } = require('./storage');
const jwt = require('./jwt');

const MAX_JSON = 50 * 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer,x-client-info,accept-profile,content-profile,range,x-upsert,cache-control,x-supabase-api-version,x-metadata,accept',
  'Access-Control-Expose-Headers': 'content-range,content-disposition',
};

// Externe Bibliotheken der Oberfläche → lokale Kopien (offline-fähig)
const VENDOR = [
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.min\.js/g, '/vendor/supabase.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/g, '/vendor/jspdf.umd.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/3\.10\.1\/jszip\.min\.js/g, '/vendor/jszip.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\/pdf\.min\.js/g, '/vendor/pdf.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\/pdf\.worker\.min\.js/g, '/vendor/pdf.worker.min.js'],
];
const MIME = { '.js': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function loadConfig(dataDir) {
  const f = path.join(dataDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  if (!cfg.jwtSecret) {
    cfg.jwtSecret = crypto.randomBytes(48).toString('base64');
    cfg.createdAt = new Date().toISOString();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

function send(res, status, body, headers) {
  const h = Object.assign({}, CORS, headers || {});
  if (body == null) { res.writeHead(status, h); res.end(); return; }
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (!h['Content-Type']) h['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(status, h); res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_JSON) { reject(new ApiError(413, 'PGRST413', 'Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new ApiError(400, 'PGRST102', 'Empty or invalid json')); }
    });
    req.on('error', reject);
  });
}

async function startServer(opts) {
  const dataDir = opts.dataDir;
  const webRoot = opts.webRoot;
  const cfg = loadConfig(dataDir);
  const db = await openDatabase(dataDir, opts.schemaDir);
  let catalog = await loadCatalog(db);
  const anonKey = jwt.sign({ iss: 'supabase', ref: 'nekosta-local', role: 'anon', iat: Math.floor(Date.parse(cfg.createdAt || '2026-01-01') / 1000), exp: 4102444800 }, cfg.jwtSecret);
  const auth = createAuth({ db, secret: cfg.jwtSecret, issuer: 'nekosta-local/auth/v1', allowSignup: opts.allowSignup !== false });
  const storage = createStorage({ db, dataDir, secret: cfg.jwtSecret });

  // Oberfläche einmal vorbereiten: Cloud-Adresse durch den lokalen Server ersetzen
  let indexCache = null;
  function indexHtml() {
    if (indexCache && !opts.devReload) return indexCache;
    let html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
    html = html.replace(/const SUPABASE_URL='[^']*';/, "const SUPABASE_URL=location.origin;")
      .replace(/const SUPABASE_KEY='[^']*';/, "const SUPABASE_KEY='" + anonKey + "';");
    for (const [re, local] of VENDOR) html = html.replace(re, local);
    html = html.replace('<head>', '<head><script>window.NEKOSTA_LOCAL=' + JSON.stringify({ version: opts.version || 'dev', server: opts.serverName || '' }) + ';</script>');
    indexCache = html;
    return html;
  }

  function context(req) {
    const c = auth.claimsFrom(req);
    if (c && c.role === 'authenticated') return { db, catalog, claims: c, role: 'authenticated' };
    if (c && c.role === 'service_role' && opts.allowServiceRole) return { db, catalog, claims: c, role: 'service_role' };
    if (c && c.role === 'anon') return { db, catalog, claims: c, role: 'anon' };
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (p.startsWith('/rest/v1/')) {
        const ctx = context(req);
        if (!ctx) throw new ApiError(401, 'PGRST301', 'No API key found in request or JWT invalid');
        const table = decodeURIComponent(p.slice('/rest/v1/'.length));
        if (!table) return send(res, 200, { info: 'NEKOSTA local REST' });
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : null;
        const r = await handleRest(ctx, req, table, url.searchParams, body);
        return send(res, r.status, r.body, r.headers);
      }
      if (p.startsWith('/auth/v1/')) {
        const sub = p.slice('/auth/v1/'.length);
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? (await readJson(req)) || {} : {};
        const r = await auth.handle(req, sub, url.searchParams, body);
        return send(res, r.status, r.body);
      }
      if (p.startsWith('/storage/v1/')) {
        const ctx = context(req) || ((p.startsWith('/storage/v1/object/sign/') && req.method === 'GET') ? { db, catalog, role: 'anon', claims: { role: 'anon' } } : null);
        if (!ctx) throw new ApiError(401, 'Unauthorized', 'Invalid JWT');
        const r = await storage.handle(ctx, req, res, p.slice('/storage/v1/'.length), url.searchParams, () => readJson(req).then((b) => b || {}));
        if (r && r.streamed) return;
        return send(res, r.status, r.body);
      }
      if (p === '/__nekosta/info') return send(res, 200, { app: 'NEKOSTA', mode: 'server', name: opts.serverName || '', version: opts.version || 'dev' });
      if (p === '/' || p === '/index.html') return send(res, 200, indexHtml(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      if (p.startsWith('/vendor/') || p.startsWith('/assets/')) {
        const f = path.join(webRoot, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
        if (f.startsWith(webRoot) && fs.existsSync(f) && fs.statSync(f).isFile()) {
          return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
        }
      }
      return send(res, 404, { message: 'Not found' });
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { code: e.status, error_code: e.code, msg: e.message, message: e.message });
      const err = pgErrorToApi(e);
      if (err.status >= 500 || opts.logErrors) console.error('[nekosta]', req.method, p, err.code, err.message);
      if (e.storage || p.startsWith('/storage/v1/')) return send(res, err.status, { statusCode: String(err.status), error: err.code, message: err.message });
      return send(res, err.status, { code: err.code, message: err.message, details: err.details, hint: err.hint });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port || 0, opts.host || '0.0.0.0', resolve); });
  const port = server.address().port;
  return {
    server, db, port, anonKey, auth,
    reloadCatalog: async () => { catalog = await loadCatalog(db); indexCache = null; },
    async close() { await new Promise((r) => server.close(r)); await db.close(); },
  };
}

module.exports = { startServer, VENDOR };
