const { query, run, cleanupExpired } = require("./db");
const whatsapp = require("./whatsapp");

// Dispara lembretes cujo horário já chegou (id, título, telefone do dono).
async function checkReminders() {
  const now = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const due = await query(
    `SELECT r.*, u.phone FROM reminders r
     JOIN users u ON u.id = r.user_id
     WHERE r.done = 0 AND r.notified = 0 AND r.remind_at <= $1`,
    [now]
  );

  for (const r of due) {
    await whatsapp.sendText(r.phone, `🔔 Lembrete: ${r.title}`);
    await run(`UPDATE reminders SET notified = 1 WHERE id = $1`, [r.id]);
  }
  return due.length;
}

// Avisa sobre contas que vencem hoje ou amanhã.
async function checkBills() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const todayISO = today.toISOString().slice(0, 10);
  const tomorrowISO = tomorrow.toISOString().slice(0, 10);

  const due = await query(
    `SELECT b.*, u.phone FROM bills b
     JOIN users u ON u.id = b.user_id
     WHERE b.paid = 0 AND b.notified = 0 AND b.due_date IN ($1, $2)`,
    [todayISO, tomorrowISO]
  );

  for (const b of due) {
    const when = b.due_date === todayISO ? "vence hoje" : "vence amanhã";
    const label = b.type === "payable" ? "Conta a pagar" : "Conta a receber";
    await whatsapp.sendText(b.phone, `⏰ ${label} ${when}: "${b.description}" — R$ ${Number(b.amount).toFixed(2)}`);
    await run(`UPDATE bills SET notified = 1 WHERE id = $1`, [b.id]);
  }
  return due.length;
}

// Roda tudo de uma vez — usado tanto pelo cron interno (Docker/Railway) quanto
// pelo endpoint /api/cron/tick chamado pelo Vercel Cron.
async function runAllChecks() {
  const reminders = await checkReminders();
  const bills = await checkBills();
  await cleanupExpired();
  return { reminders, bills };
}

// Modo "processo contínuo" (Docker, Railway, Render, VPS): mantém um cron interno
// rodando o tempo todo. NÃO é usado no Vercel — lá quem dispara isso é o
// Vercel Cron chamando /api/cron/tick (ver src/server.js e vercel.json).
function start() {
  const cron = require("node-cron");
  cron.schedule("* * * * *", () => checkReminders().catch((e) => console.error("Erro checkReminders:", e)));
  cron.schedule("0 8 * * *", () => checkBills().catch((e) => console.error("Erro checkBills:", e)));
  cron.schedule("0 4 * * *", () => cleanupExpired().catch((e) => console.error("Erro cleanupExpired:", e)));
  console.log("⏱️  Agendador de lembretes e contas iniciado (modo processo contínuo).");
}

module.exports = { start, checkReminders, checkBills, runAllChecks };
