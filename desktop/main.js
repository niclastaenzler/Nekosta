// NEKOSTA für Windows – Hauptprozess.
// Modus „Server": dieser PC hält Datenbank und Dokumente und stellt sie im Büronetz bereit.
// Modus „Arbeitsplatz": verbindet sich mit dem Server-PC im Büronetz.
'use strict';
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage, clipboard, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
const APP_ROOT = __dirname;
const WEB_ROOT = path.join(APP_ROOT, 'web');
const SCHEMA_DIR = process.env.NEKOSTA_SCHEMA_DIR || path.join(APP_ROOT, 'schema');
const ICON = path.join(APP_ROOT, 'assets', 'icon.png');
const DEFAULT_PORT = 8787;

app.setName('NEKOSTA');
if (process.env.NEKOSTA_USERDATA) app.setPath('userData', process.env.NEKOSTA_USERDATA);
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'einstellungen.json');

// Protokoll für die Fehlersuche: userData/protokoll.log (ab 2 MB wird auf protokoll.alt.log umgeschaltet).
const LOG_FILE = path.join(app.getPath('userData'), 'protokoll.log');
function log(level, ...a) {
  const line = new Date().toISOString() + ' ' + level + ' ' + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.alt.log'));
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {}
}
for (const [k, lvl] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'FEHLER']]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { log(lvl, ...a); orig(...a); };
}
process.on('uncaughtException', (e) => log('ABSTURZ', e));
process.on('unhandledRejection', (e) => log('ABSTURZ', e));
app.on('child-process-gone', (_e, d) => log('WARN', 'Hilfsprozess beendet', d));
app.on('render-process-gone', (_e, _w, d) => log('WARN', 'Fenster-Prozess beendet', d));
log('INFO', 'Start', app.getVersion(), process.platform, process.versions.electron);

let settings = {};
let srv = null;          // laufender Server (Server-Modus)
let responder = null;    // Antwort auf Server-Suche
let mainWin = null, tray = null, backupTimer = null, quitting = false;
const toolWins = {};

function loadSettings() { try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch (e) { settings = {}; } }
function saveSettings() { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); }
const dataDir = () => settings.dataDir || path.join(app.getPath('userData'), 'Daten');
const backupDir = () => settings.backupDir || path.join(app.getPath('userData'), 'Sicherungen');
const localUrl = () => `http://127.0.0.1:${srv ? srv.port : (settings.port || DEFAULT_PORT)}/`;

// ── Server ───────────────────────────────────────────────────────────────
async function startLocalServer() {
  if (srv) return srv;
  const { startServer } = require('./server');
  const { startResponder } = require('./server/discovery');
  try {
    srv = await startServer({ dataDir: dataDir(), schemaDir: SCHEMA_DIR, webRoot: WEB_ROOT, port: settings.port || DEFAULT_PORT, host: '0.0.0.0', version: app.getVersion(), serverName: require('os').hostname(), allowSignup: settings.allowSignup !== false });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`Port ${settings.port || DEFAULT_PORT} ist bereits belegt. Läuft NEKOSTA schon (Symbol unten rechts in der Taskleiste)?`);
    throw e;
  }
  log('INFO', 'Server läuft auf Port', srv.port, 'Daten:', dataDir());
  responder = startResponder({ port: srv.port, name: require('os').hostname(), id: srv.instanceId });
  scheduleBackups();
  return srv;
}

function scheduleBackups() {
  clearInterval(backupTimer);
  const check = async () => {
    const last = settings.lastBackup ? Date.parse(settings.lastBackup) : 0;
    if (Date.now() - last > 20 * 3600 * 1000) { try { await runBackup(); } catch (e) { console.error('Sicherung fehlgeschlagen:', e); notify('Datensicherung fehlgeschlagen', e.message); } }
  };
  setTimeout(check, 90 * 1000);
  backupTimer = setInterval(check, 3600 * 1000);
}

async function runBackup() {
  const { createBackup } = require('./server/backup');
  const r = await createBackup(srv.db, dataDir(), backupDir());
  settings.lastBackup = r.at; saveSettings();
  return r;
}

function notify(title, body) { try { if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show(); } catch (e) {} }

function lanUrls() {
  const { lanAddresses } = require('./server/discovery');
  const port = srv ? srv.port : (settings.port || DEFAULT_PORT);
  return lanAddresses().map((a) => `http://${a.address}:${port}`);
}

// ── Fenster ──────────────────────────────────────────────────────────────
function toolWindow(name, opts) {
  if (toolWins[name] && !toolWins[name].isDestroyed()) { toolWins[name].show(); toolWins[name].focus(); return toolWins[name]; }
  const w = new BrowserWindow(Object.assign({ width: 760, height: 640, minWidth: 560, minHeight: 460, title: 'NEKOSTA', icon: ICON, backgroundColor: '#f8f5fc', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(APP_ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }, opts || {}));
  w.loadFile(path.join(APP_ROOT, 'app', name + '.html'));
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  toolWins[name] = w;
  return w;
}

function openMain(target) {
  const url = target || (settings.mode === 'server' ? localUrl() : settings.serverUrl);
  if (mainWin && !mainWin.isDestroyed()) { mainWin.loadURL(url); mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({ width: 1400, height: 900, minWidth: 900, minHeight: 600, title: 'NEKOSTA', icon: ICON, backgroundColor: '#ffffff', show: false,
    webPreferences: { preload: path.join(APP_ROOT, 'preload-main.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true } });
  mainWin.webContents.session.setSpellCheckerLanguages(['de-DE']);
  mainWin.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) mainWin.show(); });
  const origin = new URL(url).origin;
  // PDF-Vorschauen (blob:) in eigenen Fenstern, fremde Seiten im normalen Browser
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('blob:') || u.startsWith(origin) || u === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } } };
    shell.openExternal(u); return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(origin) && !u.startsWith('blob:')) { e.preventDefault(); shell.openExternal(u); } });
  mainWin.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (isMain && code !== -3) mainWin.loadFile(path.join(APP_ROOT, 'app', 'offline.html'), { query: { url: failedUrl, fehler: desc } });
  });
  mainWin.on('close', (e) => {
    if (settings.mode === 'server' && !quitting) {
      e.preventDefault(); mainWin.hide();
      if (!settings.trayHinweis) { notify('NEKOSTA läuft weiter', 'Der Server bleibt im Hintergrund aktiv, damit die Arbeitsplätze verbunden bleiben. Beenden über das Symbol unten rechts.'); settings.trayHinweis = true; saveSettings(); }
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadURL(url);
}

function buildMenu() {
  const server = settings.mode === 'server';
  const tpl = [
    { label: 'NEKOSTA', submenu: [
      { label: server ? 'Server-Status & Datensicherung' : 'Verbindung', click: () => toolWindow('status') },
      ...(server ? [{ label: 'Benutzer verwalten', click: () => toolWindow('users') }, { label: 'Daten aus der Cloud übernehmen …', click: () => toolWindow('import') }] : []),
      { type: 'separator' },
      { label: 'Neu laden', accelerator: 'F5', click: () => mainWin && mainWin.webContents.reload() },
      { type: 'separator' },
      { label: 'Beenden', accelerator: 'Alt+F4', click: () => quitApp() },
    ] },
    { label: 'Bearbeiten', submenu: [{ role: 'undo', label: 'Rückgängig' }, { role: 'redo', label: 'Wiederholen' }, { type: 'separator' }, { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' }, { role: 'selectAll', label: 'Alles auswählen' }] },
    { label: 'Ansicht', submenu: [{ role: 'zoomIn', label: 'Vergrößern' }, { role: 'zoomOut', label: 'Verkleinern' }, { role: 'resetZoom', label: 'Originalgröße' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' }, ...(isDev ? [{ role: 'toggleDevTools' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function buildTray() {
  if (settings.mode !== 'server') { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) { tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })); tray.on('click', () => openMain()); }
  tray.setToolTip('NEKOSTA-Server läuft' + (lanUrls()[0] ? ' – ' + lanUrls()[0] : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'NEKOSTA öffnen', click: () => openMain() },
    { label: 'Server-Status & Datensicherung', click: () => toolWindow('status') },
    { label: 'Benutzer verwalten', click: () => toolWindow('users') },
    { type: 'separator' },
    { label: 'Datensicherung jetzt erstellen', click: async () => { try { const r = await runBackup(); notify('Datensicherung erstellt', path.basename(r.file)); } catch (e) { dialog.showErrorBox('Datensicherung fehlgeschlagen', e.message); } } },
    { type: 'separator' },
    { label: 'Server beenden', click: () => quitApp() },
  ]));
}

async function quitApp() {
  if (settings.mode === 'server' && srv) {
    const r = await dialog.showMessageBox({ type: 'question', buttons: ['Beenden', 'Abbrechen'], defaultId: 1, cancelId: 1, title: 'NEKOSTA beenden', message: 'NEKOSTA-Server beenden?', detail: 'Die Arbeitsplätze im Büro können dann nicht mehr auf NEKOSTA zugreifen, bis der Server wieder gestartet wird.' });
    if (r.response !== 0) return;
  }
  quitting = true; app.quit();
}

// ── IPC für die Programmfenster ─────────────────────────────────────────
function handle(name, fn) { ipcMain.handle('nk:' + name, async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } }); }

function cloudConfig() {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  const url = (html.match(/const SUPABASE_URL='([^']+)'/) || [])[1], key = (html.match(/const SUPABASE_KEY='([^']+)'/) || [])[1];
  if (!url || !key) throw new Error('Cloud-Zugang nicht gefunden.');
  return { url: process.env.NEKOSTA_CLOUD_URL || url, key: process.env.NEKOSTA_CLOUD_KEY || key };
}

function registerIpc() {
  handle('state', async () => {
    const { listBackups } = require('./server/backup');
    let users = null;
    if (srv) users = Number((await srv.db.query('select count(*)::int n from auth.users where deleted_at is null')).rows[0].n);
    return { mode: settings.mode || null, version: app.getVersion(), serverUrl: settings.serverUrl || null, dataDir: dataDir(), backupDir: backupDir(), lastBackup: settings.lastBackup || null,
      lan: srv ? lanUrls() : [], port: srv ? srv.port : (settings.port || DEFAULT_PORT), running: !!srv, users,
      backups: settings.mode === 'server' ? listBackups(backupDir()).slice(0, 14).map((b) => ({ file: b.file, name: b.name, size: b.size, mtime: b.mtime })) : [],
      autostart: app.getLoginItemSettings().openAtLogin, hostname: require('os').hostname() };
  });
  handle('pickFolder', async (title, current) => { const r = await dialog.showOpenDialog({ title: title || 'Ordner wählen', defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
  handle('chooseServer', async (opts) => {
    settings = Object.assign({}, settings, { mode: 'server', dataDir: (opts && opts.dataDir) || dataDir(), backupDir: (opts && opts.backupDir) || backupDir(), port: (opts && opts.port) || DEFAULT_PORT });
    saveSettings();
    await startLocalServer();
    if (opts && opts.autostart !== false) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    buildMenu(); buildTray();
    return { lan: lanUrls() };
  });
  handle('discover', async () => require('./server/discovery').discover(2500));
  handle('testServer', async (url) => {
    url = String(url || '').trim(); if (!/^https?:\/\//.test(url)) url = 'http://' + url; if (!/:\d+\/?$/.test(url)) url = url.replace(/\/?$/, ':' + DEFAULT_PORT);
    const r = await fetch(url.replace(/\/$/, '') + '/__nekosta/info', { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!r || !r.ok) throw new Error('Unter ' + url + ' antwortet kein NEKOSTA-Server.');
    return Object.assign({ url: url.replace(/\/$/, '') }, await r.json());
  });
  handle('chooseClient', async (url) => { settings = Object.assign({}, settings, { mode: 'client', serverUrl: url }); saveSettings(); buildMenu(); buildTray(); openMain(); Object.values(toolWins).forEach((w) => !w.isDestroyed() && w.close()); });
  handle('openMain', async () => { openMain(); });
  handle('openWindow', async (name) => { if (['status', 'users', 'import', 'setup'].includes(name)) toolWindow(name); });
  handle('resetMode', async () => {
    const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Modus wechseln', 'Abbrechen'], defaultId: 1, cancelId: 1, title: 'Modus wechseln', message: 'Einrichtung neu starten?', detail: 'Die Daten auf diesem PC bleiben erhalten. NEKOSTA startet danach neu und fragt, ob dieser PC Server oder Arbeitsplatz ist.' });
    if (r.response !== 0) return false;
    settings = { dataDir: settings.dataDir, backupDir: settings.backupDir, lastBackup: settings.lastBackup }; saveSettings();
    app.setLoginItemSettings({ openAtLogin: false });
    quitting = true; app.relaunch(); app.exit(0);
  });
  handle('setAutostart', async (on) => { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); return app.getLoginItemSettings().openAtLogin; });
  const needSrv = () => { if (!srv) throw new Error('Nur auf dem Server-PC verfügbar.'); return srv; };
  const U = () => require('./server/users');
  handle('users.list', async () => U().listUsers(needSrv().db));
  handle('users.create', async (u) => U().createUser(needSrv().auth, u.email, u.password, u.name));
  handle('users.setPassword', async (id, pw) => U().setPassword(needSrv().db, id, pw));
  handle('users.setEmail', async (id, e) => U().setEmail(needSrv().db, id, e));
  handle('users.lock', async (id, on) => U().setLocked(needSrv().db, id, on));
  handle('backup.now', async () => { needSrv(); return runBackup(); });
  handle('backup.list', async () => require('./server/backup').listBackups(backupDir()));
  handle('backup.openFolder', async () => { fs.mkdirSync(backupDir(), { recursive: true }); shell.openPath(backupDir()); });
  handle('openDataFolder', async () => { shell.openPath(dataDir()); });
  handle('copy', async (t) => { clipboard.writeText(String(t || '')); });
  handle('backup.setFolder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Ordner für Datensicherungen (z. B. externe Festplatte oder NAS)', defaultPath: backupDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return backupDir();
    settings.backupDir = r.filePaths[0]; saveSettings(); return settings.backupDir;
  });
  handle('backup.restore', async (file) => {
    needSrv();
    const c = await dialog.showMessageBox({ type: 'warning', buttons: ['Wiederherstellen', 'Abbrechen'], defaultId: 1, cancelId: 1, title: 'Datensicherung wiederherstellen', message: 'Datenbank auf den Stand vom ' + new Date(fs.statSync(file).mtime).toLocaleString('de-DE') + ' zurücksetzen?', detail: 'Alle Änderungen seit dieser Sicherung gehen verloren. Der aktuelle Stand wird vorher als zusätzliche Sicherung abgelegt. Die Arbeitsplätze sind kurz getrennt.' });
    if (c.response !== 0) return false;
    await runBackup();
    const { restoreBackup } = require('./server/backup');
    responder && responder.close(); await srv.close(); srv = null;
    await restoreBackup(dataDir(), file, backupDir());
    await startLocalServer(); openMain();
    return true;
  });
  handle('import.run', async (creds) => {
    const s = needSrv(); const cfg = cloudConfig();
    const send = (p) => { Object.values(toolWins).forEach((w) => !w.isDestroyed() && w.webContents.send('nk:progress', p)); };
    await runBackup().catch(() => {});
    const { importFromCloud } = require('./server/cloud-import');
    const rep = await importFromCloud({ db: s.db, dataDir: dataDir(), cloudUrl: cfg.url, cloudKey: cfg.key, email: creds.email, password: creds.password, onProgress: send });
    await s.reloadCatalog();
    return rep;
  });
}

// ── Start ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); } else if (settings.mode) openMain(); else toolWindow('setup'); });
  app.whenReady().then(async () => {
    loadSettings(); registerIpc(); buildMenu();
    if (settings.mode === 'server') {
      try { await startLocalServer(); buildTray(); log('INFO', 'Symbol in der Taskleiste bereit'); openMain(); log('INFO', 'Hauptfenster geöffnet'); }
      catch (e) { log('FEHLER', 'Serverstart', e); dialog.showErrorBox('NEKOSTA-Server konnte nicht starten', e.message); toolWindow('status'); }
    } else if (settings.mode === 'client') { openMain(); }
    else toolWindow('setup', { width: 820, height: 680 });
  });
  app.on('window-all-closed', () => { if (settings.mode !== 'server' || quitting) app.quit(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', async (e) => {
    if (srv) { e.preventDefault(); const s = srv; srv = null; clearInterval(backupTimer); responder && responder.close(); try { await s.close(); } catch (x) {} app.exit(0); }
  });
}
