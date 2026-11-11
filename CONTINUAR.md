# Notas para continuar o projeto (leia primeiro)

Este arquivo resume tudo o que foi decidido e feito até agora, para um novo chat continuar de onde parou.

## O que é o projeto
**Inteligência ARR**: site (SaaS) que vende uma atendente de WhatsApp com IA (Claude) para lojas.
- O lojista assina pelo site, configura o negócio, o que vende, as dicas para a atendente e as APIs (estoque, transportadora: rastreio e frete, pedidos) e conecta o WhatsApp oficial (Meta Cloud API).
- O objetivo principal é o cliente final não sentir que fala com um robô. Ela espera o cliente terminar de digitar, mostra "digitando…", responde em mensagens curtas e separadas, lembra do cliente, consulta dados reais e passa para um humano quando precisa.
- Regra mantida de propósito: se o cliente perguntar a sério se é um robô ou uma IA, ela diz a verdade.

## Decisões tomadas com o dono do projeto
- **Site, não app.** O painel já funciona no celular. Um PWA (ícone na tela inicial + notificações) é uma melhoria futura opcional.
- **Sem GitHub.** O dono prefere manter o projeto numa pasta no próprio computador.
- Idioma: tudo em português do Brasil.

## Estado atual (tudo funcionando e testado com simuladores)
- Node.js 22.13+, Express, SQLite (`node:sqlite`), SDK `@anthropic-ai/sdk`. Sem framework no front (HTML/CSS/JS puro em `public/`).
- Site: página de vendas, comparação "robô de menu x IA", planos, perguntas frequentes, Termos e Privacidade (modelos: falta preencher razão social/CNPJ e revisão de um advogado).
- Painel: Início (números, uso do plano, primeiros passos, alertas), Assinatura, Meu negócio, Atendente e dicas, Integrações (com botão de teste), WhatsApp, Testar conversa (simulador), Conversas (caixa de entrada, assumir como humano, devolver para a IA, contador e notificação).
- Confiabilidade: ignora mensagens duplicadas da Meta; nova tentativa e plano B se a IA falhar; limite de conversas por plano; lê fotos e PDFs; tokens criptografados; bloqueia acesso à rede interna nas integrações.
- Pagamento: Mercado Pago (Checkout Pro). Sem token configurado, entra em modo de teste e ativa o plano sem cobrar.
- **Ainda não foi testado com a chave real do Claude nem com um número real de WhatsApp.**

## Ponto de atenção: custo x preço dos planos
Estimativa (antes de medir de verdade): uma conversa típica (~6 mensagens do cliente, ~9 chamadas à IA) gasta ~40–70 mil tokens de entrada (a maior parte com desconto de cache) e ~3 mil de saída.
- Claude Opus 5.5 (configurado hoje em `src/config.js`, `CLAUDE_MODEL`): ~R$ 0,45–0,65 por conversa
- Claude Sonnet 5.5: ~R$ 0,22–0,33
- Claude Haiku 5.5: ~R$ 0,02–0,03

Os planos atuais (R$ 197 para 1.000 conversas, R$ 397 para 5.000, R$ 897 para 20.000) **dão prejuízo com o Opus** se o limite for usado inteiro. A escolha do modelo e dos preços é do dono. Antes de decidir, comparar a qualidade dos três modelos com as mesmas conversas.

## Próximos passos sugeridos (em ordem)
1. Ligar a chave do Claude, comparar Opus, Sonnet e Haiku com conversas reais e mostrar o gasto real de tokens por loja no painel. Depois, decidir o modelo e os preços.
2. Reduzir tokens: mandar para a IA só os campos úteis das respostas das APIs e encerrar a sessão mais cedo quando o cliente fica parado.
3. Colocar o site no ar (hospedagem com HTTPS e domínio) e testar com um número real de WhatsApp.
4. PWA para o lojista (ícone e notificações no celular).
5. Transcrever áudios (precisa de um serviço de transcrição à parte).
6. Recuperar senha por e-mail.
7. Cobrança recorrente automática no Mercado Pago.

## Como rodar
```bash
npm install
cp .env.example .env     # preencher ANTHROPIC_API_KEY, APP_SECRET e PUBLIC_URL
npm start                # abre em http://localhost:3000
```
Detalhes de cada parte estão no `README.md`.
