const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb, getOrCreateUser, joinHousehold, getHouseholdMembers, queryOne } = require("../src/db");
const { executeIntent } = require("../src/actions");

test.before(async () => {
  await initDb();
});

test("dois usuários novos começam em famílias separadas", async () => {
  const alice = await getOrCreateUser("5511800000001", "Alice");
  const bob = await getOrCreateUser("5511800000002", "Bob");
  assert.notEqual(alice.household_id, bob.household_id);
});

test("entrar com código de convite une as famílias e migra o histórico", async () => {
  const carla = await getOrCreateUser("5511800000003", "Carla");
  const davi = await getOrCreateUser("5511800000004", "Davi");

  await executeIntent(
    carla,
    { intent: "transaction", type: "expense", amount: 80, category: "mercado", description: "compras da semana", occurred_at: "2026-08-20" },
    "2026-08-20"
  );

  const carlaHousehold = await queryOne("SELECT * FROM households WHERE id = $1", [carla.household_id]);
  const result = await joinHousehold(davi.id, carlaHousehold.invite_code);
  assert.equal(result.ok, true);

  const davi2 = await getOrCreateUser("5511800000004");
  assert.equal(davi2.household_id, carla.household_id, "Davi deve estar na mesma família de Carla agora");

  const members = await getHouseholdMembers(carla.household_id);
  assert.equal(members.length, 2);
});

test("gasto lançado por um membro aparece no relatório do outro", async () => {
  const eva = await getOrCreateUser("5511800000005", "Eva");
  const felipe = await getOrCreateUser("5511800000006", "Felipe");

  const evaHousehold = await queryOne("SELECT * FROM households WHERE id = $1", [eva.household_id]);
  await joinHousehold(felipe.id, evaHousehold.invite_code);
  const felipe2 = await getOrCreateUser("5511800000006");

  await executeIntent(
    eva,
    { intent: "transaction", type: "expense", amount: 120, category: "lazer", description: "cinema", occurred_at: "2026-08-15" },
    "2026-08-15"
  );
  await executeIntent(
    felipe2,
    { intent: "transaction", type: "expense", amount: 45, category: "transporte", description: "uber", occurred_at: "2026-08-15" },
    "2026-08-15"
  );

  const reportForFelipe = await executeIntent(felipe2, { intent: "report", period: "month" }, "2026-08-15");
  assert.match(reportForFelipe, /lazer/);
  assert.match(reportForFelipe, /transporte/);
  assert.match(reportForFelipe, /Eva/);
  assert.match(reportForFelipe, /Felipe/);

  const reportForEva = await executeIntent(eva, { intent: "report", period: "month" }, "2026-08-15");
  assert.match(reportForEva, /lazer/);
  assert.match(reportForEva, /transporte/);
});

test("orçamento definido por um membro vale para a família inteira", async () => {
  const gustavo = await getOrCreateUser("5511800000007", "Gustavo");
  const helena = await getOrCreateUser("5511800000008", "Helena");
  const gustavoHousehold = await queryOne("SELECT * FROM households WHERE id = $1", [gustavo.household_id]);
  await joinHousehold(helena.id, gustavoHousehold.invite_code);
  const helena2 = await getOrCreateUser("5511800000008");

  await executeIntent(gustavo, { intent: "budget", category: "restaurante", monthly_limit: 200 }, "2026-08-15");
  await executeIntent(
    gustavo,
    { intent: "transaction", type: "expense", amount: 120, category: "restaurante", description: "jantar", occurred_at: "2026-08-15" },
    "2026-08-15"
  );
  const reply = await executeIntent(
    helena2,
    { intent: "transaction", type: "expense", amount: 100, category: "restaurante", description: "almoço", occurred_at: "2026-08-16" },
    "2026-08-16"
  );

  assert.match(reply, /ultrapassou o orçamento/);
});

test("contas a pagar lançadas por um membro aparecem para o outro", async () => {
  const igor = await getOrCreateUser("5511800000009", "Igor");
  const julia = await getOrCreateUser("5511800000010", "Julia");
  const igorHousehold = await queryOne("SELECT * FROM households WHERE id = $1", [igor.household_id]);
  await joinHousehold(julia.id, igorHousehold.invite_code);
  const julia2 = await getOrCreateUser("5511800000010");

  await executeIntent(igor, { intent: "bill", type: "payable", description: "condomínio", amount: 450, due_date: "2026-09-05" }, "2026-08-15");
  const list = await executeIntent(julia2, { intent: "list_bills" }, "2026-08-15");
  assert.match(list, /condomínio/);
  assert.match(list, /Igor/);
});
