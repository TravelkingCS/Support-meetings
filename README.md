# Supportové porady

Zápisky ze supportových porad Travelkingu: porady, témata, úkoly, body na příští poradu, printscreeny, Dixa šablony s poznámkami a návrhy a přehled hodnocení (CSAT).
Malý server (Node.js + Express) s databází PostgreSQL. Kolegové se přihlašují svým jménem a společným týmovým heslem.

## Struktura

| Soubor / složka | Co to je |
|---|---|
| `server.js` | Server: přihlášení, ukládání dat a obrázků do databáze |
| `public/index.html` | Samotná stránka (design jako Třetinka) |
| `seed/` | Současný obsah z claude.ai, při prvním spuštění se sám nahraje do prázdné databáze |
| `package.json` | Závislosti (express, pg) |

## Nasazení na Render

### 1. GitHub
Nahrajte obsah této složky do nového (soukromého) repozitáře na GitHubu. Složku `node_modules` nenahrávejte.

### 2. Databáze
V Renderu: **New → Postgres**. Region vyberte stejný, jaký bude mít web service (např. Frankfurt).

> **Pozor:** databáze na plánu **Free** se po 30 dnech maže. Pro trvalé zápisky zvolte placený plán (Basic),
> nebo použijte bezplatnou databázi jinde (např. Neon) a její adresu vložte do `DATABASE_URL`.

Po vytvoření zkopírujte **Internal Database URL**.

### 3. Web Service
**New → Web Service** → vyberte repozitář a nastavte:

| Pole | Hodnota |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |

V záložce **Environment** přidejte tyto proměnné:

| Proměnná | Hodnota |
|---|---|
| `DATABASE_URL` | Internal Database URL z kroku 2 |
| `TEAM_PASSWORD` | Týmové heslo, které dáte kolegům |
| `SESSION_SECRET` | Dlouhý náhodný text (stačí kliknout na „Generate“) |
| `ADMIN_PASSWORD` | Heslo správce (nepovinné). Kdo se přihlásí tímto heslem, může nahrávat data hodnocení (CSAT). |
| `DIXA_API_TOKEN` | API token z Dixy (nepovinné). Zapne automatické načítání hodnocení (CSAT) – viz níže. Token je jen na serveru, v prohlížeči ho nikdo neuvidí. |
| `DIXA_SYNC_MINUTES` | Jak často se hodnocení načítají z Dixy, výchozí `60` (minimum `15`). |

Po nasazení najdete stránku na adrese `https://<název>.onrender.com`.

> Na plánu **Free** web po 15 minutách bez návštěvy usne a první načtení pak trvá asi minutu.
> Plán Starter tohle odstraní.

## Hodnocení (CSAT) automaticky z Dixy

Záložka **Hodnocení** umí číst data přímo z Dixy – server si je sám stahuje a ukládá do databáze, kolegové vidí vždy aktuální stav bez jakéhokoli nastavení.

1. V Dixě vytvořte API token: **Settings → Integrations → API tokens** (token musí mít přístup k Exports API).
2. V Renderu přidejte do **Environment** proměnnou `DIXA_API_TOKEN` s tímto tokenem a službu znovu nasaďte.
3. Hotovo. Server načte **aktuální a předchozí kalendářní měsíc** (podle pražského času) při startu a pak každých `DIXA_SYNC_MINUTES` minut. Na přelomu měsíce se záložky přepnou samy.

Co je dobré vědět:
- Počítají se konverzace **vytvořené** v daném měsíci (stejná logika jako CSV export z Dixy); hodnocení, která zákazníci doplní později, se objeví při dalším načtení.
- Tlačítko **Aktualizovat teď** (vidí ho jen správce, přihlášený přes `ADMIN_PASSWORD`) spustí načtení okamžitě.
- Na plánu **Free** web po 15 minutách bez návštěvy usne a časovač neběží. Proto se data při otevření záložky automaticky osvěží, pokud jsou starší než 30 minut. Na plánu Starter běží hodinový časovač nepřetržitě.
- Dixa povoluje 10 dotazů za minutu na export konverzací, synchronizace používá 2 dotazy za běh.
- Když `DIXA_API_TOKEN` není nastaven, funguje původní ruční nahrávání dat (správce vloží data zkopírovaná z `Dixa_CSAT_Report_Live.html`).
- Pokud by token unikl, v Dixě ho zrušte a vytvořte nový; stačí pak změnit hodnotu v Renderu.

## Používání
- Přihlášení: kliknout na svou fotku (nebo napsat jméno) a zadat týmové heslo. Přihlášení vydrží 90 dní.
- Změny ostatních se načítají samy zhruba každých 8 sekund.
- Hodnocení (CSAT): při zapnuté synchronizaci s Dixou se aktualizují samy, tlačítko „Aktualizovat teď“ má jen správce (`ADMIN_PASSWORD`). Bez synchronizace může data nahrát jen správce ručně.
- Změna hesla: upravte `TEAM_PASSWORD` v Renderu. Pro odhlášení všech změňte i `SESSION_SECRET`.

## Lokální spuštění
```bash
npm install
DATABASE_URL=postgres://uzivatel:heslo@localhost/porady TEAM_PASSWORD=test SESSION_SECRET=neco npm start
```
Pak otevřete http://localhost:3000
