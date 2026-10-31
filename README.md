# Inteligência ARR

Plataforma SaaS de **atendimento ao cliente no WhatsApp com uma IA que conversa como gente**.
Os lojistas assinam pelo site, informam o que vendem, dão dicas para a atendente e conectam as APIs de **estoque**, **transportadora** (rastreio e frete) e **pedidos**.

## O que tem

**Site e painel (`public/`)**
- Página de vendas com comparação "robô de menu x IA", planos, perguntas frequentes e chamada final
- Termos de Uso e Política de Privacidade (LGPD), com aceite obrigatório no cadastro. São modelos: revise com um advogado e preencha os dados da empresa
- Cadastro e login
- Assinatura pelo Mercado Pago (Pix, cartão, boleto), ou modo de teste sem cobrança
- Painel do lojista:
  - **Início**: números do mês, uso do plano, passo a passo de configuração e alertas (plano vencendo, limite atingido, clientes esperando a equipe)
  - **Meu negócio**: descrição, produtos e preços, políticas, perguntas frequentes
  - **Atendente e dicas**: nome, jeito de falar, uso de emojis, regras e argumentos de venda
  - **Integrações (APIs)**: estoque, rastreio, frete e pedidos, com botão "Testar API"
  - **WhatsApp**: passo a passo e credenciais da API oficial da Meta
  - **Testar conversa**: simulador para conversar com a atendente antes de ligar no WhatsApp
  - **Conversas**: acompanhe tudo, assuma a conversa como humano e depois devolva para a IA. Atualiza sozinha, mostra um contador no menu e avisa pelo navegador quando um cliente precisa da equipe

**O que faz a conversa parecer humana (`src/ai`, `src/whatsapp`)**
- Espera o cliente terminar de mandar várias mensagens seguidas e responde tudo junto
- Marca como lida e mostra "digitando…" por um tempo proporcional ao tamanho do texto
- Responde em mensagens curtas e separadas, no tom da marca, sem frases de robô
- Consulta estoque, frete e rastreio de verdade antes de responder: não inventa preço nem prazo
- Vê fotos e lê PDFs que o cliente manda (foto de produto, comprovante, nota fiscal). Não confirma pagamento sozinha: a equipe confere
- Lembra do cliente entre conversas (nome, tamanho, pedido em andamento)
- Passa para um humano em caso de reclamação, irritação ou pedido do cliente
- Se o cliente perguntar a sério se está falando com um robô, ela diz a verdade. Isso preserva a confiança e evita problemas com as regras do WhatsApp

**Confiabilidade**
- Mensagens reenviadas pela Meta não geram resposta duplicada
- Se a IA falhar, tenta de novo. Se falhar outra vez, avisa o cliente ("só um instante") e passa a conversa para a equipe
- Limite de conversas por plano: acima da cota, as conversas novas vão para a equipe

A IA usa o **Claude** (Anthropic), modelo `claude-opus-5-5`, com prompt caching e fallback automático.

## Como rodar

Precisa do Node.js 22.13 ou mais novo.

```bash
npm install
cp .env.example .env     # preencha ANTHROPIC_API_KEY, APP_SECRET e PUBLIC_URL
npm start                # http://localhost:3000
```

- Sem `MERCADOPAGO_ACCESS_TOKEN`, o botão "Assinar" ativa o plano na hora (modo de teste).
- O WhatsApp precisa de uma URL pública com HTTPS. Para testar no seu computador, use `ngrok http 3000` e coloque a URL em `PUBLIC_URL`.
- O banco é SQLite, salvo em `data/app.db`. Os tokens do WhatsApp e das APIs ficam criptografados com o `APP_SECRET`.

## Como configurar as integrações

No painel, cada integração recebe a URL, o método, os headers em JSON (onde vai o token) e o corpo, se for POST. Use variáveis entre chaves duplas, e a IA preenche com o que o cliente falou:

| Integração | Variáveis | Exemplo |
|---|---|---|
| Estoque | `{{busca}}` | `GET https://api.seusistema.com.br/produtos?q={{busca}}` |
| Rastreio | `{{codigo}}` | `POST https://melhorenvio.com.br/api/v2/me/shipment/tracking`, corpo `{"orders":["{{codigo}}"]}` |
| Frete | `{{cep}}`, `{{produto}}` | `GET https://api.transportadora.com.br/frete?cep={{cep}}` |
| Pedidos | `{{numero}}` | `GET https://api.seusistema.com.br/pedidos/{{numero}}` |

O campo "Observação para a atendente" explica a resposta da API para a IA, por exemplo: "o campo `saldo` é a quantidade disponível".

## Estrutura

```
src/
  server.js              rotas do site, painel, pagamentos e webhook
  db.js                  SQLite + criptografia dos tokens
  auth.js                login com sessão assinada
  ai/prompt.js           personalidade e regras da atendente
  ai/agent.js            conversa com o Claude + ferramentas (estoque, frete, rastreio, pedidos, humano, memória)
  integrations/http.js   chamador genérico de APIs (bloqueia acesso à rede interna)
  whatsapp/cloud.js      API oficial do WhatsApp (Meta Cloud API)
  whatsapp/handler.js    agrupamento de mensagens, "digitando…", envio em bolhas
  payments/mercadopago.js
public/                  site e painel (HTML/CSS/JS puro)
```

## Próximos passos sugeridos
- Transcrever áudios (muito comuns no WhatsApp). Precisa de um serviço de transcrição à parte
- Recuperação de senha por e-mail
- Cobrança recorrente automática (assinatura do Mercado Pago) e limite de conversas por plano
- Fila persistente (ex.: Redis) para rodar em mais de um servidor
- Conectores prontos para Bling, Tiny, Nuvemshop e Melhor Envio, sem precisar montar a URL
