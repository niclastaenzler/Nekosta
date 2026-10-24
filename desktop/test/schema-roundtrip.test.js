// Export-Skript auf eine Datenbank anwenden und das Ergebnis in eine leere Datenbank zurückspielen.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { openDatabase, loadCatalog } = require('../server/db');
(async () => {
  const src = await openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-src-')), path.join(__dirname, 'schema'));
  const ddl = (await src.query(fs.readFileSync(path.join(__dirname, '..', 'tools', 'schema-export.sql'), 'utf8'))).rows[0].ddl;
  const out = path.join(os.tmpdir(), 'nk-export.sql'); fs.writeFileSync(out, ddl);
  const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-dst-')); const schemaDir = path.join(dstDir, 'schema'); fs.mkdirSync(schemaDir);
  fs.writeFileSync(path.join(schemaDir, '001_schema.sql'), ddl);
  const dst = await openDatabase(path.join(dstDir, 'data'), schemaDir);
  const sig = async (db) => {
    const c = await loadCatalog(db);
    const pol = (await db.query("select schemaname||'.'||tablename||'.'||policyname||' '||cmd||' '||coalesce(qual,'')||' '||coalesce(with_check,'') p from pg_policies where schemaname in ('public','storage') order by 1")).rows.map(r => r.p);
    const trg = (await db.query("select tgname from pg_trigger where not tgisinternal order by 1")).rows.map(r => r.tgname);
    const idx = (await db.query("select indexdef from pg_indexes where schemaname='public' and tablename not like '\\_nekosta%' order by 1")).rows.map(r => r.indexdef);
    const fns = (await db.query("select proname from pg_proc where pronamespace='public'::regnamespace order by 1")).rows.map(r => r.proname);
    const cols = Object.values(c.tables).filter(t => !t.name.startsWith('_nekosta')).map(t => t.name + ':' + t.order.map(k => k + '=' + t.cols[k]).join(',')).sort();
    const fks = c.fks.map(f => f.src + '.' + f.src_cols + '->' + f.tgt + '.' + f.tgt_cols).sort();
    return { cols, fks, pol, trg, idx, fns };
  };
  const a = await sig(src), b = await sig(dst);
  for (const k of Object.keys(a)) { assert.deepStrictEqual(b[k], a[k], k + ' unterscheidet sich'); console.log('  ✓', k, a[k].length); }
  // Trigger auf auth.users greift auch nach dem Rückspielen
  await dst.query("insert into auth.users(email,raw_user_meta_data) values ('x@y.de','{\"full_name\":\"Test\"}')");
  assert.equal((await dst.query('select full_name from user_profiles')).rows[0].full_name, 'Test'); console.log('  ✓ Trigger auf auth.users');
  console.log('Export:', out, Math.round(ddl.length / 1024) + ' KB');
  process.exit(0);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
