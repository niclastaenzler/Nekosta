// Benutzerverwaltung auf dem Server-PC (ersetzt die E-Mail-Funktionen der Cloud).
'use strict';
const bcrypt = require('bcryptjs');

async function listUsers(db) {
  return (await db.query(`select id, email, created_at, last_sign_in_at, banned_until, raw_user_meta_data->>'full_name' as name,
    coalesce((raw_user_meta_data->>'platzhalter')::boolean, false) as platzhalter, encrypted_password is not null as hat_passwort
    from auth.users where deleted_at is null order by email`)).rows;
}

async function createUser(auth, email, password, name) {
  const u = await auth.createUser(email, password, name ? { full_name: name } : {});
  return auth.userJson(u);
}

async function setPassword(db, id, password) {
  if (!password || String(password).length < 6) throw new Error('Das Passwort muss mindestens 6 Zeichen haben.');
  const r = await db.query("update auth.users set encrypted_password=$2, updated_at=now(), raw_user_meta_data = raw_user_meta_data - 'platzhalter' where id=$1 returning id", [id, await bcrypt.hash(String(password), 10)]);
  if (!r.rows.length) throw new Error('Benutzer nicht gefunden.');
  await db.query('update auth.refresh_tokens set revoked=true where user_id=$1', [id]);
}

async function setEmail(db, id, email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Bitte eine gültige E-Mail-Adresse angeben.');
  const dup = (await db.query('select id from auth.users where lower(email)=$1 and id<>$2', [email, id])).rows[0];
  if (dup) throw new Error('Diese E-Mail-Adresse ist bereits vergeben.');
  await db.query('update auth.users set email=$2, updated_at=now() where id=$1', [id, email]);
}

async function setLocked(db, id, locked) {
  await db.query('update auth.users set banned_until=$2, updated_at=now() where id=$1', [id, locked ? '2999-12-31' : null]);
  if (locked) await db.query('update auth.refresh_tokens set revoked=true where user_id=$1', [id]);
}

module.exports = { listUsers, createUser, setPassword, setEmail, setLocked };
