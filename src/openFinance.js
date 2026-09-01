// Integração Open Finance via Pluggy (https://pluggy.ai).
const { queryOne, run } = require("./db");

const PLUGGY_BASE = "https://api.pluggy.ai";
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

let cachedApiKey = null;
let cachedApiKeyExpiry = 0;

async function getApiKey() {
  if (cachedApiKey && Date.now() < cachedApiKeyExpiry) return cachedApiKey;
  const res = await fetch(`${PLUGGY_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error("Falha ao autenticar na Pluggy: " + (await res.text()));
  const data = await res.json();
  cachedApiKey = data.apiKey;
  cachedApiKeyExpiry = Date.now() + 100 * 60 * 1000;
  return cachedApiKey;
}

async function createConnectToken(userId) {
  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE}/connect_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ clientUserId: String(userId) }),
  });
  if (!res.ok) throw new Error("Falha ao criar connect token: " + (await res.text()));
  const data = await res.json();
  return data.accessToken;
}

async function saveItem(userId, itemId, institution) {
  await run(`INSERT INTO open_finance_items (user_id, item_id, institution) VALUES ($1, $2, $3)`, [
    userId,
    itemId,
    institution || null,
  ]);
}

async function isConnected(userId) {
  const row = await queryOne(`SELECT 1 FROM open_finance_items WHERE user_id = $1 AND status = 'active'`, [userId]);
  return Boolean(row);
}

// Busca as transações de um item na Pluggy e grava as novas no nosso banco,
// evitando duplicar quando o webhook disparar mais de uma vez para o mesmo item.
async function syncItemTransactions(itemId, userId) {
  const user = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!user) throw new Error("Usuário não encontrado para sincronizar transações.");

  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE}/transactions?accountId=${itemId}&pageSize=200`, {
    headers: { "X-API-KEY": apiKey },
  });
  if (!res.ok) throw new Error("Falha ao buscar transações: " + (await res.text()));
  const data = await res.json();

  let imported = 0;
  for (const tx of data.results || []) {
    const already = await queryOne(`SELECT 1 FROM open_finance_synced_transactions WHERE provider_transaction_id = $1`, [tx.id]);
    if (already) continue;

    const type = tx.amount < 0 ? "expense" : "income";
    const inserted = await queryOne(
      `INSERT INTO transactions (household_id, user_id, type, amount, category, description, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [user.household_id, userId, type, Math.abs(tx.amount), tx.category || "outros", tx.description || "", (tx.date || "").slice(0, 10)]
    );
    await run(`INSERT INTO open_finance_synced_transactions (provider_transaction_id, transaction_id) VALUES ($1, $2)`, [
      tx.id,
      inserted.id,
    ]);
    imported++;
  }
  return imported;
}

module.exports = { configured, createConnectToken, saveItem, isConnected, syncItemTransactions };
