/* ============================================================
   STORE CONTROL — СЕРВЕР ДЛЯ RENDER (ERP + приём заявок + БД)

   Что раздаёт:
   • GET  /            — сама ERP-система (index.html)
   • POST /api/lead    — приём заявки с формы (публично)
   • GET  /api/leads   — выдача заявок в ERP (по секретному токену)
   • POST /api/notify    — уведомление в Telegram владельцу (по токену)
   • GET  /api/telegram/chats — подсказка: показать chat_id (по токену)
   • POST /api/send-mail — реальная отправка письма клиенту (по токену)
   • GET/POST /api/state — облачная копия базы ERP (по токену): данные
     системы живут и на компе владельца, и здесь — побеждает свежий снимок
   • GET  /api/health  — проверка: жив ли сервер и подключена ли БД

   ХРАНЕНИЕ ЗАЯВОК:
   • Если задана переменная окружения DATABASE_URL — заявки пишутся
     в PostgreSQL (таблица site_leads) и переживают любые перезапуски.
   • Если БД нет — запасной режим: файл leads.json (на бесплатном
     Render он обнуляется при перезапуске).

   Настройка на Render:
   • Build Command:  npm install
   • Start Command:  node server.js
   • Environment:
       STORE_TOKEN  = ваш длинный секрет
       DATABASE_URL = Internal Database URL вашей базы PostgreSQL на Render
       TELEGRAM_BOT_TOKEN = токен бота из @BotFather (для /api/notify)
       TELEGRAM_CHAT_IDS  = chat_id получателей через запятую
       SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM = почта (для /api/send-mail)
============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ===== НАСТРОЙКИ ===== */
const PORT = process.env.PORT || 3000;
const STORE_TOKEN = process.env.STORE_TOKEN || 'ПОМЕНЯЙТЕ-МЕНЯ-длинный-случайный-секрет';
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'leads.json');
/* ===================== */

/* ---------- PostgreSQL (если доступна) ---------- */
let Pool = null;
try { Pool = require('pg').Pool; }
catch (e) { console.log('Модуль pg не установлен — работаю в файловом режиме (leads.json)'); }

let pool = null;
const DB_URL = process.env.DATABASE_URL || '';
if (DB_URL && Pool) {
  const needSsl = !(/localhost|127\.0\.0\.1/.test(DB_URL)) && process.env.DATABASE_SSL !== 'false';
  pool = new Pool({ connectionString: DB_URL, ssl: needSsl ? { rejectUnauthorized: false } : false });
}

async function dbInit() {
  if (!pool) return;
  await pool.query(
    'CREATE TABLE IF NOT EXISTS site_leads (' +
    ' id SERIAL PRIMARY KEY,' +
    ' name TEXT NOT NULL,' +
    ' phone TEXT NOT NULL,' +
    ' topic TEXT,' +
    ' item TEXT,' +
    ' comment TEXT,' +
    ' page TEXT,' +
    ' ip TEXT,' +
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS erp_state (' +
    ' id INT PRIMARY KEY CHECK (id=1),' +
    ' saved_at_ms BIGINT NOT NULL,' +
    ' saved_by TEXT,' +
    ' state JSONB NOT NULL,' +
    ' updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS erp_state_history (' +
    ' id SERIAL PRIMARY KEY,' +
    ' saved_at_ms BIGINT NOT NULL,' +
    ' state JSONB NOT NULL,' +
    ' created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  console.log('PostgreSQL подключена — заявки в site_leads, облачная база ERP в erp_state');
}

/* Облачная копия базы ERP (файловый запасной режим, если нет PostgreSQL) */
const STATE_FILE = path.join(process.env.DATA_DIR || __dirname, 'erp-state.json');
async function stateLoad() {
  if (pool) {
    const r = await pool.query('SELECT saved_at_ms, saved_by, state FROM erp_state WHERE id=1');
    if (!r.rows.length) return null;
    return { savedAtMs: Number(r.rows[0].saved_at_ms), savedBy: r.rows[0].saved_by, state: r.rows[0].state };
  }
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
async function stateSave(obj) {
  if (pool) {
    await pool.query(
      'INSERT INTO erp_state (id, saved_at_ms, saved_by, state) VALUES (1,$1,$2,$3) ' +
      'ON CONFLICT (id) DO UPDATE SET saved_at_ms=$1, saved_by=$2, state=$3, updated_at=now()',
      [obj.savedAtMs, obj.savedBy || '', obj.state]
    );
    /* история: снимок не чаще раза в 30 минут, храним последние 20 */
    const h = await pool.query('SELECT created_at FROM erp_state_history ORDER BY id DESC LIMIT 1');
    if (!h.rows.length || (Date.now() - new Date(h.rows[0].created_at).getTime()) > 30 * 60 * 1000) {
      await pool.query('INSERT INTO erp_state_history (saved_at_ms, state) VALUES ($1,$2)', [obj.savedAtMs, obj.state]);
      await pool.query('DELETE FROM erp_state_history WHERE id NOT IN (SELECT id FROM erp_state_history ORDER BY id DESC LIMIT 20)');
    }
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
  }
}

async function dbAddLead(l) {
  const r = await pool.query(
    'INSERT INTO site_leads (name, phone, topic, item, comment, page, ip) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
    [l.name, l.phone, l.topic, l.item, l.comment, l.page, l.ip]
  );
  return { id: r.rows[0].id, at: r.rows[0].created_at };
}

async function dbGetLeads(since) {
  const r = await pool.query(
    'SELECT id, name, phone, topic, item, comment, page, ip, created_at AS at FROM site_leads WHERE id > $1 ORDER BY id',
    [since]
  );
  return r.rows;
}

/* ---------- Запасной режим: файл ---------- */
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { nextId: 1, leads: [] }; }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* ---------- Общее ---------- */
const hits = new Map();
function floodOk(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 5) return false;
  arr.push(now); hits.set(ip, arr);
  return true;
}
const clean = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function sendFile(res, file) {
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}


/* ---------- Telegram-уведомления ---------- */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHATS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function tgSend(text) {
  if (!TG_TOKEN) return { error: 'TELEGRAM_BOT_TOKEN не задан в Environment' };
  if (!TG_CHATS.length) return { error: 'TELEGRAM_CHAT_IDS не задан в Environment' };
  const results = [];
  for (const chat of TG_CHATS) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000) })
      });
      const j = await r.json();
      results.push({ chat, ok: !!j.ok, error: j.ok ? null : (j.description || 'ошибка') });
    } catch (e) { results.push({ chat, ok: false, error: e.message }); }
  }
  return { ok: results.some(x => x.ok), results };
}

/* ---------- Почта (SMTP через nodemailer) ---------- */
let nodemailer = null;
try { nodemailer = require('nodemailer'); }
catch (e) { console.log('Модуль nodemailer не установлен — /api/send-mail будет отвечать ошибкой'); }

function mailTransport() {
  if (!nodemailer) return null;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE !== 'false',   // 465 = SSL (Яндекс/Mail.ru по умолчанию)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function mailSend(to, subject, body, isHtml) {
  const t = mailTransport();
  if (!t) return { error: 'Почта не настроена: нужны SMTP_HOST/SMTP_USER/SMTP_PASS (и nodemailer в package.json)' };
  const msg = {
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: String(to).slice(0, 200),
    subject: String(subject || 'iMagnate').slice(0, 300)
  };
  if (isHtml) msg.html = String(body || ''); else msg.text = String(body || '');
  const info = await t.sendMail(msg);
  return { ok: true, id: info.messageId };
}

function checkToken(req, url) {
  const auth = req.headers.authorization || ('Bearer ' + (url.searchParams.get('token') || ''));
  return auth === 'Bearer ' + STORE_TOKEN;
}
function readBody(req, cb) {
  let raw = '';
  req.on('data', ch => { raw += ch; if (raw.length > 50 * 1024 * 1024) req.destroy(); });
  req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch (e) {} cb(b); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  /* ---- Страницы ---- */
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, 'index.html');
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, db: pool ? 'postgres' : 'file' });

  /* ---- Сайт отправляет заявку (публично) ---- */
  if (req.method === 'POST' && url.pathname === '/api/lead') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if (!floodOk(ip)) return sendJson(res, 429, { error: 'Слишком часто. Попробуйте через минуту.' });

    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 50000) req.destroy(); });
    req.on('end', async () => {
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'Неверный JSON' }); }
      const lead = {
        name: clean(b.name, 80),
        phone: clean(b.phone, 30),
        topic: ['buy', 'tradein', 'repair', 'question'].includes(b.topic) ? b.topic : 'question',
        item: clean(b.item, 90),
        comment: clean(b.comment, 1000),
        page: clean(b.page, 300),
        ip: clean(ip, 60)
      };
      if (!lead.name || !lead.phone) return sendJson(res, 400, { error: 'Нужны имя и телефон' });

      try {
        if (pool) {
          const r = await dbAddLead(lead);
          console.log('[заявка → БД]', r.id, lead.name, lead.phone, lead.topic);
          return sendJson(res, 200, { ok: true, id: r.id });
        }
      } catch (e) {
        console.error('Ошибка БД при записи заявки, пишу в файл:', e.message);
      }
      const db = readDb();
      const rec = Object.assign({ id: db.nextId++, at: new Date().toISOString() }, lead);
      db.leads.push(rec);
      writeDb(db);
      console.log('[заявка → файл]', rec.id, lead.name, lead.phone, lead.topic);
      sendJson(res, 200, { ok: true, id: rec.id });
    });
    return;
  }

  /* ---- ERP забирает новые заявки (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/leads') {
    const auth = req.headers.authorization || ('Bearer ' + (url.searchParams.get('token') || ''));
    if (auth !== 'Bearer ' + STORE_TOKEN) return sendJson(res, 401, { error: 'Неверный токен' });

    const since = parseInt(url.searchParams.get('since')) || 0;
    (async () => {
      try {
        if (pool) return sendJson(res, 200, { leads: await dbGetLeads(since), db: 'postgres' });
      } catch (e) {
        console.error('Ошибка БД при чтении заявок, читаю файл:', e.message);
      }
      const db = readDb();
      sendJson(res, 200, { leads: db.leads.filter(l => l.id > since), db: 'file' });
    })();
    return;
  }

  /* ---- Уведомление в Telegram (из ERP, по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/notify') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      if (!b.text) return sendJson(res, 400, { error: 'Нужен text' });
      const r = await tgSend(b.text);
      console.log('[telegram]', b.text.slice(0, 80), JSON.stringify(r).slice(0, 200));
      sendJson(res, r.ok ? 200 : 500, r);
    });
  }

  /* ---- Подсказка: узнать chat_id (напишите боту что-нибудь и откройте этот адрес) ---- */
  if (req.method === 'GET' && url.pathname === '/api/telegram/chats') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    if (!TG_TOKEN) return sendJson(res, 500, { error: 'TELEGRAM_BOT_TOKEN не задан' });
    (async () => {
      try {
        const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates');
        const j = await r.json();
        const chats = {};
        (j.result || []).forEach(u => {
          const c = u.message && u.message.chat;
          if (c) chats[c.id] = (c.first_name || '') + ' ' + (c.last_name || '') + (c.username ? ' @' + c.username : '');
        });
        sendJson(res, 200, { ok: true, chats, hint: 'Возьмите нужный chat_id и впишите в TELEGRAM_CHAT_IDS на Render' });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Реальная отправка письма клиенту (из ERP, по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/send-mail') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      if (!b.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.to))) return sendJson(res, 400, { error: 'Некорректный адрес получателя' });
      try {
        const r = await mailSend(b.to, b.subject, b.body, b.isHtml);
        console.log('[почта]', b.to, (b.subject || '').slice(0, 60), r.ok ? 'ok' : r.error);
        sendJson(res, r.ok ? 200 : 500, r);
      } catch (e) {
        console.error('[почта] ошибка:', e.message);
        sendJson(res, 500, { error: e.message });
      }
    });
  }

  /* ---- Облачная база ERP: отдать снимок (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        const cur = await stateLoad();
        if (!cur) return sendJson(res, 200, { ok: true, empty: true });
        sendJson(res, 200, { ok: true, savedAtMs: cur.savedAtMs, savedBy: cur.savedBy, state: cur.state });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Облачная база ERP: принять снимок (по токену; старое не затирает новое) ---- */
  if (req.method === 'POST' && url.pathname === '/api/state') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      if (!b.state || !b.savedAtMs) return sendJson(res, 400, { error: 'Нужны state и savedAtMs' });
      try {
        const cur = await stateLoad();
        if (cur && cur.savedAtMs > b.savedAtMs + 2000) {
          return sendJson(res, 409, { error: 'На сервере данные новее', serverSavedAtMs: cur.savedAtMs });
        }
        await stateSave({ savedAtMs: b.savedAtMs, savedBy: String(b.savedBy || '').slice(0, 80), state: b.state });
        sendJson(res, 200, { ok: true, savedAtMs: b.savedAtMs });
      } catch (e) {
        console.error('[облачная база] ошибка:', e.message);
        sendJson(res, 500, { error: e.message });
      }
    });
  }

  sendJson(res, 404, { error: 'Неизвестный запрос' });
});

dbInit()
  .catch(e => { console.error('БД недоступна (' + e.message + ') — работаю в файловом режиме'); pool = null; })
  .then(() => server.listen(PORT, () => {
    console.log('Store Control запущен на порту ' + PORT);
    console.log('ERP: /   Форма: /form   API: /api   Хранение: ' + (pool ? 'PostgreSQL' : 'файл leads.json'));
    if (STORE_TOKEN.indexOf('ПОМЕНЯЙТЕ') !== -1) console.log('!!! Задайте STORE_TOKEN в переменных окружения !!!');
  }));
