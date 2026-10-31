const Anthropic = require("@anthropic-ai/sdk");
const config = require("../config");
const { buildSystemPrompt } = require("./prompt");
const { callIntegration } = require("../integrations/http");
const { notes } = require("../db");

const client = new Anthropic();

// Integrações que o lojista pode ligar no painel
const INTEGRATION_TOOLS = {
  estoque: {
    name: "consultar_estoque",
    description: "Consulta disponibilidade, quantidade, variações (tamanho/cor) e preço atual de um produto no sistema de estoque da loja. Use sempre antes de confirmar que um produto está disponível.",
    params: { busca: "Nome, código/SKU ou descrição do produto procurado" },
  },
  rastreio: {
    name: "rastrear_pedido",
    description: "Consulta o status de entrega e a localização de uma encomenda na transportadora.",
    params: { codigo: "Código de rastreio ou número do pedido informado pelo cliente" },
  },
  frete: {
    name: "cotar_frete",
    description: "Calcula valor e prazo de frete para um CEP na transportadora.",
    params: { cep: "CEP de destino, só números", produto: "Produto ou SKU (opcional; deixe vazio se não souber)" },
  },
  pedidos: {
    name: "consultar_pedido",
    description: "Consulta dados de um pedido no sistema da loja (status de pagamento, itens, nota fiscal, código de rastreio).",
    params: { numero: "Número do pedido, CPF ou e-mail do cliente" },
  },
};

function buildTools(secrets) {
  const tools = [];
  const enabled = [];
  for (const [key, def] of Object.entries(INTEGRATION_TOOLS)) {
    const integ = secrets.integrations?.[key];
    if (!integ?.enabled || !integ.url) continue;
    const required = Object.keys(def.params).filter((p) => !/opcional/i.test(def.params[p]));
    tools.push({
      name: def.name,
      description: def.description + (integ.instrucoes ? `\nObservação da loja: ${integ.instrucoes}` : ""),
      input_schema: {
        type: "object",
        properties: Object.fromEntries(Object.entries(def.params).map(([k, d]) => [k, { type: "string", description: d }])),
        required,
        additionalProperties: false,
      },
      strict: true,
    });
    enabled.push(def.name);
  }
  tools.push(
    {
      name: "transferir_para_humano",
      description: "Passa a conversa para um atendente humano da loja. Depois de usar, avise o cliente de forma natural que alguém da equipe vai continuar o atendimento.",
      input_schema: { type: "object", properties: { motivo: { type: "string", description: "Resumo curto do motivo e do que o cliente precisa" } }, required: ["motivo"], additionalProperties: false },
      strict: true,
    },
    {
      name: "salvar_nota_cliente",
      description: "Salva um fato útil sobre este cliente para lembrar em conversas futuras (nome, preferências, tamanho, pedido em andamento).",
      input_schema: { type: "object", properties: { nota: { type: "string", description: "Fato curto sobre o cliente" } }, required: ["nota"], additionalProperties: false },
      strict: true,
    }
  );
  return { tools, enabled };
}

async function runTool(name, input, ctx) {
  if (name === "transferir_para_humano") {
    ctx.handoff = input.motivo || "Cliente pediu atendimento humano";
    return "Conversa marcada para atendimento humano. A equipe foi avisada.";
  }
  if (name === "salvar_nota_cliente") {
    if (ctx.botId && ctx.phone) notes.append(ctx.botId, ctx.phone, String(input.nota).slice(0, 300));
    return "Anotado.";
  }
  const key = Object.keys(INTEGRATION_TOOLS).find((k) => INTEGRATION_TOOLS[k].name === name);
  if (!key) return "Ferramenta desconhecida.";
  try {
    const r = await callIntegration(ctx.secrets.integrations[key], input);
    return r.ok ? r.body : `Erro HTTP ${r.status}: ${r.body}`;
  } catch (e) {
    return `Falha ao consultar: ${e.message}`;
  }
}

function nowBR() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Processa as mensagens novas do cliente e devolve as bolhas de resposta.
 * history: histórico da sessão (formato Messages API). Só cresce — nunca editamos turnos antigos.
 */
async function reply({ bot, history, customerTexts, customerName, phone, extraContext, attachments = [] }) {
  const { tools, enabled } = buildTools(bot.secrets);
  const system = buildSystemPrompt(bot.settings, enabled);

  // Contexto variável vai na mensagem do usuário (não no system) para preservar o cache
  let header = `[${nowBR()}]`;
  if (history.length === 0) {
    const memoria = phone ? notes.get(bot.id, phone) : "";
    header += `\n[Contexto interno — não mencione: cliente ${customerName ? `se chama "${customerName}" no WhatsApp` : "sem nome no perfil"}.${memoria ? `\nO que já sabemos deste cliente de conversas anteriores:\n${memoria}` : " Primeira conversa com este cliente."}]`;
  }
  if (extraContext) header += `\n[Contexto interno — não mencione: ${extraContext}]`;
  const text = `${header}\n${customerTexts.join("\n")}`;
  // Fotos e PDFs enviados pelo cliente entram como blocos que o Claude consegue ler
  const blocks = attachments.map((a) =>
    a.mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } }
      : { type: "image", source: { type: "base64", media_type: a.mimeType, data: a.data } }
  );
  const messages = [...history, { role: "user", content: blocks.length ? [...blocks, { type: "text", text }] : text }];

  const ctx = { secrets: bot.secrets, botId: bot.id, phone, handoff: null };
  let finalText = "";

  for (let i = 0; i < 8; i++) {
    const response = await client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      output_config: { effort: "low" }, // conversa: prioriza resposta rápida
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      ctx.handoff = ctx.handoff || "A IA não conseguiu responder esta mensagem";
      finalText = "Deixa eu chamar alguém da equipe pra te ajudar com isso, só um instante";
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason === "tool_use" && toolUses.length) {
      const results = await Promise.all(
        toolUses.map(async (t) => ({ type: "tool_result", tool_use_id: t.id, content: await runTool(t.name, t.input, ctx) }))
      );
      messages.push({ role: "user", content: results });
      continue;
    }

    finalText = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    break;
  }

  const bubbles = finalText
    .split(/\n?\s*\|\|\|\s*\n?/)
    .map((s) => s.trim())
    .filter(Boolean);

  return { bubbles, messages, handoff: ctx.handoff };
}

module.exports = { reply, INTEGRATION_TOOLS };
