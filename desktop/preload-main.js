// Brücke für das NEKOSTA-Hauptfenster: nur Verbindungsprüfung und Modus-Wechsel
// (für die Seite „Server nicht erreichbar"), keine Verwaltungsfunktionen.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...args) => ipcRenderer.invoke('nk:' + name, ...args);
contextBridge.exposeInMainWorld('nekosta', {
  testServer: (url) => call('testServer', url),
  resetMode: () => call('resetMode'),
  openWindow: (name) => call('openWindow', name === 'status' ? 'status' : null),
});
