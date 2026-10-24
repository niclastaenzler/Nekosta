// Minimales JWT (HS256) – kompatibel zu den Supabase-Tokens.
'use strict';
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payload, secret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(head + '.' + body).digest());
  return head + '.' + body + '.' + sig;
}

function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expect = b64u(crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest());
  const a = Buffer.from(expect), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

module.exports = { sign, verify };
