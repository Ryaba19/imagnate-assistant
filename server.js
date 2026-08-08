/* ============================================================
   STORE CONTROL — СЕРВЕР ДЛЯ RENDER (ERP + приём заявок + БД)

   Что раздаёт:
   • GET  /            — сама ERP-система (index.html)
   • POST /api/lead    — приём заявки с формы (публично)
   • GET  /api/leads   — выдача заявок в ERP (по секретному токену)
   • POST /api/notify    — уведомление в Telegram владельцу (по токену)
   • GET  /api/telegram/chats — подсказка: показать chat_id (по токену)
   • POST /api/send-mail — реальная отправка письма клиенту (по токену)
   • GET  /api/lead-test — создать ТЕСТОВУЮ заявку одной ссылкой (по токену):
     проверка всего боевого пути «сайт → база → ERP → Telegram»
   • GET/POST /api/state — облачная копия базы ERP (по токену): данные
     системы живут и на компе владельца, и здесь — побеждает свежий снимок
   • POST /api/channels/poll   — опрос каналов воронки (Авито/TG/ВК/MAX) и
     выдача новых сообщений в ERP (по токену)
   • POST /api/channels/reply  — ответ клиенту в его канал (по токену)
   • GET  /api/channels/status — состояние каналов (по токену)
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
       AVITO_CLIENT_ID, AVITO_CLIENT_SECRET = ключи Авито (avito.ru/professionals/api)
       VK_GROUP_TOKEN = ключ сообщества ВК (права «Сообщения сообщества»)
       MAX_BOT_TOKEN  = токен бота MAX (создаётся у @MasterBot)
       (Telegram-личка использует тот же TELEGRAM_BOT_TOKEN)
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
  await pool.query('CREATE TABLE IF NOT EXISTS channel_kv (k TEXT PRIMARY KEY, v TEXT)');
  try { await pool.query('ALTER TABLE channel_msgs ADD COLUMN IF NOT EXISTS store TEXT'); } catch (e) {}
  await pool.query(
    'CREATE TABLE IF NOT EXISTS channel_msgs (' +
    ' key TEXT PRIMARY KEY,' +
    ' channel TEXT, chat_id TEXT, dir TEXT,' +
    ' name TEXT, contact TEXT, item TEXT, text_ TEXT,' +
    ' ts_ms BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS erp_journal (' +
    ' store TEXT, entity TEXT, jkey TEXT, data JSONB,' +
    ' updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
    ' PRIMARY KEY (store, entity, jkey))'
  );
  console.log('PostgreSQL подключена — заявки в site_leads, облачная база ERP в erp_state, журнал сущностей в erp_journal, каналы в channel_msgs');
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
/* СЛИЯНИЕ-ХРАНИТЕЛЬ (07.08): union записей. primary побеждает при конфликте
   ключей, записи secondary, которых нет в primary, ДОБАВЛЯЮТСЯ (не теряются). */
function mergeUnion(primary, secondary) {
  try {
    if (!primary || !primary.stores) return secondary || primary;
    if (!secondary || !secondary.stores) return primary;
    Object.keys(secondary.stores).forEach(function (sid) {
      var P = primary.stores[sid], S = secondary.stores[sid];
      if (!S) return;
      if (!P) { primary.stores[sid] = S; return; }
      var uni = function (kb, keyf) {
        var arrS = S[kb];
        if (!Array.isArray(arrS) || !arrS.length) return;
        if (!Array.isArray(P[kb])) P[kb] = [];
        var seen = new Set(P[kb].map(function (x) { try { return keyf(x); } catch (e) { return null; } }).filter(Boolean));
        arrS.forEach(function (x) { var k = null; try { k = keyf(x); } catch (e) {} if (k && !seen.has(k)) { P[kb].push(x); seen.add(k); } });
      };
      uni('orders', function (o) { return o && String(o.externalId || ('oid_' + o.id)); });
      uni('customers', function (c) { var p = String((((c || {}).phones) || [])[0] || '').replace(/\D/g, ''); return p.length >= 10 ? ('ph_' + p) : null; });
      uni('purchaseRequests', function (r) { return r && ('pr_' + r.id); });
      uni('service', function (t) { return t && String(t.externalId || ('srv_' + t.id)); });
      uni('leads', function (l) { return l && String(l.chatKey || l.externalId || ('ld_' + l.id)); });
      uni('cashChecks', function (x) { return x && (x.date + '|' + x.time + '|' + String(x.by || '')); });
      uni('salesLog', function (s) { return s && (s.date + '|' + s.time + '|' + String(s.orderId) + '|' + s.sum); });
      uni('cashOps', function (op) { return op && (op.date + '|' + String(op.time || '') + '|' + String(op.type || '') + '|' + op.amount); });
      if (S.warehouse) {
        if (!P.warehouse) P.warehouse = {};
        ['tech', 'tradein'].forEach(function (tab) {
          var arrS = S.warehouse[tab];
          if (!Array.isArray(arrS) || !arrS.length) return;
          if (!Array.isArray(P.warehouse[tab])) P.warehouse[tab] = [];
          var seen = new Set(P.warehouse[tab].map(function (u) { return u && String(u.imei); }).filter(Boolean));
          arrS.forEach(function (u) { if (u && u.imei && !seen.has(String(u.imei))) { P.warehouse[tab].push(u); seen.add(String(u.imei)); } });
        });
        ['accessories', 'parts'].forEach(function (tab) {
          var arrS = S.warehouse[tab];
          if (!Array.isArray(arrS) || !arrS.length) return;
          if (!Array.isArray(P.warehouse[tab])) P.warehouse[tab] = [];
          var seen = new Set(P.warehouse[tab].map(function (u) { return u && String(u.sku || u.model); }).filter(Boolean));
          arrS.forEach(function (u) { var k = u && String(u.sku || u.model); if (k && !seen.has(k)) { P.warehouse[tab].push(u); seen.add(k); } });
        });
      }
    });
    return primary;
  } catch (e) { return primary || secondary; }
}

/* Д3: паспорт боевой базы (когда база помечена боевой). */
let _prodBase = undefined;
async function prodBase() {
  if (_prodBase === undefined) { try { const v = await kvGet('erp_production_base'); _prodBase = v || null; } catch (e) { _prodBase = null; } }
  return _prodBase;
}
/* Д1: раскладка сущностей снимка в несбиваемый пораздельный реестр (upsert по ключу). */
async function journalUpsert(state) {
  if (!pool || !state || !state.stores) return 0;
  const norm = x => String(x == null ? '' : x).replace(/[^0-9]/g, '');
  const rows = [];
  for (const sid of Object.keys(state.stores)) {
    const d = state.stores[sid] || {};
    (d.orders || []).forEach(o => { if (o) rows.push([sid, 'order', String(o.externalId || ('oid_' + o.id)), o]); });
    const wh = d.warehouse || {};
    ['tech', 'tradein', 'accessories', 'parts'].forEach(tab => {
      (wh[tab] || []).forEach(u => {
        const k = (tab === 'tech' || tab === 'tradein') ? (u && u.imei && ('u_' + u.imei)) : (u && (u.sku || u.model) && ('sku_' + (u.sku || u.model)));
        if (k) rows.push([sid, 'unit_' + tab, k, u]);
      });
    });
    (d.cashOps || []).forEach(op => { if (op) rows.push([sid, 'cashop', 'c_' + (op.id != null ? op.id : (op.date + '_' + op.time + '_' + op.amount)), op]); });
    (d.customers || []).forEach(cu => { const p = norm((cu && cu.phones && cu.phones[0]) || ''); if (p.length >= 10) rows.push([sid, 'customer', 'ph_' + p, cu]); });
    (d.service || []).forEach(t => { if (t) rows.push([sid, 'repair', String(t.externalId || ('r_' + t.id)), t]); });
  }
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals = [], params = []; let p = 1;
    chunk.forEach(r => { vals.push('($' + (p++) + ',$' + (p++) + ',$' + (p++) + ',$' + (p++) + ',now())'); params.push(r[0], r[1], r[2], JSON.stringify(r[3])); });
    await pool.query('INSERT INTO erp_journal (store,entity,jkey,data,updated_at) VALUES ' + vals.join(',') +
      ' ON CONFLICT (store,entity,jkey) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', params);
  }
  return rows.length;
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
      try { const n = await journalUpsert(obj.state); if (n) console.log('[журнал] сущностей обновлено: ' + n); } catch (e) { console.error('[журнал]', e.message); }
    }
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
  }
}

/* Тестовая заявка (создана /api/lead-test): телефон 7 900 000-00-00,
   имя «ТЕСТ …», пометка в комментарии. Такие в систему не попадают. */
function isTestLead(l) {
  if (!l) return false;
  const np = String(l.phone || '').replace(/\D/g, '');
  if (np === '79000000000') return true;
  if (/^ТЕСТ(\s|$)/.test(String(l.name || '').trim())) return true;
  if (String(l.comment || '').indexOf('/api/lead-test') >= 0) return true;
  return false;
}
async function purgeTestLeads() {
  try {
    if (pool) {
      const r = await pool.query(
        "DELETE FROM site_leads WHERE regexp_replace(phone, '\\D', '', 'g') = '79000000000'" +
        " OR name LIKE 'ТЕСТ %' OR comment LIKE '%/api/lead-test%'");
      if (r.rowCount) console.log('[уборка] тест-заявки удалены из БД: ' + r.rowCount);
      return r.rowCount || 0;
    }
    const db = readDb();
    const before = db.leads.length;
    db.leads = db.leads.filter(l => !isTestLead(l));
    if (db.leads.length !== before) {
      writeDb(db);
      console.log('[уборка] тест-заявки удалены из файла: ' + (before - db.leads.length));
    }
    return before - db.leads.length;
  } catch (e) { console.error('purgeTestLeads:', e.message); return 0; }
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

async function tgSend(text, extraChats) {
  if (!TG_TOKEN) return { error: 'TELEGRAM_BOT_TOKEN не задан в Environment' };
  /* владелец (env) + адресные получатели (сотрудники на смене) */
  const extra = Array.isArray(extraChats)
    ? extraChats.map(x => String(x).trim()).filter(x => /^-?\d{4,20}$/.test(x)).slice(0, 20)
    : [];
  const chats = [...new Set([...TG_CHATS, ...extra])];
  if (!chats.length) return { error: 'TELEGRAM_CHAT_IDS не задан в Environment' };
  const results = [];
  for (const chat of chats) {
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

/* ---------- Оценки клиентов: звёзды из письма «Как вам покупка?» ----------
   Клиент жмёт звезду в письме → GET /review?o=НОМЕР&s=1..5 → фирменная страница:
   1–2 звезды — «что случилось», 3 — «чего не хватило», 4–5 — кнопка на Яндекс Карты.
   Оценка пишется уже по клику; комментарий — POST /api/review-comment.
   Владельцу уходит Telegram: клик со звёздами и отдельно комментарий. */
const REVIEW_URL_DEFAULT = 'https://yandex.ru/maps/org/imagnate/158587470766/reviews/';
let _reviews = null;                                   /* { 'номер': {s, at, text, textAt} } */
async function reviewsLoad() {
  if (_reviews) return _reviews;
  try { _reviews = JSON.parse((await kvGet('reviews_json')) || '{}') || {}; }
  catch (e) { _reviews = {}; }
  return _reviews;
}
async function reviewsSave() {
  try {
    const keys = Object.keys(_reviews || {});
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete _reviews[k];
    await kvSet('reviews_json', JSON.stringify(_reviews || {}));
  } catch (e) { console.log('reviewsSave:', e.message); }
}
async function reviewPublicUrl() {
  if (process.env.REVIEW_URL) return process.env.REVIEW_URL;
  try { const u = await kvGet('review_url'); if (u) return u; } catch (e) {}
  return REVIEW_URL_DEFAULT;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function reviewPage(o, s, yaUrl) {
  const oo = escHtml(o);
  const stars = '<span class="on">' + '★'.repeat(s) + '</span><span class="off">' + '★'.repeat(5 - s) + '</span>';
  let title, sub, body;
  const form = (ph) =>
    '<textarea id="rvText" maxlength="2000" placeholder="' + ph + '"></textarea>' +
    '<button class="btn" id="rvSend" onclick="rvSubmit()">Отправить</button>' +
    '<div class="note">Ваша оценка уже записана. Комментарий увидит только магазин — не в публичный доступ.</div>';
  if (s <= 2) {
    title = 'Нам жаль, что что-то пошло не так';
    sub = 'Расскажите, что разочаровало — разберёмся и постараемся всё исправить.';
    body = form('Что случилось? Опишите своими словами…');
  } else if (s === 3) {
    title = 'Спасибо за оценку!';
    sub = 'Похоже, всё было неплохо, но не идеально. Подскажите, чего не хватило до пяти звёзд — это лучшее, что вы можете для нас сделать.';
    body = form('Что могло быть лучше? Пара слов…');
  } else {
    title = 'Спасибо! Рады, что вам понравилось';
    sub = 'Если есть минута — поделитесь впечатлением публично. Для магазина это лучшая помощь.';
    body = '<a class="btn" href="' + escHtml(yaUrl) + '">Оставить отзыв на Яндекс Картах</a>' +
      '<a class="btn ghost" href="#" onclick="document.getElementById(\'rvExtra\').style.display=\'block\';this.style.display=\'none\';return false;">Написать пару слов нам напрямую</a>' +
      '<div id="rvExtra" style="display:none;margin-top:14px;">' + form('Пара слов о покупке…') + '</div>' +
      '<div class="note">Ваша оценка уже записана — спасибо!</div>';
  }
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Оценка — IMAGNATE</title><style>' +
    '*{margin:0;padding:0;box-sizing:border-box;}' +
    'body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;padding:34px 14px 44px;}' +
    '.wrap{max-width:520px;margin:0 auto;}' +
    '.logo{text-align:center;font-size:26px;letter-spacing:7px;font-weight:bold;color:#d9c87c;}' +
    '.logo-line{height:2px;width:64%;max-width:280px;background:#d9c87c;margin:10px auto 28px;}' +
    '.stars{text-align:center;font-size:40px;letter-spacing:6px;margin-bottom:6px;}' +
    '.stars .on{color:#d9c87c;}.stars .off{color:#3a3a3a;}' +
    'h1{text-align:center;font-size:22px;margin:10px 0 8px;}' +
    '.sub{text-align:center;color:#c9c9c9;font-size:14.5px;line-height:1.7;margin-bottom:24px;}' +
    '.card{background:#1f1f1f;border-radius:14px;padding:24px;}' +
    'textarea{width:100%;background:#141414;border:1px solid #3a3a3a;border-radius:10px;color:#fff;font-family:Arial;font-size:15px;padding:14px;min-height:110px;resize:vertical;}' +
    'textarea:focus{outline:none;border-color:#d9c87c;}' +
    '.btn{display:block;width:100%;margin-top:16px;background:#d9c87c;color:#000;font-weight:bold;font-size:15px;text-align:center;text-decoration:none;padding:15px;border-radius:10px;border:none;cursor:pointer;font-family:Arial;}' +
    '.btn.ghost{background:transparent;border:1px solid #d9c87c;color:#d9c87c;}' +
    '.note{text-align:center;color:#9a9a9a;font-size:12.5px;margin-top:14px;line-height:1.7;}' +
    '.ono{text-align:center;color:#d9c87c;font-size:13px;font-weight:bold;margin-bottom:18px;}' +
    '.done{text-align:center;font-size:17px;color:#4caf7d;font-weight:bold;padding:18px 0 6px;}' +
    '</style></head><body><div class="wrap">' +
    '<div class="logo">IMAGNATE</div><div class="logo-line"></div>' +
    '<div class="stars">' + stars + '</div>' +
    '<h1>' + title + '</h1>' +
    '<div class="ono">заказ № ' + oo + '</div>' +
    '<div class="sub">' + sub + '</div>' +
    '<div class="card" id="rvCard">' + body + '</div>' +
    '<script>function rvSubmit(){var t=document.getElementById("rvText");var txt=(t&&t.value||"").trim();' +
    'if(!txt){t.focus();return;}var b=document.getElementById("rvSend");if(b){b.disabled=true;b.textContent="Отправляем…";}' +
    'fetch("/api/review-comment",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({o:' + JSON.stringify(String(o)) + ',s:' + s + ',text:txt})})' +
    '.then(function(r){return r.json();}).then(function(j){' +
    'document.getElementById("rvCard").innerHTML=j&&j.ok?\'<div class="done">Спасибо! Мы всё получили.</div>\':\'<div class="note">Не получилось отправить — попробуйте ещё раз или позвоните нам: 8 (993) 277-27-74</div>\';})' +
    '.catch(function(){document.getElementById("rvCard").innerHTML=\'<div class="note">Нет связи — попробуйте позже</div>\';});}</script>' +
    '</div></body></html>';
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

/* ============================================================
   КАНАЛЫ ВОРОНКИ: Авито / Telegram-личка / ВКонтакте / MAX.
   ФРАНШИЗА: ключей может быть несколько комплектов — по магазинам.
   Базовый комплект (переменные без суффикса) принадлежит магазину
   CHANNELS_DEFAULT_STORE (по умолчанию store_lunnaya — Лунная 4).
   Комплект другой точки — те же переменные с суффиксом __id_точки:
     AVITO_CLIENT_ID__store_kashirka, AVITO_CLIENT_SECRET__store_kashirka,
     VK_GROUP_TOKEN__store_kashirka, MAX_BOT_TOKEN__store_kashirka,
     TELEGRAM_BOT_TOKEN__store_kashirka
   Каждое сообщение помечается магазином — ERP кладёт заявку в воронку
   своей точки. Ответ продавца уходит через комплект ключей его точки.
============================================================ */
const DEFAULT_STORE = process.env.CHANNELS_DEFAULT_STORE || 'store_lunnaya';
/* Авито/ВК отдают время в unix-секундах, но на всякий случай приводим:
   значение похоже на миллисекунды -> делим. Плюс лечение испорченного
   курсора: если он "из будущего", сбрасываем и перечитываем заново. */
function toSec(v) { v = Number(v) || 0; return v > 100000000000 ? Math.floor(v / 1000) : v; }
function saneCursor(v) {
  v = toSec(parseInt(v) || 0);
  if (v > Math.floor(Date.now() / 1000) + 86400) return 0;   /* курсор из будущего — сброс */
  return v;
}

/* Собрать комплекты ключей канала: базовый + по точкам (суффикс __store) */
function envSets(names) {
  const sets = [];
  if (names.every(n => process.env[n])) {
    const env = {}; names.forEach(n => env[n] = process.env[n]);
    sets.push({ store: DEFAULT_STORE, key: '', env });
  }
  const suffixes = new Set();
  Object.keys(process.env).forEach(k => {
    if (k.indexOf(names[0] + '__') === 0) suffixes.add(k.slice(names[0].length + 2));
  });
  suffixes.forEach(s => {
    if (names.every(n => process.env[n + '__' + s])) {
      const env = {}; names.forEach(n => env[n] = process.env[n + '__' + s]);
      sets.push({ store: s, key: '__' + s, env });
    }
  });
  return sets;
}
const CH_ENV_NAMES = {
  avito: ['AVITO_CLIENT_ID', 'AVITO_CLIENT_SECRET'],
  telegram: ['TELEGRAM_BOT_TOKEN'],
  vk: ['VK_GROUP_TOKEN'],
  max: ['MAX_BOT_TOKEN'],
  whatsapp: ['WHATSAPP_SEND_URL'],
};

/* --- ключ-значение (курсоры опроса) --- */
const KV_FILE = path.join(process.env.DATA_DIR || __dirname, 'channels-kv.json');
async function kvGet(k) {
  if (pool) {
    const r = await pool.query('SELECT v FROM channel_kv WHERE k=$1', [k]);
    return r.rows.length ? r.rows[0].v : null;
  }
  try { const o = JSON.parse(fs.readFileSync(KV_FILE, 'utf8')); return o[k] == null ? null : o[k]; } catch (e) { return null; }
}
async function kvSet(k, v) {
  if (pool) {
    await pool.query('INSERT INTO channel_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, String(v)]);
    return;
  }
  let o = {}; try { o = JSON.parse(fs.readFileSync(KV_FILE, 'utf8')); } catch (e) {}
  o[k] = String(v);
  try { fs.writeFileSync(KV_FILE, JSON.stringify(o)); } catch (e) {}
}

/* --- авторизованные компьютеры: личный ключ на каждый комп, можно отозвать --- */
let _devices = null;
async function devicesLoad() {
  if (_devices) return _devices;
  try { _devices = JSON.parse((await kvGet('devices_json')) || '[]') || []; }
  catch (e) { _devices = []; }
  return _devices;
}
async function devicesSave() {
  try { await kvSet('devices_json', JSON.stringify((_devices || []).map(d => {
    const c = Object.assign({}, d); delete c._seenDirty; return c;
  }))); } catch (e) {}
}

/* --- хранилище сообщений (PG или файл), дедупликация по key --- */
const CH_FILE = path.join(process.env.DATA_DIR || __dirname, 'channel-msgs.json');
let chFileMsgs = null;
function chFile() {
  if (chFileMsgs) return chFileMsgs;
  try { chFileMsgs = JSON.parse(fs.readFileSync(CH_FILE, 'utf8')); } catch (e) { chFileMsgs = []; }
  return chFileMsgs;
}
async function chStore(m) {   /* true = новое сообщение */
  if (pool) {
    const r = await pool.query(
      'INSERT INTO channel_msgs (key,channel,chat_id,dir,name,contact,item,text_,ts_ms,store) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (key) DO NOTHING',
      [m.key, m.channel, m.chatId, m.dir, m.name || '', m.contact || '', m.item || '', m.text || '', m.tsMs || Date.now(), m.store || DEFAULT_STORE]);
    return r.rowCount > 0;
  }
  const arr = chFile();
  if (arr.some(x => x.key === m.key)) return false;
  arr.push(m);
  if (arr.length > 3000) arr.splice(0, arr.length - 2000);
  try { fs.writeFileSync(CH_FILE, JSON.stringify(arr)); } catch (e) {}
  return true;
}
async function chList(sinceMs, limit) {
  if (pool) {
    const r = await pool.query(
      'SELECT key, channel, chat_id AS "chatId", dir, name, contact, item, text_ AS text, ts_ms AS "tsMs", store FROM channel_msgs WHERE ts_ms > $1 ORDER BY ts_ms LIMIT $2',
      [sinceMs || 0, limit || 500]);
    return r.rows.map(x => Object.assign({}, x, { tsMs: Number(x.tsMs), store: x.store || DEFAULT_STORE }));
  }
  return chFile().filter(x => (x.tsMs || 0) > (sinceMs || 0)).slice(0, limit || 500);
}

/* --- состояние каналов (для вкладки «Интеграции») --- */
const chState = {};
['avito', 'telegram', 'vk', 'max'].forEach(ch => {
  const sets = envSets(CH_ENV_NAMES[ch]);
  chState[ch] = { configured: sets.length > 0, ok: null, error: null, lastPoll: 0, stores: sets.map(s => s.store) };
});
/* токен Strapi сайта хранится на сервере — компам вводить ничего не нужно */
chState.strapiToken = !!process.env.STRAPI_API_TOKEN;

/* --- АВИТО (Messenger API), с комплектом ключей на точку --- */
const avitoAuth = {};   /* set.key -> {tok, exp, uid} */
const avitoChatFails = {};   /* chat.id -> число неудач подряд (недоступные чаты) */
async function avitoToken(set) {
  const a = avitoAuth[set.key] = avitoAuth[set.key] || {};
  if (a.tok && Date.now() < a.exp - 60000) return a.tok;
  const r = await fetch('https://api.avito.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(set.env.AVITO_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(set.env.AVITO_CLIENT_SECRET)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Авито не выдал токен: ' + JSON.stringify(j).slice(0, 150));
  a.tok = j.access_token;
  a.exp = Date.now() + (j.expires_in || 86400) * 1000;
  return a.tok;
}
async function avitoApi(set, p, opts) {
  const t = await avitoToken(set);
  const o = opts || {};
  o.headers = Object.assign({ 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }, o.headers || {});
  const r = await fetch('https://api.avito.ru' + p, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Авито HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 150));
  return j;
}
async function avitoUid(set) {
  const a = avitoAuth[set.key] = avitoAuth[set.key] || {};
  if (a.uid) return a.uid;
  const j = await avitoApi(set, '/core/v1/accounts/self');
  if (!j.id) throw new Error('Авито: не удалось получить id аккаунта');
  a.uid = j.id;
  return a.uid;
}
/* ВАЖНО (починка 29.07): чаты обрабатываем от старых к новым и двигаем
   курсор ТОЛЬКО после успешной обработки чата. Если Авито ответил ошибкой
   (например, лимит запросов) — останавливаемся, курсор не перепрыгивает
   необработанные чаты, и они добираются следующим опросом.
   Плюс перекрытие 15 минут назад + дедупликация по key — ничего не теряется. */
async function avitoPollSet(set, deep) {
  const kvKey = 'avito_cursor' + set.key;
  const saved = saneCursor(await kvGet(kvKey));
  const cur = deep ? 0 : saved;
  const uid = await avitoUid(set);
  const j = await avitoApi(set, '/messenger/v2/accounts/' + uid + '/chats?limit=30');
  const chats = (j.chats || [])
    .filter(c => toSec(c.updated) > Math.max(0, cur - 900))
    .sort((a, b) => toSec(a.updated) - toSec(b.updated));
  let newCursor = saved, added = 0, blocked = false;
  for (const chat of chats) {
    try {
      const mj = await avitoApi(set, '/messenger/v3/accounts/' + uid + '/chats/' + chat.id + '/messages/?limit=30');
      const msgs = Array.isArray(mj) ? mj : (mj.messages || []);
      const other = (chat.users || []).find(u => u.id !== uid) || {};
      const item = (chat.context && chat.context.value && chat.context.value.title) || '';
      for (const m of msgs) {
        /* ответы сотрудников из приложения Авито тоже забираем — dir='out' */
        const dir = (m.author_id === uid) ? 'out' : 'in';
        if ((m.created || 0) * 1000 < Date.now() - 14 * 86400000) continue;   /* глубже 14 дней не тащим */
        const text = (m.content && (m.content.text ||
          (m.content.link && m.content.link.url) ||
          (m.content.location && 'Геолокация') ||
          (m.content.call && 'Звонок'))) ||
          (m.type === 'image' ? '[изображение]' : '');
        if (!text) continue;
        if (await chStore({ key: 'av_' + m.id, store: set.store, channel: 'avito', chatId: String(chat.id), dir,
          name: dir === 'in' ? (other.name || 'Клиент Авито') : '', contact: '', item: String(item).slice(0, 120),
          text: String(text).slice(0, 2000), tsMs: (m.created || 0) * 1000 })) added++;
      }
      try { await avitoApi(set, '/messenger/v1/accounts/' + uid + '/chats/' + chat.id + '/read', { method: 'POST' }); } catch (e) {}
      delete avitoChatFails[chat.id];
      if (!blocked && toSec(chat.updated) > newCursor) newCursor = toSec(chat.updated);
    } catch (e) {
      /* один недоступный чат (заблокированный собеседник и т.п.) НЕ должен
         останавливать очередь: остальные чаты обрабатываем дальше.
         Курсор не двигаем, пока чат "свежий" — добираем его следующими
         опросами; после 3 неудач подряд перестаём его ждать. */
      avitoChatFails[chat.id] = (avitoChatFails[chat.id] || 0) + 1;
      chState.avito.note = 'чат ' + chat.id + ': ' + String(e.message || e).slice(0, 140);
      console.error('[авито' + set.key + '] чат ' + chat.id + ' (попытка ' + avitoChatFails[chat.id] + '):', e.message);
      if (avitoChatFails[chat.id] >= 3) {
        if (!blocked && toSec(chat.updated) > newCursor) newCursor = toSec(chat.updated);
      } else {
        blocked = true;
      }
    }
  }
  if (newCursor > saved) await kvSet(kvKey, newCursor);
  return added;
}
async function avitoSend(set, chatId, text) {
  const uid = await avitoUid(set);
  await avitoApi(set, '/messenger/v1/accounts/' + uid + '/chats/' + chatId + '/messages', {
    method: 'POST',
    body: JSON.stringify({ message: { text: String(text).slice(0, 2000) }, type: 'text' })
  });
  return { ok: true };
}

/* --- TELEGRAM-ЛИЧКА (клиенты пишут боту точки) --- */
async function tgPollSet(set) {
  const tok = set.env.TELEGRAM_BOT_TOKEN;
  const kvKey = 'tg_offset' + set.key;
  const cur = parseInt(await kvGet(kvKey)) || 0;
  const r = await fetch('https://api.telegram.org/bot' + tok + '/getUpdates?timeout=0' + (cur ? ('&offset=' + (cur + 1)) : ''));
  const j = await r.json();
  if (!j.ok) {
    if (/webhook|conflict/i.test(j.description || '')) return 0;   /* работает вебхук — опрос не нужен */
    throw new Error('Telegram: ' + (j.description || 'ошибка'));
  }
  let added = 0, maxU = cur;
  for (const u of (j.result || [])) {
    if (u.update_id > maxU) maxU = u.update_id;
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== 'private') continue;
    const cid = String(m.chat.id);
    if (TG_CHATS.includes(cid)) continue;                   /* владелец и директора — не заявки */
    const text = m.text || m.caption || '';
    if (!text || text.indexOf('/start') === 0) continue;
    const name = (((m.from && m.from.first_name) || '') + ' ' + ((m.from && m.from.last_name) || '')).trim();
    if (await chStore({ key: 'tg' + set.key + '_' + u.update_id, store: set.store, channel: 'telegram', chatId: cid, dir: 'in',
      name: name || 'Клиент Telegram',
      contact: (m.from && m.from.username) ? ('tg: @' + m.from.username) : '',
      item: '', text: String(text).slice(0, 2000), tsMs: (m.date || 0) * 1000 })) added++;
  }
  if (maxU > cur) await kvSet(kvKey, maxU);
  return added;
}
async function tgSendSet(set, chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + set.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) })
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'не отправилось'));
  return { ok: true };
}

/* --- ВКОНТАКТЕ (сообщения сообщества точки) --- */
async function vkApi(set, method, params) {
  const qs = new URLSearchParams(Object.assign({ access_token: set.env.VK_GROUP_TOKEN, v: '5.199' }, params || {}));
  const r = await fetch('https://api.vk.com/method/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs.toString()
  });
  const j = await r.json();
  if (j.error) throw new Error('ВК: ' + (j.error.error_msg || j.error.error_code));
  return j.response;
}
async function vkPollSet(set, deep) {
  const kvKey = 'vk_cursor' + set.key;
  const saved = saneCursor(await kvGet(kvKey));
  const cur = deep ? 0 : saved;
  const resp = await vkApi(set, 'messages.getConversations', { count: 20, filter: 'all' });
  let added = 0, newCursor = saved, blockedVk = false;
  const names = {};
  const needNames = [];
  const items = (resp.items || [])
    .filter(it => ((it.last_message || {}).date || 0) > Math.max(0, cur - 900))
    .sort((a, b) => ((a.last_message || {}).date || 0) - ((b.last_message || {}).date || 0));
  items.forEach(it => {
    const lm = it.last_message || {};
    if (!lm.out && lm.from_id > 0) needNames.push(lm.from_id);
  });
  if (needNames.length) {
    try {
      const us = await vkApi(set, 'users.get', { user_ids: needNames.join(',') });
      (us || []).forEach(u => { names[u.id] = ((u.first_name || '') + ' ' + (u.last_name || '')).trim(); });
    } catch (e) {}
  }
  for (const it of items) {
    const peer = it.conversation && it.conversation.peer && it.conversation.peer.id;
    const lm = it.last_message || {};
    if (!peer) continue;
    try {
      let hist = [];
      try {
        const h = await vkApi(set, 'messages.getHistory', { peer_id: peer, count: 20 });
        hist = (h.items || []).filter(m => (m.date || 0) > Math.max(0, cur - 900));
      } catch (e) { hist = [lm]; }
      for (const m of hist) {
        if ((m.date || 0) * 1000 < Date.now() - 14 * 86400000) continue;
        const mid = m.id || m.conversation_message_id || m.date;
        const dir = m.out ? 'out' : 'in';   /* ответы сотрудников из ВК тоже видны в ERP */
        if (await chStore({ key: 'vk' + set.key + '_' + peer + '_' + mid, store: set.store, channel: 'vk', chatId: String(peer), dir,
          name: dir === 'in' ? (names[m.from_id] || 'Клиент ВКонтакте') : '',
          contact: dir === 'in' ? ('vk.com/id' + (m.from_id || peer)) : '',
          item: '', text: String(m.text || '[вложение]').slice(0, 2000), tsMs: (m.date || 0) * 1000 })) added++;
      }
      if (!blockedVk && (lm.date || 0) > newCursor) newCursor = lm.date;
    } catch (e) {
      console.error('[вк' + set.key + '] диалог ' + peer + ':', e.message);
      blockedVk = true;   /* очередь не останавливаем, курсор не прыгает дальше */
    }
  }
  if (newCursor > saved) await kvSet(kvKey, newCursor);
  return added;
}
async function vkSendSet(set, peerId, text) {
  await vkApi(set, 'messages.send', { peer_id: peerId, message: String(text).slice(0, 4000), random_id: Date.now() % 2000000000 });
  return { ok: true };
}

/* --- MAX (бот точки) --- */
async function maxPollSet(set) {
  const tok = set.env.MAX_BOT_TOKEN;
  const kvKey = 'max_marker' + set.key;
  const cur = await kvGet(kvKey);
  const r = await fetch('https://botapi.max.ru/updates?access_token=' + encodeURIComponent(tok) +
    '&limit=50&types=message_created' + (cur ? ('&marker=' + encodeURIComponent(cur)) : ''));
  const j = await r.json().catch(() => ({}));
  if (j.code || (j.error && !j.updates)) throw new Error('MAX: ' + JSON.stringify(j).slice(0, 150));
  let added = 0;
  for (const u of (j.updates || [])) {
    const m = u.message;
    if (!m) continue;
    const cid = String((m.recipient && m.recipient.chat_id) || '');
    const text = (m.body && m.body.text) || '';
    if (!cid || !text) continue;
    if (await chStore({ key: 'mx' + set.key + '_' + ((m.body && m.body.mid) || (cid + '_' + u.timestamp)), store: set.store, channel: 'max', chatId: cid, dir: 'in',
      name: (m.sender && m.sender.name) || 'Клиент MAX',
      contact: (m.sender && m.sender.username) ? ('max: ' + m.sender.username) : '',
      item: '', text: String(text).slice(0, 2000), tsMs: u.timestamp || Date.now() })) added++;
  }
  if (j.marker != null) await kvSet(kvKey, j.marker);
  return added;
}
async function maxSendSet(set, chatId, text) {
  const r = await fetch('https://botapi.max.ru/messages?access_token=' + encodeURIComponent(set.env.MAX_BOT_TOKEN) + '&chat_id=' + encodeURIComponent(chatId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text).slice(0, 4000) })
  });
  const j = await r.json().catch(() => ({}));
  if (j.code || j.error) throw new Error('MAX: ' + JSON.stringify(j).slice(0, 150));
  return { ok: true };
}

/* --- общий опрос: по каждому комплекту ключей, не чаще раза в 20 сек ---
   deep=true (кнопка «Проверить связь») — без троттлинга и с нулевым
   курсором: перечитывает последние чаты и добирает всё пропущенное
   (дубликатов не будет — дедупликация по key). */
const CH_POLLSET = { avito: avitoPollSet, telegram: (s) => tgPollSet(s), vk: vkPollSet, max: (s) => maxPollSet(s) };
const chLastPoll = {};
async function channelsPollAll(deep) {
  for (const ch of Object.keys(CH_POLLSET)) {
    const sets = envSets(CH_ENV_NAMES[ch]);
    const st = chState[ch];
    st.configured = sets.length > 0;
    st.stores = sets.map(s => s.store);
    if (!sets.length) continue;
    let okAll = true, firstErr = null, polled = false;
    for (const set of sets) {
      const pk = ch + set.key;
      if (!deep && Date.now() - (chLastPoll[pk] || 0) < 20000) continue;
      chLastPoll[pk] = Date.now();
      polled = true;
      try {
        const n = await CH_POLLSET[ch](set, !!deep);
        if (n) console.log('[канал ' + ch + set.key + '] новых сообщений: ' + n);
      } catch (e) {
        okAll = false;
        if (!firstErr) firstErr = (sets.length > 1 ? set.store + ': ' : '') + String(e.message || e).slice(0, 180);
        console.error('[канал ' + ch + set.key + ']', e.message);
      }
    }
    if (polled) {
      st.lastPoll = Date.now();
      st.ok = okAll;
      st.error = okAll ? null : firstErr;
    }
  }
}
/* Отправка ответа в WhatsApp: POST на настраиваемый адрес источника
   (провайдер Wazzup/Radist или мост). Формат минимальный: {to, text}. */
async function waSend(set, chatId, text) {
  const urlSend = set.env.WHATSAPP_SEND_URL;
  if (!urlSend) throw new Error('WHATSAPP_SEND_URL не задан');
  const headers = { 'Content-Type': 'application/json' };
  if (set.env.WHATSAPP_TOKEN) headers['Authorization'] = 'Bearer ' + set.env.WHATSAPP_TOKEN;
  const r = await fetch(urlSend, { method: 'POST', headers, body: JSON.stringify({ to: chatId, text: text }) });
  if (!r.ok) throw new Error('WhatsApp send HTTP ' + r.status);
  return true;
}
const CH_SENDSET = { avito: avitoSend, telegram: tgSendSet, vk: vkSendSet, max: maxSendSet, whatsapp: waSend };

/* ---------- ПОЛНЫЙ ИМПОРТ ПЕРЕПИСКИ АВИТО (фоновая задача) ----------
   Постранично обходит ВСЕ чаты и ВСЮ глубину истории каждого чата,
   складывает в нашу базу (дедупликация по key). Бережно к лимитам:
   пауза между запросами. Прогресс виден в /api/channels/status.
   Без подписки Авито часть чатов ответит 402 — посчитаем в errors. */
let avitoImport = null;
async function avitoImportAll() {
  if (avitoImport && avitoImport.running) return;
  const sets = envSets(CH_ENV_NAMES.avito);
  avitoImport = { running: true, chats: 0, msgs: 0, errors: 0, done: false, note: sets.length ? '' : 'нет ключей' };
  chState.avito.importStatus = avitoImport;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (const set of sets) {
      const uid = await avitoUid(set);
      for (let offset = 0; offset < 2000; offset += 50) {
        const j = await avitoApi(set, '/messenger/v2/accounts/' + uid + '/chats?limit=50&offset=' + offset);
        const chats = j.chats || [];
        if (!chats.length) break;
        for (const chat of chats) {
          avitoImport.chats++;
          const other = (chat.users || []).find(u => u.id !== uid) || {};
          const item = (chat.context && chat.context.value && chat.context.value.title) || '';
          try {
            for (let mo = 0; mo < 5000; mo += 100) {
              const mj = await avitoApi(set, '/messenger/v3/accounts/' + uid + '/chats/' + chat.id + '/messages/?limit=100&offset=' + mo);
              const msgs = Array.isArray(mj) ? mj : (mj.messages || []);
              if (!msgs.length) break;
              for (const m of msgs) {
                const dir = (m.author_id === uid) ? 'out' : 'in';
                const text = (m.content && (m.content.text ||
                  (m.content.link && m.content.link.url) ||
                  (m.content.location && 'Геолокация') ||
                  (m.content.call && 'Звонок'))) || (m.type === 'image' ? '[изображение]' : '');
                if (!text) continue;
                if (await chStore({ key: 'av_' + m.id, store: set.store, channel: 'avito', chatId: String(chat.id), dir,
                  name: dir === 'in' ? (other.name || 'Клиент Авито') : '', contact: '', item: String(item).slice(0, 120),
                  text: String(text).slice(0, 2000), tsMs: (m.created || 0) * 1000 })) avitoImport.msgs++;
              }
              if (msgs.length < 100) break;
              await sleep(350);
            }
          } catch (e) {
            avitoImport.errors++;
            avitoImport.note = String(e.message || e).slice(0, 140);
          }
          await sleep(350);
        }
        if (chats.length < 50) break;
        await sleep(350);
      }
    }
  } catch (e) { avitoImport.note = String(e.message || e).slice(0, 140); }
  avitoImport.running = false;
  avitoImport.done = true;
  console.log('[импорт авито] чатов ' + avitoImport.chats + ', новых сообщений ' + avitoImport.msgs + ', недоступных чатов ' + avitoImport.errors);
}

/* ============================================================
   ВЕБХУКИ: платформы САМИ присылают новые сообщения мгновенно.
   Опрос остаётся страховкой — дедупликация по key исключает дубли.
   Адрес сервера Render определяет сам (RENDER_EXTERNAL_URL).
============================================================ */
const EXT_URL = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://imagnate-assistant.onrender.com').replace(/\/+$/, '');
async function registerWebhooks() {
  /* Авито */
  for (const set of envSets(CH_ENV_NAMES.avito)) {
    try {
      await avitoApi(set, '/messenger/v3/webhook', { method: 'POST', body: JSON.stringify({ url: EXT_URL + '/api/hooks/avito' }) });
      chState.avito.webhook = 'включён';
      console.log('[вебхук авито' + set.key + '] зарегистрирован: ' + EXT_URL + '/api/hooks/avito');
    } catch (e) {
      chState.avito.webhook = 'ошибка: ' + String(e.message || e).slice(0, 120);
      console.error('[вебхук авито' + set.key + ']', e.message);
    }
  }
  /* Telegram */
  for (const set of envSets(CH_ENV_NAMES.telegram)) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + set.env.TELEGRAM_BOT_TOKEN + '/setWebhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: EXT_URL + '/api/hooks/telegram/' + set.env.TELEGRAM_BOT_TOKEN.split(':')[0], allowed_updates: ['message'] })
      });
      const j = await r.json();
      chState.telegram.webhook = j.ok ? 'включён' : ('ошибка: ' + (j.description || '').slice(0, 120));
      console.log('[вебхук telegram' + set.key + ']', j.ok ? 'зарегистрирован' : (j.description || 'ошибка'));
    } catch (e) { chState.telegram.webhook = 'ошибка: ' + String(e.message || e).slice(0, 120); }
  }
  /* MAX */
  for (const set of envSets(CH_ENV_NAMES.max)) {
    try {
      await fetch('https://botapi.max.ru/subscriptions?access_token=' + encodeURIComponent(set.env.MAX_BOT_TOKEN), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: EXT_URL + '/api/hooks/max' })
      });
      chState.max.webhook = 'включён';
      console.log('[вебхук max' + set.key + '] подписка отправлена');
    } catch (e) { chState.max.webhook = 'ошибка: ' + String(e.message || e).slice(0, 120); }
  }
  /* ВК регистрируется вручную в настройках сообщества (Callback API) —
     приёмник /api/hooks/vk готов, строка подтверждения в env VK_CONFIRMATION */
  if (envSets(CH_ENV_NAMES.vk).length) chState.vk.webhook = process.env.VK_CONFIRMATION ? 'приёмник готов' : 'нужен VK_CONFIRMATION';
}
async function channelSend(ch, store, chatId, text) {
  const sets = envSets(CH_ENV_NAMES[ch]);
  if (!sets.length) throw new Error('Ключи канала не заданы на сервере');
  const set = sets.find(s => s.store === store) || sets[0];
  return CH_SENDSET[ch](set, chatId, text);
}

function checkToken(req, url) {
  const auth = req.headers.authorization || ('Bearer ' + (url.searchParams.get('token') || ''));
  if (auth === 'Bearer ' + STORE_TOKEN) return true;
  const t = auth.replace(/^Bearer /, '');
  const d = (_devices || []).find(x => x.token && x.token === t);
  if (d) {
    d.lastSeen = new Date().toISOString();
    if (!d._seenDirty) { d._seenDirty = 1; setTimeout(() => { d._seenDirty = 0; devicesSave(); }, 60000); }
    return true;
  }
  return false;
}
function readBody(req, cb) {
  let raw = '';
  req.on('data', ch => { raw += ch; if (raw.length > 50 * 1024 * 1024) req.destroy(); });
  req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch (e) {} cb(b); });
}

/* ============================================================
   СТОРОЖ НОВЫХ ЗАКАЗОВ/РЕМОНТОВ (24/7, решение владельца 03.08).
   Раньше Telegram слала открытая вкладка ERP — если все компы спали,
   уведомление ждало первого входа (задержки по 20+ минут).
   Теперь сервер раз в 60 сек спрашивает Strapi и шлёт сам.
   Курсоры в kv: последний увиденный id заказа/ремонта.
   Первый запуск — только запоминаем максимум, историю не спамим.
============================================================ */
async function strapiGet(path) {
  const tok = process.env.STRAPI_API_TOKEN || '';
  if (!tok) return null;
  const r = await fetch('https://admin.imagnate.ru' + path, { headers: { 'Authorization': 'Bearer ' + tok } });
  if (!r.ok) return null;
  return r.json();
}
async function staffChatFromState() {
  try {
    const cur = await stateLoad();
    for (const sid of Object.keys((cur && cur.state && cur.state.stores) || {})) {
      const st = (cur.state.stores[sid] || {}).settings || {};
      if (st.tgStaffChat && /^-?\d{4,20}$/.test(String(st.tgStaffChat).trim())) return String(st.tgStaffChat).trim();
    }
  } catch (e) {}
  return null;
}
const RU_M = { 0:'января',1:'февраля',2:'марта',3:'апреля',4:'мая',5:'июня',6:'июля',7:'августа',8:'сентября',9:'октября',10:'ноября',11:'декабря' };
function ruStamp(iso) {
  try { const d = new Date(iso); const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return String(iso || '').slice(0, 16); }
}
let _watchBusy = false;
/* Атомарная отметка «уже отправляли» (29.07-70): при деплое Render короткое
   время живут ДВА экземпляра сервера — оба видели новый заказ и слали дубль.
   INSERT ... ON CONFLICT DO NOTHING в общей Postgres пускает только первого. */
async function kvTryOnce(k) {
  try {
    if (pool) {
      const r = await pool.query('INSERT INTO channel_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING', [k, String(Date.now())]);
      return r.rowCount > 0;
    }
    const db = readDb();
    db.kv = db.kv || {};
    if (db.kv[k]) return false;
    db.kv[k] = String(Date.now());
    writeDb(db);
    return true;
  } catch (e) { return true; }   /* при сбое лучше отправить, чем промолчать */
}
async function purgeWatchLocks() {
  try {
    if (!pool) return;
    const r = await pool.query("DELETE FROM channel_kv WHERE k LIKE 'watch_sent_%' AND v ~ '^[0-9]+$' AND (v)::bigint < $1", [Date.now() - 14 * 86400000]);
    if (r.rowCount) console.log('[уборка] старых отметок сторожа: ' + r.rowCount);
  } catch (e) {}
}
async function orderWatchTick() {
  if (_watchBusy) return;
  if (!process.env.STRAPI_API_TOKEN || !TG_TOKEN || !TG_CHATS.length) return;
  _watchBusy = true;
  try {
    const staff = await staffChatFromState();
    const extra = staff ? [staff] : [];
    /* --- заказы --- */
    try {
      /* 29.07-71: status=draft — в Strapi v5 перепубликация (смена статуса)
         создаёт НОВЫЙ id опубликованной копии, и сторож считал её новым
         заказом. У черновика id стабильный. */
      const j = await strapiGet('/api/zakazies?status=draft&sort[0]=id:desc&pagination[pageSize]=10&populate=*');
      const rows = (j && j.data) || [];
      const norm = rows.map(x => Object.assign({ id: x.id }, x.attributes || x));
      if (norm.length) {
        const maxId = Math.max(...norm.map(x => x.id));
        const seen = parseInt(await kvGet('watch_zakaz_seen'));
        if (!seen) { await kvSet('watch_zakaz_seen', maxId); }
        else if (maxId > seen) {
          const fresh = norm.filter(x => x.id > seen).sort((a, b) => a.id - b.id).slice(0, 10);
          for (const z of fresh) {
            if (!(await kvTryOnce('watch_sent_z_' + (z.documentId || z.id)))) continue;   /* дубль экземпляра или перепубликации */
            const items = (z.items || []).map(it => String(it.name || 'Товар') + (it.count > 1 ? ' × ' + it.count : '')).join('\n· ');
            const sum = String(z.summary || '').replace(/\s/g, '');
            await tgSend('Поступил новый заказ ✅\n' +
              'Номер заказа: №' + (z.identificator || z.id) + '\n' +
              'Клиент: ' + (z.name || 'Без имени') + (z.phone ? '\nТелефон: ' + z.phone : '') +
              (items ? '\nСостав:\n· ' + items : '') +
              (sum && sum !== '0' ? '\nСумма: ' + Number(sum).toLocaleString('ru-RU') + ' ₽' : '') +
              '\nОформлен: ' + ruStamp(z.createdAt), extra);
          }
          await kvSet('watch_zakaz_seen', maxId);
          console.log('[сторож заказов] отправлено уведомлений: ' + fresh.length);
        }
      }
    } catch (e) { console.log('[сторож заказов] ' + e.message); }
    /* --- ремонты --- */
    try {
      const j = await strapiGet('/api/remonts?status=draft&sort[0]=id:desc&pagination[pageSize]=10');
      const rows = (j && j.data) || [];
      const norm = rows.map(x => Object.assign({ id: x.id }, x.attributes || x));
      if (norm.length) {
        const maxId = Math.max(...norm.map(x => x.id));
        const seen = parseInt(await kvGet('watch_remont_seen'));
        if (!seen) { await kvSet('watch_remont_seen', maxId); }
        else if (maxId > seen) {
          const fresh = norm.filter(x => x.id > seen).sort((a, b) => a.id - b.id).slice(0, 10);
          for (const t of fresh) {
            if (!(await kvTryOnce('watch_sent_r_' + (t.documentId || t.id)))) continue;   /* дубль экземпляра или перепубликации */
            await tgSend('Поступила новая заявка на ремонт ✅\n' +
              'Заявка сайта: №' + t.id +
              (t.name ? '\nКлиент: ' + t.name : '') + (t.phone ? '\nТелефон: ' + t.phone : '') +
              (t.device || t.model ? '\nУстройство: ' + (t.device || t.model) : '') +
              '\nОформлена: ' + ruStamp(t.createdAt), extra);
          }
          await kvSet('watch_remont_seen', maxId);
          console.log('[сторож ремонтов] отправлено уведомлений: ' + fresh.length);
        }
      }
    } catch (e) { console.log('[сторож ремонтов] ' + e.message); }
    /* --- заявки-формы сайта (29.07-72): раньше их сторожила только открытая
       вкладка ERP — ночью уведомления молчали. Теперь сервер, 24/7. --- */
    try {
      let leads = [];
      if (pool) {
        const r = await pool.query('SELECT id, name, phone, topic, item, comment, created_at FROM site_leads ORDER BY id DESC LIMIT 10');
        leads = r.rows;
      } else {
        leads = readDb().leads.slice(-10).reverse();
      }
      leads = leads.filter(l => !isTestLead(l));
      if (leads.length) {
        const maxId = Math.max(...leads.map(l => l.id));
        const seen = parseInt(await kvGet('watch_lead_seen'));
        if (!seen) { await kvSet('watch_lead_seen', maxId); }
        else if (maxId > seen) {
          const fresh = leads.filter(l => l.id > seen).sort((a, b) => a.id - b.id).slice(0, 10);
          const topics = { buy: 'Покупка', tradein: 'Trade-in', repair: 'Ремонт', question: 'Вопрос' };
          for (const l of fresh) {
            if (!(await kvTryOnce('watch_sent_l_' + l.id))) continue;
            await tgSend('📝 Новая заявка с сайта ✅\n' +
              'Тема: ' + (topics[l.topic] || l.topic || 'Не указана') + '\n' +
              'Клиент: ' + (l.name || 'Без имени') + (l.phone ? '\nТелефон: ' + l.phone : '') +
              (l.item ? '\nИнтересует: ' + l.item : '') +
              (l.comment ? '\nКомментарий: ' + String(l.comment).slice(0, 200) : '') +
              (l.created_at ? '\nОформлена: ' + ruStamp(l.created_at) : ''), extra);
          }
          await kvSet('watch_lead_seen', maxId);
          console.log('[сторож заявок] отправлено уведомлений: ' + fresh.length);
        }
      }
    } catch (e) { console.log('[сторож заявок] ' + e.message); }
  } finally { _watchBusy = false; }
}
setInterval(() => { orderWatchTick().catch(e => console.log('orderWatch:', e.message)); }, 60000);
/* СТОРОЖ-БУДИЛЬНИК (08.08): внешний самозапрос каждые 10 минут — Render видит
   входящий трафик и не усыпляет сервис. Без него бесплатный тариф засыпал
   через 15 минут тишины, и первое открытие ERP утром попадало на холодный
   старт (30–60 сек), из-за чего синхронизация клиента не стартовала. */
setInterval(() => {
  fetch(EXT_URL + '/api/health')
    .then(r => { if (!r.ok) console.log('[будильник] health: HTTP ' + r.status); })
    .catch(e => console.log('[будильник] ' + e.message));
}, 10 * 60 * 1000);
console.log('[будильник] самопинг каждые 10 минут: ' + EXT_URL + '/api/health');
setTimeout(() => { orderWatchTick().catch(() => {}); }, 8000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  /* ---- Страницы ---- */
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, 'index.html');
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, db: pool ? 'postgres' : 'file', version: '29.07-72' });

  /* ---- Автонастройка нового компа: открыл систему с сервера — она сама
     получила адрес API и ключ. Включается переменной AUTO_SETUP=1. ---- */
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const auto = process.env.AUTO_SETUP === '1';
    return sendJson(res, 200, { ok: true, apiUrl: '/api',
      orderWatch: !!(process.env.STRAPI_API_TOKEN && TG_TOKEN && TG_CHATS.length),
      strapiToken: !!process.env.STRAPI_API_TOKEN,
      storeToken: auto ? STORE_TOKEN : null,
      hint: auto ? 'автонастройка включена' : 'для полной автонастройки добавьте AUTO_SETUP=1 в Environment' });
  }

  /* ---- ОЦЕНКА ИЗ ПИСЬМА: клик по звезде ---- */
  if (req.method === 'GET' && url.pathname === '/review') {
    const o = String(url.searchParams.get('o') || '').trim().slice(0, 30);
    const s = parseInt(url.searchParams.get('s')) || 0;
    if (!/^[\wЀ-ӿ.-]{1,30}$/.test(o) || s < 1 || s > 5) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Некорректная ссылка'); }
    return (async () => {
      try {
        await reviewsLoad();
        const prev = _reviews[o];
        if (!prev || prev.s !== s) {                       /* клик записываем сразу; повтор той же оценки не дублируем */
          _reviews[o] = Object.assign({}, prev || {}, { s, at: new Date().toISOString() });
          await reviewsSave();
          const warn = s <= 2 ? '⚠️ ' : '';
          tgSend(warn + '⭐'.repeat(s) + ' — оценка ' + s + '/5 по заказу №' + o + (prev ? ' (было ' + prev.s + '/5)' : ''));
        }
        const yaUrl = await reviewPublicUrl();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(reviewPage(o, s, yaUrl));
      } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Ошибка: ' + e.message); }
    })();
  }

  /* ---- Комментарий к оценке (со страницы, без токена — но с защитой от потока) ---- */
  if (req.method === 'POST' && url.pathname === '/api/review-comment') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    if (!floodOk('rvc_' + ip)) return sendJson(res, 429, { error: 'Слишком часто' });
    return readBody(req, async b => {
      try {
        const o = String(b.o || '').trim().slice(0, 30);
        const s = parseInt(b.s) || 0;
        const text = String(b.text || '').trim().slice(0, 2000);
        if (!/^[\wЀ-ӿ.-]{1,30}$/.test(o) || s < 1 || s > 5 || !text) return sendJson(res, 400, { error: 'Нет данных' });
        await reviewsLoad();
        _reviews[o] = Object.assign({}, _reviews[o] || { s, at: new Date().toISOString() }, { text, textAt: new Date().toISOString() });
        await reviewsSave();
        tgSend('💬 Комментарий к оценке ' + s + '/5, заказ №' + o + ':\n' + text);
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }

  /* ---- Оценки для ERP (по токену) + смена ссылки на Яндекс Карты без деплоя ---- */
  if (req.method === 'GET' && url.pathname === '/api/reviews') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return (async () => {
      try { await reviewsLoad(); sendJson(res, 200, { ok: true, reviews: _reviews }); }
      catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
  }
  if (req.method === 'POST' && url.pathname === '/api/review-url') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        const u = String(b.url || '').trim().slice(0, 500);
        if (!/^https:\/\//.test(u)) return sendJson(res, 400, { error: 'Нужна ссылка вида https://…' });
        await kvSet('review_url', u);
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }

  /* ---- АВТОРИЗАЦИЯ КОМПЬЮТЕРА: новый комп вводит PIN сотрудника/владельца,
     сервер сверяет его с облачной базой и выдаёт ключ связи. Один раз на комп.
     Защита: 5 попыток в минуту с адреса. ---- */
  /* Ожидающие подтверждения устройств: vid -> {code, who, ip, ua, attempts, exp} */
  if (req.method === 'POST' && url.pathname === '/api/device-auth') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    if (!floodOk('dev_' + ip)) return sendJson(res, 429, { error: 'Слишком много попыток. Подождите минуту.' });
    return readBody(req, async b => {
      const pin = String(b.pin || '').trim();
      if (!/^\d{4,6}$/.test(pin)) return sendJson(res, 400, { error: 'PIN — от 4 до 6 цифр' });
      try {
        const cur = await stateLoad();
        if (!cur || !cur.state || !cur.state.stores) return sendJson(res, 500, { error: 'База ещё пуста — первый комп настройте вручную (шестерёнка Заказов)' });
        const crypto = require('crypto');
        const h = s => crypto.createHash('sha256').update(s).digest('hex');
        let who = null;
        for (const sid of Object.keys(cur.state.stores)) {
          const d = cur.state.stores[sid] || {};
          const st = d.settings || {};
          if (st.ownerPinHash && h('storecontrol|owner|' + pin) === st.ownerPinHash) { who = 'Владелец'; break; }
          if (st.adminPinHash && h('storecontrol|admin|' + pin) === st.adminPinHash) { who = 'Админ'; break; }
          for (const e of (d.employees || [])) {
            if (e.pinHash && h('storecontrol|emp' + e.id + '|' + pin) === e.pinHash) { who = e.name; break; }
          }
          if (who) break;
        }
        if (!who) {
          console.log('[авторизация компа] неверный PIN с ' + ip);
          return sendJson(res, 401, { error: 'PIN не найден. Проверьте или попросите владельца задать вам PIN.' });
        }
        /* ПОДТВЕРЖДЕНИЕ УСТРОЙСТВА (решение владельца 03.08): PIN — это «кто ты»,
           а «можно ли этому компьютеру» решает владелец: ему уходит 6-значный код
           (почта OWNER_EMAIL; если почта не настроена — Telegram). Без кода ключ
           не выдаётся. Если не настроены ни почта, ни Telegram — старое поведение,
           чтобы не заблокировать самих себя. */
        const mailReady = !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.OWNER_EMAIL);
        const tgReady = !!(TG_TOKEN && TG_CHATS.length);
        if (mailReady || tgReady) {
          global._devVerify = global._devVerify || {};
          /* подчистить протухшие */
          for (const k of Object.keys(global._devVerify)) if (global._devVerify[k].exp < Date.now()) delete global._devVerify[k];
          if (Object.keys(global._devVerify).length > 50) return sendJson(res, 429, { error: 'Слишком много ожидающих подтверждений — попробуйте позже' });
          const code = String(crypto.randomInt(100000, 1000000));
          const vid = 'v' + crypto.randomBytes(9).toString('hex');
          global._devVerify[vid] = { code, who, ip: String(ip).slice(0, 60),
            ua: String(req.headers['user-agent'] || '').slice(0, 120),
            attempts: 0, exp: Date.now() + 10 * 60 * 1000 };
          const info = 'Сотрудник: ' + who + '\nIP: ' + ip + '\nВремя: ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
          let channel = null;
          if (mailReady) {
            try {
              const r = await mailSend(process.env.OWNER_EMAIL, 'Store Control — код подтверждения устройства: ' + code,
                'Кто-то подключает новый компьютер к Store Control.\n\nКод подтверждения: ' + code + '\n\n' + info +
                '\n\nЕсли это не ваш сотрудник — не сообщайте код никому и смените PIN-коды.', false);
              if (r && r.ok) channel = 'почту владельца';
            } catch (e) { console.log('device-verify mail:', e.message); }
          }
          if (!channel && tgReady) {
            const r = await tgSend('🖥 Код подтверждения нового устройства: ' + code + '\n' + info + '\nЕсли это не ваш сотрудник — никому не сообщайте код.');
            if (r && r.ok) channel = 'Telegram владельца';
          } else if (channel && tgReady) {
            /* дублируем в TG для скорости */
            tgSend('🖥 Код подтверждения нового устройства: ' + code + '\n' + info);
          }
          if (!channel) {
            delete global._devVerify[vid];
            return sendJson(res, 500, { error: 'Не получилось отправить код владельцу — проверьте SMTP/Telegram на сервере' });
          }
          console.log('[авторизация компа] код отправлен (' + channel + '): ' + who + ' (' + ip + ')');
          return sendJson(res, 200, { ok: true, verifyRequired: true, vid, channel });
        }
        /* ни почты, ни Telegram — старое поведение */
        await devicesLoad();
        const tok = 'dev_' + crypto.randomBytes(18).toString('hex');
        _devices.unshift({
          id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          token: tok, who, verified: 'auto',
          ip: String(ip).slice(0, 60),
          ua: String(req.headers['user-agent'] || '').slice(0, 120),
          at: new Date().toISOString(), lastSeen: new Date().toISOString()
        });
        if (_devices.length > 100) _devices.length = 100;
        await devicesSave();
        console.log('[авторизация компа] личный ключ выдан без кода (нет каналов): ' + who + ' (' + ip + ')');
        sendJson(res, 200, { ok: true, storeToken: tok, who });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }

  /* ---- Подтверждение устройства кодом владельца ---- */
  if (req.method === 'POST' && url.pathname === '/api/device-verify') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    if (!floodOk('dvf_' + ip)) return sendJson(res, 429, { error: 'Слишком часто. Подождите минуту.' });
    return readBody(req, async b => {
      try {
        const vid = String(b.vid || '').slice(0, 40);
        const code = String(b.code || '').trim();
        const pend = (global._devVerify || {})[vid];
        if (!pend) return sendJson(res, 400, { error: 'Запрос не найден или устарел — начните заново' });
        if (pend.exp < Date.now()) { delete global._devVerify[vid]; return sendJson(res, 400, { error: 'Код устарел (10 минут) — начните заново' }); }
        if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'Код — 6 цифр' });
        if (pend.code !== code) {
          pend.attempts = (pend.attempts || 0) + 1;
          if (pend.attempts >= 5) { delete global._devVerify[vid]; return sendJson(res, 401, { error: '5 неверных попыток — начните заново' }); }
          return sendJson(res, 401, { error: 'Неверный код (' + pend.attempts + ' из 5)' });
        }
        delete global._devVerify[vid];
        const crypto = require('crypto');
        await devicesLoad();
        const tok = 'dev_' + crypto.randomBytes(18).toString('hex');
        _devices.unshift({
          id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          token: tok, who: pend.who, verified: true,
          ip: pend.ip, ua: pend.ua,
          at: new Date().toISOString(), lastSeen: new Date().toISOString()
        });
        if (_devices.length > 100) _devices.length = 100;
        await devicesSave();
        console.log('[авторизация компа] устройство ПОДТВЕРЖДЕНО кодом: ' + pend.who + ' (' + pend.ip + ')');
        sendJson(res, 200, { ok: true, storeToken: tok, who: pend.who });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }

  /* ---- Авторизованные компьютеры: список (ключи не показываем целиком) ---- */
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        await devicesLoad();
        sendJson(res, 200, { ok: true, devices: (_devices || []).map(d => ({
          id: d.id, who: d.who, ip: d.ip, ua: d.ua, at: d.at, lastSeen: d.lastSeen,
          tail: String(d.token || '').slice(-4)
        })) });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Отозвать доступ компьютера: его личный ключ перестаёт работать ---- */
  if (req.method === 'POST' && url.pathname === '/api/devices/revoke') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        await devicesLoad();
        const before = (_devices || []).length;
        _devices = (_devices || []).filter(d => d.id !== String(b.id || ''));
        await devicesSave();
        console.log('[авторизация компа] доступ отозван: ' + String(b.id || ''));
        sendJson(res, 200, { ok: true, removed: before - _devices.length });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }

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
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });

    const since = parseInt(url.searchParams.get('since')) || 0;
    (async () => {
      try {
        if (pool) return sendJson(res, 200, { leads: (await dbGetLeads(since)).filter(l => !isTestLead(l)), db: 'postgres' });
      } catch (e) {
        console.error('Ошибка БД при чтении заявок, читаю файл:', e.message);
      }
      const db = readDb();
      sendJson(res, 200, { leads: db.leads.filter(l => l.id > since && !isTestLead(l)), db: 'file' });
    })();
    return;
  }

  /* ---- Уведомление в Telegram (из ERP, по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/notify') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      if (!b.text) return sendJson(res, 400, { error: 'Нужен text' });
      const r = await tgSend(b.text, b.chatIds);
      console.log('[telegram]', b.text.slice(0, 80), JSON.stringify(r).slice(0, 200));
      sendJson(res, r.ok ? 200 : 500, r);
    });
  }

  /* ---- СМС клиенту через sms.ru. Env: SMS_RU_API_ID (обязательно),
     SMS_FROM (буквенное имя отправителя, если согласовано) ---- */
  if (req.method === 'POST' && url.pathname === '/api/send-sms') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      const key = process.env.SMS_RU_API_ID || '';
      if (!key) return sendJson(res, 200, { ok: false, error: 'СМС не настроены: добавьте SMS_RU_API_ID (кабинет sms.ru) в Environment' });
      let to = String(b.to || '').replace(/\D/g, '');
      if (to.length === 11 && to[0] === '8') to = '7' + to.slice(1);
      if (to.length === 10) to = '7' + to;
      if (!/^7\d{10}$/.test(to)) return sendJson(res, 400, { error: 'Неверный номер: ' + String(b.to || '') });
      const text = String(b.text || '').slice(0, 600);
      if (!text) return sendJson(res, 400, { error: 'Пустой текст' });
      try {
        const params = new URLSearchParams({ api_id: key, to, msg: text, json: '1' });
        if (process.env.SMS_FROM) params.set('from', process.env.SMS_FROM);
        const r = await fetch('https://sms.ru/sms/send?' + params.toString());
        const j = await r.json();
        const st = j && j.sms && j.sms[to];
        const ok = !!(st && st.status === 'OK');
        console.log('[смс] ' + to + ' → ' + (ok ? 'OK, осталось ' + (j.balance || '?') + ' ₽' : JSON.stringify(st || j).slice(0, 150)));
        sendJson(res, 200, { ok, error: ok ? null : ((st && st.status_text) || (j && j.status_text) || 'ошибка провайдера'), balance: j && j.balance });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
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

  /* ---- Тестовая заявка одной ссылкой (по токену): полный боевой путь ---- */
  if (req.method === 'GET' && url.pathname === '/api/lead-test') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    if (process.env.ALLOW_TEST_LEADS !== '1') {
      return sendJson(res, 200, { ok: false, error: 'Тестовые заявки отключены: они засоряли рабочую базу. Для разовой проверки добавьте ALLOW_TEST_LEADS=1 в Environment (и уберите после).' });
    }
    const topic = ['buy', 'tradein', 'repair', 'question'].includes(url.searchParams.get('topic')) ? url.searchParams.get('topic') : 'buy';
    const stamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const lead = {
      name: 'ТЕСТ ' + (topic === 'repair' ? 'Ремонт' : 'Заказ'),
      phone: '+7 900 000-00-00',
      topic,
      item: topic === 'repair' ? 'Тестовое устройство' : 'Тестовый товар',
      comment: 'Тестовая заявка (создана ссылкой /api/lead-test, ' + stamp + ') — можно удалить',
      page: 'test',
      ip: 'test'
    };
    (async () => {
      try {
        if (pool) {
          const r = await dbAddLead(lead);
          console.log('[тест-заявка → БД]', r.id, topic);
          return sendJson(res, 200, { ok: true, id: r.id, topic, hint: 'Заявка в базе. В течение минуты появится в системе (' + (topic === 'repair' ? 'Сервис' : 'Заказы') + ') и придёт уведомление в Telegram.' });
        }
        const db = readDb();
        const rec = Object.assign({ id: db.nextId++, at: new Date().toISOString() }, lead);
        db.leads.push(rec); writeDb(db);
        sendJson(res, 200, { ok: true, id: rec.id, topic });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Вебхук от Strapi: сайт сам сообщает о новом заказе/ремонте (29.07-67).
     Настройка в админке сайта: Settings -> Webhooks -> Create new webhook:
       URL:     https://<этот сервер>/api/strapi-hook
       Header:  Authorization: Bearer <STORE_TOKEN>
       Events:  Entry -> Create (можно также Update)
     Телом вебхука не пользуемся — он лишь толчок: сторож заказов сам сверит
     курсор с сайтом и отправит уведомления. Дубликаты исключены (курсор).
     Бонус: входящий вебхук БУДИТ спящий бесплатный Render. ---- */
  if (req.method === 'POST' && url.pathname === '/api/strapi-hook') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        console.log('[вебхук strapi]', (b && b.event) || '?', (b && b.model) || '');
      } catch (e) {}
      sendJson(res, 200, { ok: true });
      /* небольшая пауза — Strapi успевает дозаписать связи заказа */
      setTimeout(() => { orderWatchTick().catch(e => console.log('вебхук-сторож:', e.message)); }, 2000);
    });
  }

  /* ---- ПОЛНЫЙ БЭКАП (29.07-69): текущая база + история снимков + заявки,
     одним JSON-файлом. Скачивается кнопкой из ERP (Управление → Облачная база).
     Пока свой сервер не поднят — это страховка от потери всего. ---- */
  if (req.method === 'GET' && url.pathname === '/api/backup') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        const out = { kind: 'imagnate-erp-backup', version: '29.07-72', generatedAt: new Date().toISOString() };
        out.current = await stateLoad();
        if (pool) {
          const h = await pool.query('SELECT id, saved_at_ms, state, created_at FROM erp_state_history ORDER BY id DESC LIMIT 20');
          out.history = h.rows.map(r => ({ id: r.id, savedAtMs: Number(r.saved_at_ms), createdAt: r.created_at, state: r.state }));
          const l = await pool.query('SELECT id, name, phone, topic, item, comment, page, created_at FROM site_leads ORDER BY id DESC LIMIT 500');
          out.leads = l.rows;
        } else {
          out.history = [];
          try { out.leads = readDb().leads.slice(-500); } catch (e) { out.leads = []; }
        }
        const body = JSON.stringify(out);
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="imagnate-backup-' + stamp + '.json"',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
        console.log('[бэкап] выдан полный дамп (' + Math.round(body.length / 1024) + ' КБ)');
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- История облачной базы: список снимков со сводкой (по токену) ---- */
  /* ---- Д3: боевой режим (вкл/выкл/статус) ---- */
  if (req.method === 'POST' && url.pathname === '/api/state-production') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        if (b.off === true) { await kvSet('erp_production_base', ''); _prodBase = null; console.log('[боевой режим] выключен'); return sendJson(res, 200, { ok: true, production: false }); }
        const cur = await stateLoad();
        if (!cur || !cur.state) return sendJson(res, 400, { error: 'База пуста — сначала загрузите боевые данные' });
        if (cur.state._demoBorn) return sendJson(res, 400, { error: 'Текущая база помечена как демо — боевой режим нельзя включить на демо-данных' });
        const bid = cur.state._baseId;
        if (!bid) return sendJson(res, 400, { error: 'У базы нет паспорта (_baseId) — сохраните базу актуальным клиентом и повторите' });
        await kvSet('erp_production_base', String(bid)); _prodBase = String(bid);
        console.log('[боевой режим] включён, паспорт базы: ' + bid);
        sendJson(res, 200, { ok: true, production: true, baseId: bid });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/state-production') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => { try { const pb = await prodBase(); sendJson(res, 200, { ok: true, production: !!pb, baseId: pb || null }); } catch (e) { sendJson(res, 500, { error: e.message }); } })();
    return;
  }
  /* ---- Д4: боевой запуск — авторитетная очистка демо-контента + сброс журнала ---- */
  if (req.method === 'POST' && url.pathname === '/api/state-wipe') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async () => {
      try {
        const cur = await stateLoad();
        if (!cur || !cur.state) return sendJson(res, 200, { ok: true, note: 'база пуста' });
        const st = cur.state;
        const CLEAR = ['orders','service','leads','customers','cashOps','salesLog','financeOps','purchaseRequests','shipments','tradeinBonuses','serviceHandoffs','expenseClaims','fines','explanations','shiftSwaps','timeOffRequests'];
        Object.keys(st.stores || {}).forEach(function (sid) {
          const d = st.stores[sid]; if (!d) return;
          CLEAR.forEach(function (k) { if (Array.isArray(d[k])) d[k] = []; });
          /* флаги разовых догрузок — сбросить, чтобы пустая база наполнилась заново */
          delete d._backfill46; delete d._siteStatusCheckedAt; delete d._fullHistoryDone; delete d._ignoreSweep1;
          /* каналы: словарь виденных и курсоры — тоже с нуля, чтобы воронка воссоздалась */
          delete d.chSeen; d.chCursorMs = 0; d.siteLastLeadId = 0;
          d.warehouse = { tech: [], tradein: [], accessories: [], parts: [] };
          if (d.assets) {
            (d.assets.cashByStore || []).forEach(function (x) { x.amount = 0; });
            d.assets.cashless = 0; d.assets.cashlessPending = 0; d.assets.storeWarehouse = 0;
            if (d.assets.collection) { d.assets.collection.cash = 0; d.assets.collection.goods = 0; }
          }
          if (d.finance) { try { d.finance.turnover.total = 0; d.finance.revenue.total = 0; } catch (e) {} }
          d.siteLastZakazId = null; d.siteLastRemontId = null;
        });
        st._demoBorn = false;
        if (!st._baseId) st._baseId = 'base_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        const now = Date.now();
        await stateSave({ savedAtMs: now, savedBy: 'боевой запуск (очистка демо)', state: st });
        if (pool) { try { await pool.query('DELETE FROM erp_journal'); } catch (e) {} }
        console.log('[боевой запуск] контент очищен, журнал сброшен, паспорт: ' + st._baseId);
        sendJson(res, 200, { ok: true, savedAtMs: now, baseId: st._baseId });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }
  /* ---- Журнал сущностей: счётчики (проверка Д1) ---- */
  if (req.method === 'GET' && url.pathname === '/api/state-journal') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        if (!pool) return sendJson(res, 200, { ok: true, items: [], hint: 'Журнал доступен только с PostgreSQL' });
        const r = await pool.query('SELECT store, entity, count(*)::int AS n, max(updated_at) AS updated FROM erp_journal GROUP BY store, entity ORDER BY store, entity');
        sendJson(res, 200, { ok: true, items: r.rows });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }
  /* ---- Д2: восстановление снимка из журнала (union в текущую базу, ничего не теряем) ---- */
  if (req.method === 'POST' && url.pathname === '/api/state-rebuild') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async () => {
      try {
        if (!pool) return sendJson(res, 400, { error: 'Восстановление доступно только с PostgreSQL' });
        const r = await pool.query('SELECT store, entity, data FROM erp_journal');
        const stores = {};
        const ensure = sid => (stores[sid] = stores[sid] || { orders: [], customers: [], cashOps: [], service: [], warehouse: { tech: [], tradein: [], accessories: [], parts: [] } });
        r.rows.forEach(row => {
          const d = ensure(row.store), o = row.data;
          if (row.entity === 'order') d.orders.push(o);
          else if (row.entity === 'customer') d.customers.push(o);
          else if (row.entity === 'cashop') d.cashOps.push(o);
          else if (row.entity === 'repair') d.service.push(o);
          else if (row.entity.indexOf('unit_') === 0) { const tab = row.entity.slice(5); (d.warehouse[tab] = d.warehouse[tab] || []).push(o); }
        });
        const rebuilt = { stores: stores };
        const cur = await stateLoad();
        const merged = (cur && cur.state) ? mergeUnion(cur.state, rebuilt) : rebuilt;
        const now = Date.now();
        await stateSave({ savedAtMs: now, savedBy: 'восстановление из журнала', state: merged });
        sendJson(res, 200, { ok: true, stores: Object.keys(stores).length, rows: r.rows.length, savedAtMs: now });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/state-history') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        if (!pool) return sendJson(res, 200, { ok: true, items: [], hint: 'История снимков доступна только с PostgreSQL' });
        const one = parseInt(url.searchParams.get('id')) || 0;
        if (one) {
          const r = await pool.query('SELECT id, saved_at_ms, state FROM erp_state_history WHERE id=$1', [one]);
          if (!r.rows.length) return sendJson(res, 404, { error: 'Снимок не найден' });
          return sendJson(res, 200, { ok: true, id: one, savedAtMs: Number(r.rows[0].saved_at_ms), state: r.rows[0].state });
        }
        const r = await pool.query(
          "SELECT id, saved_at_ms, created_at, pg_column_size(state) AS size," +
          " CASE WHEN jsonb_typeof(state->'stores'->'store_lunnaya'->'orders')='array'" +
          "   THEN jsonb_array_length(state->'stores'->'store_lunnaya'->'orders') END AS orders," +
          " CASE WHEN jsonb_typeof(state->'stores'->'store_lunnaya'->'warehouse'->'tech')='array'" +
          "   THEN jsonb_array_length(state->'stores'->'store_lunnaya'->'warehouse'->'tech') END AS units" +
          " FROM erp_state_history ORDER BY id DESC LIMIT 30");
        sendJson(res, 200, { ok: true, items: r.rows.map(row => ({
          id: row.id, savedAtMs: Number(row.saved_at_ms), createdAt: row.created_at,
          sizeKb: Math.round((row.size || 0) / 1024),
          orders: row.orders == null ? null : Number(row.orders),
          units: row.units == null ? null : Number(row.units),
        })) });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Откат облачной базы к снимку истории (по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/state-restore') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        if (!pool) return sendJson(res, 400, { error: 'История снимков доступна только с PostgreSQL' });
        const id = parseInt(b.id) || 0;
        if (!id) return sendJson(res, 400, { error: 'Нужен id снимка' });
        const r = await pool.query('SELECT saved_at_ms, state FROM erp_state_history WHERE id=$1', [id]);
        if (!r.rows.length) return sendJson(res, 404, { error: 'Снимок не найден' });
        /* страховка: текущее состояние — в историю, чтобы откат можно было откатить */
        const cur = await pool.query('SELECT saved_at_ms, state FROM erp_state WHERE id=1');
        if (cur.rows.length) {
          await pool.query('INSERT INTO erp_state_history (saved_at_ms, state) VALUES ($1,$2)',
            [cur.rows[0].saved_at_ms, cur.rows[0].state]);
        }
        const now = Date.now();
        const st = r.rows[0].state || {};
        try { st.savedAtMs = now; } catch (e) {}   /* чтобы все компы приняли как свежий */
        await pool.query(
          'INSERT INTO erp_state (id, saved_at_ms, saved_by, state) VALUES (1,$1,$2,$3) ' +
          'ON CONFLICT (id) DO UPDATE SET saved_at_ms=$1, saved_by=$2, state=$3, updated_at=now()',
          [now, 'восстановление из истории #' + id, st]);
        console.log('[облако] восстановлен снимок истории #' + id);
        sendJson(res, 200, { ok: true, id, savedAtMs: now });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
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
        const curState = cur && cur.state;
        const curDemo = !!(curState && curState._demoBorn);
        const incDemo = !!(b.state && b.state._demoBorn);
        /* Д3: боевой режим — глушим демо и чужой/без паспорта, даже если база пуста */
        const pb = await prodBase();
        if (pb) {
          const iB = b.state && b.state._baseId;
          if (incDemo) { console.warn('[боевой режим] отклонён демо-снимок'); return sendJson(res, 200, { ok: true, ignored: 'production-no-demo', savedAtMs: cur ? cur.savedAtMs : 0 }); }
          if (!iB || iB !== pb) { console.warn('[боевой режим] отклонён снимок без/с чужим паспортом'); return sendJson(res, 200, { ok: true, ignored: 'production-foreign-base', savedAtMs: cur ? cur.savedAtMs : 0 }); }
        }
        /* демо-снимок НИКОГДА не перезаписывает реальную базу */
        if (incDemo && curState && !curDemo) {
          console.warn('[облачная база] отклонён демо-снимок поверх реальной базы');
          return sendJson(res, 200, { ok: true, ignored: 'demo-over-real', savedAtMs: cur.savedAtMs });
        }
        /* снимок с чужим паспортом базы не затирает нашу */
        const sBase = curState && curState._baseId, iBase = b.state && b.state._baseId;
        if (curState && !curDemo && sBase && iBase && sBase !== iBase) {
          console.warn('[облачная база] отклонён снимок с чужим паспортом базы');
          return sendJson(res, 200, { ok: true, ignored: 'foreign-base', savedAtMs: cur.savedAtMs });
        }
        /* СЛИЯНИЕ-ХРАНИТЕЛЬ: сервер не теряет записи. Побеждает более свежий
           снимок при конфликте, но недостающие записи из другого — сохраняются. */
        let toSave = b.state, outMs = b.savedAtMs;
        if (curState) {
          if ((b.savedAtMs || 0) >= (cur.savedAtMs || 0)) { toSave = mergeUnion(b.state, curState); outMs = b.savedAtMs; }
          else { toSave = mergeUnion(curState, b.state); outMs = cur.savedAtMs; }
        }
        await stateSave({ savedAtMs: outMs, savedBy: String(b.savedBy || '').slice(0, 80), state: toSave });
        sendJson(res, 200, { ok: true, savedAtMs: outMs, merged: true });
      } catch (e) {
        console.error('[облачная база] ошибка:', e.message);
        sendJson(res, 500, { error: e.message });
      }
    });
  }

  /* ---- ВЕБХУК АВИТО: Авито присылает каждое новое сообщение мгновенно ---- */
  if (req.method === 'POST' && url.pathname === '/api/hooks/avito') {
    return readBody(req, async b => {
      try {
        const v = b && b.payload && b.payload.value;
        if (b && b.payload && b.payload.type === 'message' && v && v.chat_id) {
          const sets = envSets(CH_ENV_NAMES.avito);
          /* чей комплект: сверяем id аккаунта; author == владелец -> исходящее */
          let set = sets[0] || null;
          for (const s of sets) { const a = avitoAuth[s.key]; if (a && a.uid === v.user_id) { set = s; break; } }
          const dir = (v.author_id === v.user_id) ? 'out' : 'in';
          const text = (v.content && (v.content.text ||
            (v.content.link && v.content.link.url) ||
            (v.content.location && 'Геолокация') ||
            (v.content.call && 'Звонок'))) || (v.type === 'image' ? '[изображение]' : '');
          let name = '', item = '';
          if (dir === 'in' && set) {
            name = 'Клиент Авито';
            try {
              const cj = await avitoApi(set, '/messenger/v2/accounts/' + v.user_id + '/chats/' + v.chat_id);
              const other = (cj.users || []).find(u => u.id !== v.user_id) || {};
              name = other.name || name;
              item = (cj.context && cj.context.value && cj.context.value.title) || '';
            } catch (e) {}
          }
          if (text) {
            const isNew = await chStore({ key: 'av_' + v.id, store: set ? set.store : DEFAULT_STORE, channel: 'avito',
              chatId: String(v.chat_id), dir, name, contact: '', item: String(item).slice(0, 120),
              text: String(text).slice(0, 2000), tsMs: (v.created || 0) * 1000 });
            if (isNew) console.log('[вебхук авито] ' + dir + ' сообщение, чат ' + v.chat_id);
          }
        }
      } catch (e) { console.error('[вебхук авито]', e.message); }
      sendJson(res, 200, { ok: true });
    });
  }

  /* ---- ВЕБХУК TELEGRAM: путь содержит id бота ---- */
  if (req.method === 'POST' && url.pathname.indexOf('/api/hooks/telegram/') === 0) {
    const botId = url.pathname.split('/').pop();
    return readBody(req, async u => {
      try {
        const set = envSets(CH_ENV_NAMES.telegram).find(s => s.env.TELEGRAM_BOT_TOKEN.split(':')[0] === botId);
        const m = u && u.message;
        if (set && m && m.chat && m.chat.type === 'private') {
          const cid = String(m.chat.id);
          const text = m.text || m.caption || '';
          if (!TG_CHATS.includes(cid) && text && text.indexOf('/start') !== 0) {
            const name = (((m.from && m.from.first_name) || '') + ' ' + ((m.from && m.from.last_name) || '')).trim();
            const isNew = await chStore({ key: 'tg' + set.key + '_' + u.update_id, store: set.store, channel: 'telegram',
              chatId: cid, dir: 'in', name: name || 'Клиент Telegram',
              contact: (m.from && m.from.username) ? ('tg: @' + m.from.username) : '',
              item: '', text: String(text).slice(0, 2000), tsMs: (m.date || 0) * 1000 });
            if (isNew) console.log('[вебхук telegram] сообщение из чата ' + cid);
          }
        }
      } catch (e) { console.error('[вебхук telegram]', e.message); }
      sendJson(res, 200, { ok: true });
    });
  }

  /* ---- ВЕБХУК MAX ---- */
  if (req.method === 'POST' && url.pathname === '/api/hooks/max') {
    return readBody(req, async b => {
      try {
        const ups = Array.isArray(b && b.updates) ? b.updates : [b];
        const set = envSets(CH_ENV_NAMES.max)[0] || null;
        for (const u of ups) {
          const m = u && u.message;
          if (!m) continue;
          const cid = String((m.recipient && m.recipient.chat_id) || '');
          const text = (m.body && m.body.text) || '';
          if (!cid || !text) continue;
          await chStore({ key: 'mx' + (set ? set.key : '') + '_' + ((m.body && m.body.mid) || (cid + '_' + u.timestamp)),
            store: set ? set.store : DEFAULT_STORE, channel: 'max', chatId: cid, dir: 'in',
            name: (m.sender && m.sender.name) || 'Клиент MAX',
            contact: (m.sender && m.sender.username) ? ('max: ' + m.sender.username) : '',
            item: '', text: String(text).slice(0, 2000), tsMs: u.timestamp || Date.now() });
        }
      } catch (e) { console.error('[вебхук max]', e.message); }
      sendJson(res, 200, { ok: true });
    });
  }

  /* ---- ВЕБХУК ВКОНТАКТЕ (Callback API): подтверждение + message_new ---- */
  if (req.method === 'POST' && url.pathname === '/api/hooks/vk') {
    return readBody(req, async b => {
      try {
        if (b && b.type === 'confirmation') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(String(process.env.VK_CONFIRMATION || ''));
        }
        if (b && b.type === 'message_new') {
          const m = (b.object && (b.object.message || b.object)) || {};
          const set = envSets(CH_ENV_NAMES.vk)[0] || null;
          const peer = m.peer_id || (m.from_id > 0 ? m.from_id : null);
          if (peer && !m.out) {
            let name = 'Клиент ВКонтакте';
            if (set && m.from_id > 0) {
              try {
                const us = await vkApi(set, 'users.get', { user_ids: m.from_id });
                if (us && us[0]) name = ((us[0].first_name || '') + ' ' + (us[0].last_name || '')).trim() || name;
              } catch (e) {}
            }
            await chStore({ key: 'vk' + (set ? set.key : '') + '_' + peer + '_' + (m.id || m.conversation_message_id || m.date),
              store: set ? set.store : DEFAULT_STORE, channel: 'vk', chatId: String(peer), dir: 'in',
              name, contact: 'vk.com/id' + (m.from_id || peer), item: '',
              text: String(m.text || '[вложение]').slice(0, 2000), tsMs: (m.date || 0) * 1000 });
          }
        }
      } catch (e) { console.error('[вебхук вк]', e.message); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  }

  /* ---- Каналы воронки: опрос и выдача новых сообщений (по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/channels/poll') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        await channelsPollAll(!!b.deep);
        const sinceMs = Number(b.sinceMs) || (Date.now() - 7 * 86400000);
        const msgs = await chList(sinceMs, 500);
        sendJson(res, 200, { ok: true, messages: msgs, status: chState });
      } catch (e) {
        console.error('[каналы] опрос:', e.message);
        sendJson(res, 500, { error: e.message });
      }
    });
  }

  /* ---- Каналы воронки: ответ клиенту в его канал (по токену) ---- */
  /* ---- WhatsApp: проверка вебхука (Meta) ---- */
  if (req.method === 'GET' && url.pathname === '/api/hooks/whatsapp') {
    const ch = url.searchParams.get('hub.challenge');
    if (ch) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ch); }
    return sendJson(res, 200, { ok: true, ready: true, hint: 'POST сюда сообщения WhatsApp: {from, name, text}' });
  }
  /* ---- WhatsApp: приём сообщений (универсально) ----
     Любой источник (провайдер/мост) POST-ит сюда. Понимаем разные формы:
     {from|phone|chatId, name, text|message}, а также {messages:[...]}. */
  if (req.method === 'POST' && url.pathname === '/api/hooks/whatsapp') {
    return readBody(req, async b => {
      try {
        const list = Array.isArray(b.messages) ? b.messages : (Array.isArray(b) ? b : [b]);
        let saved = 0;
        for (const m of list) {
          if (!m || typeof m !== 'object') continue;
          const from = String(m.from || m.phone || m.chatId || m.chat_id || m.sender || m.author || '').replace(/[^0-9]/g, '');
          const text = String(m.text || m.message || m.body || (m.content && (m.content.text || m.content.body)) || '').trim();
          if (!from || !text) continue;
          const dir = (m.dir === 'out' || m.direction === 'out' || m.fromMe === true || m.outgoing === true) ? 'out' : 'in';
          const name = String(m.name || m.senderName || m.pushName || m.contactName || '').slice(0, 80);
          const id = String(m.id || m.messageId || m.msgId || (from + '_' + (m.timestamp || m.tsMs || Date.now())));
          const ok = await chStore({
            key: 'wa_' + id, store: String(m.store || '') || DEFAULT_STORE, channel: 'whatsapp',
            chatId: from, dir, name: dir === 'in' ? (name || 'Клиент WhatsApp') : '', contact: from, item: '',
            text: text.slice(0, 2000), tsMs: Number(m.tsMs || m.timestamp) || Date.now()
          });
          if (ok) saved++;
        }
        console.log('[whatsapp] принято сообщений: ' + saved);
        sendJson(res, 200, { ok: true, saved });
      } catch (e) { sendJson(res, 500, { error: String(e.message || e).slice(0, 200) }); }
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/channels/reply') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      const ch = String(b.channel || ''), cid = String(b.chatId || ''), text = String(b.text || '').trim();
      const store = String(b.store || '') || DEFAULT_STORE;
      if (!CH_SENDSET[ch]) return sendJson(res, 400, { error: 'Канал не поддерживается: ' + ch });
      if (!cid || !text) return sendJson(res, 400, { error: 'Нужны chatId и text' });
      try {
        await channelSend(ch, store, cid, text);
        await chStore({ key: 'out_' + ch + '_' + cid + '_' + Date.now(), store, channel: ch, chatId: cid, dir: 'out',
          name: '', contact: '', item: '', text: text.slice(0, 2000), tsMs: Date.now() });
        console.log('[канал ' + ch + '] ответ отправлен в чат ' + cid);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error('[канал ' + ch + '] отправка:', e.message);
        sendJson(res, 500, { error: String(e.message || e).slice(0, 300) });
      }
    });
  }

  /* ---- Полный импорт переписки Авито: запуск фоновой задачи (по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/avito/import-all') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    if (avitoImport && avitoImport.running) return sendJson(res, 200, { ok: true, started: false, hint: 'Импорт уже идёт' });
    avitoImportAll().catch(e => console.error('[импорт авито]', e.message));
    return sendJson(res, 200, { ok: true, started: true, hint: 'Импорт запущен в фоне — прогресс на карточке Авито' });
  }

  /* ---- Архив: список всех чатов со всеми каналами (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/channels/chats') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        let chats;
        if (pool) {
          const r = await pool.query(
            "SELECT channel, chat_id AS \"chatId\", max(ts_ms) AS \"lastTs\", count(*) AS cnt, " +
            "(array_agg(name ORDER BY ts_ms DESC) FILTER (WHERE dir='in' AND name<>''))[1] AS name, " +
            "(array_agg(item ORDER BY ts_ms DESC) FILTER (WHERE item<>''))[1] AS item, " +
            "(array_agg(text_ ORDER BY ts_ms DESC))[1] AS \"lastText\", " +
            "(array_agg(dir ORDER BY ts_ms DESC))[1] AS \"lastDir\", " +
            "(array_agg(store ORDER BY ts_ms DESC))[1] AS store " +
            'FROM channel_msgs GROUP BY channel, chat_id ORDER BY max(ts_ms) DESC LIMIT 300');
          chats = r.rows.map(x => Object.assign({}, x, { lastTs: Number(x.lastTs), cnt: Number(x.cnt) }));
        } else {
          const by = {};
          chFile().forEach(m => {
            const k = m.channel + '|' + m.chatId;
            const c = by[k] = by[k] || { channel: m.channel, chatId: String(m.chatId), lastTs: 0, cnt: 0, name: '', item: '', lastText: '', lastDir: '', store: m.store };
            c.cnt++;
            if ((m.tsMs || 0) >= c.lastTs) { c.lastTs = m.tsMs || 0; c.lastText = m.text || ''; c.lastDir = m.dir; if (m.store) c.store = m.store; }
            if (m.dir === 'in' && m.name) c.name = m.name;
            if (m.item) c.item = m.item;
          });
          chats = Object.values(by).sort((a, b) => b.lastTs - a.lastTs).slice(0, 300);
        }
        sendJson(res, 200, { ok: true, count: chats.length, chats });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Вся сохранённая переписка одного чата (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/channels/history') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    const ch = url.searchParams.get('channel') || '';
    const cid = url.searchParams.get('chatId') || '';
    if (!ch || !cid) return sendJson(res, 400, { error: 'Нужны channel и chatId' });
    (async () => {
      try {
        let msgs;
        if (pool) {
          const r = await pool.query(
            'SELECT key, channel, chat_id AS "chatId", dir, name, contact, item, text_ AS text, ts_ms AS "tsMs" FROM channel_msgs WHERE channel=$1 AND chat_id=$2 ORDER BY ts_ms LIMIT 500',
            [ch, cid]);
          msgs = r.rows.map(x => Object.assign({}, x, { tsMs: Number(x.tsMs) }));
        } else {
          msgs = chFile().filter(x => x.channel === ch && String(x.chatId) === cid).slice(0, 500);
        }
        sendJson(res, 200, { ok: true, count: msgs.length, messages: msgs });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Каналы воронки: последние собранные сообщения — диагностика (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/channels/last') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      try {
        const msgs = await chList(Date.now() - 7 * 86400000, 100);
        sendJson(res, 200, { ok: true, count: msgs.length,
          messages: msgs.slice(-30).map(m => ({ key: m.key, channel: m.channel, chatId: m.chatId, dir: m.dir, name: m.name, text: String(m.text || '').slice(0, 60), tsMs: m.tsMs })) });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    })();
    return;
  }

  /* ---- Прокси к Strapi сайта: токен подставляет СЕРВЕР (STRAPI_API_TOKEN).
     Компы и браузеры больше не хранят токен — вписан один раз в Environment. ---- */
  if (req.method === 'POST' && url.pathname === '/api/strapi') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      const p = String(b.path || '');
      const method = (b.method === 'PUT' || b.method === 'POST' || b.method === 'DELETE') ? b.method : 'GET';
      if (p.indexOf('/api/') !== 0) return sendJson(res, 400, { error: 'Путь должен начинаться с /api/' });
      const tok = process.env.STRAPI_API_TOKEN || b.token || '';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
        const opts = { method, headers };
        if (b.body && method !== 'GET') opts.body = JSON.stringify(b.body);
        const r = await fetch('https://admin.imagnate.ru' + p, opts);
        const text = await r.text();
        let j = null; try { j = JSON.parse(text); } catch (e) { j = { raw: text.slice(0, 500) }; }
        sendJson(res, 200, { ok: r.ok, status: r.status, data: j });
      } catch (e) { sendJson(res, 502, { error: 'Сайт не ответил: ' + e.message }); }
    });
  }

  /* ---- Каналы воронки: состояние (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/channels/status') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    (async () => {
      const cursors = {};
      try {
        for (const k of ['avito_cursor', 'tg_offset', 'vk_cursor', 'max_marker']) cursors[k] = await kvGet(k);
      } catch (e) {}
      sendJson(res, 200, { ok: true, status: chState, cursors, nowSec: Math.floor(Date.now() / 1000) });
    })();
    return;
  }

  sendJson(res, 404, { error: 'Неизвестный запрос' });
});

/* ============================================================
   СЕРВЕРНЫЕ ПРОВЕРКИ: раз в 5 минут сервер сам смотрит облачный
   снимок базы и шлёт уведомления, ЕСЛИ ERP ни у кого не открыта
   (снимок старше 3 минут — значит, страницы нет; иначе клиент шлёт сам).
   Дедупликация: одна заявка — одно уведомление в день (channel_kv).
============================================================ */
async function serverSideChecks() {
  try {
    const cur = await stateLoad();
    if (!cur || !cur.state) return;
    if (Date.now() - (cur.savedAtMs || 0) < 3 * 60 * 1000) return;   /* страница открыта */
    const stores = cur.state.stores || {};
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    const dayKey = p(now.getDate()) + '.' + p(now.getMonth() + 1) + '.' + now.getFullYear();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const parseRu = s => { const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
    for (const sid of Object.keys(stores)) {
      const d = stores[sid] || {};
      for (const t of (d.service || [])) {
        if (['done', 'archive'].includes(t.status)) continue;
        const due = parseRu(t.due);
        if (due && due < todayMid) {
          const k = 'srvntf_overdue_' + sid + '_' + t.id + '_' + dayKey;
          if (await kvGet(k)) continue;
          await kvSet(k, '1');
          await tgSend('🔧 Просрочен ремонт\nЗаявка №' + t.id + (t.device ? ' — ' + t.device : '') + '\nСрок был: ' + t.due + '\n(отправлено сервером — ERP закрыта)');
        }
      }
      for (const l of (d.leads || [])) {
        /* 29.07-68: если в диалоге уже есть наш ответ (или ответ автоответчика
           Авито) — заявка обработана, «упавшей» её не объявляем */
        const answered = ((l.msgs || []).some(m => m && (m.dir === 'out' ||
          (m.dir === 'in' && /Ассистент Авито ответил/i.test(String(m.text || ''))))));
        if (l.fellBack && l.stage === 'new' && !answered) {
          const k = 'srvntf_fell_' + sid + '_' + l.id + '_' + dayKey;
          if (await kvGet(k)) continue;
          await kvSet(k, '1');
          await tgSend('🔴 Упавшая заявка CRM\nКлиент: ' + (l.name || '—') + '\nНе подтверждена вовремя — заберите в работу\n(отправлено сервером — ERP закрыта)');
        }
      }
    }
  } catch (e) { console.error('[серверные проверки]', e.message); }
}

/* ЕЖЕДНЕВНЫЙ ДАМП НА ПОЧТУ (29.07-69): раз в сутки полная база уходит
   вложением на OWNER_EMAIL — даже если Render и Postgres пропадут,
   вчерашняя копия всегда лежит в почте. Работает при настроенном SMTP. */
async function dailyBackupMail() {
  try {
    const to = process.env.OWNER_EMAIL || 'ryabukha03@mail.ru';
    if (!to) return;
    const t = mailTransport();
    if (!t) return;                                     /* SMTP ещё не настроен */
    const slot = Math.floor(Date.now() / (8 * 3600 * 1000)); /* 8-часовой слот */
    const dayKey = new Date().toISOString().slice(0, 13); /* для имени файла */
    if (await kvGet('backup_mailed_' + slot)) return; /* в этом 8-час. окне уже отправляли */
    const cur = await stateLoad();
    if (!cur || !cur.state) return;
    const out = { kind: 'imagnate-erp-backup', generatedAt: new Date().toISOString(), current: cur };
    const body = JSON.stringify(out);
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject: 'iMagnate ERP — резервная копия базы (' + dayKey + ')',
      text: 'Автоматическая резервная копия облачной базы Store Control.\n' +
        'Размер: ' + Math.round(body.length / 1024) + ' КБ. Восстановление: ERP → Управление → Облачная база → «Восстановить из файла».',
      attachments: [{ filename: 'imagnate-backup-' + dayKey + '.json', content: body }]
    });
    await kvSet('backup_mailed_' + slot, '1');
    console.log('[бэкап] дневной дамп отправлен на ' + to + ' (' + Math.round(body.length / 1024) + ' КБ)');
  } catch (e) { console.error('[бэкап] почтовый дамп:', e.message); }
}

dbInit()
  .catch(e => { console.error('БД недоступна (' + e.message + ') — работаю в файловом режиме'); pool = null; })
  .then(() => server.listen(PORT, () => {
    setTimeout(() => { dailyBackupMail(); }, 60000);
    setInterval(() => { dailyBackupMail(); }, 3600000);
    setTimeout(() => { purgeTestLeads().catch(() => {}); }, 8000);
    setInterval(() => { purgeTestLeads().catch(() => {}); }, 24 * 3600 * 1000);
    setInterval(() => { purgeWatchLocks(); }, 24 * 3600 * 1000);
    setTimeout(() => { registerWebhooks().catch(e => console.error('вебхуки:', e.message)); }, 5000);
    setTimeout(() => { serverSideChecks(); }, 20000);
    setInterval(() => { serverSideChecks(); }, 5 * 60 * 1000);
    setInterval(() => { registerWebhooks().catch(e => console.error('вебхуки:', e.message)); }, 24 * 3600 * 1000);
    /* при каждом запуске (деплой / пробуждение) — глубокая перечитка всех
       чатов: закрывает пропуски прошлого, дубликаты отсекает дедупликация */
    setTimeout(() => { channelsPollAll(true).catch(e => console.error('глубокий опрос:', e.message)); }, 9000);
    console.log('Store Control запущен на порту ' + PORT);
    console.log('ERP: /   Форма: /form   API: /api   Хранение: ' + (pool ? 'PostgreSQL' : 'файл leads.json'));
    if (STORE_TOKEN.indexOf('ПОМЕНЯЙТЕ') !== -1) console.log('!!! Задайте STORE_TOKEN в переменных окружения !!!');
  devicesLoad().then(d => console.log('[авторизация компа] в базе компов: ' + d.length)).catch(() => {});
  }));
