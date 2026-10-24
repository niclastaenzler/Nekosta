// Import-Assistent: eine zweite lokale Instanz spielt die „Cloud".
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { createClient } = require('@supabase/supabase-js');
const { startServer } = require('../server');
const { importFromCloud } = require('../server/cloud-import');
const ok = (r) => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
(async () => {
  const schemaDir = path.join(__dirname, 'schema'), webRoot = path.join(__dirname, '..', 'web');
  const cloud = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cloud-')), schemaDir, webRoot, port: 0, host: '127.0.0.1' });
  const cUrl = 'http://127.0.0.1:' + cloud.port;
  const A = createClient(cUrl, cloud.anonKey, { auth: { persistSession: false } }), B = createClient(cUrl, cloud.anonKey, { auth: { persistSession: false } });
  const ua = ok(await A.auth.signUp({ email: 'niclas@p-t.de', password: 'Cloud#123', options: { data: { full_name: 'Niclas' } } })).user;
  ok(await B.auth.signUp({ email: 'fremd@x.de', password: 'Fremd#123' }));
  const o = ok(await A.from('objekte').insert({ name: 'Merowingerstraße 15' }).select().single());
  const es = ok(await A.from('einheiten').insert(Array.from({ length: 1205 }, (_, i) => ({ objekt_id: o.id, bezeichnung: 'E' + i, flaeche: i + 0.5 }))).select('id'));
  const k = ok(await A.from('kontakte').insert({ vorname: 'Max', nachname: 'Mustermann' }).select().single());
  ok(await A.from('mietverhaeltnisse').insert({ objekt_id: o.id, einheit_id: es[0].id, kontakt_id: k.id, kaltmiete: 650 }));
  ok(await A.from('stammdaten').upsert({ user_id: ua.id, firma: 'Pohl & Tänzler' }));
  ok(await A.from('weg_einheit_personen').insert({ einheit_id: es[0].id, jahr: 2025, monat: 1, personen: 2 }));
  ok(await A.from('settings_json').insert({ mitglieder: [{ a: 1 }], tags: ['x'] }));
  ok(await B.from('objekte').insert({ name: 'Fremdes Objekt' }));
  ok(await A.storage.from('dokumente').upload(ua.id + '/briefbogen/kopf.jpg', new Blob([Buffer.from('JPEG')], { type: 'image/jpeg' })));
  ok(await A.storage.from('dokumente').upload(ua.id + '/objekte/' + o.id + '/vertrag.pdf', new Blob([Buffer.from('%PDF')], { type: 'application/pdf' })));

  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-local-'));
  const local = await startServer({ dataDir: localDir, schemaDir, webRoot, port: 0, host: '127.0.0.1' });
  const steps = [];
  const rep = await importFromCloud({ db: local.db, dataDir: localDir, cloudUrl: cUrl, cloudKey: cloud.anonKey, email: 'niclas@p-t.de', password: 'Cloud#123', onProgress: (p) => steps.push(p.text) });
  const t = Object.fromEntries(rep.tables.map((x) => [x.table, x]));
  assert.equal(t.einheiten.cloud, 1205); assert.equal(t.einheiten.present, 1205); assert.equal(t.objekte.cloud, 1);
  assert.equal(rep.mismatch.length, 0, JSON.stringify(rep.mismatch)); assert.equal(rep.files.copied, 2); console.log('  ✓ Tabellen vollständig, 1205 Einheiten über mehrere Seiten, 2 Dokumente');
  // Lokal mit demselben Passwort anmelden und Daten lesen
  const L = createClient('http://127.0.0.1:' + local.port, local.anonKey, { auth: { persistSession: false } });
  const lu = ok(await L.auth.signInWithPassword({ email: 'niclas@p-t.de', password: 'Cloud#123' })).user;
  assert.equal(lu.id, ua.id); console.log('  ✓ lokale Anmeldung mit Cloud-Passwort, gleiche Benutzer-ID');
  const d = ok(await L.from('mietverhaeltnisse').select('kaltmiete,kontakte(nachname),objekte(name)').single());
  assert.equal(d.kontakte.nachname, 'Mustermann'); assert.equal(d.objekte.name, 'Merowingerstraße 15'); console.log('  ✓ Beziehungen intakt');
  assert.equal(ok(await L.from('objekte').select('name')).length, 1); console.log('  ✓ Daten anderer Cloud-Benutzer nicht übernommen');
  assert.equal(ok(await L.from('stammdaten').select('firma').single()).firma, 'Pohl & Tänzler');
  assert.deepEqual(ok(await L.from('settings_json').select('mitglieder,tags').single()), { mitglieder: [{ a: 1 }], tags: ['x'] }); console.log('  ✓ jsonb/Arrays');
  const f = ok(await L.storage.from('dokumente').download(ua.id + '/objekte/' + o.id + '/vertrag.pdf'));
  assert.equal(Buffer.from(await f.arrayBuffer()).toString(), '%PDF'); console.log('  ✓ Dokument lokal abrufbar');
  // Neue Zeile lokal anlegen (Standardwerte/Trigger funktionieren nach Import)
  ok(await L.from('objekte').insert({ name: 'Neu lokal' })); console.log('  ✓ lokal weiterarbeiten');
  // Wiederholter Import: nichts doppelt
  const rep2 = await importFromCloud({ db: local.db, dataDir: localDir, cloudUrl: cUrl, cloudKey: cloud.anonKey, email: 'niclas@p-t.de', password: 'Cloud#123' });
  assert.equal(rep2.mismatch.length, 0); assert.equal(rep2.files.copied, 0); assert.equal(rep2.files.skipped, 2);
  const cnt = await L.from('einheiten').select('*', { count: 'exact', head: true }); assert.equal(cnt.count, 1205); console.log('  ✓ zweiter Import ohne Dubletten');
  // Falsches Passwort
  await assert.rejects(importFromCloud({ db: local.db, dataDir: localDir, cloudUrl: cUrl, cloudKey: cloud.anonKey, email: 'niclas@p-t.de', password: 'falsch' }), /Cloud-Anmeldung fehlgeschlagen/); console.log('  ✓ falsches Cloud-Passwort wird gemeldet');
  // Sicherung + Wiederherstellung
  const { createBackup, listBackups, restoreBackup } = require('../server/backup');
  const bdir = path.join(localDir, '..', path.basename(localDir) + '-sicherung');
  const b = await createBackup(local.db, localDir, bdir); assert(fs.existsSync(b.file) && b.documentsCopied === 2); console.log('  ✓ Sicherung', Math.round(b.size / 1024) + ' KB');
  ok(await L.from('objekte').delete().eq('name', 'Neu lokal'));
  await local.close();
  await restoreBackup(localDir, listBackups(bdir)[0].file, bdir);
  const local2 = await startServer({ dataDir: localDir, schemaDir, webRoot, port: 0, host: '127.0.0.1' });
  const L2 = createClient('http://127.0.0.1:' + local2.port, local2.anonKey, { auth: { persistSession: false } });
  ok(await L2.auth.signInWithPassword({ email: 'niclas@p-t.de', password: 'Cloud#123' }));
  assert.equal(ok(await L2.from('objekte').select('name').eq('name', 'Neu lokal')).length, 1); console.log('  ✓ Wiederherstellung (gelöschtes Objekt wieder da)');
  await local2.close(); await cloud.close();
  console.log('Import-Tests bestanden');
  process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
