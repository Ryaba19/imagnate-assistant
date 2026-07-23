/* ============================================================
   STORE CONTROL — СЕРВЕР ДЛЯ RENDER (ERP + приём заявок + БД)

   Что раздаёт:
   • GET  /            — сама ERP-система (index.html)
   • GET  /form        — страница с формой заявки для клиентов (form.html)
   • POST /api/lead    — приём заявки с формы (публично)
   • GET  /api/leads   — выдача заявок в ERP (по секретному токену)
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
  console.log('PostgreSQL подключена — заявки хранятся в таблице site_leads');
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  /* ---- Страницы ---- */
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, 'index.html');
  if (req.method === 'GET' && (url.pathname === '/form' || url.pathname === '/form.html')) return sendFile(res, 'form.html');
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

  sendJson(res, 404, { error: 'Неизвестный запрос' });
});

dbInit()
  .catch(e => { console.error('БД недоступна (' + e.message + ') — работаю в файловом режиме'); pool = null; })
  .then(() => server.listen(PORT, () => {
    console.log('Store Control запущен на порту ' + PORT);
    console.log('ERP: /   Форма: /form   API: /api   Хранение: ' + (pool ? 'PostgreSQL' : 'файл leads.json'));
    if (STORE_TOKEN.indexOf('ПОМЕНЯЙТЕ') !== -1) console.log('!!! Задайте STORE_TOKEN в переменных окружения !!!');
  }));
