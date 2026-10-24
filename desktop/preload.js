// Schmale, sichere Brücke zwischen den Programmfenstern und dem Hauptprozess.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name, ...args) => ipcRenderer.invoke('nk:' + name, ...args);

contextBridge.exposeInMainWorld('nekosta', {
  state: () => call('state'),
  pickFolder: (title, current) => call('pickFolder', title, current),
  chooseServer: (opts) => call('chooseServer', opts),
  discover: () => call('discover'),
  testServer: (url) => call('testServer', url),
  chooseClient: (url) => call('chooseClient', url),
  openMain: () => call('openMain'),
  openWindow: (name) => call('openWindow', name),
  resetMode: () => call('resetMode'),
  setAutostart: (on) => call('setAutostart', on),
  users: { list: () => call('users.list'), create: (u) => call('users.create', u), setPassword: (id, pw) => call('users.setPassword', id, pw), setEmail: (id, e) => call('users.setEmail', id, e), lock: (id, on) => call('users.lock', id, on) },
  backup: { now: () => call('backup.now'), list: () => call('backup.list'), restore: (file) => call('backup.restore', file), openFolder: () => call('backup.openFolder'), setFolder: () => call('backup.setFolder') },
  importCloud: (creds) => call('import.run', creds),
  onProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('nk:progress', h); return () => ipcRenderer.removeListener('nk:progress', h); },
  openDataFolder: () => call('openDataFolder'),
  copy: (text) => call('copy', text),
});
