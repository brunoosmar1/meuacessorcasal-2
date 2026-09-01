const crypto = require("crypto");
const { types } = require("pg");

// BIGINT (usado em expires_at, timestamps em milissegundos) vem do Postgres como
// string por padrão no node-postgres, pra não perder precisão. Como esses valores
// cabem tranquilamente em Number (Date.now() está longe do limite seguro), forçamos
// a conversão pra número — o resto do código já espera number aqui.
types.setTypeParser(20, (val) => parseInt(val, 10));

let Pool;
if (process.env.PG_MEM_TEST) {
  // Modo de teste: banco Postgres em memória (pg-mem), sem precisar de um servidor
  // real. Só é usado pela suíte de testes (nunca em produção).
  const { newDb } = require("pg-mem");
  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  ({ Pool } = memDb.adapters.createPg());
} else {
  ({ Pool } = require("pg"));
}

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString && !process.env.PG_MEM_TEST) {
  console.warn(
    "⚠️  DATABASE_URL não definida — configure um banco Postgres (ex: Neon, Supabase ou Vercel Postgres)."
  );
}

const useSSL = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

// Em ambiente serverless (Vercel), cada invocação pode rodar numa instância isolada
// nova — se o pool abrir muitas conexões por instância, o Postgres (principalmente
// planos gratuitos como o da Neon) estoura o limite de conexões simultâneas rápido.
// Por isso, mantemos o pool bem pequeno e liberamos conexões ociosas rapidamente
// quando detectamos que estamos rodando na Vercel. Em processo contínuo (Docker,
// Railway, `npm start` local) usamos um pool maior, já que a instância é única e
// de longa duração.
const isServerless = Boolean(process.env.VERCEL);
const pool = process.env.PG_MEM_TEST
  ? new Pool()
  : new Pool({
      connectionString,
      ssl: useSSL ? { rejectUnauthorized: false } : false,
      max: isServerless ? 1 : 10,
      idleTimeoutMillis: isServerless ? 5_000 : 30_000,
      connectionTimeoutMillis: 10_000,
    });

// ---------- Helpers de consulta (substituem o estilo síncrono do better-sqlite3) ----------

async function query(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

async function run(text, params = []) {
  const res = await pool.query(text, params);
  return { rowCount: res.rowCount, rows: res.rows };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS households (
  id SERIAL PRIMARY KEY,
  name TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  is_admin INTEGER DEFAULT 0,
  household_id INTEGER REFERENCES households(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('expense','income')),
  amount DOUBLE PRECISION NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  occurred_at TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bills (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('payable','receivable')),
  description TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  due_date TEXT NOT NULL,
  paid INTEGER DEFAULT 0,
  notified INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  category TEXT NOT NULL,
  monthly_limit DOUBLE PRECISION NOT NULL,
  UNIQUE(household_id, category)
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  google_event_id TEXT,
  notified INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  access_token TEXT,
  refresh_token TEXT,
  expiry_date BIGINT
);

CREATE TABLE IF NOT EXISTS open_finance_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,
  institution TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS open_finance_synced_transactions (
  provider_transaction_id TEXT PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_household_date ON transactions(household_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_household_type ON transactions(household_id, type);
CREATE INDEX IF NOT EXISTS idx_bills_household_paid ON bills(household_id, paid);
CREATE INDEX IF NOT EXISTS idx_budgets_household ON budgets(household_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user_done ON reminders(user_id, done);
CREATE INDEX IF NOT EXISTS idx_reminders_notify ON reminders(done, notified, remind_at);
CREATE INDEX IF NOT EXISTS idx_bills_notify ON bills(paid, notified, due_date);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id);
`;

let initPromise = null;

// Cria as tabelas se ainda não existirem. Em ambiente serverless (Vercel), cada
// invocação de função pode ser uma instância "fria" nova, então chamamos isso no
// início de cada request — é rápido e idempotente (CREATE TABLE IF NOT EXISTS).
function initDb() {
  if (!initPromise) {
    initPromise = pool.query(SCHEMA_SQL).catch((err) => {
      initPromise = null; // permite tentar de novo na próxima chamada se falhar
      throw err;
    });
  }
  return initPromise;
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, 8);
}

async function createHousehold(name) {
  let code;
  let exists = true;
  while (exists) {
    code = generateInviteCode();
    exists = await queryOne(`SELECT 1 FROM households WHERE invite_code = $1`, [code]);
  }
  return queryOne(`INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING *`, [name || null, code]);
}

async function getOrCreateUser(phone, name) {
  const existing = await queryOne(`SELECT * FROM users WHERE phone = $1`, [phone]);
  if (existing) return existing;

  const isAdmin = process.env.ADMIN_PHONE && phone === process.env.ADMIN_PHONE ? 1 : 0;
  const household = await createHousehold(name ? `Família de ${name}` : null);

  return queryOne(
    `INSERT INTO users (phone, name, is_admin, household_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [phone, name || null, isAdmin, household.id]
  );
}

function getHouseholdMembers(householdId) {
  return query(`SELECT id, name, phone FROM users WHERE household_id = $1 ORDER BY id ASC`, [householdId]);
}

function getHouseholdByInviteCode(code) {
  return queryOne(`SELECT * FROM households WHERE invite_code = $1`, [code]);
}

// Move o usuário para a família de outra pessoa (usando o código de convite dela)
// e migra o histórico financeiro dele (lançamentos, contas, orçamentos) para lá.
async function joinHousehold(userId, inviteCode) {
  const targetHousehold = await getHouseholdByInviteCode(inviteCode);
  if (!targetHousehold) return { ok: false, error: "Código de convite inválido." };

  const user = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!user) return { ok: false, error: "Usuário não encontrado." };
  if (user.household_id === targetHousehold.id) {
    return { ok: false, error: "Vocês já estão na mesma família." };
  }

  const oldHouseholdId = user.household_id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE transactions SET household_id = $1 WHERE household_id = $2`, [targetHousehold.id, oldHouseholdId]);
    await client.query(`UPDATE bills SET household_id = $1 WHERE household_id = $2`, [targetHousehold.id, oldHouseholdId]);

    const oldBudgets = (await client.query(`SELECT * FROM budgets WHERE household_id = $1`, [oldHouseholdId])).rows;
    for (const b of oldBudgets) {
      const conflict = (
        await client.query(`SELECT 1 FROM budgets WHERE household_id = $1 AND category = $2`, [targetHousehold.id, b.category])
      ).rows[0];
      if (!conflict) {
        await client.query(`UPDATE budgets SET household_id = $1 WHERE id = $2`, [targetHousehold.id, b.id]);
      }
    }
    await client.query(`DELETE FROM budgets WHERE household_id = $1`, [oldHouseholdId]);
    await client.query(`UPDATE users SET household_id = $1 WHERE id = $2`, [targetHousehold.id, userId]);
    await client.query(`DELETE FROM households WHERE id = $1`, [oldHouseholdId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { ok: true, household: targetHousehold };
}

async function cleanupExpired() {
  const now = Date.now();
  await run(`DELETE FROM sessions WHERE expires_at < $1`, [now]);
  await run(`DELETE FROM login_codes WHERE expires_at < $1`, [now]);
}

module.exports = {
  pool,
  query,
  queryOne,
  run,
  initDb,
  getOrCreateUser,
  cleanupExpired,
  getHouseholdMembers,
  getHouseholdByInviteCode,
  joinHousehold,
};
