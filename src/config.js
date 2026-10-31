const fs = require("node:fs");
const path = require("node:path");

// Carrega .env simples (sem dependência extra)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  appSecret: process.env.APP_SECRET || "dev-secret-change-me",
  mercadoPagoToken: process.env.MERCADOPAGO_ACCESS_TOKEN || "",
  bufferSeconds: Number(process.env.BUFFER_SECONDS || 6),
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  plans: {
    essencial: { name: "Essencial", price: 197, conversations: 1000, description: "1 número de WhatsApp, até 1.000 conversas/mês" },
    profissional: { name: "Profissional", price: 397, conversations: 5000, description: "1 número, até 5.000 conversas/mês, todas as integrações" },
    escala: { name: "Escala", price: 897, conversations: 20000, description: "Até 3 números, 20.000 conversas/mês, suporte prioritário" },
  },
};

if (config.appSecret === "dev-secret-change-me") {
  console.warn("[aviso] APP_SECRET não definido — use um valor aleatório em produção.");
}

module.exports = config;
