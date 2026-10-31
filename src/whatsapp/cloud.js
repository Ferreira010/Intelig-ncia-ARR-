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
        let media = null;
        if (["image", "audio", "video", "document", "sticker"].includes(m.type)) {
          const obj = m[m.type] || {};
          const label = ({ image: "uma imagem", audio: "um áudio", video: "um vídeo", document: "um documento", sticker: "uma figurinha" })[m.type];
          text = `[Cliente enviou ${label}${obj.filename ? ` (${obj.filename})` : ""}${obj.caption ? ` com a legenda: "${obj.caption}"` : ""}]`;
          // Imagens e PDFs a IA consegue ler
          if ((m.type === "image" && /^image\/(jpeg|png|webp|gif)$/.test(obj.mime_type || "")) || (m.type === "document" && obj.mime_type === "application/pdf")) {
            media = { id: obj.id, mimeType: obj.mime_type };
          }
        }
        if (text) out.push({ from: m.from, id: m.id, name: names[m.from], text, media, phoneNumberId: v.metadata?.phone_number_id });
      }
    }
  }
  return out;
}

// Baixa uma mídia recebida (imagem/PDF) e devolve em base64. Limite de 5 MB.
const MAX_MEDIA = 5 * 1024 * 1024;
async function downloadMedia(secrets, mediaId) {
  const auth = { Authorization: `Bearer ${secrets.whatsappToken}` };
  const meta = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(15000) });
  if (!meta.ok) throw new Error(`mídia ${meta.status}`);
  const { url, file_size, mime_type } = await meta.json();
  if (file_size > MAX_MEDIA) throw new Error("arquivo grande demais");
  const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error(`download ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_MEDIA) throw new Error("arquivo grande demais");
  return { mimeType: mime_type, data: buf.toString("base64") };
}

module.exports = { sendText, markReadAndTyping, parseWebhook, downloadMedia };
