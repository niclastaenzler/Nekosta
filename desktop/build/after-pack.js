// Nach dem Packen: Programmsymbol und Versionsangaben in NEKOSTA.exe schreiben
// (ohne Wine – reine JavaScript-Bearbeitung der Windows-Ressourcen).
'use strict';
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const data = fs.readFileSync(exe);
  const exeFile = PE.NtExecutable.from(data, { ignoreCert: true });
  const res = PE.NtExecutableResource.from(exeFile);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups.length ? groups[0] : { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));
  const version = ctx.packager.appInfo.version;
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map((x) => parseInt(x, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
  const strings = { CompanyName: 'NEKOSTA', FileDescription: 'NEKOSTA – Nebenkosten- und WEG-Verwaltung', ProductName: 'NEKOSTA', LegalCopyright: '© ' + new Date().getFullYear() + ' NEKOSTA', OriginalFilename: 'NEKOSTA.exe', InternalName: 'NEKOSTA', FileVersion: version, ProductVersion: version };
  const langs = vi.getAllLanguagesForStringValues();
  for (const l of (langs.length ? langs : [{ lang: 1033, codepage: 1200 }])) vi.setStringValues(l, strings);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeFile);
  fs.writeFileSync(exe, Buffer.from(exeFile.generate()));
  console.log('  • Symbol und Versionsangaben gesetzt:', path.basename(exe));
};
