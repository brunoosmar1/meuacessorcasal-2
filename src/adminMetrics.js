const { query, queryOne } = require("./db");

async function getMetrics() {
  const totalUsers = Number((await queryOne(`SELECT COUNT(*) as n FROM users`)).n);

  const activeUsers7d = Number(
    (
      await queryOne(
        `SELECT COUNT(DISTINCT user_id) as n FROM messages
         WHERE direction = 'in' AND created_at >= NOW() - INTERVAL '7 days'`
      )
    ).n
  );

  const activeUsers30d = Number(
    (
      await queryOne(
        `SELECT COUNT(DISTINCT user_id) as n FROM messages
         WHERE direction = 'in' AND created_at >= NOW() - INTERVAL '30 days'`
      )
    ).n
  );

  const totalMessages = Number((await queryOne(`SELECT COUNT(*) as n FROM messages WHERE direction = 'in'`)).n);
  const totalTransactions = Number((await queryOne(`SELECT COUNT(*) as n FROM transactions`)).n);

  const volumeThisMonth = await query(
    `SELECT type, COALESCE(SUM(amount),0) as total FROM transactions
     WHERE occurred_at >= to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') GROUP BY type`
  );

  const googleConnections = Number((await queryOne(`SELECT COUNT(*) as n FROM google_tokens`)).n);
  const openFinanceConnections = Number(
    (await queryOne(`SELECT COUNT(DISTINCT user_id) as n FROM open_finance_items WHERE status = 'active'`)).n
  );

  const newestUsers = await query(`SELECT phone, name, created_at FROM users ORDER BY id DESC LIMIT 10`);

  const messagesPerDay = await query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as n FROM messages
     WHERE direction = 'in' AND created_at >= NOW() - INTERVAL '14 days'
     GROUP BY day ORDER BY day ASC`
  );

  return {
    totalUsers,
    activeUsers7d,
    activeUsers30d,
    totalMessages,
    totalTransactions,
    volumeThisMonth,
    googleConnections,
    openFinanceConnections,
    newestUsers,
    messagesPerDay: messagesPerDay.map((d) => ({ day: d.day, n: Number(d.n) })),
  };
}

module.exports = { getMetrics };
