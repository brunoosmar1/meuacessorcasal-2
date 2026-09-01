const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb, getOrCreateUser, run } = require("../src/db");
const scheduler = require("../src/scheduler");

test.before(async () => {
  await initDb();
});

test("checkReminders dispara lembretes vencidos e marca como notificado", async () => {
  const user = await getOrCreateUser("5511733330001", "Paula");
  const past = new Date(Date.now() - 60_000).toISOString().slice(0, 16); // 1 minuto atrás
  await run(`INSERT INTO reminders (user_id, title, remind_at) VALUES ($1, $2, $3)`, [user.id, "reunião", past]);

  const count = await scheduler.checkReminders();
  assert.ok(count >= 1);

  // Rodar de novo não deve disparar o mesmo lembrete duas vezes
  const countAgain = await scheduler.checkReminders();
  assert.equal(countAgain, 0);
});

test("checkReminders não dispara lembretes no futuro", async () => {
  const user = await getOrCreateUser("5511733330002", "Quintino");
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16); // 1h no futuro
  await run(`INSERT INTO reminders (user_id, title, remind_at) VALUES ($1, $2, $3)`, [user.id, "dentista", future]);

  const before = await scheduler.checkReminders();
  const reminders = await require("../src/db").query(`SELECT * FROM reminders WHERE user_id = $1`, [user.id]);
  assert.equal(reminders[0].notified, 0);
});

test("checkBills avisa contas que vencem hoje ou amanhã, e não repete o aviso", async () => {
  const user = await getOrCreateUser("5511733330003", "Rita");
  const todayISO = new Date().toISOString().slice(0, 10);
  await run(
    `INSERT INTO bills (household_id, user_id, type, description, amount, due_date) VALUES ($1, $2, 'payable', 'aluguel', 1200, $3)`,
    [user.household_id, user.id, todayISO]
  );

  const count = await scheduler.checkBills();
  assert.ok(count >= 1);

  const countAgain = await scheduler.checkBills();
  assert.equal(countAgain, 0);
});

test("checkBills ignora contas com vencimento distante", async () => {
  const user = await getOrCreateUser("5511733330004", "Sergio");
  await run(
    `INSERT INTO bills (household_id, user_id, type, description, amount, due_date) VALUES ($1, $2, 'payable', 'IPTU', 900, '2027-01-01')`,
    [user.household_id, user.id]
  );

  const { query } = require("../src/db");
  await scheduler.checkBills();
  const bills = await query(`SELECT * FROM bills WHERE user_id = $1`, [user.id]);
  assert.equal(bills[0].notified, 0);
});

test("runAllChecks roda tudo junto sem quebrar", async () => {
  const result = await scheduler.runAllChecks();
  assert.equal(typeof result.reminders, "number");
  assert.equal(typeof result.bills, "number");
});
