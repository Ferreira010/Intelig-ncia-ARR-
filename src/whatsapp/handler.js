// Recebe mensagens do WhatsApp, agrupa as que chegam em sequência e responde como uma pessoa.
const config = require("../config");
const { bots, users, conversations, stats } = require("../db");
const { reply } = require("../ai/agent");
const wa = require("./cloud");

const pending = new Map(); // chave bot:telefone -> { items, timer, lastMsgId, name, busy }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(botId, msg) {
  const key = `${botId}:${msg.from}`;
  let p = pending.get(key);
  if (!p) pending.set(key, (p = { items: [], timer: null, busy: false }));
  p.items.push(msg);
  p.lastMsgId = msg.id;
  p.name = msg.name || p.name;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(botId, msg.from, key), config.bufferSeconds * 1000);
}

async function flush(botId, phone, key) {
  const p = pending.get(key);
  if (!p || !p.items.length) return;
  if (p.busy) { p.timer = setTimeout(() => flush(botId, phone, key), 1500); return; }
  p.busy = true;
  const items = p.items.splice(0);
  try {
    await handle(botId, phone, items, p.name, p.lastMsgId);
  } catch (e) {
    console.error(`[bot ${botId}] erro inesperado com ${phone}:`, e);
  } finally {
    p.busy = false;
    if (!p.items.length) pending.delete(key);
  }
}

async function handle(botId, phone, items, name, lastMsgId) {
  const bot = bots.byId(botId);
  if (!bot || bot.settings.pausado) return;
  const owner = users.byId(bot.userId);
  if (!users.isActive(owner)) return; // assinatura vencida: não responde

  const texts = items.map((m) => m.text);
  const conv = conversations.current(botId, phone);
  if (name && conv.customer_name !== name) conversations.setName(conv.id, name);

  // Em atendimento humano: só registra, o bot fica quieto
  if (conv.status === "humano") {
    for (const t of texts) conversations.appendHumanLog(conv.id, `Cliente: ${t}`);
    return;
  }

  // Limite do plano: conversa nova acima da cota vai direto para a equipe
  const limit = config.plans[owner.plan]?.conversations;
  if (limit && conv.messages.length === 0 && stats.conversationsThisMonth(botId) > limit) {
    conversations.setStatus(conv.id, "humano", "Limite de conversas do plano atingido");
    for (const t of texts) conversations.appendHumanLog(conv.id, `Cliente: ${t}`);
    return;
  }

  await wa.markReadAndTyping(bot.secrets, lastMsgId);

  // Baixa fotos/PDFs para a IA ler (se falhar, ela recebe só a descrição em texto)
  const attachments = [];
  for (const m of items.filter((i) => i.media).slice(0, 5)) {
    try { attachments.push(await wa.downloadMedia(bot.secrets, m.media.id)); }
    catch (e) { console.warn(`[bot ${botId}] não baixou mídia:`, e.message); }
  }

  const humanLog = conversations.takeHumanLog(conv.id);
  const started = Date.now();
  const params = {
    bot, history: conv.messages, customerTexts: texts, customerName: name || conv.customer_name, phone, attachments,
    extraContext: humanLog ? `um atendente humano conversou com o cliente antes desta mensagem:\n${humanLog}` : null,
  };

  let result;
  try {
    result = await reply(params);
  } catch (e) {
    console.error(`[bot ${botId}] falha na IA, tentando de novo:`, e.message);
    await sleep(3000);
    try {
      result = await reply(params);
    } catch (e2) {
      // Plano B: ninguém fica sem resposta — avisa o cliente e chama a equipe
      console.error(`[bot ${botId}] falha na IA:`, e2.message);
      for (const t of texts) conversations.appendHumanLog(conv.id, `Cliente: ${t}`);
      conversations.setStatus(conv.id, "humano", "Falha técnica na IA — responda pelo painel");
      await wa.sendText(bot.secrets, phone, "Só um instante, já vou te responder 🙏").catch(() => {});
      return;
    }
  }

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
