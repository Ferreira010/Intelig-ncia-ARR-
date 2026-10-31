// WhatsApp Business Cloud API (oficial da Meta)
const GRAPH = process.env.WHATSAPP_GRAPH_URL || "https://graph.facebook.com/v21.0";

async function graph(secrets, payload) {
  const { whatsappPhoneId, whatsappToken } = secrets;
  if (!whatsappPhoneId || !whatsappToken) throw new Error("WhatsApp não configurado.");
  const res = await fetch(`${GRAPH}/${whatsappPhoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${whatsappToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  return res.json();
}

const sendText = (secrets, to, text) => graph(secrets, { recipient_type: "individual", to, type: "text", text: { preview_url: true, body: text } });

// Marca como lida (dois tiques azuis) e mostra "digitando…"
const markReadAndTyping = (secrets, messageId) =>
  graph(secrets, { status: "read", message_id: messageId, typing_indicator: { type: "text" } }).catch(() => {});

// Extrai mensagens recebidas do payload do webhook
function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        let text = null;
        if (m.type === "text") text = m.text.body;
        else if (m.type === "button") text = m.button.text;
        else if (m.type === "interactive") text = m.interactive.button_reply?.title || m.interactive.list_reply?.title;
        else if (m.type === "location") text = `[Cliente enviou localização: ${m.location.latitude},${m.location.longitude} ${m.location.address || ""}]`;
        else if (["image", "audio", "video", "document", "sticker"].includes(m.type))
          text = `[Cliente enviou ${({ image: "uma imagem", audio: "um áudio", video: "um vídeo", document: "um documento", sticker: "uma figurinha" })[m.type]}${m[m.type]?.caption ? ` com a legenda: "${m[m.type].caption}"` : ""}]`;
        if (text) out.push({ from: m.from, id: m.id, name: names[m.from], text, phoneNumberId: v.metadata?.phone_number_id });
      }
    }
  }
  return out;
}

module.exports = { sendText, markReadAndTyping, parseWebhook };
