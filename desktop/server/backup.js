// Datensicherung: Datenbank als komprimiertes Abbild + Spiegel der Dokumentablage.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KEEP = 14; // so viele Datenbank-Sicherungen bleiben erhalten

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Kopiert neue/geänderte Dateien der Dokumentablage (einseitiger Spiegel, löscht nichts).
function mirror(src, dst) {
  let copied = 0;
  if (!fs.existsSync(src)) return copied;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copied += mirror(s, d);
    else if (e.isFile()) {
      const ss = fs.statSync(s);
      let need = true;
      try { const ds = fs.statSync(d); need = ds.size !== ss.size || ds.mtimeMs < ss.mtimeMs; } catch (x) {}
      if (need) { fs.copyFileSync(s, d); copied++; }
    }
  }
  return copied;
}

async function createBackup(db, dataDir, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const when = new Date();
  const dump = await db.dumpDataDir('gzip');
  const buf = Buffer.from(await dump.arrayBuffer());
  const file = path.join(backupDir, `nekosta-datenbank_${stamp(when)}.tar.gz`);
  fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
  const copied = mirror(path.join(dataDir, 'storage'), path.join(backupDir, 'dokumente'));
  fs.copyFileSync(path.join(dataDir, 'config.json'), path.join(backupDir, 'config.json'));
  // alte Datenbank-Sicherungen aufräumen
  const all = listBackups(backupDir);
  for (const b of all.slice(KEEP)) { try { fs.unlinkSync(b.file); } catch (e) {} }
  return { file, size: buf.length, documentsCopied: copied, at: when.toISOString() };
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => /^nekosta-datenbank_.*\.tar\.gz$/.test(f))
    .map((f) => { const file = path.join(backupDir, f); return { file, name: f, size: fs.statSync(file).size, mtime: fs.statSync(file).mtime }; })
    .sort((a, b) => b.mtime - a.mtime);
}

// Stellt eine Sicherung wieder her. Der Server muss vorher beendet sein.
// Die bisherige Datenbank bleibt als pgdata.vor-wiederherstellung-<zeit> erhalten.
async function restoreBackup(dataDir, backupFile, backupDir) {
  const { PGlite } = require('@electric-sql/pglite');
  const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
  const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');
  const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
  const pg = path.join(dataDir, 'pgdata');
  const tmp = path.join(dataDir, 'pgdata.wiederherstellung');
  fs.rmSync(tmp, { recursive: true, force: true });
  const blob = new Blob([fs.readFileSync(backupFile)]);
  const db = await PGlite.create(tmp, { loadDataDir: blob, extensions: { pgcrypto, uuid_ossp, pg_trgm } });
  await db.query('select 1');
  await db.close();
  const old = path.join(dataDir, 'pgdata.vor-wiederherstellung-' + stamp(new Date()));
  if (fs.existsSync(pg)) fs.renameSync(pg, old);
  fs.renameSync(tmp, pg);
  // Dokumente aus dem Spiegel ergänzen (vorhandene bleiben)
  if (backupDir) mirror(path.join(backupDir, 'dokumente'), path.join(dataDir, 'storage'));
  return { previous: old };
}

module.exports = { createBackup, listBackups, restoreBackup, mirror };
