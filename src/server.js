require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const { initDb, getOrCreateUser, run, query, queryOne, getHouseholdMembers, joinHousehold } = require("./db");
const { interpretMessage, interpretImageMessage, transcribeAudio } = require("./parser");
const { executeIntent } = require("./actions");
const whatsapp = require("./whatsapp");
const googleCalendar = require("./googleCalendar");
const openFinance = require("./openFinance");
const scheduler = require("./scheduler");
const auth = require("./auth");
const adminMetrics = require("./adminMetrics");

const app = express();
app.set("trust proxy", 1); // necessário atrás do proxy da Vercel/Railway para cookies "secure" e IP correto no rate limit

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // corpo cru, usado para validar a assinatura do webhook da Meta
    },
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

// Garante que as tabelas existem antes de qualquer rota tocar no banco. Em ambiente
// serverless (Vercel), cada instância "fria" precisa disso; a chamada é idempotente
// e barata (CREATE TABLE IF NOT EXISTS), então não tem problema repetir.
app.use(async (req, res, next) => {
  try {
    await initDb();
    next();
  } catch (err) {
    console.error("Erro ao inicializar o banco:", err);
    res.status(503).json({ error: "Banco de dados indisponível. Verifique a variável DATABASE_URL." });
  }
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const requestCodeLimiter = process.env.PG_MEM_TEST
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Muitos pedidos de código. Aguarde alguns minutos e tente novamente." },
    });

const verifyCodeLimiter = process.env.PG_MEM_TEST
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
    });

function isValidMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  const signature = req.get("x-hub-signature-256");
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function processTextForUser(user, text) {
  await run(`INSERT INTO messages (user_id, direction, content) VALUES ($1, 'in', $2)`, [user.id, text]);
  if (!process.env.ANTHROPIC_API_KEY) {
    return "⚠️ ANTHROPIC_API_KEY não configurada no servidor.";
  }
  const parsed = await interpretMessage(text, todayISO());
  const reply = await executeIntent(user, parsed, todayISO());
  await run(`INSERT INTO messages (user_id, direction, content) VALUES ($1, 'out', $2)`, [user.id, reply]);
  return reply;
}

async function processImageForUser(user, base64Data, mimeType, caption) {
  await run(`INSERT INTO messages (user_id, direction, content) VALUES ($1, 'in', $2)`, [
    user.id,
    caption ? `[imagem] ${caption}` : "[imagem enviada]",
  ]);
  const parsed = await interpretImageMessage(base64Data, mimeType, todayISO(), caption);
  const reply = await executeIntent(user, parsed, todayISO());
  await run(`INSERT INTO messages (user_id, direction, content) VALUES ($1, 'out', $2)`, [user.id, reply]);
  return reply;
}

// Envolve rotas async pra qualquer erro não tratado cair no handler de erro do Express,
// em vez de travar a função serverless sem resposta.
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---------- Health check ----------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    whatsappConfigured: whatsapp.configured(),
  });
});

// ---------- Cron (chamado pelo Vercel Cron, ou por qualquer scheduler externo) ----------

async function handleCronTick(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.get("authorization") || "";
    if (authHeader !== `Bearer ${secret}`) return res.status(401).json({ error: "Não autorizado." });
  }
  const result = await scheduler.runAllChecks();
  res.json({ ok: true, ...result });
}

// A Vercel Cron chama rotas com GET por padrão; aceitamos GET e POST para
// funcionar tanto com o Vercel Cron quanto com um scheduler externo (ex: cron-job.org).
app.get("/api/cron/tick", asyncRoute(handleCronTick));
app.post("/api/cron/tick", asyncRoute(handleCronTick));

// ---------- Login (código de 6 dígitos enviado por WhatsApp) ----------

app.post(
  "/api/auth/request-code",
  requestCodeLimiter,
  asyncRoute(async (req, res) => {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
    const result = await auth.requestLoginCode(phone, name);
    res.json(result);
  })
);

app.post(
  "/api/auth/verify",
  verifyCodeLimiter,
  asyncRoute(async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "phone e code são obrigatórios" });
    const result = await auth.verifyLoginCode(phone, code);
    if (!result.ok) return res.status(401).json({ error: result.error });

    res.cookie("session", result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, user: { name: result.user.name, phone: result.user.phone } });
  })
);

app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    if (req.cookies?.session) await auth.destroySession(req.cookies.session);
    res.clearCookie("session");
    res.json({ ok: true });
  })
);

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ name: req.user.name, phone: req.user.phone, isAdmin: Boolean(req.user.is_admin) });
});

// ---------- Chat e painel do usuário logado ----------

app.post(
  "/api/chat",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text é obrigatório" });
    const reply = await processTextForUser(req.user, text);
    res.json({ reply });
  })
);

app.get(
  "/api/history",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await query(`SELECT direction, content, created_at FROM messages WHERE user_id = $1 ORDER BY id ASC`, [
      req.user.id,
    ]);
    res.json(rows);
  })
);

app.get(
  "/api/summary",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const user = req.user;
    const month = todayISO().slice(0, 7);

    const byCategory = await query(
      `SELECT category, SUM(amount) as total FROM transactions
       WHERE household_id = $1 AND type = 'expense' AND occurred_at LIKE $2
       GROUP BY category ORDER BY total DESC`,
      [user.household_id, `${month}%`]
    );

    const totals = await query(
      `SELECT type, COALESCE(SUM(amount),0) as total FROM transactions
       WHERE household_id = $1 AND occurred_at LIKE $2 GROUP BY type`,
      [user.household_id, `${month}%`]
    );

    const bills = await query(
      `SELECT b.*, u.name as user_name FROM bills b JOIN users u ON u.id = b.user_id
       WHERE b.household_id = $1 AND b.paid = 0 ORDER BY b.due_date ASC`,
      [user.household_id]
    );
    const reminders = await query(`SELECT * FROM reminders WHERE user_id = $1 AND done = 0 ORDER BY remind_at ASC`, [user.id]);
    const budgets = await query(`SELECT * FROM budgets WHERE household_id = $1`, [user.household_id]);
    const googleConnected = await googleCalendar.isConnected(user.id);
    const openFinanceConnected = await openFinance.isConnected(user.id);

    const recentByPerson = await query(
      `SELECT t.amount, t.category, t.type, t.description, t.occurred_at, u.name as user_name, u.phone as user_phone
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.household_id = $1 ORDER BY t.id DESC LIMIT 15`,
      [user.household_id]
    );

    res.json({ byCategory, totals, bills, reminders, budgets, googleConnected, openFinanceConnected, recentByPerson });
  })
);

// ---------- Família (household): convidar e ver membros ----------

app.get(
  "/api/household/me",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const household = await queryOne(`SELECT * FROM households WHERE id = $1`, [req.user.household_id]);
    const members = await getHouseholdMembers(req.user.household_id);
    res.json({
      inviteCode: household.invite_code,
      members: members.map((m) => ({ name: m.name, phone: m.phone, isYou: m.id === req.user.id })),
    });
  })
);

app.post(
  "/api/household/join",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: "Código de convite é obrigatório." });
    const result = await joinHousehold(req.user.id, inviteCode.trim().toUpperCase());
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  })
);

// ---------- Open Finance (Pluggy): conectar conta bancária ----------

app.post(
  "/api/open-finance/connect-token",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    if (!openFinance.configured()) {
      return res.status(400).json({ error: "Open Finance não configurado no servidor (PLUGGY_CLIENT_ID/SECRET ausentes)." });
    }
    const accessToken = await openFinance.createConnectToken(req.user.id);
    res.json({ accessToken });
  })
);

app.post(
  "/api/open-finance/link",
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const { itemId, institution } = req.body;
    await openFinance.saveItem(req.user.id, itemId, institution);
    const imported = await openFinance.syncItemTransactions(itemId, req.user.id);
    res.json({ ok: true, imported });
  })
);

app.post(
  "/webhook/pluggy",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const { event, itemId, clientUserId } = req.body;
    if (event === "transactions/updated" && itemId && clientUserId) {
      await openFinance.syncItemTransactions(itemId, Number(clientUserId));
    }
  })
);

// ---------- Painel administrativo ----------

app.get(
  "/api/admin/metrics",
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    res.json(await adminMetrics.getMetrics());
  })
);

// ---------- Google Agenda: conectar conta ----------

app.get("/auth/google/start", auth.requireAuth, (req, res) => {
  res.redirect(googleCalendar.getAuthUrl(req.user.id));
});

app.get(
  "/auth/google/callback",
  asyncRoute(async (req, res) => {
    const { code, state } = req.query;
    await googleCalendar.handleOAuthCallback(code, Number(state));
    res.send("✅ Google Agenda conectada! Você já pode fechar esta janela e voltar ao chat.");
  })
);

// ---------- Webhook real do WhatsApp (Meta Cloud API) ----------

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post(
  "/webhook/whatsapp",
  asyncRoute(async (req, res) => {
    if (!isValidMetaSignature(req)) {
      console.warn("Webhook do WhatsApp recebido com assinatura inválida — ignorado.");
      return res.sendStatus(403);
    }
    res.sendStatus(200); // responde rápido pra Meta não reenviar o mesmo evento

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const contactName = change.value.contacts?.[0]?.profile?.name;
    const user = await getOrCreateUser(from, contactName);

    if (message.type === "text") {
      const reply = await processTextForUser(user, message.text.body);
      await whatsapp.sendText(from, reply);
    } else if (message.type === "image") {
      const { buffer, mimeType } = await whatsapp.downloadMedia(message.image.id);
      const reply = await processImageForUser(user, buffer.toString("base64"), mimeType, message.image.caption);
      await whatsapp.sendText(from, reply);
    } else if (message.type === "audio") {
      const { buffer, mimeType } = await whatsapp.downloadMedia(message.audio.id);
      const text = await transcribeAudio(buffer, mimeType);
      if (!text) {
        await whatsapp.sendText(
          from,
          "Recebi seu áudio, mas a transcrição de voz ainda não está configurada neste servidor. Pode escrever em texto por enquanto?"
        );
        return;
      }
      const reply = await processTextForUser(user, text);
      await whatsapp.sendText(from, reply);
    } else {
      await whatsapp.sendText(from, "Por enquanto eu entendo texto, foto de boleto/comprovante e áudio.");
    }
  })
);

// Handler de erro genérico — evita que uma função serverless morra sem resposta.
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

// Em ambientes com processo contínuo (Docker, Railway, Render, VPS ou `npm start`
// local), sobe o servidor normalmente e liga o cron interno. Na Vercel, este arquivo
// só exporta o `app` — quem sobe é o runtime serverless (ver api/index.js), e os
// lembretes/contas são disparados pelo Vercel Cron chamando /api/cron/tick.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Meu Assessor (clone) rodando em http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("⚠️  ANTHROPIC_API_KEY não definida. Copie .env.example para .env e preencha.");
    }
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      console.log("⚠️  DATABASE_URL não definida. Configure um Postgres (ex: Neon) antes de usar de verdade.");
    }
    if (!whatsapp.configured()) {
      console.log("ℹ️  WhatsApp Cloud API não configurada — mensagens de saída reais serão apenas logadas (modo simulado).");
    }
    scheduler.start();
  });
}

module.exports = app;
