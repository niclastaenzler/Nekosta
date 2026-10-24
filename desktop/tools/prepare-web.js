// Kopiert die NEKOSTA-Oberfläche (../index.html) und alle Bibliotheken nach web/,
// damit das Programm komplett offline läuft.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const vendor = path.join(web, 'vendor');
fs.mkdirSync(vendor, { recursive: true });

const copy = (from, to) => { fs.copyFileSync(path.join(root, from), path.join(vendor, to)); };
fs.copyFileSync(path.join(root, '..', 'index.html'), path.join(web, 'index.html'));
copy('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js');
copy('node_modules/jspdf/dist/jspdf.umd.min.js', 'jspdf.umd.min.js');
copy('node_modules/jszip/dist/jszip.min.js', 'jszip.min.js');
copy('node_modules/pdfjs-dist/build/pdf.min.js', 'pdf.min.js');
copy('node_modules/pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js');

// Prüfen, dass alle externen Skripte der Oberfläche eine lokale Entsprechung haben
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const ext = [...new Set((html.match(/https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/[^'"\s)]+/g) || []))];
const { VENDOR } = require('../server');
const missing = ext.filter((u) => !VENDOR.some(([re]) => { re.lastIndex = 0; return re.test(u); }));
if (missing.length) { console.error('Nicht lokal verfügbar:', missing); process.exit(1); }
console.log('web/ vorbereitet:', ext.length, 'externe Bibliotheken lokal ersetzt');
