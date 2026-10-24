// Kleine Helfer für die Programmfenster
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(fn, ...args) {
  const r = await fn(...args);
  if (!r || !r.ok) throw new Error((r && r.error) || 'Unbekannter Fehler');
  return r.data;
}
function msg(el, kind, text) { el.className = 'msg ' + kind; el.textContent = text; el.classList.remove('hidden'); }
function fmtDate(d) { if (!d) return '–'; const x = new Date(d); return x.toLocaleDateString('de-DE') + ', ' + x.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'; }
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
