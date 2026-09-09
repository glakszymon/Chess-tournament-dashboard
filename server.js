/**
 * Chess Tournament — Local Network Server
 * ----------------------------------------
 * Run: node server.js
 * Then open:
 *   Manager → http://localhost:3000
 *   TV View  → http://localhost:3000/tv.html  (or from any device on LAN)
 *
 * No dependencies needed — uses only Node.js built-ins.
 *
 * POPRAWKI:
 *  [FIX-15] Limit rozmiaru body (ochrona przed DoS)
 *  [FIX-5]  Nagłówki bezpieczeństwa (X-Content-Type-Options, X-Frame-Options)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 3000;
const DATA_FILE = path.join(__dirname, 'tournament-data.json');
const MAX_BODY  = 512 * 1024; // 512 KB — [FIX-15]

// ─── In-memory state (also persisted to JSON) ─────────────────────────────
let state = loadState();

// ─── SSE clients for real-time push to TV ────────────────────────────────
const sseClients = new Set();

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load error:', e.message); }
  return { cfg: {}, players: [], matches: [], brRounds: [], _mc: 0, updatedAt: 0 };
}

function saveState(newState) {
  newState.updatedAt = Date.now();
  state = newState;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Save error:', e.message);
    return; // Nie broadcastuj jeśli zapis się nie powiódł
  }
  broadcast('update', { updatedAt: state.updatedAt });
}

// ─── MIME types ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

// ─── Security headers helper ──────────────────────────────────────────────
// [FIX-5] Dodane nagłówki bezpieczeństwa
function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ─── Static file helper ───────────────────────────────────────────────────
function serveFile(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, ...secHeaders() });
    res.end(content);
  } catch (_) {
    res.writeHead(404); res.end('Not found: ' + path.basename(filePath));
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...secHeaders(),
  });
  res.end(JSON.stringify(data));
}

// [FIX-15] readBody z limitem rozmiaru
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── SSE endpoint: TV subscribes here for live updates ──────────────────
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: {"ok":true}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    // Send heartbeat every 15s so proxies don't close connection
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); }
      catch (_) { clearInterval(hb); sseClients.delete(res); }
    }, 15000);
    return;
  }

  // ── REST: full state ────────────────────────────────────────────────────
  if (url === '/api/state') {
    if (method === 'GET') return json(res, state);
    if (method === 'POST' || method === 'PUT') {
      try {
        const body = await readBody(req);
        saveState(body);
        return json(res, { ok: true, updatedAt: state.updatedAt });
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
  }

  // ── REST: partial update (just one match result) ────────────────────────
  if (url === '/api/result' && method === 'POST') {
    try {
      const { matchId, s1, s2, note } = await readBody(req);
      const m = state.matches.find(m => m.id === matchId);
      if (!m) return json(res, { error: 'match not found' }, 404);
      m.s1 = s1; m.s2 = s2; m.done = true; m.note = note || '';
      saveState(state);
      const p1 = state.players.find(p => p.id === m.p1);
      const p2 = state.players.find(p => p.id === m.p2);
      broadcast('result', { match: m, p1, p2 });
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 400); }
  }

  // ── REST: overtime ──────────────────────────────────────────────────────
  if (url === '/api/overtime' && method === 'POST') {
    try {
      const { matchId } = await readBody(req);
      const m = state.matches.find(m => m.id === matchId);
      if (!m) return json(res, { error: 'match not found' }, 404);
      const p1 = state.players.find(p => p.id === m.p1);
      const p2 = state.players.find(p => p.id === m.p2);
      broadcast('overtime', { match: m, p1, p2 });
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 400); }
  }

  // ── REST: finish tournament ──────────────────────────────────────────────
  if (url === '/api/finish' && method === 'POST') {
    state.cfg = state.cfg || {};
    state.cfg.finished = true;
    state.cfg.finishedAt = Date.now();
    saveState(state);
    broadcast('finish', { finishedAt: state.cfg.finishedAt });
    return json(res, { ok: true });
  }

  // ── REST: unfinish (reset finished flag) ─────────────────────────────────
  if (url === '/api/unfinish' && method === 'POST') {
    if (state.cfg) { state.cfg.finished = false; delete state.cfg.finishedAt; }
    saveState(state);
    broadcast('update', { updatedAt: state.updatedAt });
    return json(res, { ok: true });
  }

  // ── Static files ────────────────────────────────────────────────────────
  if (url === '/' || url === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'));
  }
  if (url === '/tv' || url === '/tv.html') {
    return serveFile(res, path.join(__dirname, 'tv.html'));
  }
  if (['/style.css', '/app.js', '/tv.js', '/shared.js'].includes(url)) {
    return serveFile(res, path.join(__dirname, url.slice(1)));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ♟  Chess Tournament Server  ♟              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Manager:  http://localhost:${PORT}              ║`);
  ips.forEach(ip =>
    console.log(`║  TV View:  http://${ip}:${PORT}/tv.html          ║`)
  );
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('Ctrl+C to stop\n');
});