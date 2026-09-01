# Meu Assessor (clone) — pronto para Vercel

Assistente financeiro + agenda via WhatsApp, no estilo do "Meu Assessor". Suporta
WhatsApp real (Meta Cloud API), Google Agenda, leitura de texto/imagem, contas a
pagar/receber, orçamentos, lembretes com notificação automática, compartilhamento
de gastos entre pessoas (família) e painel web — rodando em Postgres, compatível
com deploy serverless na Vercel.

## Funcionalidades

**Financeiro**
- Registro de gastos e receitas por texto ou foto de boleto/comprovante (IA com visão)
- Categorização automática
- Contas a pagar / a receber, com "já paguei" por linguagem natural
- Comando para desfazer o último lançamento
- Orçamento mensal por categoria com aviso ao estourar
- Resumo financeiro sob pedido (hoje / semana / mês), com quebra por pessoa

**Família (compartilhamento entre pessoas)**
- Cada pessoa loga com seu próprio número de WhatsApp
- Duas (ou mais) pessoas podem unir suas contas com um código de convite —
  gastos, contas e orçamentos passam a ser compartilhados; agenda continua pessoal

**Agenda / rotina**
- Lembretes por linguagem natural, com sincronização automática no Google Agenda
- Aviso automático quando o lembrete chega e quando uma conta está por vencer

**Canal**
- Simulado pelo navegador para testes, ou WhatsApp real via Meta Cloud API

## Passo a passo para começar a usar

### 1. Banco de dados (Postgres)
Este projeto usa Postgres (não SQLite), justamente para funcionar em serverless.
Camada gratuita recomendada: [Neon](https://neon.tech) (mais simples de integrar
com a Vercel) ou [Supabase](https://supabase.com).

1. Crie uma conta na Neon → crie um projeto → copie a "Connection string".
   **Importante para a Vercel:** a Neon oferece duas connection strings — uma
   direta e uma "pooled" (geralmente com `-pooler` no nome do host, via PgBouncer).
   Use a **pooled** como `DATABASE_URL` na Vercel — funções serverless abrem e
   fecham conexões o tempo todo, e a versão direta esgota o limite de conexões
   simultâneas do plano gratuito rapidinho. Localmente (processo único e contínuo),
   qualquer uma das duas funciona bem.
2. Guarde essa string — é o valor de `DATABASE_URL`.

Você não precisa criar tabelas manualmente: o app cria tudo sozinho na primeira
requisição (`CREATE TABLE IF NOT EXISTS`).

### 2. Rodar localmente primeiro (recomendado antes de ir pra Vercel)

```bash
npm install
cp .env.example .env
```

Preencha no `.env`:
- `ANTHROPIC_API_KEY` (console.anthropic.com) — obrigatório
- `DATABASE_URL` (da Neon/Supabase) — obrigatório

```bash
npm start
```

Abra `http://localhost:3000`, faça login (o código aparece na tela em modo
simulado, já que o WhatsApp real ainda não está configurado) e teste o chat/painel.

### 3. Rodar os testes (opcional, mas confirma que está tudo íntegro)

```bash
npm test
```

Os testes rodam contra um Postgres **em memória** (pg-mem) — não tocam no seu
banco real, então pode rodar sem medo mesmo em produção.

## Deploy na Vercel

1. Suba este projeto num repositório do GitHub.
2. Na Vercel, "Add New Project" → importe o repositório. A Vercel detecta o
   `vercel.json` automaticamente (não precisa mudar build settings).
3. Em "Environment Variables", adicione as mesmas variáveis do `.env`
   (pelo menos `ANTHROPIC_API_KEY` e `DATABASE_URL`).
4. **Se estiver usando Vercel Postgres/Neon integrado pela própria Vercel**: ao
   conectar o banco pelo marketplace da Vercel, ela cria automaticamente uma
   variável `POSTGRES_URL` — o código já reconhece essa variável também, não
   precisa duplicar em `DATABASE_URL`.
5. Deploy. Pronto — `https://SEU-PROJETO.vercel.app` já serve o app inteiro
   (painel, login, webhooks) através de uma única função serverless.

### Como isso funciona por baixo dos panos
Todo o Express app roda dentro de `api/index.js`, e o `vercel.json` redireciona
**todas** as rotas pra essa função — inclusive os arquivos estáticos do painel
(`public/index.html`, `public/admin.html`). Isso significa que o comportamento é
idêntico ao de rodar localmente; só muda onde o processo roda.

### ⚠️ Sobre lembretes e avisos de conta na Vercel (importante)
O Vercel Cron no plano **Hobby (grátis) só permite rodar 1x por dia** — não dá
pra verificar lembretes minuto a minuto direto pela Vercel sem pagar o plano Pro.
O `vercel.json` já vem configurado com um cron diário (`/api/cron/tick` às 8h UTC),
que cobre bem o aviso de contas a vencer, mas lembretes com horário exato
("me lembra às 15h") só disparariam 1x por dia nesse modo.

**Para lembretes em tempo real de graça**, use um scheduler externo gratuito
(ex: [cron-job.org](https://cron-job.org)) chamando a cada minuto:
```
POST https://SEU-PROJETO.vercel.app/api/cron/tick
Header: Authorization: Bearer SEU_CRON_SECRET
```
Configure `CRON_SECRET` no `.env`/Vercel com uma string aleatória seguir esse
mesmo valor no scheduler externo. Sem `CRON_SECRET` definido, a rota fica aberta
(ok para testar, não recomendado em produção).

Se preferir não lidar com isso, **Railway, Render ou Fly.io** rodam o
`scheduler.js` como processo contínuo de verdade (lembretes minuto a minuto,
sem downgrade) — o `Dockerfile`/`docker-compose.yml` já estão prontos pra isso.

## Compartilhar gastos entre duas pessoas (ex: casal)

Cada pessoa entra com seu próprio número de WhatsApp/login, mas os dois podem
compartilhar os mesmos gastos, contas a pagar e orçamentos.

1. Cada pessoa faz login normalmente (seu próprio número).
2. No painel → card **Família**, cada um vê seu próprio código de convite.
3. Uma pessoa pega o código da outra e cola no campo "Código de convite" → **Entrar**.
4. Os gastos, contas e orçamentos de ambos passam a aparecer juntos para os dois.
   O histórico de quem entrou por último é migrado automaticamente.

**Compartilhado:** lançamentos, contas a pagar/receber, orçamentos por categoria.
**Pessoal:** lembretes/agenda, conexão Google Calendar, conexão bancária (Open
Finance) — cada um conecta a própria conta, mas as transações importadas entram
na base compartilhada.

## Como ativar o WhatsApp de verdade

1. Crie um app em https://developers.facebook.com/apps → produto **WhatsApp**.
2. Copie `Access Token` → `WHATSAPP_ACCESS_TOKEN`, `Phone number ID` →
   `WHATSAPP_PHONE_NUMBER_ID`.
3. Escolha uma string secreta para `WHATSAPP_VERIFY_TOKEN`.
4. Configure o webhook no painel do app apontando para
   `https://SEU-PROJETO.vercel.app/webhook/whatsapp`, com o mesmo `WHATSAPP_VERIFY_TOKEN`.
5. Inscreva o campo `messages`.
6. (Recomendado) copie o `App Secret` do painel para `WHATSAPP_APP_SECRET` —
   valida que o webhook realmente vem da Meta.

## Como ativar o Google Agenda

1. Projeto em https://console.cloud.google.com/ → ative **Google Calendar API**.
2. Credenciais → OAuth Client ID (tipo "Aplicativo da Web").
3. URI de redirecionamento: `https://SEU-PROJETO.vercel.app/auth/google/callback`.
4. Copie `Client ID`/`Client Secret` para `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
   e ajuste `GOOGLE_REDIRECT_URI` para a URL de produção.
5. No painel, clique em **Conectar Google Agenda**.

## Como ativar Open Finance (conexão bancária automática)

1. Conta em https://dashboard.pluggy.ai → copie `Client ID`/`Client Secret`.
2. Preencha `PLUGGY_CLIENT_ID`/`PLUGGY_CLIENT_SECRET`.
3. No painel, clique em **Conectar conta bancária** (widget oficial da Pluggy).
4. Configure na Pluggy um webhook para `https://SEU-PROJETO.vercel.app/webhook/pluggy`.

## Como ativar transcrição de áudio

O Claude não aceita áudio bruto como entrada. Plugue um provedor de transcrição
(Whisper, Deepgram etc.) em `transcribeAudio()` dentro de `src/parser.js`, e informe
a URL em `TRANSCRIPTION_PROVIDER_URL`.

## Testes automatizados

```bash
npm test
```

17 testes de regras de negócio/login/família + 10 testes de integração HTTP (batendo
direto nas rotas do Express com supertest: login completo, sessão, família via HTTP,
admin, cron) + 5 testes do agendador (lembretes e contas). Tudo roda contra Postgres
em memória (pg-mem) — não precisa de banco real para testar, e roda automaticamente
a cada push via GitHub Actions.

## Segurança

- Webhook do WhatsApp valida assinatura HMAC (`X-Hub-Signature-256`) via `WHATSAPP_APP_SECRET`.
- `/api/cron/tick` pode ser protegida por `CRON_SECRET` (recomendado em produção).
- `/api/auth/request-code` limita a 5 pedidos por IP a cada 15 min; `/api/auth/verify` a 20 tentativas.
- Sessões e códigos de login expirados são limpos automaticamente pelo cron diário.
- Tokens do Google e da Pluggy nunca chegam ao front-end.

## Monitoramento

`GET /health` devolve `{ ok, anthropicConfigured, whatsappConfigured }`.

## Estrutura

```
api/
  index.js            → ponto de entrada serverless da Vercel (reexporta o app do Express)
src/
  db.js                → conexão Postgres, schema, criação/entrada em família
  auth.js              → login por código via WhatsApp, sessões
  adminMetrics.js       → métricas agregadas para o painel administrativo
  parser.js             → IA: interpreta texto e imagens em intenção estruturada
  actions.js             → executa a intenção (grava no banco, calcula orçamento)
  whatsapp.js            → envio de mensagens e download de mídia via Meta Cloud API
  googleCalendar.js       → OAuth2 e criação de eventos no Google Agenda
  openFinance.js          → conexão bancária e importação via Pluggy
  scheduler.js             → lembretes/contas: processo contínuo OU chamado via /api/cron/tick
  server.js                → app Express completo (rotas, webhooks, login)
public/
  index.html               → painel (login + chat simulado + família + integrações)
  admin.html                → painel administrativo
test/
  actions.test.js            → regras de negócio (lançamentos, orçamento, contas, lembretes)
  auth.test.js                → login por código, sessões, promoção a admin
  household.test.js            → compartilhamento de gastos entre pessoas
  scheduler.test.js             → disparo de lembretes e avisos de conta
  server.test.js                 → integração HTTP (rotas reais via supertest)
vercel.json                  → roteamento serverless + configuração do cron diário
Dockerfile / docker-compose.yml → alternativa a Vercel: Railway/Render/VPS
```

## Alternativa: rodar fora da Vercel (Railway, Render, Docker)

O mesmo código funciona como processo contínuo tradicional — nesse caso o
`scheduler.js` roda seu próprio cron interno (lembretes minuto a minuto de verdade,
sem limitação de plano):

```bash
docker compose up -d --build
```

Ou aponte Railway/Render pro repositório com comando de start `npm start` e as
mesmas variáveis de ambiente.

## Próximos passos possíveis

- Fila de mensagens (BullMQ + Redis) para alto volume no webhook.
- Multi-região / cache de conexão Postgres para reduzir cold start na Vercel.
