/**
 * app.js — Chess Tournament Manager
 *
 * POPRAWKI:
 *  [FIX-6]  Wyścig stanu SSE: nie nadpisuj S.matches gdy modal wyniku jest otwarty
 *  [FIX-8]  XSS w inline onclick — showDrawPanel używa data-atrybutów zamiast inline strings
 *  [FIX-9]  Staggered animacja wejścia match cardów (--i CSS variable)
 *  [FIX-16] Debounce pushToServer przy addPlayer
 *  [FIX-18] Dynamiczny meta theme-color
 */

/* ════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
const S = {
  cfg: {
    name:'', org:'', date:'', loc:'',
    fmt:'league', ptsW:1, ptsD:.5, ptsL:0,
    tie:'direct', rematch:'no', order:'rr',
    cup3rd:'yes', cupSeed:'seed',
    swRounds:5, swPair:'points',
    theme:'#1c1917',
    active:false, swRound:0,
  },
  players:[], matches:[], brRounds:[], _mc:0,
  avColor:'#1d4ed8', lvColor:'#1d4ed8',
  curStep:1, curView:'matches', openMatchId:null,
};

let _uid = 0;
let _serverOk = false;
// [FIX-16] Debounce timer dla pushToServer
let _pushTimer = null;

/* ════════════════════════════════════════════════════════
   SERVER SYNC
═══════════════════════════════════════════════════════ */
async function syncFromServer() {
  try {
    const remote = await API.getState();
    if (remote.cfg && remote.players) {
      Object.assign(S.cfg, remote.cfg);
      S.players   = remote.players  || [];
      S.matches   = remote.matches  || [];
      S.brRounds  = remote.brRounds || [];
      S._mc       = remote._mc      || 0;
      return true;
    }
  } catch (e) {
    console.warn('Server sync failed:', e.message);
  }
  return false;
}

async function pushToServer() {
  try {
    await API.setState({
      cfg: S.cfg, players: S.players, matches: S.matches,
      brRounds: S.brRounds, _mc: S._mc,
    });
    setConnected(true);
  } catch (e) {
    console.warn('Push failed:', e.message);
    setConnected(false);
  }
}

// [FIX-16] Debounced push — łączy szybkie kolejne wywołania w jedno
function pushToServerDebounced(delay = 300) {
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushToServer, delay);
}

async function pushResult(matchId, s1, s2, note) {
  try {
    await API.postResult(matchId, s1, s2, note);
    await pushToServer();
    setConnected(true);
  } catch (e) {
    console.warn('Result push failed:', e.message);
    setConnected(false);
  }
}

function setConnected(ok) {
  _serverOk = ok;
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (dot) {
    dot.className = 'conn-dot' + (ok ? ' ok' : '');
    if (label) label.textContent = ok ? 'Połączono z serwerem' : 'Brak serwera';
  }
  const banner = document.getElementById('server-banner');
  if (banner) banner.style.display = ok ? 'none' : 'flex';
}

/* ════════════════════════════════════════════════════════
   MATCH FACTORY
═══════════════════════════════════════════════════════ */
function mkM(p1, p2, type, round, byeWin) {
  S._mc++;
  const m = { id:'m'+S._mc, p1, p2, type, round, s1:null, s2:null, done:!!byeWin, note:'' };
  if (byeWin) { m.s1=1; m.s2=0; }
  return m;
}

const gM  = id => S.matches.find(m => m.id === id);
const gP  = id => S.players.find(p => p.id === id);
const ini = Utils.ini;
const fS  = Utils.fS;

/* ════════════════════════════════════════════════════════
   PANEL NAVIGATION
═══════════════════════════════════════════════════════ */
function goPanel(n, back = false) {
  if (n >= 2 && !document.getElementById('t-name').value.trim() && !S.cfg.name) {
    toast('Podaj nazwę turnieju ✦', '⚠️'); return;
  }
  if (n >= 4 && S.players.length < 2) {
    toast('Dodaj minimum 2 graczy', '⚠️'); goPanel(3); return;
  }
  const oldEl = document.querySelector('.panel.active');
  if (oldEl) oldEl.classList.remove('active');
  const newEl = document.getElementById('p' + n);
  newEl.classList.add('active');
  newEl.classList.remove('entering', 'entering-back');
  void newEl.offsetWidth;
  newEl.classList.add(back ? 'entering-back' : 'entering');
  S.curStep = n;
  updateRail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function railClick(n) {
  if (n > S.curStep) return;
  if (n === 4 && !S.cfg.active) return;
  goPanel(n, n < S.curStep);
}

function updateRail() {
  document.querySelectorAll('.rail-step').forEach(el => {
    const i = parseInt(el.dataset.s);
    el.classList.remove('active', 'done', 'clickable');
    if (i < S.curStep)       { el.classList.add('done', 'clickable'); }
    else if (i === S.curStep) { el.classList.add('active'); }
    if (i === 4 && S.cfg.active) el.classList.add('clickable');
    el.querySelector('span').textContent = i < S.curStep ? '✓' : i;
  });
}

/* ════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════ */
function pickTheme(el) {
  document.querySelectorAll('#sw-theme .swatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel');
  applyTheme(el.dataset.c);
}

function applyTheme(c) {
  S.cfg.theme = c;
  const rgb = Utils.hexRgb(c);
  const r   = document.documentElement;
  r.style.setProperty('--accent',     c);
  r.style.setProperty('--accent-rgb', rgb);
  r.style.setProperty('--accent-l',   `rgba(${rgb},.07)`);
  r.style.setProperty('--accent-m',   `rgba(${rgb},.2)`);
  // [FIX-18] Dynamiczny meta theme-color dla mobile
  const meta = document.getElementById('meta-theme');
  if (meta) meta.content = c;
}

/* ════════════════════════════════════════════════════════
   FORMAT SETUP
═══════════════════════════════════════════════════════ */
function pickFmt(el) {
  document.querySelectorAll('.fmt-card').forEach(c => c.classList.remove('sel'));
  el.classList.add('sel');
  S.cfg.fmt = el.dataset.fmt;
  ['league','cup','swiss'].forEach(f => {
    const d = document.getElementById('fopt-' + f);
    if (d) d.style.display = 'none';
  });
  const show = document.getElementById('fopt-' + S.cfg.fmt);
  if (show) show.style.display = 'block';
}

function pickScore(v, el) {
  document.querySelectorAll('#score-pills .pill').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  if (v === 'chess')       { setScores(1, .5, 0); }
  else if (v === 'sport')  { setScores(3, 1, 0); }
}

function setScores(w, d, l) {
  document.getElementById('pts-w').value = w;
  document.getElementById('pts-d').value = d;
  document.getElementById('pts-l').value = l;
}

/* ════════════════════════════════════════════════════════
   PLAYERS
═══════════════════════════════════════════════════════ */
function pickAv(el) {
  document.querySelectorAll('#sw-av .swatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel'); S.avColor = el.dataset.c;
}

function pickLv(el) {
  document.querySelectorAll('#sw-live .swatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel'); S.lvColor = el.dataset.c;
}

let _addingPlayer = false;

function addPlayer() {
  if (_addingPlayer) return;
  const name = document.getElementById('p-name').value.trim();
  if (!name) { toast('Podaj imię gracza', '⚠️'); return; }
  _addingPlayer = true;
  const p = {
    id: 'p' + Date.now() + '_' + (++_uid),
    name, level: document.getElementById('p-level').value,
    color: S.avColor, seed: S.players.length + 1,
  };
  S.players.push(p);
  document.getElementById('p-name').value = '';
  renderRoster();
  toast(`${name} dołączył! 🎉`, '✓');
  // [FIX-16] Debounced push — grupuje szybkie dodania
  pushToServerDebounced(400);
  setTimeout(() => { _addingPlayer = false; }, 200);
}

function removePlayer(id) {
  if (S.cfg.active) {
    // W trakcie turnieju: usuń gracza i wszystkie jego mecze
    S.players = S.players.filter(p => p.id !== id);
    S.matches = S.matches.filter(m => m.p1 !== id && m.p2 !== id);
    // Usuń z drabinki (puchar)
    S.brRounds.forEach(r => {
      r.mids = r.mids.filter(mid => {
        const m = gM(mid);
        return m && m.p1 !== id && m.p2 !== id;
      });
    });
    renderTournament(); renderStandings(); renderBracket(); renderStats();
    toast('Gracz i jego mecze usunięte', 'ℹ️');
  } else {
    S.players = S.players.filter(p => p.id !== id);
    renderRoster();
  }
  pushToServerDebounced(400);
}

function renderRoster() {
  const g = document.getElementById('player-grid');
  document.getElementById('roster-count').textContent = S.players.length;
  if (!S.players.length) {
    g.innerHTML = '<p class="text-sm text-dim italic" style="grid-column:1/-1;padding:8px 0">Jeszcze nikogo nie dodano…</p>';
    return;
  }
  g.innerHTML = S.players.map((p, i) => `
    <div class="player-tile" style="animation-delay:${i*40}ms">
      <div class="avatar avatar-lg" style="background:${p.color}">${ini(p.name)}</div>
      <div style="min-width:0;flex:1">
        <div class="player-name">${Utils.esc(p.name)}</div>
        <div class="player-sub">${Utils.lvLabel(p.level)}</div>
      </div>
      <button class="tile-remove" data-pid="${Utils.esc(p.id)}" onclick="removePlayer(this.dataset.pid)">✕</button>
    </div>`).join('');
}

let _addingLive = false;

function addLivePlayer() {
  if (_addingLive) return;
  const name = document.getElementById('lv-name').value.trim();
  if (!name) { toast('Podaj imię', '⚠️'); return; }
  if (S.cfg.fmt === 'cup') {
    toast('W pucharówce nie można dodać gracza — bracket jest zablokowany', '⚠️');
    return;
  }
  _addingLive = true;
  const p = {
    id: 'p' + Date.now() + '_' + (++_uid),
    name, level: document.getElementById('lv-level').value,
    color: S.lvColor, seed: S.players.length + 1,
  };
  S.players.push(p);
  document.getElementById('lv-name').value = '';
  const existing = S.players.filter(pl => pl.id !== p.id);
  const nextR = Math.max(...S.matches.map(m => m.round), 0) + 1;
  existing.forEach(pl => S.matches.push(mkM(p.id, pl.id, 'league', nextR, false)));
  renderTournament();
  toast(`${name} dołączył do turnieju! 🎉`, '✓');
  pushToServer();
  _addingLive = false;
}

/* ════════════════════════════════════════════════════════
   LAUNCH / RESET
═══════════════════════════════════════════════════════ */
let _launching = false;

function launchTournament() {
  if (_launching) return;
  if (S.players.length < 2) { toast('Dodaj min. 2 graczy', '⚠️'); return; }
  _launching = true;
  const c = S.cfg;
  c.name  = document.getElementById('t-name').value.trim() || 'Turniej';
  c.org   = document.getElementById('t-org').value.trim();
  c.date  = document.getElementById('t-date').value;
  c.loc   = document.getElementById('t-loc').value.trim();
  c.ptsW  = parseFloat(document.getElementById('pts-w').value) || 1;
  c.ptsD  = parseFloat(document.getElementById('pts-d').value) || .5;
  c.ptsL  = parseFloat(document.getElementById('pts-l').value) || 0;
  c.tie       = document.getElementById('opt-tie').value;
  c.rematch   = document.getElementById('opt-rematch')?.value  || 'no';
  c.cup3rd    = document.getElementById('opt-3rd')?.value      || 'yes';
  c.cupSeed   = document.getElementById('opt-seed')?.value     || 'seed';
  c.swRounds  = parseInt(document.getElementById('opt-sw-rounds')?.value || 5);
  c.swPair    = document.getElementById('opt-sw-pair')?.value  || 'points';
  c.overtime  = document.getElementById('opt-overtime')?.checked || false;
  c.active = true; c.swRound = 0;
  S.matches=[]; S.brRounds=[]; S._mc=0;
  generateMatches();
  document.getElementById('hdr-name').textContent = '— ' + c.name;
  renderTournament(); renderStandings(); renderBracket(); renderStats();
  goPanel(4);
  toast(`"${c.name}" uruchomiony! 🚀`, '✓');
  pushToServer();
  _launching = false;
}

function resetTournament() {
  if (!confirm('Zresetować turniej? Wszystkie wyniki zostaną usunięte.')) return;
  S.cfg.active = false; S.cfg.swRound = 0;
  S.matches=[]; S.brRounds=[]; S._mc=0;
  goPanel(3, true);
  toast('Turniej zresetowany', 'ℹ️');
  pushToServer();
}

async function finishTournament() {
  if (!confirm('Zakończyć turniej? Zostanie wyświetlona ceremonia wręczenia nagród.')) return;
  try {
    await API.postFinish();
    toast('Turniej zakończony! 🏆 Widok TV pokazuje podium.', '✓');
  } catch (e) {
    toast('Błąd zakończenia turnieju', '⚠️');
  }
}

/* ════════════════════════════════════════════════════════
   MATCH GENERATION
═══════════════════════════════════════════════════════ */
function generateMatches() {
  if (S.cfg.fmt === 'league')      genLeague();
  else if (S.cfg.fmt === 'cup')    genCup(S.players.map(p => p.id));
  else if (S.cfg.fmt === 'swiss')  genSwiss(1);
}

function genLeague() {
  let list = S.players.map(p => p.id);
  if (list.length % 2 !== 0) list.push(null);
  const sz = list.length, nr = sz - 1;
  const seen = new Set();
  for (let r = 0; r < nr; r++) {
    for (let i = 0; i < sz / 2; i++) {
      const a = list[i], b = list[sz - 1 - i];
      if (!a || !b) continue;
      const k = [a, b].sort().join(':');
      if (seen.has(k)) continue;
      seen.add(k);
      S.matches.push(mkM(a, b, 'league', r + 1, false));
      if (S.cfg.rematch === 'yes') S.matches.push(mkM(b, a, 'league', r + 1, false));
    }
    list = [list[0], list[sz - 1], ...list.slice(1, sz - 1)];
  }
}

function genCup(ids) {
  let slots = [...ids];
  if (S.cfg.cupSeed === 'random') {
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
  }
  while ((slots.length & (slots.length - 1)) !== 0) slots.push(null);
  const totalR = Math.log2(slots.length);
  const r1Ids  = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i], b = slots[i + 1];
    const isBye = b === null;
    const m = mkM(a, isBye ? null : b, 'cup', 1, isBye);
    if (isBye) m.byeMatch = true;
    S.matches.push(m); r1Ids.push(m.id);
  }
  S.brRounds.push({ id:'r1', name:Utils.rName(totalR,1), mids:r1Ids });
  for (let r = 2; r <= totalR; r++) {
    const cnt  = Math.floor(S.brRounds[r - 2].mids.length / 2);
    const mids = [];
    for (let i = 0; i < cnt; i++) {
      const m = mkM(null, null, 'cup', r, false);
      S.matches.push(m); mids.push(m.id);
    }
    S.brRounds.push({ id:'r'+r, name:Utils.rName(totalR, r), mids });
  }
  if (S.cfg.cup3rd === 'yes' && totalR >= 2) {
    const m3 = mkM(null, null, 'cup3rd', totalR, false);
    m3.label = '🥉 3. miejsce';
    S.matches.push(m3);
    S.brRounds.push({ id:'r3rd', name:'3. Miejsce', mids:[m3.id] });
  }
  _propagateByes();
}

function _propagateByes() {
  const main = S.brRounds.filter(r => r.id !== 'r3rd');
  for (let ri = 0; ri < main.length - 1; ri++) {
    const cur = main[ri], nxt = main[ri + 1];
    const cms = cur.mids.map(id => gM(id)).filter(Boolean);
    const nms = nxt.mids.map(id => gM(id)).filter(Boolean);
    nms.forEach((nm, i) => {
      const left  = cms[i * 2];
      const right = cms[i * 2 + 1];
      const np1 = left  && left.done  ? Compute.winOf(left)  : nm.p1;
      const np2 = right && right.done ? Compute.winOf(right) : nm.p2;
      nm.p1 = np1 || null; nm.p2 = np2 || null;
      if (nm.p1 && nm.p2 === null) { nm.done=true; nm.s1=1; nm.s2=0; nm.byeMatch=true; }
    });
  }
}

function genSwiss(rn) {
  const pts  = Compute.standings(S);
  const ps   = [...S.players].sort((a,b) => (pts[b.id]?.pts||0) - (pts[a.id]?.pts||0));
  const used = new Set();
  for (let i = 0; i < ps.length; i++) {
    if (used.has(ps[i].id)) continue;
    let paired = false;
    for (let pass = 0; pass < 2 && !paired; pass++) {
      for (let j = i + 1; j < ps.length; j++) {
        if (used.has(ps[j].id)) continue;
        const met = pass === 0 && S.matches.some(m =>
          m.type.startsWith('swiss') &&
          ((m.p1===ps[i].id&&m.p2===ps[j].id)||(m.p1===ps[j].id&&m.p2===ps[i].id))
        );
        if (!met) {
          S.matches.push(mkM(ps[i].id, ps[j].id, 'swiss', rn, false));
          used.add(ps[i].id); used.add(ps[j].id);
          paired = true; break;
        }
      }
    }
  }
  S.cfg.swRound = rn;
}

function generateNextRound() {
  if (S.cfg.fmt === 'swiss') {
    const pend = S.matches.filter(m => m.type.startsWith('swiss') && !m.done);
    if (pend.length) { toast('Zakończ wszystkie mecze bieżącej rundy', '⚠️'); return; }
    const next = S.cfg.swRound + 1;
    if (next > S.cfg.swRounds) { toast('Wszystkie rundy zakończone! 🏆', '✓'); return; }
    genSwiss(next); renderTournament();
    toast(`Runda ${next} wygenerowana ✓`, '✓');
    pushToServer();
  }
}

function advanceBracket() {
  const main = S.brRounds.filter(r => r.id !== 'r3rd');
  let updated = false;
  for (let ri = 0; ri < main.length - 1; ri++) {
    const cur = main[ri], nxt = main[ri + 1];
    const cms = cur.mids.map(id => gM(id)).filter(Boolean);
    const nms = nxt.mids.map(id => gM(id)).filter(Boolean);
    if (!cms.every(m => m.done)) continue;
    const winners = cms.map(m => Compute.winOf(m));
    nms.forEach((nm, i) => {
      const np1 = winners[i * 2] || null, np2 = winners[i * 2 + 1] || null;
      if (nm.p1 !== np1 || nm.p2 !== np2) { nm.p1=np1; nm.p2=np2; updated=true; }
    });
  }
  const semi = main[main.length - 2];
  if (semi) {
    const sms = semi.mids.map(id => gM(id)).filter(Boolean);
    if (sms.every(m => m.done)) {
      const los = sms.map(m => Compute.losOf(m));
      const th  = S.matches.find(m => m.type === 'cup3rd');
      if (th && (th.p1 !== los[0] || th.p2 !== los[1])) {
        th.p1 = los[0]||null; th.p2 = los[1]||null; updated = true;
      }
    }
  }
  _propagateByes();
  renderTournament(); renderBracket();
  if (updated) { toast('Drabinka zaktualizowana ✓', '✓'); pushToServer(); }
  else toast('Zakończ mecze aktualnej rundy', 'ℹ️');
}

/* ════════════════════════════════════════════════════════
   RENDER TOURNAMENT
═══════════════════════════════════════════════════════ */
function renderTournament() {
  const c    = S.cfg;
  const done = S.matches.filter(m => m.done && m.p1);
  const pend = S.matches.filter(m => !m.done && m.p1 && m.p2);
  const data   = Compute.standings(S);
  const sorted = Compute.sortedPlayers(S, data);
  const leader = sorted[0];

  document.getElementById('t-hero-title').textContent = c.name;
  document.getElementById('t-hero-sub').textContent =
    `${{league:'Liga',cup:'Puchar',swiss:'Szwajcarski'}[c.fmt]||c.fmt} · ${S.players.length} graczy · ${done.length} rozegranych`;

  document.getElementById('big-stats').innerHTML = [
    { n:S.players.length, l:'Graczy' },
    { n:done.length,      l:'Rozegranych' },
    { n:pend.length,      l:'W kolejce' },
    { n:leader ? ini(leader.name) : '—', l:'Lider', serif:true },
  ].map((s,i) => `
    <div class="big-stat" style="animation-delay:${i*60}ms">
      <div class="stat-num" ${s.serif?'style="font-family:Fraunces,serif;font-style:italic"':''}>${s.n}</div>
      <div class="stat-lbl">${s.l}</div>
    </div>`).join('');

  document.getElementById('btn-next-rnd').style.display = c.fmt==='swiss' ? 'block' : 'none';
  document.getElementById('btn-adv-br').style.display   = (c.fmt==='cup'&&S.brRounds.length) ? 'block' : 'none';

  const liveSection = document.getElementById('sidebar-live-add');
  if (liveSection) liveSection.style.display = c.fmt==='cup' ? 'none' : 'block';

  renderMatchesMain();
}

function renderMatchesMain() {
  const wrap  = document.getElementById('matches-main');
  const byKey = {};

  S.matches.filter(m => m.p1 && m.p2 && !m.byeMatch).forEach(m => {
    let k;
    if (m.type === 'league')              k = `Runda ${m.round}`;
    else if (m.type.startsWith('swiss'))  k = `Runda Szwajcarska ${m.round}`;
    else if (m.type === 'cup')            k = Utils.rName(S.brRounds.filter(r=>r.id!=='r3rd').length, m.round);
    else if (m.type === 'cup3rd')         k = '🥉 Mecz o 3. miejsce';
    else                                  k = `Runda ${m.round}`;
    if (!byKey[k]) byKey[k] = { k, ms:[] };
    byKey[k].ms.push(m);
  });

  const keys = Object.keys(byKey);
  if (!keys.length) {
    wrap.innerHTML = '<p class="text-dim italic" style="text-align:center;padding:40px">Brak meczów do wyświetlenia</p>';
    return;
  }

  // [FIX-9] Globalne liczenie kart dla staggered animacji
  let globalCardIdx = 0;
  wrap.innerHTML = keys.map((key, ri) => {
    const g     = byKey[key];
    const doneN = g.ms.filter(m => m.done).length, total = g.ms.length;
    const pct   = total ? Math.round(doneN / total * 100) : 0;
    const cardsHtml = g.ms.map(m => matchCardHTML(m, globalCardIdx++)).join('');
    return `
      <div class="round-block" style="animation-delay:${ri*60}ms">
        <div class="round-header">
          <div class="round-title">${g.k}</div>
          <div class="round-prog-wrap">
            <div class="round-bar"><div class="round-fill" style="width:${pct}%"></div></div>
            <span class="round-prog-txt">${doneN}/${total}</span>
          </div>
        </div>
        <div>${cardsHtml}</div>
      </div>`;
  }).join('');
}

// [FIX-9] matchCardHTML z --i CSS variable dla staggered animacji
function matchCardHTML(m, globalIdx = 0) {
  if (m.byeMatch) return '';
  const p1 = gP(m.p1), p2 = gP(m.p2);
  if (!p1 || !p2) return '';
  const w1 = m.done && m.s1 > m.s2, w2 = m.done && m.s2 > m.s1;
  return `
    <div class="match-card ${m.done?'done':'pending'}" data-mid="${m.id}" style="--i:${globalIdx}">
      <div class="match-player ${w1?'win':w2?'lose':''}">
        <div class="avatar avatar-sm" style="background:${p1.color}">${ini(p1.name)}</div>
        <span>${Utils.esc(p1.name)}</span>
      </div>
      ${m.done
        ? `<div class="match-score">${fS(m.s1)} — ${fS(m.s2)}</div>`
        : `<div class="match-vs">VS</div>`}
      <div class="match-player rev ${w2?'win':w1?'lose':''}">
        <div class="avatar avatar-sm" style="background:${p2.color}">${ini(p2.name)}</div>
        <span>${Utils.esc(p2.name)}</span>
      </div>
      <button class="match-btn">${m.done ? '✏️' : '📝 Wynik'}</button>
    </div>
    ${m.note ? `<p style="font-size:12px;color:var(--ink-4);font-style:italic;padding:0 16px 6px">"${Utils.esc(m.note)}"</p>` : ''}`;
}

/* ════════════════════════════════════════════════════════
   STANDINGS / BRACKET / STATS
═══════════════════════════════════════════════════════ */
function renderStandings() {
  const card = document.getElementById('std-card');
  if (!S.players.length) { card.innerHTML = '<p class="text-dim italic" style="text-align:center;padding:32px">Brak graczy</p>'; return; }
  const data   = Compute.standings(S);
  const sorted = Compute.sortedPlayers(S, data);
  card.innerHTML = `
    <div class="card-eyebrow">Tabela wyników</div>
    <table class="std-table">
      <thead><tr><th>#</th><th>Gracz</th><th>M</th><th>W</th><th>R</th><th>P</th><th>GD</th><th>Pkt</th></tr></thead>
      <tbody>${sorted.map((p, i) => {
        const d  = data[p.id] || {};
        const rc = ['rank-1','rank-2','rank-3'][i] || 'rank-n';
        return `<tr>
          <td><div class="rank-badge ${rc}">${i+1}</div></td>
          <td><div style="display:flex;align-items:center;gap:9px">
            <div class="avatar avatar-sm" style="background:${p.color}">${ini(p.name)}</div>
            <span style="font-weight:600">${Utils.esc(p.name)}</span>
          </div></td>
          <td class="text-dim">${d.played||0}</td>
          <td style="color:var(--green);font-weight:600">${d.wins||0}</td>
          <td style="color:var(--gold)">${d.draws||0}</td>
          <td style="color:var(--red)">${d.losses||0}</td>
          <td class="text-dim" style="font-size:13px">${(d.gd||0)>0?'+':''}${d.gd||0}</td>
          <td><div class="pts-chip">${fS(d.pts||0)}</div></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function renderBracket() {
  const inner = document.getElementById('br-inner');
  if (!S.brRounds.length) {
    inner.innerHTML = '<p class="text-dim italic" style="min-width:200px;text-align:center;padding:32px">Brak drabinki dla tego formatu</p>';
    return;
  }
  inner.innerHTML = S.brRounds.map(round => {
    const ms = round.mids.map(id => gM(id)).filter(Boolean);
    return `<div class="br-col">
      <div class="br-col-ttl">${round.name}</div>
      <div class="br-matches">${ms.map(m => {
        const p1 = m.p1 ? gP(m.p1) : null, p2 = m.p2 ? gP(m.p2) : null;
        const w1 = m.done && m.s1 > m.s2, w2 = m.done && m.s2 > m.s1;
        return `<div class="br-m" data-mid="${m.id}">
          <div class="br-p ${p1?(w1?'win':w2?'lose':''):'tbd'}">
            ${p1 ? `<div style="display:flex;align-items:center;gap:6px"><div class="avatar avatar-sm" style="background:${p1.color}">${ini(p1.name)}</div>${Utils.esc(p1.name)}</div><span class="br-score">${m.done?fS(m.s1):''}</span>` : '<span>TBD</span>'}
          </div>
          <div class="br-p ${p2?(w2?'win':w1?'lose':''):'tbd'}">
            ${p2 ? `<div style="display:flex;align-items:center;gap:6px"><div class="avatar avatar-sm" style="background:${p2.color}">${ini(p2.name)}</div>${Utils.esc(p2.name)}</div><span class="br-score">${m.done?fS(m.s2):''}</span>` : (m.byeMatch?'<span style="font-size:11px;color:var(--ink-4);font-style:italic">BYE — wolny los</span>':'<span>TBD</span>')}
          </div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }).join('');
}

function renderStats() {
  const data   = Compute.standings(S);
  const sorted = Compute.sortedPlayers(S, data);
  const done   = S.matches.filter(m => m.done && m.p1);
  const draws  = done.filter(m => m.s1 === m.s2).length;
  const card   = document.getElementById('stats-card');
  if (!sorted.length) { card.innerHTML = '<p class="text-dim italic" style="text-align:center;padding:32px">Brak danych</p>'; return; }
  card.innerHTML = `
    <div class="card-eyebrow">Statystyki graczy</div>
    <div class="big-stats mb16">
      <div class="big-stat"><div class="stat-num">${done.length}</div><div class="stat-lbl">Mecze</div></div>
      <div class="big-stat"><div class="stat-num">${done.length?Math.round(draws/done.length*100):0}%</div><div class="stat-lbl">Remisy</div></div>
      <div class="big-stat"><div class="stat-num">${S.players.length}</div><div class="stat-lbl">Gracze</div></div>
    </div>
    <table class="std-table">
      <thead><tr><th>#</th><th>Gracz</th><th>M</th><th>Wyg.</th><th>% Wyg.</th><th>Zdobyte</th><th>Stracone</th></tr></thead>
      <tbody>${sorted.map((p, i) => {
        const d  = data[p.id] || {};
        const wp = d.played ? Math.round(d.wins / d.played * 100) : 0;
        const rc = ['rank-1','rank-2','rank-3'][i] || 'rank-n';
        return `<tr>
          <td><div class="rank-badge ${rc}">${i+1}</div></td>
          <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar avatar-sm" style="background:${p.color}">${ini(p.name)}</div><span style="font-weight:600">${Utils.esc(p.name)}</span></div></td>
          <td class="text-dim">${d.played||0}</td>
          <td style="color:var(--green);font-weight:600">${d.wins||0}</td>
          <td><div style="display:flex;align-items:center;gap:7px"><span style="font-size:12px;font-weight:600;min-width:32px">${wp}%</span><div style="flex:1;height:4px;background:var(--warm);border-radius:4px;min-width:50px;overflow:hidden"><div style="height:100%;width:${wp}%;background:linear-gradient(90deg,var(--accent),rgba(var(--accent-rgb),.5));border-radius:4px"></div></div></div></td>
          <td style="font-size:13px">${fS(d.gf||0)}</td>
          <td class="text-dim" style="font-size:13px">${fS(d.ga||0)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function switchView(name, el) {
  ['matches','standings','bracket','stats'].forEach(v => {
    const e = document.getElementById('v-' + v);
    if (e) e.style.display = v === name ? 'block' : 'none';
  });
  document.querySelectorAll('#view-pills .pill').forEach(b => b.classList.remove('sel'));
  if (el) el.classList.add('sel');
  S.curView = name;
  if (name === 'standings') renderStandings();
  if (name === 'bracket')   renderBracket();
  if (name === 'stats')     renderStats();
}

/* ════════════════════════════════════════════════════════
   RESULT MODAL
═══════════════════════════════════════════════════════ */
function openResult(matchId) {
  const m = gM(matchId); if (!m) return;
  if (!m.p1 || !m.p2) { toast('Ten mecz nie ma jeszcze graczy', 'ℹ️'); return; }
  S.openMatchId = matchId;
  const p1 = gP(m.p1), p2 = gP(m.p2);

  document.getElementById('res-players').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;background:var(--cream);border-radius:var(--r);padding:14px 16px">
      <div class="avatar avatar-lg" style="background:${p1.color}">${ini(p1.name)}</div>
      <div style="flex:1"><div style="font-weight:700;font-size:16px">${Utils.esc(p1.name)}</div><div class="text-xs text-dim">${Utils.lvLabel(p1.level)}</div></div>
      <div style="font-family:'Fraunces',serif;font-size:11px;color:var(--ink-4);letter-spacing:.1em">VS</div>
      <div style="flex:1;text-align:right"><div style="font-weight:700;font-size:16px">${Utils.esc(p2.name)}</div><div class="text-xs text-dim">${Utils.lvLabel(p2.level)}</div></div>
      <div class="avatar avatar-lg" style="background:${p2.color}">${ini(p2.name)}</div>
    </div>`;

  document.getElementById('rq1').textContent = '🏆 ' + p1.name;
  document.getElementById('rq2').textContent = '🏆 ' + p2.name;
  document.getElementById('rl1').textContent = p1.name;
  document.getElementById('rl2').textContent = p2.name;
  document.getElementById('rs1').value = m.s1 ?? '';
  document.getElementById('rs2').value = m.s2 ?? '';
  document.getElementById('r-note').value = m.note || '';
  document.querySelectorAll('.rq-btn').forEach(b => b.classList.remove('sel'));
  document.getElementById('ov-result').classList.add('open');
}

function setQuickResult(type) {
  const c = S.cfg;
  document.querySelectorAll('.rq-btn').forEach(b => b.classList.remove('sel'));
  if (type === 'p1')        { document.getElementById('rs1').value=c.ptsW; document.getElementById('rs2').value=c.ptsL; document.getElementById('rq1').classList.add('sel'); }
  else if (type === 'p2')   { document.getElementById('rs1').value=c.ptsL; document.getElementById('rs2').value=c.ptsW; document.getElementById('rq2').classList.add('sel'); }
  else                      { document.getElementById('rs1').value=c.ptsD; document.getElementById('rs2').value=c.ptsD; document.querySelectorAll('.rq-btn')[1].classList.add('sel'); }
}

async function saveResult() {
  const m = gM(S.openMatchId);
  if (!m) { toast('Błąd: mecz nie znaleziony', '⚠️'); return; }
  const s1 = parseFloat(document.getElementById('rs1').value);
  const s2 = parseFloat(document.getElementById('rs2').value);
  if (isNaN(s1) || isNaN(s2)) { toast('Podaj wyniki dla obu graczy', '⚠️'); return; }
  const note = document.getElementById('r-note').value.trim();

  const isDraw = s1 === s2;
  const overtimeEnabled = S.cfg.overtime;

  if (isDraw && overtimeEnabled) {
    m._overtimeBase1 = (m._overtimeBase1 ?? 0) + s1;
    m._overtimeBase2 = (m._overtimeBase2 ?? 0) + s2;
    showDrawPanel(m, s1, s2, note);
    return;
  }

  await commitResult(m, s1, s2, note);
}

// [FIX-8] showDrawPanel — bez inline onclick z danymi w stringu
// Używa data-atrybutów zamiast wstrzykiwania wartości do atrybutu onclick
function showDrawPanel(m, s1, s2, note) {
  const p1 = gP(m.p1), p2 = gP(m.p2);
  const existing = document.getElementById('draw-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'draw-panel';
  panel.innerHTML = `
    <div class="draw-panel-inner">
      <div class="draw-panel-icon">⚖️</div>
      <div class="draw-panel-title">Remis!</div>
      <div class="draw-panel-sub">
        ${Utils.esc(p1.name)} ${fS(s1)} — ${fS(s2)} ${Utils.esc(p2.name)}<br>
        <span style="font-size:12px;color:var(--ink-4);font-style:italic">Czy grają dogrywkę?</span>
      </div>
      <div class="draw-panel-btns">
        <button class="btn-accent" id="draw-btn-overtime">⚡ Kontynuuj grę (dogrywka)</button>
        <button class="btn-ghost"  id="draw-btn-confirm">✓ Zatwierdź wynik (remis)</button>
      </div>
    </div>
  `;
  document.getElementById('ov-result').appendChild(panel);

  // [FIX-8] Event listeners zamiast inline onclick — bezpieczne, bez XSS
  panel.querySelector('#draw-btn-overtime').addEventListener('click', () => startOvertime(m.id, s1, s2, note));
  panel.querySelector('#draw-btn-confirm').addEventListener('click',  () => confirmDraw(m.id, s1, s2, note));
}

async function startOvertime(matchId, s1, s2, note) {
  const m = gM(matchId);
  if (!m) return;
  const panel = document.getElementById('draw-panel');
  if (panel) panel.remove();
  document.getElementById('rs1').value = 0;
  document.getElementById('rs2').value = 0;
  document.querySelectorAll('.rq-btn').forEach(b => b.classList.remove('sel'));
  try { await API.postOvertime(matchId); } catch (e) { console.warn('Overtime notify failed:', e); }
  toast(`Dogrywka! Wpisz wynik dogrywki — zostanie dodany do ${fS(s1)}—${fS(s2)}`, 'ⓘ');
}

async function confirmDraw(matchId, s1, s2, note) {
  const m = gM(matchId);
  if (!m) return;
  const panel = document.getElementById('draw-panel');
  if (panel) panel.remove();
  const finalS1 = m._overtimeBase1 !== undefined ? m._overtimeBase1 : s1;
  const finalS2 = m._overtimeBase2 !== undefined ? m._overtimeBase2 : s2;
  delete m._overtimeBase1; delete m._overtimeBase2;
  await commitResult(m, finalS1, finalS2, note);
}

async function commitResult(m, s1, s2, note) {
  const finalS1 = m._overtimeBase1 !== undefined ? m._overtimeBase1 + s1 : s1;
  const finalS2 = m._overtimeBase2 !== undefined ? m._overtimeBase2 + s2 : s2;
  delete m._overtimeBase1; delete m._overtimeBase2;

  m.s1=finalS1; m.s2=finalS2; m.done=true; m.note=note;
  closeOverlay();
  renderTournament(); renderStandings();

  await pushResult(m.id, finalS1, finalS2, note);

  const p1 = gP(m.p1), p2 = gP(m.p2);
  toast(`${p1.name} ${fS(finalS1)} — ${fS(finalS2)} ${p2.name} ✓`, '✓');

  if (S.cfg.fmt === 'cup') {
    const roundObj = S.brRounds.find(r => r.mids.includes(m.id));
    if (roundObj) {
      const allDone = roundObj.mids.map(id => gM(id)).every(rm => rm && rm.done);
      if (allDone) { advanceBracket(); renderBracket(); }
    }
  }
}

function closeOverlay() {
  document.getElementById('ov-result').classList.remove('open');
  const panel = document.getElementById('draw-panel');
  if (panel) panel.remove();
  if (S.openMatchId) {
    const m = gM(S.openMatchId);
    if (m) { delete m._overtimeBase1; delete m._overtimeBase2; }
  }
  S.openMatchId = null;
}

document.getElementById('ov-result').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeOverlay();
});

// Event delegation — match cards (zamiast inline onclick — XSS safe)
document.addEventListener('click', e => {
  const card = e.target.closest('.match-card[data-mid]');
  if (card) openResult(card.dataset.mid);
});

/* ════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════ */
function toast(msg, icon = 'ℹ️') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${Utils.esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .28s var(--spring) forwards';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/* ════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════ */
(async function init() {
  // Link do TV — działa zarówno przez serwer, jak i file://
  const tvLink = document.getElementById('tv-link');
  if (tvLink) tvLink.href = location.protocol === 'file:' ? 'http://localhost:3000/tv.html' : '/tv.html';

  const loaded = await syncFromServer();
  setConnected(loaded);

  if (S.cfg.theme) applyTheme(S.cfg.theme);

  const tv = (id, key) => { const el = document.getElementById(id); if (el && S.cfg[key]) el.value = S.cfg[key]; };
  tv('t-name','name'); tv('t-org','org'); tv('t-date','date'); tv('t-loc','loc');
  if (!S.cfg.date) {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    document.getElementById('t-date').value = localDate;
  }
  const otEl = document.getElementById('opt-overtime');
  if (otEl) otEl.checked = !!S.cfg.overtime;

  const fc = document.querySelector(`.fmt-card[data-fmt="${S.cfg.fmt}"]`);
  if (fc) {
    document.querySelectorAll('.fmt-card').forEach(c => c.classList.remove('sel'));
    fc.classList.add('sel');
    ['league','cup','swiss'].forEach(f => { const d=document.getElementById('fopt-'+f); if(d) d.style.display='none'; });
    const s = document.getElementById('fopt-' + S.cfg.fmt);
    if (s) s.style.display = 'block';
  }

  const sw = document.querySelector(`#sw-theme .swatch[data-c="${S.cfg.theme}"]`);
  if (sw) { document.querySelectorAll('#sw-theme .swatch').forEach(s=>s.classList.remove('sel')); sw.classList.add('sel'); }

  renderRoster();

  if (S.cfg.active) {
    document.getElementById('hdr-name').textContent = '— ' + S.cfg.name;
    renderTournament(); renderStandings(); renderBracket(); renderStats();
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('p4').classList.add('active');
    S.curStep = 4;
  }
  updateRail();

  // [FIX-6] Subscribe do SSE — nie nadpisuj stanu gdy modal wyniku jest otwarty
  API.subscribe((evt, data) => {
    if (evt === 'connected') setConnected(true);
    if (evt === 'error')     setConnected(false);
    if (evt === 'update') {
      // [FIX-6] Pomiń sync jeśli modal wyniku jest aktywny — zapobiegaj wyścigowi stanu
      if (S.openMatchId) return;
      syncFromServer().then(() => {
        if (S.cfg.active) { renderTournament(); renderStandings(); renderBracket(); }
      });
    }
  });

  // Retry server connection every 10s if offline
  setInterval(async () => {
    if (!_serverOk) {
      const ok = await syncFromServer();
      setConnected(ok);
    }
  }, 10000);
})();