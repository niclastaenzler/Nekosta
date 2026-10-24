// Vor dem Bau prüfen: Ohne das echte NEKOSTA-Schema wäre das Programm unbrauchbar.
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'schema');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
if (!files.length && !process.env.NEKOSTA_ALLOW_TEST_SCHEMA) {
  console.error('\n✗ desktop/schema/ enthält kein Datenbankschema.\n  Bitte tools/schema-export.sql in Supabase ausführen und das Ergebnis als schema/001_nekosta.sql speichern.\n');
  process.exit(1);
}
console.log('Schema:', files.join(', ') || '(Testschema)');
