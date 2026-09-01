const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_PHONE = "5511900000099";

const { initDb, getOrCreateUser } = require("../src/db");
const authModule = require("../src/auth");

test.before(async () => {
  await initDb();
});

test("gera código, verifica e cria sessão válida", async () => {
  const phone = "5511911110001";
  const result = await authModule.requestLoginCode(phone, "Grazi");
  assert.equal(result.sent, true);
  assert.ok(result.devCode, "em modo simulado, o código deve vir na resposta para testes");

  const verify = await authModule.verifyLoginCode(phone, result.devCode);
  assert.equal(verify.ok, true);
  assert.ok(verify.token);

  const user = await authModule.getUserBySession(verify.token);
  assert.equal(user.phone, phone);
});

test("rejeita código incorreto", async () => {
  const phone = "5511911110002";
  await authModule.requestLoginCode(phone, "Léo");
  const verify = await authModule.verifyLoginCode(phone, "000000");
  assert.equal(verify.ok, false);
});

test("rejeita verificação sem código pendente", async () => {
  const verify = await authModule.verifyLoginCode("5511911119999", "123456");
  assert.equal(verify.ok, false);
  assert.match(verify.error, /Nenhum código pendente/);
});

test("usuário com ADMIN_PHONE nasce como admin automaticamente", async () => {
  const user = await getOrCreateUser("5511900000099", "Admin");
  assert.equal(user.is_admin, 1);
});

test("usuário comum não nasce como admin", async () => {
  const user = await getOrCreateUser("5511911110003", "Usuário comum");
  assert.equal(user.is_admin, 0);
});

test("sessão inválida/expirada não retorna usuário", async () => {
  const user = await authModule.getUserBySession("token-que-nao-existe");
  assert.equal(user, null);
});
