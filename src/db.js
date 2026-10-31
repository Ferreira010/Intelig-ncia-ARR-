const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const config = require("./config");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT,
  plan_active_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Configuração do bot de cada cliente (1 por usuário)
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  settings TEXT NOT NULL DEFAULT '{}',   -- persona, negócio, catálogo, dicas (texto puro)
  secrets TEXT,                          -- tokens WhatsApp + integrações (criptografado)
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Uma "sessão" de conversa com um cliente final. Nova sessão após inatividade longa.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  messages TEXT NOT NULL DEFAULT '[]',   -- histórico no formato da API do Claude (só cresce)
  status TEXT NOT NULL DEFAULT 'bot',    -- bot | humano
  human_log TEXT NOT NULL DEFAULT '',    -- o que foi falado enquanto um humano atendia
  handoff_reason TEXT,
  last_activity INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conv_lookup ON conversations(bot_id, customer_phone, last_activity);
-- Memória de longo prazo sobre cada cliente final (preferências, pedidos anteriores…)
CREATE TABLE IF NOT EXISTS customer_notes (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (bot_id, customer_phone)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

// ---------- criptografia dos segredos (AES-256-GCM) ----------
const key = crypto.createHash("sha256").update("secrets:" + config.appSecret).digest();
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(str) {
  if (!str) return {};
  const buf = Buffer.from(str, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

// ---------- usuários ----------
const users = {
  create(name, email, passwordHash) {
    const r = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, passwordHash);
    const id = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO bots (id, user_id, settings) VALUES (?, ?, ?)").run(crypto.randomBytes(9).toString("base64url"), id, "{}");
    return id;
  },
  byEmail: (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email),
  byId: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),
  activatePlan(userId, plan, days = 30) {
    const u = users.byId(userId);
    const now = Math.floor(Date.now() / 1000);
    const base = u.plan_active_until && u.plan_active_until > now ? u.plan_active_until : now;
    db.prepare("UPDATE users SET plan = ?, plan_active_until = ? WHERE id = ?").run(plan, base + days * 86400, userId);
  },
  isActive: (u) => !!u && !!u.plan_active_until && u.plan_active_until > Date.now() / 1000,
};

// ---------- bots ----------
function hydrateBot(row) {
  if (!row) return null;
  return { id: row.id, userId: row.user_id, settings: JSON.parse(row.settings || "{}"), secrets: decrypt(row.secrets) };
}
const bots = {
  byUser: (userId) => hydrateBot(db.prepare("SELECT * FROM bots WHERE user_id = ?").get(userId)),
  byId: (id) => hydrateBot(db.prepare("SELECT * FROM bots WHERE id = ?").get(id)),
  save(botId, settings, secrets) {
    db.prepare("UPDATE bots SET settings = ?, secrets = ?, updated_at = unixepoch() WHERE id = ?")
      .run(JSON.stringify(settings), encrypt(secrets), botId);
  },
};

// ---------- conversas ----------
const SESSION_IDLE_SECONDS = 12 * 3600; // depois de 12h sem falar, começa nova sessão (com memória do cliente)
const SESSION_MAX_MESSAGES = 120;
const conversations = {
  current(botId, phone) {
    const row = db.prepare("SELECT * FROM conversations WHERE bot_id = ? AND customer_phone = ? ORDER BY id DESC LIMIT 1").get(botId, phone);
    const now = Math.floor(Date.now() / 1000);
    if (row) {
      const msgs = JSON.parse(row.messages);
      const fresh = now - row.last_activity < SESSION_IDLE_SECONDS && msgs.length < SESSION_MAX_MESSAGES;
      // Conversa em atendimento humano continua aberta mesmo após inatividade
      if (fresh || row.status === "humano") return { ...row, messages: msgs };
    }
    const r = db.prepare("INSERT INTO conversations (bot_id, customer_phone, customer_name) VALUES (?, ?, ?)").run(botId, phone, row?.customer_name || null);
    return { id: Number(r.lastInsertRowid), bot_id: botId, customer_phone: phone, customer_name: row?.customer_name || null, messages: [], status: "bot" };
  },
  saveMessages(id, messages) {
    db.prepare("UPDATE conversations SET messages = ?, last_activity = unixepoch() WHERE id = ?").run(JSON.stringify(messages), id);
  },
  setName: (id, name) => db.prepare("UPDATE conversations SET customer_name = ? WHERE id = ?").run(name, id),
  setStatus: (id, status, reason = null) => db.prepare("UPDATE conversations SET status = ?, handoff_reason = ?, last_activity = unixepoch() WHERE id = ?").run(status, reason, id),
  appendHumanLog: (id, line) => db.prepare("UPDATE conversations SET human_log = human_log || ?, last_activity = unixepoch() WHERE id = ?").run(line + "\n", id),
  takeHumanLog(id) {
    const log = db.prepare("SELECT human_log FROM conversations WHERE id = ?").get(id)?.human_log || "";
    db.prepare("UPDATE conversations SET human_log = '' WHERE id = ?").run(id);
    return log.trim();
  },
  byId(id) {
    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? { ...row, messages: JSON.parse(row.messages) } : null;
  },
  list: (botId) => db.prepare(
    "SELECT id, customer_phone, customer_name, status, handoff_reason, last_activity, json_array_length(messages) AS total FROM conversations WHERE bot_id = ? ORDER BY last_activity DESC LIMIT 200"
  ).all(botId),
};

const notes = {
  get: (botId, phone) => db.prepare("SELECT notes FROM customer_notes WHERE bot_id = ? AND customer_phone = ?").get(botId, phone)?.notes || "",
  append(botId, phone, note) {
    const cur = notes.get(botId, phone);
    const next = (cur ? cur + "\n" : "") + `- ${note}`;
    db.prepare("INSERT INTO customer_notes (bot_id, customer_phone, notes) VALUES (?, ?, ?) ON CONFLICT(bot_id, customer_phone) DO UPDATE SET notes = excluded.notes")
      .run(botId, phone, next.slice(-4000));
  },
};

const payments = {
  upsert(id, userId, plan, status) {
    db.prepare("INSERT INTO payments (id, user_id, plan, status) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status").run(id, userId, plan, status);
  },
  byId: (id) => db.prepare("SELECT * FROM payments WHERE id = ?").get(id),
};

module.exports = { db, users, bots, conversations, notes, payments };
