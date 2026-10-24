// Import-Assistent: kopiert alle für einen Cloud-Benutzer sichtbaren Daten und Dokumente
// einmalig in die lokale Datenbank. Wiederholbar: bereits vorhandene Zeilen/Dateien bleiben unverändert.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const PAGE = 1000;
const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// Tabellen so sortieren, dass referenzierte Tabellen zuerst kommen
function topoOrder(tables, fks) {
  const deps = {}; tables.forEach((t) => { deps[t] = new Set(); });
  fks.forEach((f) => { if (deps[f.src] && deps[f.tgt] && f.src !== f.tgt) deps[f.src].add(f.tgt); });
  const out = [], seen = {}, visiting = {};
  const visit = (t) => { if (seen[t]) return; if (visiting[t]) return; visiting[t] = 1; deps[t].forEach(visit); seen[t] = 1; out.push(t); };
  tables.slice().sort().forEach(visit);
  return out;
}

async function localColumns(db) {
  const r = await db.query(`select c.relname as tbl, a.attname as col, a.attgenerated <> '' as generated, a.attidentity as identity, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
    and c.relname not like '\\_nekosta%' order by c.relname, a.attnum`);
  const t = {};
  for (const x of r.rows) (t[x.tbl] = t[x.tbl] || []).push(x);
  return t;
}

async function authUserRefs(db) {
  return (await db.query(`select c.relname as tbl, a.attname as col from pg_constraint con
    join pg_class c on c.oid=con.conrelid join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
    where con.contype='f' and con.confrelid='auth.users'::regclass and c.relnamespace='public'::regnamespace and array_length(con.conkey,1)=1`)).rows;
}

async function pkOf(db, tbl) {
  const r = await db.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
    where i.indrelid=('public.'||quote_ident($1))::regclass and i.indisprimary`, [tbl]);
  return r.rows.map((x) => x.attname);
}

async function importFromCloud(opts) {
  const { db, dataDir, cloudUrl, cloudKey, email, password } = opts;
  const log = opts.onProgress || (() => {});
  const fetchImpl = opts.fetch;
  const cloud = createClient(cloudUrl, cloudKey, { auth: { persistSession: false, autoRefreshToken: false }, global: fetchImpl ? { fetch: fetchImpl } : undefined });
  const report = { tables: [], files: { found: 0, copied: 0, skipped: 0, failed: [] }, placeholders: 0, warnings: [] };

  log({ step: 'login', text: 'Anmeldung bei der Cloud …' });
  const li = await cloud.auth.signInWithPassword({ email, password });
  if (li.error) throw new Error('Cloud-Anmeldung fehlgeschlagen: ' + li.error.message);
  const cu = li.data.user;

  // Lokales Benutzerkonto mit derselben ID (damit alle Verweise passen) und demselben Passwort
  const existing = (await db.query('select id from auth.users where lower(email)=lower($1)', [cu.email])).rows[0];
  if (existing && existing.id !== cu.id) {
    throw new Error(`Lokal gibt es bereits ein anderes Konto mit ${cu.email}. Bitte dieses Konto zuerst unter „Benutzer" umbenennen oder einen leeren Server verwenden.`);
  }
  await db.query(`insert into auth.users(id,email,encrypted_password,email_confirmed_at,raw_user_meta_data,raw_app_meta_data,created_at)
    values ($1,lower($2),$3,coalesce($4::timestamptz,now()),$5::jsonb,$6::jsonb,coalesce($7::timestamptz,now()))
    on conflict (id) do update set email=excluded.email, encrypted_password=excluded.encrypted_password,
      raw_user_meta_data = auth.users.raw_user_meta_data - 'platzhalter' || excluded.raw_user_meta_data`,
    [cu.id, cu.email, await bcrypt.hash(password, 10), cu.email_confirmed_at, JSON.stringify(cu.user_metadata || {}), JSON.stringify(cu.app_metadata || {}), cu.created_at]);

  const cols = await localColumns(db);
  const catalogFks = (await db.query(`select sc.relname as src, tc.relname as tgt from pg_constraint con join pg_class sc on sc.oid=con.conrelid join pg_class tc on tc.oid=con.confrelid
    where con.contype='f' and sc.relnamespace='public'::regnamespace and tc.relnamespace='public'::regnamespace`)).rows;
  const order = topoOrder(Object.keys(cols), catalogFks);
  const userRefs = await authUserRefs(db);
  const knownUsers = new Set((await db.query('select id from auth.users')).rows.map((r) => r.id));

  async function ensureUsers(tbl, rows) {
    const refCols = userRefs.filter((r) => r.tbl === tbl).map((r) => r.col);
    for (const row of rows) for (const c of refCols) {
      const id = row[c];
      if (!id || knownUsers.has(id)) continue;
      await db.query(`insert into auth.users(id,email,encrypted_password,raw_user_meta_data) values ($1,$2,null,'{"platzhalter":true}'::jsonb) on conflict do nothing`,
        [id, 'importiert-' + String(id).slice(0, 8) + '@nekosta.local']);
      knownUsers.add(id); report.placeholders++;
    }
  }

  for (const tbl of order) {
    const lc = cols[tbl];
    const insertable = lc.filter((c) => !c.generated);
    const identityAlways = lc.some((c) => c.identity === 'a');
    const pk = await pkOf(db, tbl);
    let cloudCount = null;
    const head = await cloud.from(tbl).select('*', { count: 'exact', head: true });
    if (head.error) {
      report.tables.push({ table: tbl, cloud: null, imported: 0, error: head.error.message });
      log({ step: 'table', table: tbl, text: `${tbl}: übersprungen (${head.error.message})` });
      continue;
    }
    cloudCount = head.count || 0;
    let imported = 0, present = 0, from = 0, extraCols = new Set();
    while (from < cloudCount) {
      let qb = cloud.from(tbl).select('*');
      pk.forEach((k) => { qb = qb.order(k, { ascending: true }); });
      const page = await qb.range(from, from + PAGE - 1);
      if (page.error) { report.warnings.push(`${tbl}: ${page.error.message}`); break; }
      const rows = page.data || [];
      if (!rows.length) break;
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (!lc.some((c) => c.col === k)) extraCols.add(k); }));
      await ensureUsers(tbl, rows);
      const names = insertable.map((c) => qi(c.col)).join(',');
      const res = await db.transaction(async (tx) => {
        // Fremdschlüssel- und Benutzer-Trigger während des Kopierens aussetzen (1:1-Kopie)
        await tx.exec("set local session_replication_role = 'replica'");
        return tx.query(`insert into public.${qi(tbl)} (${names}) ${identityAlways ? 'overriding system value ' : ''}
          select ${names} from jsonb_populate_recordset(null::public.${qi(tbl)}, $1::jsonb) on conflict do nothing`, [JSON.stringify(rows)]);
      });
      imported += res.affectedRows || 0;
      // Vollständigkeit über die Primärschlüssel prüfen (auch bei wiederholtem Import korrekt)
      if (pk.length) {
        const keys = rows.map((r) => { const o = {}; pk.forEach((k) => { o[k] = r[k]; }); return o; });
        present += Number((await db.query(`select count(*)::int as n from public.${qi(tbl)} x join jsonb_populate_recordset(null::public.${qi(tbl)}, $1::jsonb) k on ${pk.map((k) => `x.${qi(k)} = k.${qi(k)}`).join(' and ')}`, [JSON.stringify(keys)])).rows[0].n);
      } else present += res.affectedRows || 0;
      from += rows.length;
      log({ step: 'table', table: tbl, text: `${tbl}: ${Math.min(from, cloudCount)} / ${cloudCount}` });
    }
    if (extraCols.size) report.warnings.push(`${tbl}: Spalten fehlen lokal und wurden nicht übernommen: ${[...extraCols].join(', ')}`);
    report.tables.push({ table: tbl, cloud: cloudCount, imported, present });
  }

  // Zähler (serial/identity) hinter die übernommenen Werte setzen
  await db.exec(`do $$ declare r record; begin
    for r in select s.relname as seq, t.relname as tbl, a.attname as col from pg_class s
      join pg_depend d on d.objid=s.oid and d.deptype in ('a','i') join pg_class t on t.oid=d.refobjid
      join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid where s.relkind='S' and t.relnamespace='public'::regnamespace loop
      execute format('select setval(%L, greatest(coalesce((select max(%I) from public.%I),0),1))', 'public.'||r.seq, r.col, r.tbl);
    end loop; end $$`);

  // Dokumente
  if (opts.withFiles !== false) {
    const buckets = opts.buckets || ['dokumente'];
    for (const bucket of buckets) {
      const files = [];
      const walk = async (prefix, depth) => {
        if (depth > 12) return;
        for (let off = 0; ; off += 1000) {
          const l = await cloud.storage.from(bucket).list(prefix, { limit: 1000, offset: off, sortBy: { column: 'name', order: 'asc' } });
          if (l.error) { report.warnings.push(`Dokumente ${prefix || '/'}: ${l.error.message}`); return; }
          for (const e of l.data || []) {
            const full = prefix ? prefix + '/' + e.name : e.name;
            if (e.id) files.push({ name: full, meta: e.metadata, created_at: e.created_at, updated_at: e.updated_at });
            else if (e.name !== '.emptyFolderPlaceholder') await walk(full, depth + 1);
          }
          if (!l.data || l.data.length < 1000) break;
        }
      };
      log({ step: 'files', text: 'Dokumente werden gesucht …' });
      await walk('', 0);
      report.files.found += files.length;
      const root = path.join(dataDir, 'storage');
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ex = (await db.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, f.name])).rows[0];
        if (ex) { report.files.skipped++; continue; }
        const dl = await cloud.storage.from(bucket).download(f.name);
        if (dl.error) { report.files.failed.push(f.name + ': ' + dl.error.message); continue; }
        const buf = Buffer.from(await dl.data.arrayBuffer());
        const id = crypto.randomUUID();
        const file = path.join(root, id.slice(0, 2), id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        const owner = /^[0-9a-f-]{36}\//i.test(f.name) ? f.name.slice(0, 36) : cu.id;
        const meta = Object.assign({ size: buf.length, mimetype: dl.data.type || 'application/octet-stream' }, f.meta || {});
        await db.query(`insert into storage.objects(id,bucket_id,name,owner,owner_id,metadata,created_at,updated_at) values ($1,$2,$3,$4::uuid,$4::text,$5::jsonb,coalesce($6::timestamptz,now()),coalesce($7::timestamptz,now()))`,
          [id, bucket, f.name, knownUsers.has(owner) ? owner : cu.id, JSON.stringify(meta), f.created_at, f.updated_at]);
        report.files.copied++;
        log({ step: 'files', text: `Dokumente: ${i + 1} / ${files.length}` });
      }
    }
  }
  await cloud.auth.signOut().catch(() => {});
  report.user = { id: cu.id, email: cu.email };
  report.mismatch = report.tables.filter((t) => t.cloud != null && t.present < t.cloud);
  return report;
}

module.exports = { importFromCloud, topoOrder };
