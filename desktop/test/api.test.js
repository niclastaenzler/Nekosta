// Prüft den lokalen Server mit der echten supabase-js-Bibliothek (wie die NEKOSTA-Oberfläche).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createClient } = require('@supabase/supabase-js');
const { startServer } = require('../server');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e); }
}
const ok = (r) => { if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekosta-test-'));
  const srv = await startServer({ dataDir, schemaDir: path.join(__dirname, 'schema'), webRoot: path.join(__dirname, '..', 'web'), port: 0, host: '127.0.0.1' });
  const url = 'http://127.0.0.1:' + srv.port;
  const mk = () => createClient(url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const A = mk(), B = mk();
  let o1, o2, e1, e2, k1, k2, mv1;

  console.log('Auth');
  await t('signUp + Session', async () => { const d = ok(await A.auth.signUp({ email: 'anna@test.de', password: 'geheim123', options: { data: { full_name: 'Anna' } } })); assert(d.session && d.user.id); });
  await t('signInWithPassword', async () => { ok(await A.auth.signInWithPassword({ email: 'Anna@Test.de', password: 'geheim123' })); });
  await t('falsches Passwort → Fehler', async () => { const r = await mk().auth.signInWithPassword({ email: 'anna@test.de', password: 'falsch' }); assert(r.error && /Invalid login/.test(r.error.message), JSON.stringify(r.error)); });
  await t('getUser + user_metadata', async () => { const d = ok(await A.auth.getUser()); assert.equal(d.user.user_metadata.full_name, 'Anna'); });
  await t('zweiter Benutzer', async () => { ok(await B.auth.signUp({ email: 'bert@test.de', password: 'geheim123' })); });

  console.log('Einfügen / Lesen');
  await t('insert().select().single()', async () => { o1 = ok(await A.from('objekte').insert({ name: 'Merowingerstraße 15', strasse: 'Merowingerstr. 15', kategorie: 'miete' }).select().single()); assert(o1.id && o1.user_id); });
  await t('insert Array ohne select → kein Inhalt', async () => { const r = await A.from('objekte').insert([{ name: 'Grabenstraße 41' }, { name: 'WEG Test', kategorie: 'weg' }]); assert(!r.error && r.data === null && r.status === 201, JSON.stringify(r)); });
  await t('select + order + Spaltenwahl', async () => { const d = ok(await A.from('objekte').select('id,name,kategorie').order('name')); assert.deepEqual(d.map((x) => x.name), ['Grabenstraße 41', 'Merowingerstraße 15', 'WEG Test']); o2 = d[0]; assert(!('strasse' in d[0])); });
  await t('Daten Einheiten/Kontakte/Mietverhältnisse', async () => {
    [e1, e2] = ok(await A.from('einheiten').insert([{ objekt_id: o1.id, bezeichnung: 'EG links', flaeche: 72.5 }, { objekt_id: o1.id, bezeichnung: '1. OG', flaeche: 80 }]).select());
    [k1, k2] = ok(await A.from('kontakte').insert([{ anrede: 'Herr', vorname: 'Max', nachname: 'Mustermann', email: 'max@x.de' }, { anrede: 'Frau', vorname: 'Erika', nachname: 'Mustermann' }]).select());
    mv1 = ok(await A.from('mietverhaeltnisse').insert({ objekt_id: o1.id, einheit_id: e1.id, kontakt_id: k1.id, kaltmiete: 650.5 }).select().single());
    ok(await A.from('mietverhaeltnis_mieter').insert({ mietverhaeltnis_id: mv1.id, kontakt_id: k2.id }));
    ok(await A.from('mietverhaeltnisse').insert({ objekt_id: o1.id, einheit_id: e2.id, kontakt_id: k2.id, aktiv: false, auszug: '2025-12-31' }));
  });
  await t('numeric als Zahl', async () => { const d = ok(await A.from('einheiten').select('flaeche').eq('id', e1.id).single()); assert.strictEqual(d.flaeche, 72.5); });

  console.log('Eingebettete Relationen');
  await t('m2o + o2m + verschachtelt (wie Anschreiben)', async () => {
    const d = ok(await A.from('mietverhaeltnisse').select('id,einheit_id,kontakt_id,aktiv,kontakte(anrede,vorname,nachname),mietverhaeltnis_mieter(kontakt_id,kontakte(anrede,vorname,nachname))').eq('objekt_id', o1.id).eq('aktiv', true));
    assert.equal(d.length, 1); assert.equal(d[0].kontakte.nachname, 'Mustermann'); assert.equal(d[0].mietverhaeltnis_mieter[0].kontakte.vorname, 'Erika');
  });
  await t('*,objekte(name),einheiten(bezeichnung)', async () => { const d = ok(await A.from('mietverhaeltnisse').select('*,objekte(name),einheiten(bezeichnung)').order('kaltmiete', { ascending: true, nullsFirst: false })); assert.equal(d[0].objekte.name, 'Merowingerstraße 15'); assert.equal(d[0].einheiten.bezeichnung, 'EG links'); assert.equal(d[1].kaltmiete, null); });
  await t('Alias spalte:feld', async () => { const d = ok(await A.from('objekte').select('titel:name').eq('id', o1.id).single()); assert.equal(d.titel, 'Merowingerstraße 15'); });

  console.log('Filter');
  await t('in()', async () => { const d = ok(await A.from('einheiten').select('id').in('id', [e1.id, e2.id])); assert.equal(d.length, 2); });
  await t('is null / not is null', async () => { assert.equal(ok(await A.from('mietverhaeltnisse').select('id').is('auszug', null)).length, 1); assert.equal(ok(await A.from('mietverhaeltnisse').select('id').not('auszug', 'is', null)).length, 1); });
  await t('or() mit ilike', async () => { const d = ok(await A.from('kontakte').select('vorname').or('vorname.ilike.%max%,email.ilike.%nix%')); assert.deepEqual(d.map((x) => x.vorname), ['Max']); });
  await t('or() mit eq + is.null', async () => { const d = ok(await A.from('objekte').select('id').or('kategorie.eq.weg,kategorie.is.null')); assert.equal(d.length, 2); });
  await t('gte/lte Datum', async () => { const d = ok(await A.from('mietverhaeltnisse').select('id').gte('auszug', '2025-01-01').lte('auszug', '2025-12-31')); assert.equal(d.length, 1); });
  await t('neq + limit', async () => { const d = ok(await A.from('objekte').select('id').neq('id', o1.id).limit(1)); assert.equal(d.length, 1); });
  await t('count exact + head', async () => { const r = await A.from('objekte').select('*', { count: 'exact', head: true }); assert(!r.error); assert.equal(r.count, 3); });
  await t('count exact mit Daten', async () => { const r = await A.from('objekte').select('id', { count: 'exact' }).limit(1); assert.equal(r.count, 3); assert.equal(r.data.length, 1); });
  await t('range()', async () => { const d = ok(await A.from('objekte').select('name').order('name').range(1, 2)); assert.deepEqual(d.map((x) => x.name), ['Merowingerstraße 15', 'WEG Test']); });
  await t('maybeSingle → null bei 0 Treffern', async () => { const r = await A.from('objekte').select('id').eq('name', 'gibtsnicht').maybeSingle(); assert(!r.error && r.data === null); });
  await t('single → Fehler bei 0 Treffern', async () => { const r = await A.from('objekte').select('id').eq('name', 'gibtsnicht').single(); assert(r.error && r.error.code === 'PGRST116'); });

  console.log('Ändern / Upsert / Löschen');
  await t('update().eq()', async () => { ok(await A.from('objekte').update({ strasse: 'Neue Str. 1' }).eq('id', o1.id)); assert.equal(ok(await A.from('objekte').select('strasse').eq('id', o1.id).single()).strasse, 'Neue Str. 1'); });
  await t('update().in().select()', async () => { const d = ok(await A.from('einheiten').update({ flaeche: 99 }).in('id', [e1.id, e2.id]).select('id,flaeche')); assert.equal(d.length, 2); assert(d.every((x) => x.flaeche === 99)); });
  await t('upsert onConflict user_id (stammdaten)', async () => {
    const uid = (await A.auth.getUser()).data.user.id;
    ok(await A.from('stammdaten').upsert({ user_id: uid, firma: 'Pohl & Tänzler' }, { onConflict: 'user_id' }));
    ok(await A.from('stammdaten').upsert({ user_id: uid, gruss_text: 'Mit freundlichen Grüßen' }, { onConflict: 'user_id' }));
    const d = ok(await A.from('stammdaten').select('*').single()); assert.equal(d.firma, 'Pohl & Tänzler'); assert.equal(d.gruss_text, 'Mit freundlichen Grüßen');
  });
  await t('upsert mehrspaltig onConflict', async () => {
    ok(await A.from('weg_einheit_personen').upsert([{ einheit_id: e1.id, jahr: 2025, monat: 1, personen: 2 }, { einheit_id: e1.id, jahr: 2025, monat: 2, personen: 2 }], { onConflict: 'einheit_id,jahr,monat' }));
    ok(await A.from('weg_einheit_personen').upsert([{ einheit_id: e1.id, jahr: 2025, monat: 1, personen: 3 }], { onConflict: 'einheit_id,jahr,monat' }));
    const d = ok(await A.from('weg_einheit_personen').select('monat,personen').order('monat')); assert.deepEqual(d, [{ monat: 1, personen: 3 }, { monat: 2, personen: 2 }]);
  });
  await t('jsonb + text[]', async () => { const d = ok(await A.from('settings_json').insert({ mitglieder: [{ objekt_id: 'x', alle: true }], tags: ['a', 'b'] }).select().single()); assert.equal(d.mitglieder[0].alle, true); assert.deepEqual(d.tags, ['a', 'b']); });
  await t('delete().eq()', async () => { ok(await A.from('objekte').delete().eq('name', 'WEG Test')); assert.equal(ok(await A.from('objekte').select('id')).length, 2); });

  console.log('Zugriffsschutz (RLS)');
  await t('B sieht A-Daten nicht', async () => { assert.equal(ok(await B.from('objekte').select('*')).length, 0); });
  await t('B kann A-Daten nicht ändern', async () => { ok(await B.from('objekte').update({ name: 'gehackt' }).eq('id', o1.id)); assert.equal(ok(await A.from('objekte').select('name').eq('id', o1.id).single()).name, 'Merowingerstraße 15'); });
  await t('B kann nicht für A einfügen', async () => { const uidA = (await A.auth.getUser()).data.user.id; const r = await B.from('objekte').insert({ user_id: uidA, name: 'x' }); assert(r.error && r.error.code === '42501', JSON.stringify(r.error)); });
  await t('ohne Login keine Daten', async () => { assert.equal(ok(await mk().from('objekte').select('*')).length, 0); });

  console.log('Dokumente (Storage)');
  const uidA = (await A.auth.getUser()).data.user.id;
  await t('upload Blob + list', async () => {
    ok(await A.storage.from('dokumente').upload(uidA + '/briefbogen/kopf.jpg', new Blob([Buffer.from('JPEGDATA')], { type: 'image/jpeg' }), { contentType: 'image/jpeg', cacheControl: '0' }));
    ok(await A.storage.from('dokumente').upload(uidA + '/vertrag.pdf', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), { upsert: false }));
    const l = ok(await A.storage.from('dokumente').list(uidA + '/briefbogen', { limit: 100 })); assert.deepEqual(l.map((x) => x.name), ['kopf.jpg']);
    const top = ok(await A.storage.from('dokumente').list(uidA)); assert.deepEqual(top.map((x) => x.name).sort(), ['briefbogen', 'vertrag.pdf']);
  });
  await t('doppelter Upload ohne upsert → Fehler', async () => { const r = await A.storage.from('dokumente').upload(uidA + '/vertrag.pdf', new Blob(['x'])); assert(r.error); });
  await t('download', async () => { const b = ok(await A.storage.from('dokumente').download(uidA + '/briefbogen/kopf.jpg')); assert.equal(Buffer.from(await b.arrayBuffer()).toString(), 'JPEGDATA'); });
  await t('createSignedUrl + Abruf ohne Login', async () => {
    const d = ok(await A.storage.from('dokumente').createSignedUrl(uidA + '/vertrag.pdf', 120, { download: 'Mietvertrag.pdf' }));
    const r = await fetch(d.signedUrl); assert.equal(r.status, 200); assert.equal(await r.text(), '%PDF-1.4 test'); assert(/Mietvertrag\.pdf/.test(r.headers.get('content-disposition')));
  });
  await t('B kann A-Dokumente nicht lesen', async () => { const r = await B.storage.from('dokumente').download(uidA + '/vertrag.pdf'); assert(r.error); });
  await t('B kann nicht in A-Ordner hochladen', async () => { const r = await B.storage.from('dokumente').upload(uidA + '/boese.txt', new Blob(['x'])); assert(r.error); });
  await t('remove', async () => { const d = ok(await A.storage.from('dokumente').remove([uidA + '/vertrag.pdf'])); assert.equal(d.length, 1); assert.equal(ok(await A.storage.from('dokumente').list(uidA)).length, 1); });

  console.log('Passwort / Abmelden');
  await t('updateUser Passwort', async () => { ok(await A.auth.updateUser({ password: 'neuesPW99' })); ok(await mk().auth.signInWithPassword({ email: 'anna@test.de', password: 'neuesPW99' })); });
  await t('refreshSession', async () => { const C = createClient(url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }); ok(await C.auth.signInWithPassword({ email: 'bert@test.de', password: 'geheim123' })); const d = ok(await C.auth.refreshSession()); assert(d.session.access_token); });
  await t('signOut', async () => { const r = await A.auth.signOut(); assert(!r.error, JSON.stringify(r.error)); });

  await srv.close();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
