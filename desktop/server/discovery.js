// Server im Büronetz finden: Der Server antwortet auf UDP-Rundrufe,
// Arbeitsplätze senden einen Rundruf und sammeln die Antworten.
'use strict';
const dgram = require('dgram');
const os = require('os');

const PORT = 41234;
const ASK = 'NEKOSTA-SERVER?';

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, netmask: a.netmask });
  }
  return out;
}
function broadcastOf(a) {
  const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
  return ip.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.');
}

function startResponder({ port, name, id }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString() !== ASK) return;
    const reply = JSON.stringify({ app: 'NEKOSTA', port, id: id || null, name: name || os.hostname() });
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => console.warn('[nekosta] Server-Suche nicht verfügbar:', e.message));
  sock.bind(PORT);
  return { close: () => { try { sock.close(); } catch (e) {} } };
}

function discover(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d.app !== 'NEKOSTA') return;
        // Ein Server kann über mehrere Adressen antworten (Netzwerk + 127.0.0.1): einmal zeigen,
        // Netzwerkadresse bevorzugen, damit die Einstellung auch für andere PCs passt.
        const key = d.id || (rinfo.address + ':' + d.port);
        const prev = found.get(key), loop = rinfo.address.startsWith('127.');
        if (!prev || (prev.loopback && !loop)) found.set(key, { url: `http://${rinfo.address}:${d.port}`, name: d.name, address: rinfo.address, loopback: loop });
      } catch (e) {}
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const targets = new Set(['255.255.255.255', '127.0.0.1', ...lanAddresses().map(broadcastOf)]);
      for (const t of targets) sock.send(ASK, PORT, t, () => {});
    });
    setTimeout(() => { try { sock.close(); } catch (e) {} resolve([...found.values()]); }, timeoutMs || 2000);
  });
}

module.exports = { startResponder, discover, lanAddresses, PORT };
