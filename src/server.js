const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const config = require("./config");
const { users, bots, conversations, payments } = require("./db");
const { hashPassword, verifyPassword, setSession, clearSession, requireAuth } = require("./auth");
const { callIntegration } = require("./integrations/http");
const { reply, INTEGRATION_TOOLS } = require("./ai/agent");
const wa = require("./whatsapp/cloud");
const { enqueue } = require("./whatsapp/handler");
const mp = require("./payments/mercadopago");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, planActiveUntil: u.plan_active_until, active: users.isActive(u) });

// Limite simples de tentativas de login/cadastro por IP
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = req.path + req.ip, now = Date.now();
    const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
    h.push(now); hits.set(k, h); next();
  };
}

// ---------------- conta ----------------
app.post("/api/cadastro", rateLimit(10, 15 * 60e3), (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Preencha nome, e-mail e senha." });
  if (String(password).length < 8) return res.status(400).json({ error: "A senha precisa ter pelo menos 8 caracteres." });
  const em = String(email).trim().toLowerCase();
  if (users.byEmail(em)) return res.status(409).json({ error: "Este e-mail já tem conta. Faça login." });
  const id = users.create(String(name).trim(), em, hashPassword(String(password)));
  setSession(res, id);
  res.json({ user: publicUser(users.byId(id)) });
});

app.post("/api/login", rateLimit(20, 15 * 60e3), (req, res) => {
  const { email, password } = req.body || {};
  const u = email && users.byEmail(String(email).trim().toLowerCase());
  if (!u || !verifyPassword(String(password || ""), u.password_hash)) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post("/api/logout", (_req, res) => { clearSession(res); res.json({ ok: true }); });
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------------- planos e pagamento ----------------
app.get("/api/planos", (_req, res) => res.json({ plans: config.plans, testMode: !config.mercadoPagoToken }));

app.post("/api/assinar", requireAuth, wrap(async (req, res) => {
  const plan = req.body?.plan;
  if (!config.plans[plan]) return res.status(400).json({ error: "Plano inválido." });
  if (!config.mercadoPagoToken) {
    users.activatePlan(req.user.id, plan, 30);
    return res.json({ activated: true, testMode: true });
  }
  res.json({ checkoutUrl: await mp.createCheckout(req.user, plan) });
}));

app.post("/api/pagamentos/webhook", wrap(async (req, res) => {
  res.sendStatus(200); // responde rápido; o processamento segue
  const id = req.body?.data?.id || req.query["data.id"] || req.query.id;
  const type = req.body?.type || req.query.type || req.query.topic;
  if (!id || (type && type !== "payment")) return;
  const pay = await mp.getPayment(id);
  const [userId, plan] = String(pay.external_reference || "").split(":");
  if (!users.byId(Number(userId)) || !config.plans[plan]) return;
  const before = payments.byId(String(pay.id));
  payments.upsert(String(pay.id), Number(userId), plan, pay.status);
  if (pay.status === "approved" && before?.status !== "approved") users.activatePlan(Number(userId), plan, 30);
}));

// ---------------- configuração do bot ----------------
const mask = (v) => (v ? "••••" + String(v).slice(-4) : "");
const isMasked = (v) => typeof v === "string" && v.startsWith("••••");

app.get("/api/bot", requireAuth, (req, res) => {
  const bot = bots.byUser(req.user.id);
  const s = bot.secrets;
  res.json({
    id: bot.id,
    webhookUrl: `${config.publicUrl}/webhook/whatsapp/${bot.id}`,
    settings: bot.settings,
    whatsapp: { phoneId: s.whatsappPhoneId || "", token: mask(s.whatsappToken), verifyToken: s.whatsappVerifyToken || "", appSecret: mask(s.whatsappAppSecret) },
    integrations: Object.fromEntries(Object.keys(INTEGRATION_TOOLS).map((k) => [k, s.integrations?.[k] || { enabled: false, method: "GET", url: "", headers: "", body: "", instrucoes: "" }])),
  });
});

app.put("/api/bot", requireAuth, (req, res) => {
  const bot = bots.byUser(req.user.id);
  const { settings, whatsapp = {}, integrations = {} } = req.body || {};
  const s = bot.secrets;
  const next = {
    whatsappPhoneId: String(whatsapp.phoneId ?? s.whatsappPhoneId ?? "").trim(),
    whatsappToken: isMasked(whatsapp.token) ? s.whatsappToken : String(whatsapp.token || "").trim(),
    whatsappVerifyToken: String(whatsapp.verifyToken || s.whatsappVerifyToken || crypto.randomBytes(12).toString("hex")).trim(),
    whatsappAppSecret: isMasked(whatsapp.appSecret) ? s.whatsappAppSecret : String(whatsapp.appSecret || "").trim(),
    integrations: {},
  };
  for (const k of Object.keys(INTEGRATION_TOOLS)) {
    const i = integrations[k] || {};
    if (i.headers) { try { JSON.parse(i.headers); } catch { return res.status(400).json({ error: `Os headers da integração "${k}" precisam ser um JSON válido, ex.: {"Authorization": "Bearer SEU_TOKEN"}` }); } }
    next.integrations[k] = { enabled: !!i.enabled, method: i.method === "POST" ? "POST" : "GET", url: String(i.url || "").trim(), headers: String(i.headers || ""), body: String(i.body || ""), instrucoes: String(i.instrucoes || "").slice(0, 1000) };
  }
  bots.save(bot.id, settings && typeof settings === "object" ? settings : bot.settings, next);
  res.json({ ok: true });
});

app.post("/api/bot/testar-integracao", requireAuth, wrap(async (req, res) => {
  const { key, integration, vars } = req.body || {};
  if (!INTEGRATION_TOOLS[key]) return res.status(400).json({ error: "Integração inválida." });
  try {
    res.json(await callIntegration(integration, vars || {}));
  } catch (e) {
    res.json({ ok: false, status: 0, body: e.message });
  }
}));

// Simulador no painel: conversa de teste com o bot (não usa WhatsApp)
const simulations = new Map(); // userId -> { history, count, day }
app.post("/api/bot/simular", requireAuth, wrap(async (req, res) => {
  const { texto, reset } = req.body || {};
  const today = new Date().toDateString();
  let sim = simulations.get(req.user.id);
  if (!sim || sim.day !== today) sim = { history: [], count: 0, day: today };
  if (reset) sim.history = [];
  simulations.set(req.user.id, sim);
  if (!texto) return res.json({ bubbles: [] });
  const limit = users.isActive(req.user) ? 300 : 20;
  if (sim.count >= limit) return res.status(429).json({ error: "Limite diário de testes atingido. Assine um plano para testar mais." });
  sim.count++;
  const bot = bots.byUser(req.user.id);
  const r = await reply({ bot, history: sim.history, customerTexts: [String(texto)], customerName: "Cliente Teste", phone: null });
  sim.history = r.messages;
  res.json({ bubbles: r.bubbles, handoff: r.handoff, toolCalls: r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use").length });
}));

// ---------------- conversas (caixa de entrada) ----------------
function ownConversation(req) {
  const bot = bots.byUser(req.user.id);
  const conv = conversations.byId(Number(req.params.id));
  return conv && conv.bot_id === bot.id ? { bot, conv } : null;
}

app.get("/api/conversas", requireAuth, (req, res) => res.json({ conversations: conversations.list(bots.byUser(req.user.id).id) }));

app.get("/api/conversas/:id", requireAuth, (req, res) => {
  const own = ownConversation(req);
  if (!own) return res.sendStatus(404);
  // Converte o histórico da API em linhas legíveis
  const lines = [];
  for (const m of own.conv.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text" && m.role === "user") {
        const human = b.text.match(/atendente humano conversou[^\n]*:\n([\s\S]*?)\]\n/);
        if (human) for (const l of human[1].split("\n")) lines.push({ from: l.startsWith("Cliente:") ? "cliente" : "humano", text: l.replace(/^(Cliente|Atendente): /, "") });
        lines.push({ from: "cliente", text: b.text.replace(/^(\[[\s\S]*?\]\n)+/, "").trim() });
      }
      else if (b.type === "text") lines.push({ from: "bot", text: b.text.replace(/\s*\|\|\|\s*/g, "\n") });
      else if (b.type === "tool_use") lines.push({ from: "sistema", text: `consultou ${b.name}: ${JSON.stringify(b.input)}` });
    }
  }
  if (own.conv.human_log) for (const l of own.conv.human_log.trim().split("\n")) lines.push({ from: l.startsWith("Cliente:") ? "cliente" : "humano", text: l.replace(/^(Cliente|Atendente): /, "") });
  res.json({ conversation: { ...own.conv, messages: undefined }, lines });
});

app.post("/api/conversas/:id/responder", requireAuth, wrap(async (req, res) => {
  const own = ownConversation(req);
  if (!own) return res.sendStatus(404);
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "Escreva uma mensagem." });
  await wa.sendText(own.bot.secrets, own.conv.customer_phone, texto);
  if (own.conv.status !== "humano") conversations.setStatus(own.conv.id, "humano", "Atendente assumiu pelo painel");
  conversations.appendHumanLog(own.conv.id, `Atendente: ${texto}`);
  res.json({ ok: true });
}));

app.post("/api/conversas/:id/devolver", requireAuth, (req, res) => {
  const own = ownConversation(req);
  if (!own) return res.sendStatus(404);
  conversations.setStatus(own.conv.id, "bot");
  res.json({ ok: true });
});

// ---------------- webhook do WhatsApp (Meta) ----------------
app.get("/webhook/whatsapp/:botId", (req, res) => {
  const bot = bots.byId(req.params.botId);
  if (bot && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === bot.secrets.whatsappVerifyToken) {
    return res.status(200).send(String(req.query["hub.challenge"]));
  }
  res.sendStatus(403);
});

app.post("/webhook/whatsapp/:botId", (req, res) => {
  const bot = bots.byId(req.params.botId);
  if (!bot) return res.sendStatus(404);
  if (bot.secrets.whatsappAppSecret) {
    const sig = req.get("x-hub-signature-256") || "";
    const expected = "sha256=" + crypto.createHmac("sha256", bot.secrets.whatsappAppSecret).update(req.rawBody || "").digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  }
  res.sendStatus(200);
  for (const msg of wa.parseWebhook(req.body)) {
    if (msg.phoneNumberId && bot.secrets.whatsappPhoneId && msg.phoneNumberId !== bot.secrets.whatsappPhoneId) continue;
    enqueue(bot.id, msg);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Algo deu errado. Tente novamente." });
});

app.listen(config.port, () => console.log(`Inteligência ARR rodando em http://localhost:${config.port}`));
