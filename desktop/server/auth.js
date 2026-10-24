// Login-Schnittstelle (/auth/v1) kompatibel zu supabase-js (GoTrue).
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('./jwt');

const ACCESS_TTL = 3600; // Sekunden

class AuthError extends Error {
  constructor(status, code, msg) { super(msg); this.status = status; this.code = code; }
}

function userJson(u) {
  return {
    id: u.id, aud: u.aud || 'authenticated', role: u.role || 'authenticated', email: u.email,
    email_confirmed_at: u.email_confirmed_at, phone: u.phone || '', confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at, app_metadata: u.raw_app_meta_data || { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data || {}, identities: [], created_at: u.created_at, updated_at: u.updated_at,
    is_anonymous: false,
  };
}

function createAuth({ db, secret, issuer, allowSignup }) {
  const accessToken = (u, sessionId) => {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      aud: 'authenticated', exp: now + ACCESS_TTL, iat: now, iss: issuer, sub: u.id, email: u.email, phone: '',
      app_metadata: u.raw_app_meta_data || {}, user_metadata: u.raw_user_meta_data || {}, role: 'authenticated',
      aal: 'aal1', amr: [{ method: 'password', timestamp: now }], session_id: sessionId, is_anonymous: false,
    }, secret);
  };

  async function session(u, sessionId) {
    sessionId = sessionId || crypto.randomUUID();
    const refresh = crypto.randomBytes(24).toString('base64url');
    await db.query('insert into auth.refresh_tokens(token,user_id,session_id) values ($1,$2,$3)', [refresh, u.id, sessionId]);
    const now = Math.floor(Date.now() / 1000);
    return { access_token: accessToken(u, sessionId), token_type: 'bearer', expires_in: ACCESS_TTL, expires_at: now + ACCESS_TTL, refresh_token: refresh, user: userJson(u) };
  }

  async function userById(id) {
    return (await db.query('select * from auth.users where id=$1 and deleted_at is null', [id])).rows[0] || null;
  }
  async function userByEmail(email) {
    return (await db.query('select * from auth.users where lower(email)=lower($1) and deleted_at is null', [String(email || '').trim()])).rows[0] || null;
  }

  async function createUser(email, password, meta, id) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    if (!password || String(password).length < 6) throw new AuthError(422, 'weak_password', 'Password should be at least 6 characters.');
    if (await userByEmail(email)) throw new AuthError(422, 'user_already_exists', 'User already registered');
    const hash = await bcrypt.hash(String(password), 10);
    const r = await db.query(`insert into auth.users(id,email,encrypted_password,raw_user_meta_data) values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4::jsonb) returning *`,
      [id || null, email, hash, JSON.stringify(meta || {})]);
    return r.rows[0];
  }

  // Bearer-Token → Benutzer
  function claimsFrom(req) {
    const h = String(req.headers['authorization'] || '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['apikey'] || '');
    return jwt.verify(tok, secret);
  }
  async function requireUser(req) {
    const c = claimsFrom(req);
    if (!c || c.role !== 'authenticated' || !c.sub) throw new AuthError(401, 'no_authorization', 'This endpoint requires a valid Bearer token');
    const u = await userById(c.sub);
    if (!u) throw new AuthError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    return { u, c };
  }

  async function handle(req, sub, sp, body) {
    const m = req.method;
    if (m === 'GET' && sub === 'settings') return { status: 200, body: { external: { email: true }, disable_signup: !allowSignup, mailer_autoconfirm: true } };
    if (m === 'GET' && sub === 'health') return { status: 200, body: { name: 'NEKOSTA local auth' } };
    if (m === 'POST' && sub === 'signup') {
      if (!allowSignup) throw new AuthError(403, 'signup_disabled', 'Signups not allowed for this instance');
      const u = await createUser(body.email, body.password, body.data);
      const s = await session(u);
      return { status: 200, body: s };
    }
    if (m === 'POST' && sub === 'token') {
      const grant = sp.get('grant_type');
      if (grant === 'password') {
        const u = await userByEmail(body.email);
        const ok = u && u.encrypted_password && await bcrypt.compare(String(body.password || ''), u.encrypted_password.replace(/^\$2y\$/, '$2a$'));
        if (!ok) throw new AuthError(400, 'invalid_credentials', 'Invalid login credentials');
        if (u.banned_until && new Date(u.banned_until) > new Date()) throw new AuthError(400, 'user_banned', 'User is banned');
        await db.query('update auth.users set last_sign_in_at=now() where id=$1', [u.id]);
        return { status: 200, body: await session(Object.assign(u, { last_sign_in_at: new Date().toISOString() })) };
      }
      if (grant === 'refresh_token') {
        const r = (await db.query('update auth.refresh_tokens set revoked=true where token=$1 and not revoked returning *', [body.refresh_token || ''])).rows[0];
        if (!r) throw new AuthError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        const u = await userById(r.user_id);
        if (!u) throw new AuthError(400, 'user_not_found', 'User not found');
        return { status: 200, body: await session(u, r.session_id) };
      }
      throw new AuthError(400, 'unsupported_grant_type', 'Unsupported grant type');
    }
    if (m === 'GET' && sub === 'user') { const { u } = await requireUser(req); return { status: 200, body: userJson(u) }; }
    if (m === 'PUT' && sub === 'user') {
      const { u } = await requireUser(req);
      if (body.password != null) {
        if (String(body.password).length < 6) throw new AuthError(422, 'weak_password', 'Password should be at least 6 characters.');
        await db.query('update auth.users set encrypted_password=$2, updated_at=now() where id=$1', [u.id, await bcrypt.hash(String(body.password), 10)]);
      }
      if (body.email && String(body.email).toLowerCase() !== u.email) {
        if (await userByEmail(body.email)) throw new AuthError(422, 'email_exists', 'A user with this email address has already been registered');
        await db.query('update auth.users set email=lower($2), updated_at=now() where id=$1', [u.id, String(body.email).trim()]);
      }
      if (body.data) await db.query("update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb) || $2::jsonb, updated_at=now() where id=$1", [u.id, JSON.stringify(body.data)]);
      return { status: 200, body: userJson(await userById(u.id)) };
    }
    if (m === 'POST' && sub === 'logout') {
      const c = claimsFrom(req);
      if (c && c.sub) {
        if (sp.get('scope') === 'local' && c.session_id) await db.query('update auth.refresh_tokens set revoked=true where user_id=$1 and session_id=$2', [c.sub, c.session_id]);
        else await db.query('update auth.refresh_tokens set revoked=true where user_id=$1', [c.sub]);
      }
      return { status: 204, body: null };
    }
    if (m === 'POST' && sub === 'recover') {
      // Kein E-Mail-Versand lokal: Passwort setzt der Server-PC unter „Benutzer" zurück.
      return { status: 200, body: {} };
    }
    throw new AuthError(404, 'not_found', 'Not found: ' + sub);
  }

  return { handle, claimsFrom, createUser, userByEmail, userById, userJson, AuthError };
}

module.exports = { createAuth, AuthError };
