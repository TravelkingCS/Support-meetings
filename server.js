// Supportové porady – server (Express + PostgreSQL)
// Env: DATABASE_URL, TEAM_PASSWORD, SESSION_SECRET, volitelně ADMIN_PASSWORD, DIXA_API_TOKEN, DIXA_SYNC_MINUTES, PORT (Render nastaví sám)
"use strict";
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const { DATABASE_URL, TEAM_PASSWORD, SESSION_SECRET, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !TEAM_PASSWORD || !SESSION_SECRET) {
  console.error("Chybí proměnné prostředí: DATABASE_URL, TEAM_PASSWORD a SESSION_SECRET jsou povinné.");
  process.exit(1);
}

// SSL jen pro externí adresy (interní adresa Renderu je bez tečky, např. dpg-xxxx-a)
function needsSsl(url) {
  if (process.env.PGSSL === "true") return true;
  if (process.env.PGSSL === "false") return false;
  try { const h = new URL(url).hostname; return h.includes(".") && h !== "localhost" && h !== "127.0.0.1"; }
  catch { return false; }
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false });

const COLLECTIONS = new Set(["porady", "body", "dixaNotes", "dixaNavrhy", "csat"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_RE = /^[0-9a-f]{32}$/;
const MAX_ASSET = 15 * 1024 * 1024;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      col TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT,
      PRIMARY KEY (col, id));
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT);
  `);
  // Prvotní import obsahu (jen když je databáze prázdná)
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM docs WHERE col='porady'");
  if (rows[0].n === 0) {
    const seedFile = path.join(__dirname, "seed", "porady.json");
    if (fs.existsSync(seedFile)) {
      const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      for (const d of seed) await pool.query("INSERT INTO docs (col,id,data,updated_by) VALUES ('porady',$1,$2,'import') ON CONFLICT DO NOTHING", [d.id, d.data]);
      const dir = path.join(__dirname, "seed", "assets");
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
        const id = f.split(".")[0]; if (!ASSET_RE.test(id)) continue;
        const ext = path.extname(f).slice(1).toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] || "application/octet-stream";
        await pool.query("INSERT INTO assets (id,mime,bytes,created_by) VALUES ($1,$2,$3,'import') ON CONFLICT DO NOTHING", [id, mime, fs.readFileSync(path.join(dir, f))]);
      }
      console.log(`Importováno ${seed.length} porad ze seed/porady.json`);
    }
  }
}

/* ---------- přihlášení (podepsaná cookie) ---------- */
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
function makeToken(name, admin) { const v = Buffer.from(JSON.stringify({ n: name, a: !!admin, t: Date.now() })).toString("base64url"); return v + "." + sign(v); }
function readToken(tok) {
  if (!tok || !tok.includes(".")) return null;
  const [v, s] = tok.split(".");
  const ok = s && s.length === sign(v).length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(v)));
  if (!ok) return null;
  try { const j = JSON.parse(Buffer.from(v, "base64url").toString()); return j.n ? { name: j.n, admin: !!j.a } : null; } catch { return null; }
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))])); }
function setCookie(req, res, val, maxAge) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `porady_sid=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}
const pwEqual = (p, ref) => { if (!ref) return false; const a = crypto.createHash("sha256").update(String(p || "")).digest(), b = crypto.createHash("sha256").update(ref).digest(); return crypto.timingSafeEqual(a, b); };

const attempts = new Map(); // jednoduchá ochrana proti hádání hesla
function tooMany(ip) { const a = attempts.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); } attempts.set(ip, a); return a.n >= 10; }


/* ---------- CSAT z Dixy (automatická synchronizace) ---------- */
// Token zůstává jen na serveru (proměnná DIXA_API_TOKEN), do prohlížeče se nikdy nedostane.
const DIXA_TOKEN = process.env.DIXA_API_TOKEN || "";
const SYNC_MIN = Math.max(15, parseInt(process.env.DIXA_SYNC_MINUTES || "60", 10) || 60);
const csat = { enabled: !!DIXA_TOKEN, running: false, lastRun: 0, lastOk: 0, lastError: "", counts: {} };
const pad2 = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pragueYM(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit" }).formatToParts(d);
  return { y: +p.find(x => x.type === "year").value, m: +p.find(x => x.type === "month").value };
}
// [aktuální měsíc, předchozí měsíc] podle pražského času, např. ["2026-11", "2026-10"]
function monthKeys(d = new Date()) {
  const { y, m } = pragueYM(d);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return [`${y}-${pad2(m)}`, `${prev.y}-${pad2(prev.m)}`];
}
function nextMonthStart(key) { let [y, m] = key.split("-").map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${pad2(m)}-01`; }
const tsFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtTs = ms => ms ? tsFmt.format(new Date(ms)).replace(/\u00a0/g, " ") : "";
function mapChannel(c) {
  c = String(c || "").toLowerCase();
  if (c === "email") return "Email";
  if (c === "pstn_phone" || c === "phone") return "Phone";
  if (c === "voicemail") return "Voicemail";
  if (c === "widgetchat") return "Chat";
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : "";
}
// Z ratings[] konverzace vybere CSAT odpověď (1–5). NPS a palec nahoru/dolů se ignorují.
function pickRating(c) {
  let best = null, bestTs = -1;
  for (const r of Array.isArray(c.ratings) ? c.ratings : []) {
    const t = String(r.rating_type || "").toUpperCase();
    if (/NPS|THUMB/.test(t)) continue;
    const s = (r.rating_score == null || r.rating_score === "") ? NaN : Number(r.rating_score);
    if (!(s >= 1 && s <= 5) || Math.floor(s) !== s) continue;
    const ts = r.rating_rated_timestamp || r.rating_modified_timestamp || r.rating_offered_timestamp || 0;
    if (!best || ts > bestTs) { best = r; bestTs = ts; }
  }
  return best ? { r: best, score: Number(best.rating_score), ts: bestTs } : null;
}
// Řádek ve stejném formátu jako ruční snapshot: [id, agent, skóre, komentář, fronta, kanál, vytvořeno, odpovězeno]
function convToRow(c) {
  const p = pickRating(c); if (!p) return null;
  const agent = String(c.assignee_name || "").trim(); if (!agent) return { noAgent: true };
  return [String(c.id), agent.slice(0, 80), p.score, String(p.r.rating_message || "").trim().slice(0, 600), String(c.queue_name || "").slice(0, 80), mapChannel(c.initial_channel), fmtTs(c.created_at), fmtTs(p.ts)];
}
async function fetchMonth(key) {
  const url = `https://exports.dixa.io/v1/conversation_export?created_after=${key}-01&created_before=${nextMonthStart(key)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${DIXA_TOKEN}` }, signal: AbortSignal.timeout(180000) });
    if (res.status === 429 && attempt === 0) { await sleep(20000); continue; }
    if (res.status === 401) throw new Error("Dixa odmítla token (401)");
    if (res.status === 429) throw new Error("Překročen limit Dixa API (429)");
    if (!res.ok) throw new Error("Dixa API chyba " + res.status);
    return res.json();
  }
}
async function syncCsat() {
  if (!csat.enabled || csat.running) return false;
  csat.running = true; csat.lastRun = Date.now();
  try {
    const counts = {};
    for (const key of monthKeys()) {
      let convs = await fetchMonth(key);
      const byId = new Map(); let noAgent = 0;
      for (const c of convs) { const r = convToRow(c); if (!r) continue; if (r.noAgent) { noAgent++; continue; } byId.set(r[0], r); }
      const data = { month: key, rows: [...byId.values()], generatedAt: new Date().toISOString(), source: "dixa-api", conversations: convs.length, noAgent };
      convs = null;
      await pool.query(`INSERT INTO docs (col,id,data,updated_by) VALUES ('csat',$1,$2,'dixa-sync')
        ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now(), updated_by=EXCLUDED.updated_by`, [key, data]);
      counts[key] = data.rows.length;
      await sleep(2000);
    }
    csat.lastOk = Date.now(); csat.lastError = ""; csat.counts = counts;
    console.log("CSAT synchronizace OK:", JSON.stringify(counts));
  } catch (e) {
    csat.lastError = e.message || String(e);
    console.error("CSAT synchronizace selhala:", csat.lastError);
  } finally { csat.running = false; }
  return true;
}
// Na bezplatném plánu Renderu web usíná – proto se při otevření záložky data osvěží, pokud jsou starší než 30 min.
function maybeSync() { if (csat.enabled && !csat.running && Date.now() - csat.lastRun > 30 * 60e3) syncCsat(); }

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });

app.post("/api/login", express.json({ limit: "10kb" }), (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: "Příliš mnoho pokusů, zkuste to za 15 minut." });
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Vyberte nebo napište své jméno." });
  const admin = pwEqual(req.body?.password, ADMIN_PASSWORD);
  if (!admin && !pwEqual(req.body?.password, TEAM_PASSWORD)) { attempts.get(ip).n++; return res.status(401).json({ error: "Špatné heslo." }); }
  attempts.delete(ip);
  setCookie(req, res, makeToken(name, admin), 60 * 60 * 24 * 90);
  res.json({ name, admin });
});
app.post("/api/logout", (req, res) => { setCookie(req, res, "", 0); res.json({ ok: true }); });

function auth(req, res, next) {
  const s = readToken(cookies(req).porady_sid);
  if (!s) return res.status(401).json({ error: "Nepřihlášen" });
  req.user = s.name; req.admin = s.admin; next();
}
app.get("/api/me", auth, (req, res) => res.json({ name: req.user, admin: !!req.admin }));

app.get("/api/csat-status", auth, (req, res) => {
  maybeSync();
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: csat.enabled, running: csat.running, lastRun: csat.lastRun, lastOk: csat.lastOk, lastError: csat.lastError, intervalMin: SYNC_MIN });
});
app.post("/api/csat-refresh", auth, (req, res) => {
  if (!req.admin) return res.status(403).json({ error: "Jen pro správce" });
  if (!csat.enabled) return res.status(400).json({ error: "Synchronizace s Dixou není zapnutá (chybí proměnná DIXA_API_TOKEN)." });
  if (csat.running) return res.status(202).json({ started: false, running: true });
  if (Date.now() - csat.lastRun < 20000) return res.status(429).json({ error: "Počkejte prosím chvíli a zkuste to znovu." });
  syncCsat();
  res.status(202).json({ started: true });
});

/* ---------- dokumenty ---------- */
const colOk = (req, res) => { if (!COLLECTIONS.has(req.params.col)) { res.status(404).json({ error: "Neznámá kolekce" }); return false; } if (req.params.id !== undefined && !ID_RE.test(req.params.id)) { res.status(400).json({ error: "Neplatné id" }); return false; } return true; };
const ADMIN_ONLY = new Set(["csat"]); // zápis jen pro přihlášené admin heslem
const writeOk = (req, res) => { if (ADMIN_ONLY.has(req.params.col) && !req.admin) { res.status(403).json({ error: "Jen pro správce" }); return false; } return true; };
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Chyba serveru" }); });

app.get("/api/:col", auth, wrap(async (req, res) => {
  if (!colOk(req, res)) return;
  const { rows } = await pool.query("SELECT id, data FROM docs WHERE col=$1", [req.params.col]);
  res.setHeader("Cache-Control", "no-store");
  res.json(rows);
}));
app.put("/api/:col/:id", auth, express.json({ limit: "5mb" }), wrap(async (req, res) => {
  if (!colOk(req, res)) return; if (!writeOk(req, res)) return;
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "Neplatná data" });
  await pool.query(`INSERT INTO docs (col,id,data,updated_by) VALUES ($1,$2,$3,$4)
    ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now(), updated_by=EXCLUDED.updated_by`, [req.params.col, req.params.id, req.body, req.user]);
  res.status(204).end();
}));
app.patch("/api/:col/:id", auth, express.json({ limit: "5mb" }), wrap(async (req, res) => {
  if (!colOk(req, res)) return; if (!writeOk(req, res)) return;
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "Neplatná data" });
  const r = await pool.query("UPDATE docs SET data = data || $3::jsonb, updated_at=now(), updated_by=$4 WHERE col=$1 AND id=$2", [req.params.col, req.params.id, req.body, req.user]);
  if (!r.rowCount) return res.status(404).json({ error: "Nenalezeno" });
  res.status(204).end();
}));
app.delete("/api/:col/:id", auth, wrap(async (req, res) => {
  if (!colOk(req, res)) return; if (!writeOk(req, res)) return;
  await pool.query("DELETE FROM docs WHERE col=$1 AND id=$2", [req.params.col, req.params.id]);
  res.status(204).end();
}));

/* ---------- obrázky ---------- */
app.post("/api/assets", auth, express.raw({ type: "image/*", limit: MAX_ASSET }), wrap(async (req, res) => {
  const mime = String(req.headers["content-type"] || "").split(";")[0];
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Nahrajte obrázek PNG, JPG, WEBP nebo GIF." });
  const id = crypto.randomBytes(16).toString("hex");
  await pool.query("INSERT INTO assets (id,mime,bytes,created_by) VALUES ($1,$2,$3,$4)", [id, mime, req.body, req.user]);
  res.json({ id, url: "/_blob/" + id });
}));
app.delete("/api/assets/:id", auth, wrap(async (req, res) => {
  if (!ASSET_RE.test(req.params.id)) return res.status(400).end();
  await pool.query("DELETE FROM assets WHERE id=$1", [req.params.id]);
  res.status(204).end();
}));
app.get("/_blob/:id", auth, wrap(async (req, res) => {
  if (!ASSET_RE.test(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query("SELECT mime, bytes FROM assets WHERE id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).end();
  res.setHeader("Content-Type", rows[0].mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(rows[0].bytes);
}));

app.get("/healthz", (req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => {
  console.log("Supportové porady běží na portu " + PORT);
  if (csat.enabled) { syncCsat(); setInterval(syncCsat, SYNC_MIN * 60e3); console.log(`CSAT: synchronizace s Dixou zapnutá (každých ${SYNC_MIN} min)`); }
  else console.log("CSAT: DIXA_API_TOKEN není nastaven – data hodnocení se nahrávají ručně.");
}))
  .catch(e => { console.error("Nepodařilo se připojit k databázi:", e.message); process.exit(1); });
