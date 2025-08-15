// server.js — multi-user + backdating
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const app = express();

// --- DB ---------------------------------------------------------------------
const db = new Database(path.join(__dirname, 'db', 'plantkeeper.db'));
db.pragma('journal_mode = wal');

// Migrations: create tables if missing & add columns for multi-user
// Users & sessions
// users(email unique), sessions(session_id -> user_id)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

// Plants (add user_id if missing)
db.exec(`
CREATE TABLE IF NOT EXISTS plants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT,
  location TEXT,
  water_interval_days INTEGER DEFAULT 7,
  repot_interval_days INTEGER DEFAULT 365,
  notes TEXT,
  last_watered TEXT,
  last_repotted TEXT
);
`);

// Add user_id column if missing
const hasUserIdCol = db.prepare("PRAGMA table_info(plants)").all().some(c => c.name === 'user_id');
if (!hasUserIdCol) {
  db.exec(`ALTER TABLE plants ADD COLUMN user_id INTEGER;`);
  // Backfill existing rows to a default owner if you want; for now leave NULL
}

// History tables (if your original app uses a single history table, adjust accordingly)
db.exec(`
CREATE TABLE IF NOT EXISTS waterings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  user_id INTEGER,
  FOREIGN KEY(plant_id) REFERENCES plants(id)
);
CREATE TABLE IF NOT EXISTS repottings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  user_id INTEGER,
  FOREIGN KEY(plant_id) REFERENCES plants(id)
);
`);

// --- App middleware ----------------------------------------------------------
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-secret-change-me'));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth helpers ------------------------------------------------------------
const SESSION_COOKIE = 'pk_session';
const sessionTTLHours = 24 * 30; // 30 days

function createSession(userId) {
  const id = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO sessions(id, user_id) VALUES (?, ?)`).run(id, userId);
  return id;
}
function getSession(req) {
  const sid = req.signedCookies[SESSION_COOKIE];
  if (!sid) return null;
  const row = db.prepare(`SELECT s.id, u.id AS user_id, u.email
                          FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.id = ?`).get(sid);
  return row || null;
}
function destroySession(req, res) {
  const sid = req.signedCookies[SESSION_COOKIE];
  if (sid) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  res.clearCookie(SESSION_COOKIE);
}
function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id: sess.user_id, email: sess.email };
  next();
}

// Normalize input date (YYYY-MM-DD -> ISO date at 00:00) or use now
function normalizeDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  // Accept YYYY-MM-DD or ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const iso = new Date(dateStr + 'T00:00:00').toISOString();
    return iso;
  }
  // Fallback: try to parse
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// --- Auth routes -------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const hash = await bcrypt.hash(password, 11);
  try {
    const info = db.prepare(`INSERT INTO users(email, password_hash) VALUES (?, ?)`).run(email, hash);
    const sid = createSession(info.lastInsertRowid);
    res.cookie(SESSION_COOKIE, sid, { httpOnly: true, signed: true, sameSite: 'lax', maxAge: sessionTTLHours * 3600 * 1000 });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'email already exists' });
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email || '');
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const sid = createSession(user.id);
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, signed: true, sameSite: 'lax', maxAge: sessionTTLHours * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: sess.user_id, email: sess.email });
});

// --- Plant APIs (scoped to req.user) ----------------------------------------
app.get('/api/plants', requireAuth, (req, res) => {
  const plants = db.prepare(`SELECT * FROM plants WHERE user_id IS ? OR user_id = ? ORDER BY id DESC`).all(null, req.user.id);
  res.json(plants);
});

app.post('/api/plants', requireAuth, (req, res) => {
  const { name, species, location, water_interval_days, repot_interval_days, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const stmt = db.prepare(`INSERT INTO plants(name, species, location, water_interval_days, repot_interval_days, notes, user_id)
                           VALUES(?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(name, species, location, Number(water_interval_days||7), Number(repot_interval_days||365), notes, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/plants/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(`SELECT * FROM plants WHERE id = ? AND (user_id IS ? OR user_id = ? )`).get(id, null, req.user.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const { name, species, location, water_interval_days, repot_interval_days, notes } = req.body || {};
  db.prepare(`UPDATE plants SET name=?, species=?, location=?, water_interval_days=?, repot_interval_days=?, notes=? WHERE id=?`).run(
    name ?? p.name,
    species ?? p.species,
    location ?? p.location,
    Number(water_interval_days ?? p.water_interval_days),
    Number(repot_interval_days ?? p.repot_interval_days),
    notes ?? p.notes,
    id
  );
  res.json({ ok: true });
});

app.delete('/api/plants/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(`SELECT id FROM plants WHERE id = ? AND (user_id IS ? OR user_id = ? )`).get(id, null, req.user.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare(`DELETE FROM waterings WHERE plant_id = ?`).run(id);
  db.prepare(`DELETE FROM repottings WHERE plant_id = ?`).run(id);
  db.prepare(`DELETE FROM plants WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// --- Backdated actions -------------------------------------------------------
app.post('/api/water/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const plant = db.prepare(`SELECT * FROM plants WHERE id = ? AND (user_id IS ? OR user_id = ? )`).get(id, null, req.user.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const at = normalizeDate(req.body?.date); // may be undefined => now
  const ins = db.prepare(`INSERT INTO waterings(plant_id, at, user_id) VALUES(?, ?, ?)`);
  ins.run(id, at, req.user.id);
  // Update last_watered if newer than existing
  const newer = !plant.last_watered || new Date(at) > new Date(plant.last_watered);
  if (newer) db.prepare(`UPDATE plants SET last_watered = ? WHERE id = ?`).run(at, id);
  res.json({ ok: true, at });
});

app.post('/api/repot/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const plant = db.prepare(`SELECT * FROM plants WHERE id = ? AND (user_id IS ? OR user_id = ? )`).get(id, null, req.user.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const at = normalizeDate(req.body?.date);
  db.prepare(`INSERT INTO repottings(plant_id, at, user_id) VALUES(?, ?, ?)`).run(id, at, req.user.id);
  const newer = !plant.last_repotted || new Date(at) > new Date(plant.last_repotted);
  if (newer) db.prepare(`UPDATE plants SET last_repotted = ? WHERE id = ?`).run(at, id);
  res.json({ ok: true, at });
});

app.get('/api/history/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const plant = db.prepare(`SELECT id FROM plants WHERE id = ? AND (user_id IS ? OR user_id = ? )`).get(id, null, req.user.id);
  if (!plant) return res.status(404).json({ error: 'not found' });
  const w = db.prepare(`SELECT 'watered' AS type, at FROM waterings WHERE plant_id = ? ORDER BY at DESC`).all(id);
  const r = db.prepare(`SELECT 'repotted' AS type, at FROM repottings WHERE plant_id = ? ORDER BY at DESC`).all(id);
  res.json([...w, ...r].sort((a,b)=> new Date(b.at)-new Date(a.at)));
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => console.log(`Plant Keeper listening on http://localhost:${PORT}`));
