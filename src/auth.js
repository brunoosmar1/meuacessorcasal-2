const crypto = require("crypto");
const { query, queryOne, run, getOrCreateUser } = require("./db");
const whatsapp = require("./whatsapp");

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

// Gera um código de 6 dígitos e envia por WhatsApp (ou loga no console se o
// WhatsApp real não estiver configurado, útil para testar em desenvolvimento).
async function requestLoginCode(phone, name) {
  await getOrCreateUser(phone, name);
  const code = generateCode();
  const expiresAt = Date.now() + CODE_TTL_MS;

  await run(
    `INSERT INTO login_codes (phone, code, expires_at, attempts) VALUES ($1, $2, $3, 0)
     ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`,
    [phone, code, expiresAt]
  );

  await whatsapp.sendText(phone, `Seu código de acesso ao Meu Assessor é: ${code}\nVale por 10 minutos.`);
  return { sent: true, simulated: !whatsapp.configured(), devCode: whatsapp.configured() ? undefined : code };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await run(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [token, userId, expiresAt]);
  return { token, expiresAt };
}

async function verifyLoginCode(phone, code) {
  const row = await queryOne(`SELECT * FROM login_codes WHERE phone = $1`, [phone]);
  if (!row) return { ok: false, error: "Nenhum código pendente para esse número. Peça um novo." };
  if (Date.now() > Number(row.expires_at)) return { ok: false, error: "Código expirado. Peça um novo." };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "Muitas tentativas erradas. Peça um novo código." };

  if (row.code !== String(code)) {
    await run(`UPDATE login_codes SET attempts = attempts + 1 WHERE phone = $1`, [phone]);
    return { ok: false, error: "Código incorreto." };
  }

  await run(`DELETE FROM login_codes WHERE phone = $1`, [phone]);
  const user = await getOrCreateUser(phone);
  const session = await createSession(user.id);
  return { ok: true, token: session.token, user };
}

async function getUserBySession(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > $2`,
    [token, Date.now()]
  );
  return row || null;
}

async function destroySession(token) {
  await run(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// Middleware Express: exige sessão válida (cookie "session") e injeta req.user.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.session;
    const user = await getUserBySession(token);
    if (!user) return res.status(401).json({ error: "Não autenticado. Faça login novamente." });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware Express: exige sessão válida E que o usuário seja admin.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: "Acesso restrito a administradores." });
    next();
  });
}

module.exports = {
  requestLoginCode,
  verifyLoginCode,
  getUserBySession,
  destroySession,
  requireAuth,
  requireAdmin,
};
