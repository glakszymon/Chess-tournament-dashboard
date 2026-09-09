# ♟ Chess Tournament Dashboard

Aurora-lookowy dashboard do zarządzania turniejami szachowymi w sieci lokalnej — z natychmiastową animacją na ekranie TV.

Zero zależności. Zero bundlerów. Czysty Node.js + HTML/CSS/JS.

---

## Funkcje

| Moduł | Co robi |
|-------|---------|
| **Manager** (`index.html`) | Panel krok po kroku: dane turnieju → format → gracze → rozgrywki |
| **Widok TV** (`tv.html`) | Pełnoekranowy widok na TV/projektorze z animowaną tabelą, flash overlay, podium |
| **Serwer** (`server.js`) | REST API + SSE (Server-Sent Events) — push wyników w czasie rzeczywistym |
| **Tryby rozgrywek** | Liga (każdy z każdym), Puchar (drabinka), Szwajcarski |
| **Punktacja** | Szachowa (1/½/0), Sportowa (3/1/0) lub własna |
| **Dogrywka** | Opcjonalna dogrywka przy remisie z animowanym panelem wyboru |
| **TV Animacje** | FLIP-animated ranking, cinematic result overlay, fire streak, podium ceremony |
| **Live dołączanie** | Gracz może dołączyć w trakcie trwania turnieju (Liga/Szwajcarski) |
| **Wieloplatformowość** | Działa na laptopie, Smart TV, tablecie, telefonie — w jednej sieci WiFi |

---

## Instalacja

### Wymagania

- **Node.js** >= 18 (pobierz z [nodejs.org](https://nodejs.org))
- Brak jakichkolwiek zależności npm — serwer używa tylko wbudowanych modułów Node.js

### Uruchomienie

```bash
# 1. Sklonuj repozytorium
git clone [https://github.com/TWOJ_NICK/chess-tournament-dashboard.git](https://github.com/glakszymon/Chess-tournament-dashboard.git)
cd chess-tournament-dashboard

# 2. Uruchom serwer
node server.js
```

Po uruchomieniu zobaczysz w terminalu:

```
╔══════════════════════════════════════════════╗
║   ♟  Chess Tournament Server  ♟              ║
╠══════════════════════════════════════════════╣
║  Manager:  http://localhost:3000              ║
║  TV View:  http://192.168.1.42:3000/tv        ║
╚══════════════════════════════════════════════╝
```

### Otwórz w przeglądarkach

| Cel | URL | Urządzenie |
|-----|-----|------------|
| **Manager** (wpisywanie wyników) | `http://localhost:3000` | Laptop organizatora |
| **Widok TV** (tabela + animacje) | `http://<IP_LAN>:3000/tv` | TV / projektor / tablet |

> Wszystkie urządzenia muszą być w tej samej sieci WiFi/LAN.

---

## Struktura projektu

```
chess-tournament-dashboard/
├── server.js              # Node.js serwer (REST API + SSE)
├── index.html             # Panel zarządzania turniejem (Manager)
├── tv.html                # Widok TV (animacje, tabela live, podium)
├── style.css              # Style managera (design system)
├── app.js                 # Logika managera (panel navigation, matches, standings)
├── tv.js                  # Logika widoku TV (FLIP animation, flash overlay, fire effects)
├── shared.js              # Wspólne: API layer, Utils, Compute (standings, sorting)
├── tournament-data.json   # Dane turnieju (auto-tworzony przez serwer)
├── .gitignore
└── README.md
```
---

## Style rozgrywek

### Liga (Round-Robin)
Każdy z każdym. Opcjonalnie mecz rewanżowy. Generuje wszystkie pary przed startem.

### Puchar (Knockout)
Drabinka eliminacyjna. Wolne losy (bye) dla nieparzystej liczby graczy. Mecz o 3. miejsce opcjonalny.

### Szwajcarski
Gracz zagra z kimś o podobnym poziomie. Nie wypada z turnieju. Liczba rund konfigurowana.

---

## Licencja

MIT — używaj dowolnie.

