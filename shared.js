/**
 * shared.js — Common utilities & API layer
 * Used by both index.html (manager) and tv.html (TV display)
 *
 * POPRAWKI:
 *  [FIX-14] Utils.lvLabel — bezpieczny fallback zamiast surowego klucza
 */

// ── Server URL detection ─────────────────────────────────────────────────
// Jeśli plik jest otwarty z dysku (file://), użyj localhost:3000
const API_BASE = window.location.protocol === 'file:'
  ? 'http://localhost:3000'
  : window.location.origin;

// ── API helpers ──────────────────────────────────────────────────────────
const API = {
  async getState() {
    const r = await fetch(`${API_BASE}/api/state`);
    if (!r.ok) throw new Error('Server unreachable');
    return r.json();
  },

  async setState(state) {
    const r = await fetch(`${API_BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!r.ok) throw new Error('Save failed');
    return r.json();
  },

  async postResult(matchId, s1, s2, note = '') {
    const r = await fetch(`${API_BASE}/api/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId, s1, s2, note }),
    });
    if (!r.ok) throw new Error('Result save failed');
    return r.json();
  },

  async postOvertime(matchId) {
    const r = await fetch(`${API_BASE}/api/overtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId }),
    });
    if (!r.ok) throw new Error('Overtime notify failed');
    return r.json();
  },

  async postFinish() {
    const r = await fetch(`${API_BASE}/api/finish`, { method: 'POST' });
    if (!r.ok) throw new Error('Finish failed');
    return r.json();
  },

  subscribe(onUpdate) {
    const es = new EventSource(`${API_BASE}/api/events`);
    es.addEventListener('update',    e => onUpdate('update',    JSON.parse(e.data)));
    es.addEventListener('result',    e => onUpdate('result',    JSON.parse(e.data)));
    es.addEventListener('overtime',  e => onUpdate('overtime',  JSON.parse(e.data)));
    es.addEventListener('finish',    e => onUpdate('finish',    JSON.parse(e.data)));
    es.addEventListener('connected', e => onUpdate('connected', JSON.parse(e.data)));
    es.onerror = () => onUpdate('error', {});
    return es;
  },
};

// ── Pure utility functions ────────────────────────────────────────────────
const Utils = {
  ini: n => (n || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2),

  fS: v => v === null || v === undefined ? '?' : v % 1 === 0 ? String(v) : v.toFixed(1),

  // Escape HTML — zapobiega XSS gdy nazwa gracza zawiera <, >, &, ", '
  esc: s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),

  hexRgb: hex => {
    const n = parseInt(hex.replace('#', ''), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  },

  // [FIX-14] Bezpieczny fallback — zamiast surowego klucza zwraca '—'
  lvLabel: l => ({
    beginner:     '🐣 Nowicjusz',
    intermediate: '🎮 Casual',
    advanced:     '🔥 Zaawansowany',
    expert:       '⚡ Ekspert',
  }[l] || '—'),

  rName: (totalRounds, r) => {
    const diff = totalRounds - r;
    if (diff === 0) return '🏆 Finał';
    if (diff === 1) return 'Półfinał';
    if (diff === 2) return 'Ćwierćfinał';
    return 'Runda ' + r;
  },
};

// ── State computation helpers (shared between manager + TV) ───────────────
const Compute = {
  standings(state) {
    const { players, matches, cfg } = state;
    const d = {};
    players.forEach(p => {
      d[p.id] = { pts: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, gd: 0, played: 0 };
    });
    matches.filter(m => m.done && m.p1 && m.p2).forEach(m => {
      const a = d[m.p1], b = d[m.p2];
      if (!a || !b) return;
      a.played++; b.played++;
      a.gf += m.s1; a.ga += m.s2;
      b.gf += m.s2; b.ga += m.s1;
      if (m.s1 > m.s2) {
        a.pts += cfg.ptsW; a.wins++;
        b.pts += cfg.ptsL; b.losses++;
      } else if (m.s2 > m.s1) {
        b.pts += cfg.ptsW; b.wins++;
        a.pts += cfg.ptsL; a.losses++;
      } else {
        a.pts += cfg.ptsD; a.draws++;
        b.pts += cfg.ptsD; b.draws++;
      }
    });
    players.forEach(p => { if (d[p.id]) d[p.id].gd = d[p.id].gf - d[p.id].ga; });
    return d;
  },

  sortedPlayers(state, standingsData) {
    return [...state.players].sort((a, b) => {
      const pa = standingsData[a.id] || {}, pb = standingsData[b.id] || {};
      if ((pb.pts || 0) !== (pa.pts || 0)) return (pb.pts || 0) - (pa.pts || 0);
      if (state.cfg.tie === 'wins') return (pb.wins || 0) - (pa.wins || 0);
      return (pb.gd || 0) - (pa.gd || 0);
    });
  },

  winOf: m => !m || !m.done ? null : m.s1 >= m.s2 ? m.p1 : m.p2,
  losOf: m => !m || !m.done ? null : m.s1 >= m.s2 ? m.p2 : m.p1,

  getPlayer: (state, id) => state.players.find(p => p.id === id),
  getMatch:  (state, id) => state.matches.find(m => m.id === id),
};

window.API     = API;
window.Utils   = Utils;
window.Compute = Compute;