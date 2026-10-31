// Recebe mensagens do WhatsApp, agrupa as que chegam em sequência e responde como uma pessoa.
const config = require("../config");
const { bots, users, conversations } = require("../db");
const { reply } = require("../ai/agent");
const wa = require("./cloud");

const pending = new Map(); // chave bot:telefone -> { texts, timer, lastMsgId, name, busy }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(botId, msg) {
  const key = `${botId}:${msg.from}`;
  let p = pending.get(key);
  if (!p) pending.set(key, (p = { texts: [], timer: null, busy: false }));
  p.texts.push(msg.text);
  p.lastMsgId = msg.id;
  p.name = msg.name || p.name;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(botId, msg.from, key), config.bufferSeconds * 1000);
}

async function flush(botId, phone, key) {
  const p = pending.get(key);
  if (!p || !p.texts.length) return;
  if (p.busy) { p.timer = setTimeout(() => flush(botId, phone, key), 1500); return; }
  p.busy = true;
  const texts = p.texts.splice(0);
  try {
    await handle(botId, phone, texts, p.name, p.lastMsgId);
  } catch (e) {
    console.error(`[bot ${botId}] erro ao responder ${phone}:`, e.message);
  } finally {
    p.busy = false;
    if (!p.texts.length) pending.delete(key);
  }
}

async function handle(botId, phone, texts, name, lastMsgId) {
  const bot = bots.byId(botId);
  if (!bot || bot.settings.pausado) return;
  const owner = users.byId(bot.userId);
  if (!users.isActive(owner)) return; // assinatura vencida: não responde

  const conv = conversations.current(botId, phone);
  if (name && conv.customer_name !== name) conversations.setName(conv.id, name);

  // Em atendimento humano: só registra, o bot fica quieto
  if (conv.status === "humano") {
    for (const t of texts) conversations.appendHumanLog(conv.id, `Cliente: ${t}`);
    return;
  }

  await wa.markReadAndTyping(bot.secrets, lastMsgId);
  const humanLog = conversations.takeHumanLog(conv.id);
  const started = Date.now();
  const result = await reply({
    bot, history: conv.messages, customerTexts: texts, customerName: name || conv.customer_name, phone,
    extraContext: humanLog ? `um atendente humano conversou com o cliente antes desta mensagem:\n${humanLog}` : null,
  });
  conversations.saveMessages(conv.id, result.messages);
  if (result.handoff) conversations.setStatus(conv.id, "humano", result.handoff);

  // Envia em bolhas, com tempo de "digitação" proporcional ao tamanho (como uma pessoa)
  for (let i = 0; i < result.bubbles.length; i++) {
    const text = result.bubbles[i];
    const typingMs = Math.min(1200 + text.length * 35, 7000) - (i === 0 ? Date.now() - started : 0);
    if (typingMs > 0) await sleep(typingMs);
    await wa.sendText(bot.secrets, phone, text);
    if (i < result.bubbles.length - 1) await wa.markReadAndTyping(bot.secrets, lastMsgId);
  }
}

module.exports = { enqueue };
