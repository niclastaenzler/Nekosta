// Eingebaute PostgreSQL-Datenbank (PGlite) mit Supabase-kompatibler Grundstruktur.
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');

async function openDatabase(dataDir, schemaDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(path.join(dataDir, 'pgdata'), { extensions: { pgcrypto, uuid_ossp, pg_trgm } });
  await db.exec("set timezone='UTC'");
  await db.exec(fs.readFileSync(path.join(__dirname, 'compat.sql'), 'utf8'));
  await applySchema(db, schemaDir);
  return db;
}

// Wendet schema/*.sql in Namensreihenfolge einmalig an (wie Migrationen).
async function applySchema(db, schemaDir) {
  if (!schemaDir || !fs.existsSync(schemaDir)) return;
  const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await db.query('select name from public._nekosta_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(schemaDir, f), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      // Supabase gewährt allen API-Rollen Tabellenrechte; RLS regelt den Zugriff.
      await tx.exec(`grant all on all tables in schema public to anon, authenticated, service_role;
        grant all on all sequences in schema public to anon, authenticated, service_role;
        grant execute on all functions in schema public to anon, authenticated, service_role;
        revoke all on public._nekosta_migrations from anon, authenticated;`);
      await tx.query('insert into public._nekosta_migrations(name) values ($1)', [f]);
    });
  }
}

// Katalog: Spaltentypen und Fremdschlüssel (für Filter-Casts und eingebettete Relationen).
async function loadCatalog(db) {
  const cols = await db.query(`
    select n.nspname as schema, c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnum
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage','auth') and c.relkind in ('r','v','m','p','f') and a.attnum>0 and not a.attisdropped
    order by n.nspname, c.relname, a.attnum`);
  const fks = await db.query(`
    select con.conname as name, sn.nspname as src_schema, sc.relname as src, tn.nspname as tgt_schema, tc.relname as tgt,
      (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.n) as src_cols,
      (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.n) as tgt_cols
    from pg_constraint con
    join pg_class sc on sc.oid=con.conrelid join pg_namespace sn on sn.oid=sc.relnamespace
    join pg_class tc on tc.oid=con.confrelid join pg_namespace tn on tn.oid=tc.relnamespace
    where con.contype='f' and sn.nspname='public' and tn.nspname='public'`);
  const pks = await db.query(`
    select c.relname as tbl, (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.n) as cols
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    where con.contype='p' and n.nspname='public'`);
  const tables = {};
  for (const r of cols.rows) {
    if (r.schema !== 'public') continue;
    (tables[r.tbl] = tables[r.tbl] || { name: r.tbl, cols: {}, order: [] }).cols[r.col] = r.type;
    tables[r.tbl].order.push(r.col);
  }
  for (const r of pks.rows) if (tables[r.tbl]) tables[r.tbl].pk = r.cols;
  return { tables, fks: fks.rows };
}

module.exports = { openDatabase, applySchema, loadCatalog };
