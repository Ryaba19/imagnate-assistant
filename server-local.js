/* ============================================================
   STORE CONTROL — ЛОКАЛЬНЫЙ СЕРВЕР ДАННЫХ (на компьютере владельца)

   Что делает:
   • Раздаёт ERP:            http://localhost:8787
   • Хранит данные системы:  GET/POST /api/state (общие для всех устройств в сети)
   • Бэкапы:                 папка backups/ — автоматически, последние 30
   • Каталог сайта:          GET /api/site-catalog (прокси к admin.imagnate.ru,
                             чтобы браузер не упирался в CORS)
   • Проверка:               GET /api/health

   Как запустить: положить рядом index.html и запустить start.bat
   (нужен установленный Node.js — см. инструкцию).

   Хранение: SQLite-файл data/store-control.db (встроен в Node 22+).
   Если Node старее — запасной режим: файл data/store-control.json.
   Бэкап = просто скопировать папку data/ на флешку.
============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------- Хранилище: SQLite (Node 22+) или JSON-файл ---------- */
let db = null, storage = 'file';
const JSON_FILE = path.join(DATA_DIR, 'store-control.json');
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(path.join(DATA_DIR, 'store-control.db'));
  db.exec('CREATE TABLE IF NOT EXISTS erp_state (id INTEGER PRIMARY KEY CHECK (id=1), saved_at_ms INTEGER, saved_by TEXT, state TEXT)');
  storage = 'sqlite';
} catch (e) {
  console.log('SQLite недоступна (' + e.message + ') — использую JSON-файл. Рекомендуется Node.js 22+.');
}

function loadState() {
  try {
    if (db) {
      const row = db.prepare('SELECT saved_at_ms, saved_by, state FROM erp_state WHERE id=1').get();
      if (!row) return null;
      return { savedAtMs: Number(row.saved_at_ms), savedBy: row.saved_by, state: JSON.parse(row.state) };
    }
    const raw = fs.readFileSync(JSON_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function saveState(obj) {
  if (db) {
    db.prepare('INSERT INTO erp_state (id, saved_at_ms, saved_by, state) VALUES (1,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET saved_at_ms=excluded.saved_at_ms, saved_by=excluded.saved_by, state=excluded.state')
      .run(obj.savedAtMs, obj.savedBy || '', JSON.stringify(obj.state));
  } else {
    const tmp = JSON_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, JSON_FILE);   // атомарная запись: не побьётся при выключении света
  }
}

/* ---------- Бэкапы: не чаще раза в 30 минут, храним последние 30 ---------- */
let lastBackup = 0;
function maybeBackup(obj) {
  const now = Date.now();
  if (now - lastBackup < 30 * 60 * 1000) return;
  lastBackup = now;
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    fs.writeFileSync(path.join(BACKUP_DIR, 'erp-' + stamp + '.json'), JSON.stringify(obj));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('erp-')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { console.error('Бэкап не записался:', e.message); }
}

/* ---------- HTTP ---------- */
function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Положите index.html рядом с server-local.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const cur = loadState();
    return sendJson(res, 200, { ok: true, local: true, storage, savedAtMs: cur ? cur.savedAtMs : null });
  }

  /* Снимок данных: отдать */
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const cur = loadState();
    if (!cur) return sendJson(res, 200, { ok: true, empty: true });
    return sendJson(res, 200, { ok: true, savedAtMs: cur.savedAtMs, savedBy: cur.savedBy, state: cur.state });
  }

  /* Снимок данных: принять (защита от перезаписи новых данных старыми) */
  if (req.method === 'POST' && url.pathname === '/api/state') {
    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 80 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { error: 'Неверный JSON' }); }
      if (!b.state || !b.savedAtMs) return sendJson(res, 400, { error: 'Нужны state и savedAtMs' });
      const cur = loadState();
      if (cur && cur.savedAtMs > b.savedAtMs + 2000) {
        /* на сервере данные НОВЕЕ присланных — не затираем */
        return sendJson(res, 409, { error: 'На сервере данные новее', serverSavedAtMs: cur.savedAtMs });
      }
      const obj = { savedAtMs: b.savedAtMs, savedBy: String(b.savedBy || '').slice(0, 80), state: b.state };
      try { saveState(obj); maybeBackup(obj); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      sendJson(res, 200, { ok: true, savedAtMs: obj.savedAtMs });
    });
    return;
  }

  /* Каталог товаров с сайта магазина — сервер ходит сам, CORS не мешает */
  if (req.method === 'GET' && url.pathname === '/api/site-catalog') {
    (async () => {
      try {
        const r = await fetch('https://admin.imagnate.ru/api/produkties-deep?pagination[pageSize]=2000');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j.data || []);
        console.log('[каталог сайта] получено позиций: ' + arr.length);
        sendJson(res, 200, { ok: true, count: arr.length, items: arr });
      } catch (e) {
        console.error('[каталог сайта] ошибка:', e.message);
        sendJson(res, 502, { error: 'Сайт не ответил: ' + e.message });
      }
    })();
    return;
  }

  sendJson(res, 404, { error: 'Неизвестный запрос' });
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  Object.values(nets).forEach(list => (list || []).forEach(n => { if (n.family === 'IPv4' && !n.internal) ips.push(n.address); }));
  console.log('==============================================');
  console.log(' Store Control — локальный сервер данных');
  console.log(' Хранилище: ' + (storage === 'sqlite' ? 'SQLite (data/store-control.db)' : 'JSON-файл (data/store-control.json)'));
  console.log(' На этом компе:  http://localhost:' + PORT);
  ips.forEach(ip => console.log(' С других устройств сети: http://' + ip + ':' + PORT));
  console.log(' Бэкапы: папка backups/ (каждые 30 минут, последние 30)');
  console.log(' Не закрывайте это окно, пока работаете в системе.');
  console.log('==============================================');
});
