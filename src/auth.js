const crypto = require("node:crypto");
const config = require("./config");
const { users } = require("./db");

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

const sign = (v) => crypto.createHmac("sha256", config.appSecret).update(v).digest("base64url");
function makeToken(userId) {
  const payload = `${userId}.${Date.now() + 30 * 86400 * 1000}`;
  return `${payload}.${sign(payload)}`;
}
function readToken(tok) {
  if (!tok) return null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  if (expected.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Number(parts[0]);
}

function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setSession(res, userId) {
  const secure = config.publicUrl.startsWith("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(makeToken(userId))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

function requireAuth(req, res, next) {
  const userId = readToken(getCookie(req, "sid"));
  const user = userId && users.byId(userId);
  if (!user) return res.status(401).json({ error: "Faça login para continuar." });
  req.user = user;
  next();
}

module.exports = { hashPassword, verifyPassword, setSession, clearSession, requireAuth };
