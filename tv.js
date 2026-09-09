/**
 * tv.js — Chess Tournament TV Display
 *
 * KOLEJNOŚĆ ZDARZEŃ:
 *
 *  1. Menedżer wpisuje wynik
 *  2. SSE "result" → pobieramy NOWY stan z serwera i dołączamy
 *     go do elementu flashQueue (każdy flash ma własny snapshot stanu)
 *  3. processFlash() → pendingState = item.state → flash overlay
 *  4. Flash znika → tabela wciąż pokazuje STARY stan
 *  5. 800ms pauzy — widać stary stan tabeli
 *  6. animateTableUpdate() — algorytm FLIP:
 *       a) obliczamy oldSorted (raz, poza pętlą — O(n+m))
 *       b) mierzymy pozycje wierszy ze STAREGO stanu
 *       c) przebudowujemy DOM wg NOWEGO stanu (appendChild)
 *       d) cofamy wiersze translateY do starych pozycji
 *       e) animujemy translateY(0) — wiersze jadą na nowe miejsca
 *  7. Po zakończeniu FLIP (800ms, gwarantowany zapas):
 *       a) Wyczyść style FLIP (background/shadow/border z fazy ruchu)
 *       b) animateRankNum() — animacja numeru/medalu (slide-out/slide-in)
 *       c) animateStatsUpdate() — ANIMOWANA aktualizacja statystyk
 *          (każda zmieniona wartość: scale-down→fade-out → podmiana → scale-up→fade-in)
 *       d) Po danych: snap-pulse na awansujących + setDelta() — trwałe strzałki ▲N / ▼N (zmiana od ostatniej rundy)
 *       e) Zapisz displayedState, zwolnij flagę isAnimatingTable
 *  8. Koalescencja: jeśli >3 flashy w kolejce, zachowaj ostatni
 *
 * OCHRONA PRZED JEDNOCZESNYM URUCHOMIENIEM:
 *  - isFlashing — blokuje równoległy flash overlay
 *  - isAnimatingTable — blokuje równoległą animację tabeli
 *  - loadInitial() i finish handler czekają na zakończenie animacji
 */

/* ═══════════════════════════════════════════════
   ZMIENNE GLOBALNE
═══════════════════════════════════════════════ */

// Stan aktualnie WYŚWIETLONY na ekranie
let displayedState = { cfg:{}, players:[], matches:[], brRounds:[], _mc:0 };

// Nowy stan czekający na animację (wypełniany przez SSE "result")
let pendingState = null;

let flashQueue  = [];
let isFlashing  = false;
let isAnimatingTable = false;
let sseAlive    = false;
let ignoreUpdateUntil = 0; // timestamp — ignoruj 'update' SSE tuż po 'result'

/* ═══════════════════════════════════════════════
   SSE + FALLBACK
═══════════════════════════════════════════════ */
function connectSSE() {
  API.subscribe(onSSEEvent);
  setInterval(async () => {
    if (sseAlive) return;
    if (isFlashing || isAnimatingTable) return; // nie nadpisuj DOM w trakcie animacji
    if (flashQueue.length || pendingState) return; // nie nadpisuj gdy coś w kolejce
    if (Date.now() < ignoreUpdateUntil) return;
    try {
      const s = await API.getState();
      displayedState = s;
      pendingState   = null;
      renderAll(s);
      showConn(true);
    } catch (_) { showConn(false); }
  }, 6000);
}

function onSSEEvent(evt, data) {
  if (evt === 'connected') { sseAlive = true;  showConn(true);  loadInitial(); return; }
  if (evt === 'error')     { sseAlive = false; showConn(false); return; }

  if (evt === 'update') {
    // Cicha aktualizacja (np. reset) — tylko jeśli nie ma nic w kolejce
    // WAŻNE: ignoruj 'update' wywołane przez saveState() tuż przed 'result',
    // bo inaczej renderAll() nadpisze displayedState i FLIP nie zobaczy różnicy
    if (Date.now() < ignoreUpdateUntil) return;
    if (!isFlashing && !isAnimatingTable && !pendingState && !flashQueue.length) {
      API.getState().then(s => {
        // Podwójne sprawdzenie — promise mógł się rozwiązać po nadejściu 'result'
        if (Date.now() < ignoreUpdateUntil || isFlashing || isAnimatingTable || pendingState || flashQueue.length) return;
        displayedState = s; pendingState = null; renderAll(s);
      }).catch(() => {});
    }
    return;
  }

  if (evt === 'result') {
    const { match, p1, p2 } = data;
    // Blokuj 'update' SSE przez 2s — saveState() w server.js wysyła 'update'
    // tuż PRZED 'result', co by nadpisało displayedState i zepsuło FLIP
    ignoreUpdateUntil = Date.now() + 2000;
    // Pobierz nowy stan — każdy flash dostaje własny snapshot stanu
    API.getState().then(fresh => {
      // Header i progress bar — od razu (nie dotyczą tabeli)
      renderHeader(fresh);
      renderProgressBar(fresh);
      // Sidebar NIE jest aktualizowany tutaj — będzie po flash+FLIP
      // (inaczej slide-in jest niewidoczny za pełnoekranowym overlay)
      // Uruchom flash, po którym nastąpi animacja tabeli
      if (match && p1 && p2 && !match.byeMatch) {
        flashQueue.push({ match, p1, p2, state: fresh });
        processFlash();
      } else {
        // Brak flash (bye) — animuj od razu, sidebar po FLIP
        pendingState = fresh;
        animateTableUpdate();
      }
    }).catch(() => {});
    return;
  }

  if (evt === 'finish') {
    API.getState().then(s => {
      const doFinish = () => {
        displayedState = s; pendingState = null;
        renderAll(s); showPodium();
      };
      // Poczekaj aż animacja się zakończy przed wyświetleniem podium
      if (isFlashing || isAnimatingTable) {
        const waitForAnim = setInterval(() => {
          if (!isFlashing && !isAnimatingTable) {
            clearInterval(waitForAnim);
            doFinish();
          }
        }, 200);
        // Timeout bezpieczeństwa — nie czekaj dłużej niż 15s
        setTimeout(() => { clearInterval(waitForAnim); doFinish(); }, 15000);
      } else {
        doFinish();
      }
    }).catch(() => {});
    return;
  }

  if (evt === 'overtime') {
    const { match, p1, p2 } = data;
    if (match && p1 && p2) showOvertimeBanner(p1, p2);
  }
}

async function loadInitial() {
  // Nie nadpisuj DOM w trakcie animacji — spróbuj ponownie za chwilę
  if (isFlashing || isAnimatingTable) {
    setTimeout(loadInitial, 1000);
    return;
  }
  try {
    const s = await API.getState();
    displayedState = s;
    pendingState   = null;
    renderAll(s);
    showConn(true);
    if (s.cfg?.finished) showPodium();
  } catch (_) { showConn(false); setTimeout(loadInitial, 3000); }
}

function showConn(ok) {
  const dot = document.getElementById('tv-conn-dot');
  const lbl = document.getElementById('tv-conn-label');
  if (dot) { dot.style.background = ok ? '#22c55e' : '#ef4444'; dot.style.animation = ok ? 'pulse-green 2s infinite' : 'none'; }
  if (lbl) lbl.textContent = ok ? 'Live' : 'Brak połączenia…';
}

/* ═══════════════════════════════════════════════
   FLASH QUEUE
   Po zakończeniu flash → czekaj 800ms → animuj tabelę
═══════════════════════════════════════════════ */
function processFlash() {
  if (isFlashing || !flashQueue.length) return;

  // Koalescencja: jeśli >3 w kolejce, pomiń flash overlay dla środkowych
  // — zachowaj tylko ostatni element, animuj tabelę do najnowszego stanu
  if (flashQueue.length > 3) {
    const last = flashQueue[flashQueue.length - 1];
    flashQueue.length = 0;
    flashQueue.push(last);
  }

  isFlashing = true;
  const item = flashQueue.shift();
  pendingState = item.state;   // ustaw stan powiązany z tym flashem
  showResultFlash(item.match, item.p1, item.p2, () => {
    // Flash zniknął. Tabela wciąż pokazuje STARY stan.
    isFlashing = false;
    // 800ms pauzy — widać stary stan tabeli zanim cokolwiek się ruszy
    setTimeout(() => {
      animateTableUpdate();
      // Następny flash po dłuższej chwili
      setTimeout(processFlash, 2000);
    }, 800);
  });
}

/* ═══════════════════════════════════════════════
   animateTableUpdate
   ─────────────────────────────────────────────
   To jest serce całego systemu.

   Wymaga:
   - displayedState  = co jest TERAZ na ekranie
   - pendingState    = co MA BYĆ na ekranie

   Algorytm FLIP:
   1. Snapshot pozycji wierszy ze STAREGO stanu (getBCR)
   2. appendChild w NOWEJ kolejności (DOM przeskakuje)
   3. Nałóż translateY(old - new) bez transition
      → wiersze wyglądają jak przed przesunięciem
   4. rAF → rAF → transition + translateY(0)
      → wiersze płynnie jadą na nowe miejsca
   5. Po animacji: aktualizuj treść wierszy (liczby)
      i zapisz pendingState jako displayedState
═══════════════════════════════════════════════ */
function animateTableUpdate() {
  if (!pendingState) return;
  if (isAnimatingTable) return;

  const wrap = document.getElementById('tv-standings');

  // Upewnij się że overflow:visible — bez tego translateY jest przycinane
  if (wrap) {
    wrap.style.overflow      = 'visible';
    wrap.style.flexDirection = 'column';
    wrap.style.gap           = '5px';
  }

  // Cup / brak wrappera — cichy rebuild
  if (!wrap || (pendingState.cfg?.fmt === 'cup' && pendingState.brRounds?.length)) {
    displayedState = pendingState;
    pendingState   = null;
    renderAll(displayedState);
    return;
  }

  isAnimatingTable = true;

  const newState  = pendingState;
  const newData   = Compute.standings(newState);
  const newSorted = Compute.sortedPlayers(newState, newData);
  const ac        = newState.cfg?.theme || '#f59e0b';
  const [ar,ag,ab]= Utils.hexRgb(ac).split(',').map(Number);
  const roundDeltas = computeRoundDeltas(newState);

  // ── Oblicz stare pozycje (raz, poza pętlą) — O(n + m) zamiast O(n²·m) ──
  const oldData     = Compute.standings(displayedState);
  const oldSorted   = Compute.sortedPlayers(displayedState, oldData);
  const oldIndexMap = {};
  oldSorted.forEach((p, i) => { oldIndexMap[p.id] = i; });

  // ── KROK 1: FIRST — snapshot starych pozycji (z displayedState na ekranie) ──
  const oldTops = {};
  wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
    oldTops[el.dataset.pid] = el.getBoundingClientRect().top;
  });

  // ── KROK 2: wyłącz transition, przesuń węzły DOM w nową kolejność ──
  wrap.querySelectorAll('.tv-row').forEach(el => {
    el.style.transition = 'none';
    el.style.transform  = '';
  });

  newSorted.forEach(p => {
    let row = wrap.querySelector(`.tv-row[data-pid="${p.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className   = 'tv-row';
      row.dataset.pid = p.id;
      row.innerHTML   = rowInnerHTML(p, newSorted.indexOf(p), newData[p.id]||{}, ac, roundDeltas[p.id]||0);
      row.dataset.isnew = '1';
    }
    wrap.appendChild(row);
  });

  // Usuń zniknięłych graczy
  wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
    if (!newSorted.find(p => p.id === el.dataset.pid)) el.remove();
  });

  // ── KROK 3: LAST — zmierz nowe pozycje ──
  const newTops = {};
  wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
    newTops[el.dataset.pid] = el.getBoundingClientRect().top;
  });

  // ── KROK 4: INVERT — cofnij każdy wiersz translateY(old-new) ──
  wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
    const pid = el.dataset.pid;
    if (el.dataset.isnew) {
      el.style.opacity   = '0';
      el.style.transform = 'translateX(80px)';
      return;
    }
    const dy = (oldTops[pid] ?? newTops[pid]) - newTops[pid];
    el.style.transform = dy !== 0 ? `translateY(${dy}px)` : '';
  });

  // ── KROK 5: PLAY — dwa rAF gwarantują reflow przed transition ──
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {

      wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
        const pid   = el.dataset.pid;
        const isNew = !!el.dataset.isnew;
        const dy    = (oldTops[pid] ?? 0) - (newTops[pid] ?? 0);
        const isUp  = dy > 5;
        const isDn  = dy < -5;

        if (isNew) {
          el.style.transition = 'opacity 600ms ease, transform 600ms cubic-bezier(.25,1,.5,1)';
          el.style.opacity    = '1';
          el.style.transform  = '';
          return;
        }

        if (isUp) {
          el.classList.add('flip-winner-flash');
        } else if (isDn) {
          el.classList.add('flip-loser-flash');
        }

        el.style.transition = 'transform 700ms cubic-bezier(.25,1,.5,1), opacity 700ms ease';
        el.style.transform  = '';
        if (isDn) el.style.opacity = '1';
      });

      // ══════════════════════════════════════════════════════════
      // KROK 6: FLIP ZAKOŃCZONY (800ms) → FAZA AKTUALIZACJI DANYCH
      //
      // Ścisła kolejność:
      //   A) Wyczyść style FLIP (background/shadow/border z fazy ruchu)
      //   B) Animuj zmianę danych (stat-out → podmiana → stat-in) — ~600ms
      //   C) Animuj rank num (slide-out/slide-in) — równolegle z B
      //   D) Po danych: snap-pulse dla awansujących + delta badges
      //   E) Zapisz stan, zwolnij flagę
      // ══════════════════════════════════════════════════════════
      setTimeout(() => {
        // ── A) Wyczyść style FLIP (wiersze już na miejscu) ──
        wrap.querySelectorAll('.tv-row[data-pid]').forEach(el => {
          delete el.dataset.isnew;
          el.style.transition  = 'none';
          el.style.background  = '';
          el.style.boxShadow   = '';
          el.style.borderColor = '';
          el.style.opacity     = '';
          // Usuń klasy flash z fazy ruchu (fire classes celowo zachowane)
          el.classList.remove('flip-winner-flash', 'flip-loser-flash');
        });

        // ── B+C) Animowana aktualizacja danych i rangi ──
        // Zbieramy informację, które wiersze mają zmiany
        let maxDataAnimTime = 0; // ile ms najdłuższa animacja danych
        const DATA_OUT_MS  = 180;
        const DATA_IN_MS   = 350;
        const DATA_GAP_MS  = 30; // stagger między wierszami
        const RANK_ANIM_MS = 720; // animateRankNum: 210 + 500

        newSorted.forEach((p, i) => {
          const row = wrap.querySelector(`.tv-row[data-pid="${p.id}"]`);
          if (!row) return;

          const oldIdx   = oldIndexMap[p.id] ?? -1;
          const newIdx   = i;
          const posDelta = oldIdx >= 0 ? oldIdx - newIdx : 0;

          if (posDelta !== 0 && oldIdx >= 0) {
            // Ranga zmieniona — animuj rank num i dane osobno
            animateRankNum(row, newIdx, oldIdx, posDelta);
            animateStatsUpdate(row, newData[p.id]||{}, ac, i * DATA_GAP_MS);
            maxDataAnimTime = Math.max(maxDataAnimTime, i * DATA_GAP_MS + DATA_OUT_MS + DATA_IN_MS, RANK_ANIM_MS);
          } else {
            // Brak zmiany pozycji lub nowy gracz — animowana aktualizacja wszystkiego
            animateFullContentUpdate(row, p, i, newData[p.id]||{}, ac, i * DATA_GAP_MS);
            maxDataAnimTime = Math.max(maxDataAnimTime, i * DATA_GAP_MS + DATA_OUT_MS + DATA_IN_MS);
          }
        });

        // ── D) Po zakończeniu animacji danych: snap-pulse + trwałe strzałki delta ──
        setTimeout(() => {
          newSorted.forEach((p, i) => {
            const row = wrap.querySelector(`.tv-row[data-pid="${p.id}"]`);
            if (!row) return;

            const oldIdx   = oldIndexMap[p.id] ?? -1;
            const posDelta = oldIdx >= 0 ? oldIdx - i : 0;
            const isUp     = posDelta > 0;

            // Snap-pulse dla awansujących
            if (isUp) {
              row.style.transition = 'none';
              row.style.background = `rgba(${ar},${ag},${ab},0.42)`;
              row.style.boxShadow  = `0 0 0 2.5px rgba(${ar},${ag},${ab},1), 0 14px 60px rgba(${ar},${ag},${ab},0.6)`;
              requestAnimationFrame(() => {
                row.style.transition = 'background 1.5s ease, box-shadow 1.5s ease';
                row.style.background = '';
                row.style.boxShadow  = '';
              });
            }

            // Ustaw trwałą strzałkę delta (zmiana od ostatniej rundy)
            const rd = roundDeltas[p.id] || 0;
            setDelta(row, rd, true);

            // Fire effect (CSS classes — przeżywa FLIP cleanup)
            const streak = computeWinStreak(newState, p.id);
            applyFireEffect(row, streak);
          });

          // ── E) Zapisz stan, zwolnij flagę, zaktualizuj sidebar z animacją ──
          displayedState   = newState;
          pendingState     = null;
          isAnimatingTable = false;

          // Sidebar update opóźniony do po FLIP — slide-in jest teraz widoczny
          setTimeout(() => {
            renderSidebar(newState, { animate: true });
          }, 100);
        }, maxDataAnimTime + 100); // +100ms zapas

      }, 800); // 800ms > 700ms FLIP transition — gwarantuje zakończenie ruchu

    });
  });

  // Timeout bezpieczeństwa — reset flagi gdyby animacja się zawiesiła
  // 800ms FLIP + ~1200ms dane + ~700ms delta = ~2700ms; 8s jest bezpieczne
  setTimeout(() => { isAnimatingTable = false; }, 8000);
}


/* ═══════════════════════════════════════════════
   OBLICZANIE TRWAŁYCH DELT (zmiana pozycji od ostatniej rundy)
   ─────────────────────────────────────────────
   Runda jest „ukończona" gdy WSZYSTKIE jej mecze (nie-bye)
   mają done=true. Porównujemy tabelę z końca ostatniej
   pełnej rundy z tabelą aktualną.
   Jeśli nie ma żadnej ukończonej rundy → delta = 0 dla wszystkich.
═══════════════════════════════════════════════ */
function computeRoundDeltas(s) {
  const matches  = s.matches || [];
  const players  = s.players || [];
  const deltas   = {}; // pid → delta (dodatnia = awans)
  players.forEach(p => { deltas[p.id] = 0; });

  // Zgrupuj mecze wg rundy (pomijając bye)
  const rounds = {};
  matches.forEach(m => {
    if (!m.round || m.byeMatch) return;
    if (!rounds[m.round]) rounds[m.round] = [];
    rounds[m.round].push(m);
  });

  // Znajdź ostatnią PEŁNĄ rundę (wszystkie mecze done) PRZED aktualną (niepełną)
  const roundNums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  
  // Znajdź bieżącą tabelę
  const curData   = Compute.standings(s);
  const curSorted = Compute.sortedPlayers(s, curData);
  const curPosMap = {};
  curSorted.forEach((p, i) => { curPosMap[p.id] = i; });

  // Znajdź ostatnią pełną rundę i oblicz tabelę na jej koniec
  // Strategia: idź od najwyższej rundy w dół, szukając pełnej rundy
  // „Pełna" runda = wszystkie mecze w niej mają done=true
  let prevRoundNum = null;
  for (let ri = roundNums.length - 1; ri >= 0; ri--) {
    const rn = roundNums[ri];
    const allDone = rounds[rn].every(m => m.done);
    if (allDone) {
      // Sprawdź czy jest jakakolwiek wcześniejsza runda — porównujemy z jej stanem
      // Jeśli to jedyna runda, porównujemy z pozycją startową (kolejność graczy)
      prevRoundNum = rn;
      break;
    }
  }

  if (prevRoundNum === null) return deltas; // Brak ukończonej rundy — same zera

  // Oblicz tabelę na koniec poprzedniej pełnej rundy
  // (= stan uwzględniający TYLKO mecze z rund <= prevRoundNum MINUS aktualna niepełna)
  // Ale prościej: oblicz tabelę uwzględniając mecze z rund < prevRoundNum
  // (to daje tabelę PRZED ostatnią ukończoną rundą)
  
  // Szukamy rundy PRZED prevRoundNum, by mieć punkt odniesienia
  // „delta" = zmiana pozycji w OSTATNIEJ ukończonej rundzie
  let refRoundNum = null;
  for (let ri = roundNums.indexOf(prevRoundNum) - 1; ri >= 0; ri--) {
    const rn = roundNums[ri];
    if (rounds[rn].every(m => m.done)) {
      refRoundNum = rn;
      break;
    }
  }

  // Oblicz tabelę referencyjną (na koniec rundy referencyjnej)
  // Tworzymy "wirtualny" stan z meczami tylko do refRoundNum
  const refMatches = refRoundNum !== null
    ? matches.map(m => {
        // Uwzględnij tylko ukończone mecze z rund <= refRoundNum
        if (m.done && m.round && m.round <= refRoundNum) return m;
        // Wszystko inne traktuj jako nierozegrane
        return { ...m, done: false, s1: 0, s2: 0 };
      })
    : // Brak wcześniejszej rundy → tabela startowa (wszyscy mają 0 pkt)
      matches.map(m => ({ ...m, done: false, s1: 0, s2: 0 }));

  const refState  = { ...s, matches: refMatches };
  const refData   = Compute.standings(refState);
  const refSorted = Compute.sortedPlayers(refState, refData);
  const refPosMap = {};
  refSorted.forEach((p, i) => { refPosMap[p.id] = i; });

  // Delta = stara pozycja - nowa pozycja (dodatnia = awans)
  players.forEach(p => {
    const oldPos = refPosMap[p.id] ?? 0;
    const newPos = curPosMap[p.id] ?? 0;
    deltas[p.id] = oldPos - newPos;
  });

  return deltas;
}

/* ═══════════════════════════════════════════════
   HTML WIERSZA TABELI
═══════════════════════════════════════════════ */
function rowInnerHTML(p, i, d, ac, delta) {
  const medals = ['🥇','🥈','🥉'];
  const mClass = ['tv-rank-gold','tv-rank-silver','tv-rank-bronze'];
  const pts    = Utils.fS(d.pts || 0);
  const gd     = d.gd || 0;
  const deltaHTML = deltaToHTML(delta || 0);
  return `
    <div class="tv-rank ${mClass[i]||''}"><span class="rank-inner">${i < 3 ? medals[i] : i+1}</span></div>
    <div class="tv-av" style="background:${p.color}">${Utils.ini(p.name)}</div>
    <div class="tv-pname">${Utils.esc(p.name)}</div>
    <div class="tv-delta-cell">${deltaHTML}</div>
    <div class="tv-stats-group">
      <div class="tv-stat-col col-m" ><div class="tv-stat-val">${d.played||0}</div><div class="tv-stat-lbl">M</div></div>
      <div class="tv-stat-col col-w" ><div class="tv-stat-val">${d.wins||0}</div><div class="tv-stat-lbl">W</div></div>
      <div class="tv-stat-col col-d" ><div class="tv-stat-val">${d.draws||0}</div><div class="tv-stat-lbl">R</div></div>
      <div class="tv-stat-col col-l" ><div class="tv-stat-val">${d.losses||0}</div><div class="tv-stat-lbl">P</div></div>
      <div class="tv-stat-col col-gd"><div class="tv-stat-val">${gd>0?'+'+gd:gd}</div><div class="tv-stat-lbl">GD</div></div>
      <div class="tv-stat-col col-pts">
        <div class="tv-stat-val" style="color:${ac}">${pts}</div>
        <div class="tv-stat-lbl" style="color:${ac}">Pkt</div>
      </div>
    </div>`;
}

/* Aktualizuje liczby w ISTNIEJĄCYM wierszu (bez tykania kolejności DOM) */
function updateContent(row, p, i, d, ac) {
  const medals = ['🥇','🥈','🥉'];
  const mClass = ['tv-rank-gold','tv-rank-silver','tv-rank-bronze'];

  const inner = row.querySelector('.rank-inner');
  if (inner) inner.textContent = i < 3 ? medals[i] : i + 1;

  const rankEl = row.querySelector('.tv-rank');
  if (rankEl) rankEl.className = 'tv-rank ' + (mClass[i] || '');

  const pts   = Utils.fS(d.pts || 0);
  const gd    = d.gd || 0;
  const gdStr = gd > 0 ? `+${gd}` : `${gd}`;

  const vals = row.querySelectorAll('.tv-stat-val');
  if (vals[0]) vals[0].textContent = d.played || 0;
  if (vals[1]) vals[1].textContent = d.wins   || 0;
  if (vals[2]) vals[2].textContent = d.draws  || 0;
  if (vals[3]) vals[3].textContent = d.losses || 0;
  if (vals[4]) vals[4].textContent = gdStr;
  if (vals[5]) { vals[5].textContent = pts; vals[5].style.color = ac; }

  const lbls = row.querySelectorAll('.tv-stat-lbl');
  if (lbls[5]) lbls[5].style.color = ac;
}

/* ═══════════════════════════════════════════════
   ANIMOWANE AKTUALIZACJE DANYCH
   ─────────────────────────────────────────────
   Każda zmieniona wartość: scale-down→fadeout (180ms)
   → podmiana tekstu → scale-up→fadein (350ms) z overshoot
   Kolumna z zmianą dostaje pulsujący highlight tła
═══════════════════════════════════════════════ */

/**
 * Animuje zmianę pojedynczej wartości .tv-stat-val
 * Jeśli wartość się nie zmieniła, nic nie robi.
 * @returns {boolean} true jeśli wartość się zmieniła
 */
function animateSingleStat(valEl, colEl, newText, hlRgb, delayMs) {
  if (!valEl) return false;
  const oldText = valEl.textContent.trim();
  const newStr  = String(newText).trim();
  if (oldText === newStr) return false;

  setTimeout(() => {
    // Highlight na kolumnie
    if (colEl) {
      colEl.style.setProperty('--hl-rgb', hlRgb);
      colEl.classList.add('stat-changed');
      setTimeout(() => colEl.classList.remove('stat-changed'), 1400);
    }

    // Faza OUT
    valEl.classList.remove('stat-in');
    valEl.classList.add('stat-out');

    // Po wyjściu → podmień tekst → faza IN
    setTimeout(() => {
      valEl.textContent = newStr;
      valEl.classList.remove('stat-out');
      valEl.classList.add('stat-in');
      // Cleanup klasy po animacji
      setTimeout(() => valEl.classList.remove('stat-in'), 400);
    }, 180);
  }, delayMs);

  return true;
}

/**
 * Animuje aktualizację TYLKO statystyk (ranga animowana osobno przez animateRankNum)
 */
function animateStatsUpdate(row, d, ac, staggerMs) {
  const pts   = Utils.fS(d.pts || 0);
  const gd    = d.gd || 0;
  const gdStr = gd > 0 ? `+${gd}` : `${gd}`;
  const acRgb = Utils.hexRgb(ac);

  const vals = row.querySelectorAll('.tv-stat-val');
  const cols = row.querySelectorAll('.tv-stat-col');

  // Kolory highlight per kolumna: M=biały, W=zielony, R=złoty, P=czerwony, GD=biały, Pkt=accent
  const hlColors = ['200,200,200', '34,197,94', '245,158,11', '239,68,68', '200,200,200', acRgb];
  const newVals  = [d.played||0, d.wins||0, d.draws||0, d.losses||0, gdStr, pts];

  let stagger = 0;
  newVals.forEach((nv, idx) => {
    const changed = animateSingleStat(vals[idx], cols[idx], nv, hlColors[idx], staggerMs + stagger);
    if (changed) stagger += 60; // stagger tylko między zmienionymi wartościami
  });

  // Upewnij się że kolor Pkt jest poprawny
  if (vals[5]) vals[5].style.color = ac;
  const lbls = row.querySelectorAll('.tv-stat-lbl');
  if (lbls[5]) lbls[5].style.color = ac;
}

/**
 * Animuje aktualizację WSZYSTKIEGO (ranga + statystyki) — dla wierszy bez zmiany pozycji
 */
function animateFullContentUpdate(row, p, i, d, ac, staggerMs) {
  const medals = ['🥇','🥈','🥉'];
  const mClass = ['tv-rank-gold','tv-rank-silver','tv-rank-bronze'];

  // Animuj rangę jeśli się zmieniła
  const inner  = row.querySelector('.rank-inner');
  const rankEl = row.querySelector('.tv-rank');
  const newRankText = i < 3 ? medals[i] : String(i + 1);
  if (inner && inner.textContent.trim() !== newRankText.trim()) {
    setTimeout(() => {
      inner.style.transition = 'transform .18s ease-in, opacity .15s ease-in';
      inner.style.transform  = 'scale(0.3)';
      inner.style.opacity    = '0';
      setTimeout(() => {
        inner.textContent      = newRankText;
        if (rankEl) rankEl.className = 'tv-rank ' + (mClass[i] || '');
        inner.style.transition = 'none';
        inner.style.transform  = 'scale(0.3)';
        inner.style.opacity    = '0';
        void inner.offsetWidth;
        inner.style.transition = 'transform .35s cubic-bezier(.34,1.56,.64,1), opacity .25s ease';
        inner.style.transform  = 'scale(1)';
        inner.style.opacity    = '1';
      }, 180);
    }, staggerMs);
  } else {
    // Ranga nie zmieniła się ale klasa mogła
    if (rankEl) rankEl.className = 'tv-rank ' + (mClass[i] || '');
  }

  // Animuj statystyki
  animateStatsUpdate(row, d, ac, staggerMs);
}

/* ═══════════════════════════════════════════════
   animateRankNum — pop numeru/medalu
═══════════════════════════════════════════════ */
function animateRankNum(row, newIdx, oldIdx, delta) {
  const inner  = row.querySelector('.rank-inner');
  const rankEl = row.querySelector('.tv-rank');
  if (!inner || delta === 0) return;

  const medals = ['🥇','🥈','🥉'];
  const mClass = ['tv-rank-gold','tv-rank-silver','tv-rank-bronze'];
  const newVal  = newIdx < 3 ? medals[newIdx] : String(newIdx + 1);
  const dir     = delta > 0 ? 1 : -1; // awans → stary wyjeżdża w dół

  inner.style.transition = 'transform .22s ease-in, opacity .18s ease-in';
  inner.style.transform  = `translateY(${dir * 22}px)`;
  inner.style.opacity    = '0';

  setTimeout(() => {
    if (rankEl) {
      rankEl.classList.remove('tv-rank-gold','tv-rank-silver','tv-rank-bronze');
      if (newIdx < 3) rankEl.classList.add(mClass[newIdx]);
    }
    inner.textContent      = newVal;
    inner.style.transition = 'none';
    inner.style.transform  = `translateY(${dir * -22}px)`;
    inner.style.opacity    = '0';
    void inner.offsetWidth;
    inner.style.transition = 'transform .5s cubic-bezier(.34,1.56,.64,1), opacity .3s ease';
    inner.style.transform  = 'translateY(0)';
    inner.style.opacity    = '1';

    // Wejście na podium: scale burst
    if (newIdx < 3 && oldIdx >= 3 && rankEl) {
      rankEl.style.transition = 'none';
      rankEl.style.transform  = 'scale(2.5)';
      void rankEl.offsetWidth;
      rankEl.style.transition = 'transform .5s cubic-bezier(.34,1.56,.64,1)';
      rankEl.style.transform  = 'scale(1)';
    }
  }, 210);
}

/* ═══════════════════════════════════════════════
   TRWAŁE STRZAŁKI DELTA — helper HTML + set/animacja
═══════════════════════════════════════════════ */

/** Generuje HTML strzałki delta (lub pusty string gdy delta=0) */
function deltaToHTML(delta) {
  if (!delta || delta === 0) return '';
  const up  = delta > 0;
  const col = up ? '#22c55e' : '#ef4444';
  return `<span class="tv-delta-badge" style="color:${col}">${up ? '▲' : '▼'}${Math.abs(delta)}</span>`;
}

/**
 * Ustawia trwałą strzałkę delta w wierszu (bez znikania).
 * Opcjonalnie z animacją wejścia jeśli animate=true.
 */
function setDelta(row, delta, animate) {
  const cell = row.querySelector('.tv-delta-cell');
  if (!cell) return;
  const oldHTML = cell.innerHTML.trim();
  const newHTML = deltaToHTML(delta);
  
  // Nic się nie zmieniło
  if (oldHTML === newHTML) return;
  
  cell.innerHTML = newHTML;

  if (animate && delta !== 0) {
    const b = cell.querySelector('.tv-delta-badge');
    if (!b) return;
    b.style.opacity   = '0';
    b.style.transform = 'translateY(10px) scale(.5)';
    void b.offsetWidth;
    b.style.transition = 'opacity .35s ease, transform .45s cubic-bezier(.34,1.56,.64,1)';
    b.style.opacity   = '1';
    b.style.transform = 'translateY(0) scale(1)';
  }
}

/* ═══════════════════════════════════════════════
   applyFireEffect — dodaj/usuń klasy ognia na wierszu
   ─────────────────────────────────────────────
   Używa klas CSS (nie inline styles) — przeżywa FLIP cleanup.
═══════════════════════════════════════════════ */
function applyFireEffect(row, streak) {
  // Usuń poprzednie klasy fire i elementy płomieni
  row.classList.remove('on-fire-2', 'on-fire-3');
  row.querySelectorAll('.fire-streak-badge, .fire-edge').forEach(el => el.remove());

  if (streak >= 3) {
    row.classList.add('on-fire-3');
  } else if (streak >= 2) {
    row.classList.add('on-fire-2');
  }

  // Płomienie + badge widoczne od streak >= 2
  if (streak >= 2) {
    // Graficzne płomienie po lewej i prawej
    const level = streak >= 3 ? 3 : 2;
    ['left', 'right'].forEach(side => {
      const flames = document.createElement('div');
      flames.className = `fire-edge fire-${side} fire-level-${level}`;
      // 3 warstwy płomieni o różnej wielkości i fazie
      flames.innerHTML =
        '<div class="flame flame-1"></div>' +
        '<div class="flame flame-2"></div>' +
        '<div class="flame flame-3"></div>';
      row.appendChild(flames);
    });

    const badge = document.createElement('span');
    badge.className = 'fire-streak-badge';
    badge.textContent = `STREAK: ${streak}`;
    const pname = row.querySelector('.tv-pname');
    if (pname) pname.after(badge);
  }
}

/* ═══════════════════════════════════════════════
   computeWinStreak — seria kolejnych wygranych
   ─────────────────────────────────────────────
   Liczy ile kolejnych wygranych (od najnowszej) ma gracz.
   Remis i przegrana przerywają streak. Bye ignorowane.
═══════════════════════════════════════════════ */
function computeWinStreak(state, playerId) {
  const matches = (state.matches || [])
    .filter(m => m.done && !m.byeMatch && (m.p1 === playerId || m.p2 === playerId))
    .sort((a, b) => (b.round || 0) - (a.round || 0)); // od najnowszej

  let streak = 0;
  for (const m of matches) {
    const isP1 = m.p1 === playerId;
    const won = isP1 ? m.s1 > m.s2 : m.s2 > m.s1;
    if (won) streak++;
    else break; // remis lub przegrana przerywa streak
  }
  return streak;
}

/* ═══════════════════════════════════════════════
   computeHypeScore — "ekscytacja" nadchodzącego meczu
   ─────────────────────────────────────────────
   Zwraca 0..1 na podstawie sumy punktów obu graczy
   znormalizowanej do max możliwego wyniku.
═══════════════════════════════════════════════ */
function computeHypeScore(state, match) {
  const data = Compute.standings(state);
  const pts1 = data[match.p1]?.pts || 0;
  const pts2 = data[match.p2]?.pts || 0;
  const sum = pts1 + pts2;

  const completedRounds = getCompletedRoundsCount(state);
  const maxPerPlayer = completedRounds * (state.cfg?.ptsW || 3);
  const maxSum = maxPerPlayer * 2;

  return maxSum > 0 ? Math.min(sum / maxSum, 1) : 0;
}

function getCompletedRoundsCount(state) {
  const matches = state.matches || [];
  const rounds = {};
  matches.forEach(m => {
    if (!m.round || m.byeMatch) return;
    if (!rounds[m.round]) rounds[m.round] = { total: 0, done: 0 };
    rounds[m.round].total++;
    if (m.done) rounds[m.round].done++;
  });
  return Object.values(rounds).filter(r => r.done === r.total).length;
}

/* ═══════════════════════════════════════════════
   renderProgressBar — pasek postępu turnieju
═══════════════════════════════════════════════ */
function renderProgressBar(s) {
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  if (!fill || !label) return;

  const matches = s.matches || [];
  const rounds = {};
  matches.forEach(m => {
    if (!m.round || m.byeMatch) return;
    if (!rounds[m.round]) rounds[m.round] = { total: 0, done: 0 };
    rounds[m.round].total++;
    if (m.done) rounds[m.round].done++;
  });

  const roundNums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  const totalRounds = roundNums.length;
  const currentRound = roundNums.find(r => rounds[r].done < rounds[r].total) || roundNums[roundNums.length - 1] || 1;

  // Cup format — użyj nazw rund
  if (s.cfg?.fmt === 'cup' && s.brRounds?.length) {
    const br = s.brRounds;
    const current = br.find(r => {
      const ms = r.mids.map(id => matches.find(m => m.id === id)).filter(Boolean);
      return ms.some(m => !m.done && m.p1 && m.p2);
    }) || br[br.length - 1];
    label.textContent = current?.name || 'Final';
    const idx = br.indexOf(current);
    fill.style.width = `${((idx >= 0 ? idx + 1 : br.length) / br.length) * 100}%`;
    return;
  }

  if (totalRounds === 0) {
    label.textContent = 'Runda 1 z ?';
    fill.style.width = '0%';
    return;
  }

  label.textContent = `Runda ${currentRound} z ${totalRounds}`;
  fill.style.width = `${(currentRound / totalRounds) * 100}%`;
}

/* ═══════════════════════════════════════════════
   renderAll — pełne wyrenderowanie wszystkiego
   (tylko przy init i cichym update)
═══════════════════════════════════════════════ */
function renderAll(s) {
  renderHeader(s);
  renderProgressBar(s);
  renderTable(s);
  renderSidebar(s);
}

/* ═══════════════════════════════════════════════
   renderHeader
═══════════════════════════════════════════════ */
function renderHeader(s) {
  const el  = document.getElementById('tv-title');
  const sub = document.getElementById('tv-sub');
  if (el)  el.textContent = s.cfg?.name ? `♟ ${s.cfg.name}` : '♟ Chess Tournament';
  if (sub) {
    const fmt  = { league:'Liga', cup:'Puchar', swiss:'Szwajcarski' }[s.cfg?.fmt] || '';
    const done = (s.matches||[]).filter(m => m.done && !m.byeMatch).length;
    const tot  = (s.matches||[]).filter(m => m.p1 && m.p2 && !m.byeMatch).length;
    sub.textContent = [fmt, `${s.players?.length||0} graczy`, `${done}/${tot} meczów`].filter(Boolean).join(' · ');
  }
  if (s.cfg?.theme) {
    const rgb = Utils.hexRgb(s.cfg.theme);
    document.documentElement.style.setProperty('--accent',     s.cfg.theme);
    document.documentElement.style.setProperty('--accent-rgb', rgb);
  }
}

/* ═══════════════════════════════════════════════
   renderTable — pełny rebuild tabeli (init/quiet)
═══════════════════════════════════════════════ */
function renderTable(s) {
  const wrap = document.getElementById('tv-standings');
  if (!wrap) return;

  if (s.cfg?.fmt === 'cup' && s.brRounds?.length) {
    renderBracket(s);
    return;
  }

  const label = document.querySelector('.tv-main .tv-section-label');
  if (label) label.textContent = '🏆 Tabela wyników';

  wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:5px;overflow:visible;position:relative;';

  const data   = Compute.standings(s);
  const sorted = Compute.sortedPlayers(s, data);
  const ac     = s.cfg?.theme || '#f59e0b';
  const deltas = computeRoundDeltas(s);

  wrap.innerHTML = sorted.map((p, i) => `<div class="tv-row" data-pid="${p.id}">${rowInnerHTML(p, i, data[p.id]||{}, ac, deltas[p.id]||0)}</div>`).join('');

  // Aplikuj fire effect na pełnym renderze (init/reconnect)
  sorted.forEach((p, i) => {
    const row = wrap.querySelector(`.tv-row[data-pid="${p.id}"]`);
    if (row) {
      const streak = computeWinStreak(s, p.id);
      applyFireEffect(row, streak);
    }
  });
}

/* ═══════════════════════════════════════════════
   renderBracket
═══════════════════════════════════════════════ */
function renderBracket(s) {
  const wrap = document.getElementById('tv-standings');
  if (!wrap) return;
  const label = document.querySelector('.tv-main .tv-section-label');
  if (label) label.textContent = '🏆 Drabinka turniejowa';
  wrap.style.cssText = 'flex:1;display:flex;flex-direction:row;gap:18px;overflow-x:auto;overflow-y:auto;align-items:flex-start;position:relative;';

  const rounds=s.brRounds||[], matches=s.matches||[], players=s.players||[];
  const gP=id=>players.find(p=>p.id===id), gM=id=>matches.find(m=>m.id===id);
  if (!rounds.length){wrap.innerHTML='<div class="tv-empty">Brak drabinki</div>';return;}
  wrap.innerHTML=rounds.map(r=>{
    const ms=r.mids.map(id=>gM(id)).filter(Boolean).filter(m=>!m.byeMatch||(m.p1&&m.p2));
    if(!ms.length)return'';
    return`<div class="tv-br-col"><div class="tv-br-col-title">${r.name}</div><div class="tv-br-matches">${ms.map(m=>{const p1=m.p1?gP(m.p1):null,p2=m.p2?gP(m.p2):null,w1=m.done&&m.s1>m.s2,w2=m.done&&m.s2>m.s1;return`<div class="tv-br-match"><div class="tv-br-player ${p1?(w1?'br-win':w2?'br-lose':''):'br-tbd'}">${p1?`<div class="tv-av tv-av-sm" style="background:${p1.color}">${Utils.ini(p1.name)}</div><span>${Utils.esc(p1.name)}</span>`:'<span>TBD</span>'}${m.done&&p1?`<span class="tv-br-score ${w1?'tv-score-win':w2?'tv-score-lose':'tv-score-draw'}">${Utils.fS(m.s1)}</span>`:''}</div><div class="tv-br-sep"></div><div class="tv-br-player ${p2?(w2?'br-win':w1?'br-lose':''):'br-tbd'}">${p2?`<div class="tv-av tv-av-sm" style="background:${p2.color}">${Utils.ini(p2.name)}</div><span>${Utils.esc(p2.name)}</span>`:'<span>TBD</span>'}${m.done&&p2?`<span class="tv-br-score ${w2?'tv-score-win':w1?'tv-score-lose':'tv-score-draw'}">${Utils.fS(m.s2)}</span>`:''}</div></div>`;}).join('')}</div></div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   renderSidebar — incremental DOM z data-mid diffingiem
   ─────────────────────────────────────────────
   Zamiast innerHTML replacement (które niszczy DOM i resetuje
   animacje), używa reconciliation opartej na data-mid:
   - Nowe mecze są dodawane (opcjonalnie z animacją slide-in)
   - Usunięte mecze płynnie znikają
   - Istniejące mecze są aktualizowane in-place
═══════════════════════════════════════════════ */
function renderSidebar(s, options = {}) {
  const { animate = false } = options;
  const matches = s.matches || [], players = s.players || [];
  const gP = id => players.find(p => p.id === id);

  // ── Done matches (ostatnie 5) ──
  const done = matches.filter(m => m.done && m.p1 && m.p2 && !m.byeMatch).slice(-5).reverse();
  const dw = document.getElementById('tv-done');
  if (dw) reconcileDoneMatches(dw, done, gP, s, animate);

  // ── Next matches (pierwsze 4 pending) ──
  const pend = matches.filter(m => !m.done && m.p1 && m.p2 && !m.byeMatch);
  const nw = document.getElementById('tv-next');
  if (nw) reconcileNextMatches(nw, pend.slice(0, 4), gP, s, animate);
}

/* ── Reconcile done matches ────────────────── */
function reconcileDoneMatches(container, matches, gP, state, animate) {
  const newIds = new Set(matches.map(m => m.id));

  // Usuń mecze które zniknęły z listy (z animacją fade-out)
  container.querySelectorAll('[data-mid]').forEach(el => {
    if (!newIds.has(el.dataset.mid)) {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 300);
    }
  });

  // Dodaj lub zaktualizuj
  matches.forEach(m => {
    let row = container.querySelector(`[data-mid="${m.id}"]`);
    if (!row) {
      row = createDoneMatchRow(m, gP, state);
      container.appendChild(row);
      if (animate) {
        row.style.opacity = '0';
        row.style.transform = 'translateX(80px)';
        void row.offsetWidth; // force reflow
        row.style.transition = 'opacity .5s ease, transform .5s cubic-bezier(.25,1,.5,1)';
        row.style.opacity = '1';
        row.style.transform = '';
      }
    } else {
      updateDoneMatchRow(row, m, gP, state);
    }
  });

  // Empty state
  const hasRows = container.querySelector('[data-mid]');
  const emptyEl = container.querySelector('.tv-empty');
  if (matches.length === 0 && !emptyEl) {
    container.innerHTML = '<div class="tv-empty">Brak rozegranych meczów</div>';
  } else if (matches.length > 0 && emptyEl) {
    emptyEl.remove();
  }
}

/* ── Reconcile next matches ────────────────── */
function reconcileNextMatches(container, matches, gP, state, animate) {
  const newIds = new Set(matches.map(m => m.id));

  // Usuń mecze które zniknęły
  container.querySelectorAll('[data-mid]').forEach(el => {
    if (!newIds.has(el.dataset.mid)) {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 300);
    }
  });

  // Dodaj lub zaktualizuj
  matches.forEach(m => {
    let row = container.querySelector(`[data-mid="${m.id}"]`);
    if (!row) {
      row = createNextMatchRow(m, gP, state);
      container.appendChild(row);
      if (animate) {
        row.style.opacity = '0';
        row.style.transform = 'translateX(80px)';
        void row.offsetWidth;
        row.style.transition = 'opacity .5s ease, transform .5s cubic-bezier(.25,1,.5,1)';
        row.style.opacity = '1';
        row.style.transform = '';
      }
    } else {
      updateNextMatchRow(row, m, gP, state);
    }
  });

  // Empty state
  const hasRows = container.querySelector('[data-mid]');
  const emptyEl = container.querySelector('.tv-empty');
  if (matches.length === 0 && !emptyEl) {
    container.innerHTML = '<div class="tv-empty">Brak oczekujących meczów</div>';
  } else if (matches.length > 0 && emptyEl) {
    emptyEl.remove();
  }
}

/* ── Create a done match row DOM element ───── */
function createDoneMatchRow(m, gP, state) {
  const p1 = gP(m.p1), p2 = gP(m.p2);
  const w1 = m.s1 > m.s2, w2 = m.s2 > m.s1, dr = !w1 && !w2;
  const row = document.createElement('div');
  row.className = 'tv-done-row' + (dr ? ' result-draw' : (w1 || w2) ? ' result-decisive' : '');
  row.dataset.mid = m.id;
  if (!p1 || !p2) return row;
  row.innerHTML =
    `<div class="tv-dp ${w1 ? 'winner' : w2 ? 'loser' : ''}">` +
      `<div class="tv-av tv-av-sm" style="background:${p1.color}">${Utils.ini(p1.name)}</div>` +
      `<span>${Utils.esc(p1.name)}</span>` +
    `</div>` +
    `<div class="tv-done-score">` +
      `<span class="${w1 ? 'tv-score-win' : dr ? 'tv-score-draw' : 'tv-score-lose'}">${Utils.fS(m.s1)}</span>` +
      `<span class="tv-score-sep">—</span>` +
      `<span class="${w2 ? 'tv-score-win' : dr ? 'tv-score-draw' : 'tv-score-lose'}">${Utils.fS(m.s2)}</span>` +
    `</div>` +
    `<div class="tv-dp tv-dp-right ${w2 ? 'winner' : w1 ? 'loser' : ''}">` +
      `<span>${Utils.esc(p2.name)}</span>` +
      `<div class="tv-av tv-av-sm" style="background:${p2.color}">${Utils.ini(p2.name)}</div>` +
    `</div>`;
  return row;
}

/* ── Update an existing done match row ─────── */
function updateDoneMatchRow(row, m, gP, state) {
  const p1 = gP(m.p1), p2 = gP(m.p2);
  if (!p1 || !p2) return;
  const w1 = m.s1 > m.s2, w2 = m.s2 > m.s1, dr = !w1 && !w2;

  // Update row class (result type)
  row.classList.remove('result-decisive', 'result-draw');
  if (dr) row.classList.add('result-draw');
  else if (w1 || w2) row.classList.add('result-decisive');

  // Update player 1
  const dp1 = row.querySelector('.tv-dp:first-child');
  if (dp1) {
    dp1.className = `tv-dp ${w1 ? 'winner' : w2 ? 'loser' : ''}`;
    const span1 = dp1.querySelector('span');
    if (span1) span1.textContent = p1.name;
    const av1 = dp1.querySelector('.tv-av');
    if (av1) { av1.style.background = p1.color; av1.textContent = Utils.ini(p1.name); }
  }

  // Update scores
  const scoreEls = row.querySelectorAll('.tv-done-score span');
  if (scoreEls[0]) { scoreEls[0].className = w1 ? 'tv-score-win' : dr ? 'tv-score-draw' : 'tv-score-lose'; scoreEls[0].textContent = Utils.fS(m.s1); }
  if (scoreEls[2]) { scoreEls[2].className = w2 ? 'tv-score-win' : dr ? 'tv-score-draw' : 'tv-score-lose'; scoreEls[2].textContent = Utils.fS(m.s2); }

  // Update player 2
  const dp2 = row.querySelector('.tv-dp-right');
  if (dp2) {
    dp2.className = `tv-dp tv-dp-right ${w2 ? 'winner' : w1 ? 'loser' : ''}`;
    const span2 = dp2.querySelector('span');
    if (span2) span2.textContent = p2.name;
    const av2 = dp2.querySelector('.tv-av');
    if (av2) { av2.style.background = p2.color; av2.textContent = Utils.ini(p2.name); }
  }
}

/* ── Create a next match row DOM element ───── */
function createNextMatchRow(m, gP, state) {
  const p1 = gP(m.p1), p2 = gP(m.p2);
  const row = document.createElement('div');
  row.className = 'tv-match-row';
  row.dataset.mid = m.id;
  if (!p1 || !p2) return row;
  row.innerHTML =
    `<div class="tv-match-player">` +
      `<div class="tv-av tv-av-sm" style="background:${p1.color}">${Utils.ini(p1.name)}</div>` +
      `<span>${Utils.esc(p1.name)}</span>` +
    `</div>` +
    `<div class="tv-vs">VS</div>` +
    `<div class="tv-match-player tv-right">` +
      `<span>${Utils.esc(p2.name)}</span>` +
      `<div class="tv-av tv-av-sm" style="background:${p2.color}">${Utils.ini(p2.name)}</div>` +
    `</div>`;

  // Hype bar
  const hype = computeHypeScore(state, m);
  const hypeBar = document.createElement('div');
  hypeBar.className = 'tv-hype-bar';
  hypeBar.innerHTML = `<div class="tv-hype-fill${hype > 0.6 ? ' hype-high' : ''}" style="width:${hype * 100}%"></div>`;
  row.appendChild(hypeBar);

  return row;
}

/* ── Update an existing next match row ─────── */
function updateNextMatchRow(row, m, gP, state) {
  const p1 = gP(m.p1), p2 = gP(m.p2);
  if (!p1 || !p2) return;

  // Player 1
  const mp1 = row.querySelector('.tv-match-player:first-child');
  if (mp1) {
    const span = mp1.querySelector('span');
    if (span) span.textContent = p1.name;
    const av = mp1.querySelector('.tv-av');
    if (av) { av.style.background = p1.color; av.textContent = Utils.ini(p1.name); }
  }

  // Player 2
  const mp2 = row.querySelector('.tv-match-player.tv-right');
  if (mp2) {
    const span = mp2.querySelector('span');
    if (span) span.textContent = p2.name;
    const av = mp2.querySelector('.tv-av');
    if (av) { av.style.background = p2.color; av.textContent = Utils.ini(p2.name); }
  }

  // Update hype bar
  const hype = computeHypeScore(state, m);
  let hypeBar = row.querySelector('.tv-hype-bar');
  if (!hypeBar) {
    hypeBar = document.createElement('div');
    hypeBar.className = 'tv-hype-bar';
    hypeBar.innerHTML = `<div class="tv-hype-fill" style="width:0%"></div>`;
    row.appendChild(hypeBar);
  }
  const fill = hypeBar.querySelector('.tv-hype-fill');
  if (fill) {
    fill.style.width = `${hype * 100}%`;
    fill.classList.toggle('hype-high', hype > 0.6);
  }
}

/* ═══════════════════════════════════════════════
   TICKER
═══════════════════════════════════════════════ */
function updateTicker() {
  const s = pendingState || displayedState;
  const matches=(s.matches||[]).filter(m=>m.done&&m.p1&&m.p2&&!m.byeMatch).slice(-10).reverse();
  const ticker=document.getElementById('tv-ticker');
  if(!ticker||!matches.length)return;
  const gP=id=>(s.players||[]).find(p=>p.id===id);
  ticker.textContent=matches.map(m=>{const p1=gP(m.p1),p2=gP(m.p2);if(!p1||!p2)return'';const w=m.s1>m.s2?p1:m.s2>m.s1?p2:null;return w?`${w.name} wygrał ${Utils.fS(Math.max(m.s1,m.s2))}–${Utils.fS(Math.min(m.s1,m.s2))} z ${w===p1?p2.name:p1.name}`:`${p1.name} remis ${Utils.fS(m.s1)} z ${p2.name}`;}).filter(Boolean).join('   ·   ');
}

/* ═══════════════════════════════════════════════
   OVERTIME BANNER
═══════════════════════════════════════════════ */
function showOvertimeBanner(p1, p2) {
  let b=document.getElementById('overtime-banner');if(b)b.remove();
  b=document.createElement('div');b.id='overtime-banner';
  const ac=(pendingState||displayedState).cfg?.theme||'#f59e0b';
  b.innerHTML=`<div class="ot-inner" style="--ac:${ac};--ac-rgb:${Utils.hexRgb(ac)}"><div class="ot-icon">⚡</div><div class="ot-text"><div class="ot-title">DOGRYWKA!</div><div class="ot-sub">${Utils.esc(p1.name)} vs ${Utils.esc(p2.name)}</div></div><div class="ot-icon">⚡</div></div>`;
  document.body.appendChild(b);void b.offsetWidth;b.classList.add('ot-visible');
  setTimeout(()=>{b.classList.add('ot-fade-out');setTimeout(()=>b.remove(),700);},8000);
}

/* ═══════════════════════════════════════════════
   FLASH OVERLAY
═══════════════════════════════════════════════ */
function showResultFlash(match, p1, p2, onDone) {
  const isDraw=match.s1===match.s2;
  const winner=match.s1>match.s2?p1:p2, loser=match.s1>match.s2?p2:p1;
  const ws=Math.max(match.s1,match.s2), ls=Math.min(match.s1,match.s2);
  const ac=winner.color||'#f59e0b', rgb=Utils.hexRgb(ac);

  let ov=document.getElementById('result-overlay');if(ov)ov.remove();
  ov=document.createElement('div');ov.id='result-overlay';
  ov.innerHTML=buildOverlayHTML(isDraw,winner,loser,p1,p2,ws,ls,ac,rgb);
  document.body.appendChild(ov);void ov.offsetWidth;ov.classList.add('ov-visible');

  const db=ov.querySelector('.duel-box'),sc=ov.querySelector('.duel-score'),rb=ov.querySelector('.duel-ribbon'),pw=ov.querySelector('.particle-wrap');
  setTimeout(()=>db.classList.add('duel-visible'),300);
  setTimeout(()=>sc.classList.add('score-visible'),800);
  setTimeout(()=>rb.classList.add('ribbon-visible'),1200);
  setTimeout(()=>{ isDraw?spawnDrawParticles(pw):(spawnConfetti(pw,ac),spawnPieces(pw)); },1400);

  // 9s wygrana, 6s remis
  setTimeout(()=>{
    ov.classList.add('ov-fade-out');
    setTimeout(()=>{ ov.remove(); onDone(); }, 700);
  }, isDraw ? 6000 : 9000);
}

function buildOverlayHTML(isDraw,winner,loser,p1,p2,ws,ls,ac,rgb){
  const bg=isDraw?`radial-gradient(ellipse at center,#3d3730,#0a0806)`:`radial-gradient(ellipse at 50% 60%,rgba(${rgb},.35) 0%,rgba(${rgb},.12) 30%,#050403 70%)`;
  const score=`${Utils.fS(ws)} — ${Utils.fS(ls)}`;
  const av=isDraw
    ?`<div class="duel-avatars-row"><div class="duel-av-wrap"><div class="duel-av" style="background:${p1.color}">${Utils.ini(p1.name)}</div><div class="duel-av-name">${Utils.esc(p1.name)}</div></div><div class="duel-vs-badge">VS</div><div class="duel-av-wrap"><div class="duel-av" style="background:${p2.color}">${Utils.ini(p2.name)}</div><div class="duel-av-name">${Utils.esc(p2.name)}</div></div></div>`
    :`<div class="duel-av-wrap duel-av-center"><div class="duel-av duel-av-winner" style="background:${winner.color};box-shadow:0 0 80px ${winner.color}88,0 0 160px ${winner.color}44">${Utils.ini(winner.name)}</div><div class="duel-av-name">${Utils.esc(winner.name)}</div><div class="duel-av-sub">pokonuje ${Utils.esc(loser.name)}</div></div>`;
  return`<div class="ov-bg" style="background:${bg}"></div><div class="ov-content"><div class="duel-box"><div class="duel-label">${isDraw?'REMIS!':'ZWYCIĘZCA!'}</div>${av}<div class="duel-score" style="--score-color:${ac}">${score}</div><div class="duel-ribbon">${isDraw?'🤝 Remis — obaj walczyli dzielnie!':'🏆 Gratulacje!'}</div></div><div class="particle-wrap"></div></div>`;
}

function spawnConfetti(wrap,ac){const cols=[ac,'#fff','#ffd700','#ff6b6b','#a8e6cf',ac+'88'];for(let i=0;i<100;i++)setTimeout(()=>{const el=document.createElement('div'),sz=Math.random()*12+6;el.style.cssText=`position:absolute;top:-${sz}px;left:${Math.random()*100}%;width:${sz}px;height:${sz*(Math.random()*.7+.4)}px;background:${cols[Math.floor(Math.random()*cols.length)]};border-radius:${Math.random()>.5?'50%':'2px'};animation:confettiDrop ${Math.random()*2.5+2}s linear ${Math.random()*2}s forwards;transform:rotate(${Math.random()*360}deg)`;wrap.appendChild(el);},i*25);}
function spawnPieces(wrap){const p=['♟','♞','♜','♛','♝','♚','♔','♕','♖','♗','♘','♙'];for(let i=0;i<16;i++)setTimeout(()=>{const el=document.createElement('div');el.style.cssText=`position:absolute;font-size:${Math.random()*50+30}px;left:${Math.random()*90+5}%;top:${Math.random()*70+10}%;opacity:0;color:rgba(255,255,255,.6);animation:piecePop ${Math.random()*1.5+1.5}s ease ${Math.random()*2}s forwards`;el.textContent=p[Math.floor(Math.random()*p.length)];wrap.appendChild(el);},i*120);}
function spawnDrawParticles(wrap){const cols=['#f59e0b','#94a3b8','#fff','rgba(255,255,255,.4)'];for(let i=0;i<50;i++)setTimeout(()=>{const el=document.createElement('div'),a=Math.random()*360;el.style.cssText=`position:absolute;width:8px;height:8px;border-radius:50%;left:50%;top:50%;background:${cols[Math.floor(Math.random()*cols.length)]};animation:drawBurst ${Math.random()*1+1}s ease-out forwards;transform-origin:0 0;--angle:${a}deg;--dist:${Math.random()*40+15}vw`;wrap.appendChild(el);},i*30);}

/* ═══════════════════════════════════════════════
   PODIUM
═══════════════════════════════════════════════ */
function showPodium() {
  const s=displayedState;
  let sorted=s.cfg?.fmt==='cup'&&s.brRounds?.length?_cupOrder(s):null;
  if(!sorted?.length){const d=Compute.standings(s);sorted=Compute.sortedPlayers(s,d);}
  if(!sorted.length)return;
  let ov=document.getElementById('podium-overlay');if(ov)ov.remove();
  const ac=s.cfg?.theme||'#f59e0b',rgb=Utils.hexRgb(ac);
  const top3=sorted.slice(0,Math.min(3,sorted.length)),rest=sorted.slice(3);
  const po=[top3[1],top3[0],top3[2]].filter(Boolean),ht=['140px','180px','110px'],med=['🥈','🥇','🥉'];
  const data=Compute.standings(s);
  ov=document.createElement('div');ov.id='podium-overlay';
  ov.innerHTML=`<div class="pod-bg" style="background:radial-gradient(ellipse at 50% 70%,rgba(${rgb},.25) 0%,rgba(${rgb},.08) 40%,#030201 100%)"></div><div class="pod-content"><div class="pod-title"><span class="pod-trophy">🏆</span><span>${Utils.esc(s.cfg?.name||'Turniej')}</span><span class="pod-trophy">🏆</span></div><div class="pod-subtitle">Wyniki końcowe</div><div class="pod-stage">${po.map((p,vi)=>{if(!p)return'';const gi=sorted.indexOf(p),d=data[p.id]||{};return`<div class="pod-column" style="--ht:${ht[vi]};--delay:${vi*.25}s;--ac:${ac}"><div class="pod-av-ring" style="border-color:${ac}"><div class="pod-av" style="background:${p.color}">${Utils.ini(p.name)}</div></div><div class="pod-name">${Utils.esc(p.name)}</div><div class="pod-pstat">${Utils.fS(d.pts||0)} pkt · ${d.wins||0}W ${d.draws||0}R ${d.losses||0}P</div><div class="pod-block"><div class="pod-medal">${med[vi]}</div><div class="pod-pos">${gi+1}</div></div></div>`;}).join('')}</div>${rest.length?`<div class="pod-rest">${rest.map((p,i)=>{const d=data[p.id]||{};return`<div class="pod-rest-row" style="animation-delay:${.8+i*.1}s"><div class="pod-rest-pos">${i+4}</div><div class="tv-av tv-av-sm" style="background:${p.color}">${Utils.ini(p.name)}</div><div class="pod-rest-name">${Utils.esc(p.name)}</div><div class="pod-rest-pts" style="color:${ac}">${Utils.fS(d.pts||0)}</div></div>`;}).join('')}</div>`:''}<button class="pod-close-btn" id="pod-close-btn">✕ Zamknij</button></div><div class="pod-particles"></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#pod-close-btn').addEventListener('click',()=>{ov.classList.add('pod-fade-out');setTimeout(()=>ov.remove(),600);});
  void ov.offsetWidth;ov.classList.add('pod-visible');
  setTimeout(()=>_fireworks(ov.querySelector('.pod-particles'),ac),600);
}
function _cupOrder(s){const players=s.players||[],matches=s.matches||[],rounds=s.brRounds||[];const gP=id=>players.find(p=>p.id===id);const fr=rounds.find(r=>r.id!=='r3rd'&&r.id==='r'+(rounds.filter(x=>x.id!=='r3rd').length));const fm=fr?fr.mids.map(id=>matches.find(m=>m.id===id)).filter(Boolean).find(m=>m.type==='cup'&&m.done):null;if(!fm)return[];const first=gP(Compute.winOf(fm)),second=gP(Compute.losOf(fm));const th=matches.find(m=>m.type==='cup3rd'&&m.done),third=th?gP(Compute.winOf(th)):null;const ids=[first,second,third].filter(Boolean).map(p=>p.id);const rest=players.filter(p=>!ids.includes(p.id));const sd=Compute.standings(s);rest.sort((a,b)=>(sd[b.id]?.pts||0)-(sd[a.id]?.pts||0));return[first,second,third,...rest].filter(Boolean);}
function _fireworks(wrap,ac){const cols=[ac,'#ffd700','#ff6b6b','#a8e6cf','#c3b1e1','#fff'];[0,600,1200,2400,3600].forEach(d=>setTimeout(()=>{for(let i=0;i<60;i++){const el=document.createElement('div'),ang=(i/60)*360;el.style.cssText=`position:absolute;width:${Math.random()*8+4}px;height:${Math.random()*8+4}px;border-radius:50%;left:${20+Math.random()*60}%;top:${20+Math.random()*40}%;background:${cols[Math.floor(Math.random()*cols.length)]};animation:fireworkBurst ${Math.random()*1+1}s ease-out forwards;--ang:${ang}deg;--spd:${Math.random()*35+15}vw;box-shadow:0 0 6px currentColor`;wrap.appendChild(el);setTimeout(()=>el.remove(),2500);}},d));}

/* ═══════════════════════════════════════════════
   ZEGAR + INIT
═══════════════════════════════════════════════ */
function startClock(){const t=()=>{const el=document.getElementById('tv-clock');if(el)el.textContent=new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});};t();setInterval(t,1000);}

(function init(){
  startClock();
  connectSSE();
  setInterval(updateTicker,5000);
  updateTicker();
})();