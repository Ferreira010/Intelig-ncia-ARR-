// Checkout Pro do Mercado Pago (Pix, cartão, boleto)
const config = require("../config");
const API = "https://api.mercadopago.com";

async function mp(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${config.mercadoPagoToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createCheckout(user, planKey) {
  const plan = config.plans[planKey];
  const pref = await mp("/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [{ title: `Inteligência ARR — Plano ${plan.name} (30 dias)`, quantity: 1, unit_price: plan.price, currency_id: "BRL" }],
      payer: { email: user.email, name: user.name },
      external_reference: `${user.id}:${planKey}`,
      back_urls: { success: `${config.publicUrl}/painel.html?pagamento=ok`, failure: `${config.publicUrl}/painel.html?pagamento=falhou`, pending: `${config.publicUrl}/painel.html?pagamento=pendente` },
      auto_return: "approved",
      notification_url: `${config.publicUrl}/api/pagamentos/webhook`,
    }),
  });
  return pref.init_point;
}

// Sempre buscamos o pagamento na API (nunca confiamos no corpo do webhook)
const getPayment = (id) => mp(`/v1/payments/${encodeURIComponent(id)}`);

module.exports = { createCheckout, getPayment };
