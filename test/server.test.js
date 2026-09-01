// Testes de integração HTTP: batem direto nas rotas do Express (via supertest),
// sem precisar abrir uma porta de verdade. Roda contra Postgres em memória (pg-mem).

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../src/server");

function extractDevCode(res) {
  assert.equal(res.body.sent, true);
  assert.ok(res.body.devCode, "em modo simulado, o código deve vir na resposta");
  return res.body.devCode;
}

async function loginAs(phone, name) {
  const agent = request.agent(app); // mantém cookies entre chamadas, como um navegador
  const r1 = await agent.post("/api/auth/request-code").send({ phone, name });
  assert.equal(r1.status, 200);
  const code = extractDevCode(r1);

  const r2 = await agent.post("/api/auth/verify").send({ phone, code });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.ok, true);
  return agent;
}

test("health check responde OK sem autenticação", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("rotas protegidas exigem sessão válida", async () => {
  const res = await request(app).get("/api/summary");
  assert.equal(res.status, 401);
});

test("fluxo completo de login por código funciona de ponta a ponta", async () => {
  const agent = await loginAs("5511722220001", "Helena");
  const me = await agent.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.name, "Helena");
  assert.equal(me.body.isAdmin, false);
});

test("chat sem ANTHROPIC_API_KEY responde com aviso, mas não quebra", async () => {
  const agent = await loginAs("5511722220002", "Igor");
  const res = await agent.post("/api/chat").send({ text: "oi" });
  assert.equal(res.status, 200);
  assert.match(res.body.reply, /ANTHROPIC_API_KEY/);
});

test("household/me retorna código de convite e membros via HTTP", async () => {
  const agent = await loginAs("5511722220003", "Julia");
  const res = await agent.get("/api/household/me");
  assert.equal(res.status, 200);
  assert.ok(res.body.inviteCode);
  assert.equal(res.body.members.length, 1);
  assert.equal(res.body.members[0].isYou, true);
});

test("dois usuários conectam a família via HTTP e compartilham o resumo", async () => {
  const marido = await loginAs("5511722220004", "Marcos");
  const esposa = await loginAs("5511722220005", "Nina");

  const info = await marido.get("/api/household/me");
  const inviteCode = info.body.inviteCode;

  const joinRes = await esposa.post("/api/household/join").send({ inviteCode });
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.body.ok, true);

  const membersAfter = await marido.get("/api/household/me");
  assert.equal(membersAfter.body.members.length, 2);
});

test("rota de admin retorna 403 para usuário comum", async () => {
  const agent = await loginAs("5511722220006", "Otavio");
  const res = await agent.get("/api/admin/metrics");
  assert.equal(res.status, 403);
});

test("endpoint de cron roda sem quebrar e sem exigir autenticação (sem CRON_SECRET configurado)", async () => {
  const res = await request(app).post("/api/cron/tick");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.reminders, "number");
  assert.equal(typeof res.body.bills, "number");
});

test("endpoint de cron aceita GET também (formato usado pelo Vercel Cron)", async () => {
  const res = await request(app).get("/api/cron/tick");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("webhook do WhatsApp responde 403 quando a verificação do token falha", async () => {
  const res = await request(app).get("/webhook/whatsapp").query({
    "hub.mode": "subscribe",
    "hub.verify_token": "token-errado",
    "hub.challenge": "123",
  });
  assert.equal(res.status, 403);
});
