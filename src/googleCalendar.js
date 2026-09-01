// Integração com Google Agenda via OAuth2.
const { google } = require("googleapis");
const { queryOne, run } = require("./db");

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(userId) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: String(userId),
  });
}

async function handleOAuthCallback(code, userId) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  await run(
    `INSERT INTO google_tokens (user_id, access_token, refresh_token, expiry_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
       expiry_date = excluded.expiry_date`,
    [userId, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null]
  );
  return tokens;
}

async function isConnected(userId) {
  const row = await queryOne(`SELECT 1 FROM google_tokens WHERE user_id = $1`, [userId]);
  return Boolean(row);
}

async function getAuthorizedClient(userId) {
  const row = await queryOne(`SELECT * FROM google_tokens WHERE user_id = $1`, [userId]);
  if (!row) return null;
  const client = getOAuthClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date,
  });
  client.on("tokens", (tokens) => {
    const query = tokens.refresh_token
      ? `UPDATE google_tokens SET access_token = $1, expiry_date = $2, refresh_token = $3 WHERE user_id = $4`
      : `UPDATE google_tokens SET access_token = $1, expiry_date = $2 WHERE user_id = $3`;
    const params = tokens.refresh_token
      ? [tokens.access_token, tokens.expiry_date, tokens.refresh_token, userId]
      : [tokens.access_token, tokens.expiry_date, userId];
    run(query, params).catch((err) => console.error("Erro ao atualizar token do Google:", err.message));
  });
  return client;
}

// Cria um evento no Google Agenda a partir de um lembrete (título + data/hora ISO local).
async function createEvent(userId, title, remindAtISO) {
  const client = await getAuthorizedClient(userId);
  if (!client) return null;

  const calendar = google.calendar({ version: "v3", auth: client });
  const start = new Date(remindAtISO);
  const end = new Date(start.getTime() + 30 * 60000);

  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
  return event.data.id;
}

module.exports = { getAuthUrl, handleOAuthCallback, isConnected, createEvent };
