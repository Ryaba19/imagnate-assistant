/* ============================================================
   STORE CONTROL — СЕРВЕР ДЛЯ RENDER (всё в одном)
   Без зависимостей: только встроенные модули Node.js.

   Что раздаёт:
   • GET  /            — сама ERP-система (index.html)
   • GET  /form        — страница с формой заявки для клиентов (form.html)
   • POST /api/lead    — приём заявки с формы (публично)
   • GET  /api/leads   — выдача заявок в ERP (по секретному токену)
   • GET  /api/health  — проверка, что сервер жив

   Настройка на Render:
   • Build Command:  (пусто)
   • Start Command:  node server.js
   • Environment → STORE_TOKEN = ваш длинный секрет

   ВАЖНО: на бесплатном тарифе Render диск не сохраняется между
   перезапусками — leads.json может обнулиться. Это не страшно:
   ERP забирает заявки каждую минуту, поэтому всё, что пришло,
   уже лежит в системе. Для 100% надёжности подключите Render Disk.
============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ===== НАСТРОЙКИ ===== */
const PORT = process.env.PORT || 3000;
const STORE_TOKEN = process.env.STORE_TOKEN || 'ПОМЕНЯЙТЕ-МЕНЯ-длинный-случайный-секрет';
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'leads.json');
/* ===================== */

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { nextId: 1, leads: [] }; }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* Защита от флуда: не больше 5 заявок в минуту с одного IP */
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
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

  /* ---- Сайт отправляет заявку (без токена — форма публичная) ---- */
  if (req.method === 'POST' && url.pathname === '/api/lead') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if (!floodOk(ip)) return sendJson(res, 429, { error: 'Слишком часто. Попробуйте через минуту.' });

    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 50000) req.destroy(); });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'Неверный JSON' }); }
      const name = clean(b.name, 80);
      const phone = clean(b.phone, 30);
      if (!name || !phone) return sendJson(res, 400, { error: 'Нужны имя и телефон' });

      const db = readDb();
      const lead = {
        id: db.nextId++,
        name,
        phone,
        topic: ['buy', 'tradein', 'repair', 'question'].includes(b.topic) ? b.topic : 'question',
        item: clean(b.item, 90),
        comment: clean(b.comment, 1000),
        page: clean(b.page, 300),
        ip: clean(ip, 60),
        at: new Date().toISOString()
      };
      db.leads.push(lead);
      writeDb(db);
      console.log('[заявка]', lead.id, lead.name, lead.phone, lead.topic);
      sendJson(res, 200, { ok: true, id: lead.id });
    });
    return;
  }

  /* ---- ERP забирает новые заявки (только с токеном) ---- */
  if (req.method === 'GET' && url.pathname === '/api/leads') {
    const auth = req.headers.authorization || ('Bearer ' + (url.searchParams.get('token') || ''));
    if (auth !== 'Bearer ' + STORE_TOKEN) return sendJson(res, 401, { error: 'Неверный токен' });

    const since = parseInt(url.searchParams.get('since')) || 0;
    const db = readDb();
    return sendJson(res, 200, { leads: db.leads.filter(l => l.id > since) });
  }

  sendJson(res, 404, { error: 'Неизвестный запрос' });
});

server.listen(PORT, () => {
  console.log('Store Control запущен на порту ' + PORT);
  console.log('ERP: /   Форма: /form   API: /api');
  if (STORE_TOKEN.indexOf('ПОМЕНЯЙТЕ') !== -1) console.log('!!! Задайте STORE_TOKEN в переменных окружения !!!');
});
