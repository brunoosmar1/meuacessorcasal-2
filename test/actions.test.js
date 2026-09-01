// Testes das regras de negócio (sem depender da IA — testamos executeIntent diretamente
// com objetos já "interpretados", que é o formato que o parser.js produziria).
// Roda contra um Postgres em memória (pg-mem) — não precisa de banco real.
// Rodar com: npm test

const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb, getOrCreateUser } = require("../src/db");
const { executeIntent } = require("../src/actions");

test.before(async () => {
  await initDb();
});

test("registra despesa e reflete no relatório mensal", async () => {
  const user = await getOrCreateUser("5511900000001", "Ana");
  const today = "2026-08-15";

  const reply = await executeIntent(
    user,
    { intent: "transaction", type: "expense", amount: 50, category: "alimentação", description: "almoço", occurred_at: today },
    today
  );
  assert.match(reply, /Gasto registrado/);

  const report = await executeIntent(user, { intent: "report", period: "month" }, today);
  assert.match(report, /alimentação/);
  assert.match(report, /R\$\s*50,00/);
});

test("avisa quando o orçamento da categoria é ultrapassado", async () => {
  const user = await getOrCreateUser("5511900000002", "Bruno");
  const today = "2026-08-15";

  await executeIntent(user, { intent: "budget", category: "lazer", monthly_limit: 100 }, today);
  await executeIntent(
    user,
    { intent: "transaction", type: "expense", amount: 60, category: "lazer", description: "cinema", occurred_at: today },
    today
  );
  const reply = await executeIntent(
    user,
    { intent: "transaction", type: "expense", amount: 60, category: "lazer", description: "show", occurred_at: today },
    today
  );
  assert.match(reply, /ultrapassou o orçamento/);
});

test("cria e lista conta a pagar, depois marca como paga", async () => {
  const user = await getOrCreateUser("5511900000003", "Carla");
  const today = "2026-08-15";

  await executeIntent(
    user,
    { intent: "bill", type: "payable", description: "conta de luz", amount: 210, due_date: "2026-09-10" },
    today
  );

  const list1 = await executeIntent(user, { intent: "list_bills" }, today);
  assert.match(list1, /conta de luz/);

  const paidReply = await executeIntent(user, { intent: "mark_bill_paid", description_hint: "luz" }, today);
  assert.match(paidReply, /Marquei/);

  const list2 = await executeIntent(user, { intent: "list_bills" }, today);
  assert.match(list2, /não têm nenhuma conta pendente/i);
});

test("cria lembrete e marca como concluído", async () => {
  const user = await getOrCreateUser("5511900000004", "Duda");
  const today = "2026-08-15";

  await executeIntent(user, { intent: "reminder", title: "ir ao dentista", remind_at: "2026-08-16T15:00" }, today);
  const list1 = await executeIntent(user, { intent: "list_reminders" }, today);
  assert.match(list1, /dentista/);

  const doneReply = await executeIntent(user, { intent: "mark_reminder_done", title_hint: "dentista" }, today);
  assert.match(doneReply, /concluído/);

  const list2 = await executeIntent(user, { intent: "list_reminders" }, today);
  assert.match(list2, /não tem lembretes ativos/i);
});

test("relatório vazio avisa quando não há lançamentos", async () => {
  const user = await getOrCreateUser("5511900000005", "Eva");
  const reply = await executeIntent(user, { intent: "report", period: "month" }, "2026-08-15");
  assert.match(reply, /não encontrei lançamentos/i);
});

test("desfaz o último lançamento", async () => {
  const user = await getOrCreateUser("5511900000006", "Flávio");
  const today = "2026-08-15";

  await executeIntent(
    user,
    { intent: "transaction", type: "expense", amount: 30, category: "transporte", description: "uber", occurred_at: today },
    today
  );
  const undoReply = await executeIntent(user, { intent: "undo_last_transaction" }, today);
  assert.match(undoReply, /removido/);

  const secondUndo = await executeIntent(user, { intent: "undo_last_transaction" }, today);
  assert.match(secondUndo, /Não encontrei/);
});
