// Chamador genérico de APIs configuradas pelo cliente no painel.
// Cada integração tem: url, método, headers (JSON), corpo (template) — com variáveis {{nome}}.
const dns = require("node:dns/promises");
const net = require("node:net");

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Evita que um cliente use o servidor para acessar a rede interna (SSRF)
async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("A URL precisa começar com http:// ou https://");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("Endereço interno não permitido.");
}

function fill(template, vars, encode) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k] ?? "";
    return encode ? encodeURIComponent(v) : String(v).replace(/["\\]/g, "\\$&");
  });
}

async function callIntegration(integration, vars) {
  if (!integration?.url) throw new Error("Integração não configurada.");
  const url = fill(integration.url, vars, true);
  await assertPublicUrl(url);
  let headers = {};
  if (integration.headers) {
    try { headers = JSON.parse(integration.headers); } catch { throw new Error("Headers da integração não são um JSON válido."); }
  }
  const method = (integration.method || "GET").toUpperCase();
  const init = { method, headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(15000) };
  if (method !== "GET" && integration.body) {
    init.body = fill(integration.body, vars, false);
    if (!Object.keys(init.headers).some((h) => h.toLowerCase() === "content-type")) init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  // Limita o tamanho para não estourar o contexto da IA
  const body = text.length > 8000 ? text.slice(0, 8000) + "\n…(resposta truncada)" : text;
  return { status: res.status, ok: res.ok, body };
}

module.exports = { callIntegration, assertPublicUrl };
