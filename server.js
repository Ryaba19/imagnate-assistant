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
  await pool.query(
    'CREATE TABLE IF NOT EXISTS channel_msgs (' +
    ' key TEXT PRIMARY KEY,' +
    ' channel TEXT, chat_id TEXT, dir TEXT,' +
    ' name TEXT, contact TEXT, item TEXT, text_ TEXT,' +
    ' ts_ms BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );
  console.log('PostgreSQL подключена — заявки в site_leads, облачная база ERP в erp_state, каналы в channel_msgs');
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

/* ============================================================
   КАНАЛЫ ВОРОНКИ: Авито / Telegram-личка / ВКонтакте / MAX.
   Ключи — в Environment. Сервер опрашивает платформы по запросу ERP
   (не чаще раза в 20 секунд на канал), складывает сообщения в
   channel_msgs (дедупликация по key) и отдаёт их ERP. Ответ продавца
   уходит клиенту обратно в его канал.
============================================================ */
const AVITO_ID = process.env.AVITO_CLIENT_ID || '';
const AVITO_SECRET = process.env.AVITO_CLIENT_SECRET || '';
const VK_TOKEN = process.env.VK_GROUP_TOKEN || '';
const MAX_TOKEN = process.env.MAX_BOT_TOKEN || '';

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

/* --- хранилище сообщений (PG или файл) --- */
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
      'INSERT INTO channel_msgs (key,channel,chat_id,dir,name,contact,item,text_,ts_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (key) DO NOTHING',
      [m.key, m.channel, m.chatId, m.dir, m.name || '', m.contact || '', m.item || '', m.text || '', m.tsMs || Date.now()]);
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
      'SELECT key, channel, chat_id AS "chatId", dir, name, contact, item, text_ AS text, ts_ms AS "tsMs" FROM channel_msgs WHERE ts_ms > $1 ORDER BY ts_ms LIMIT $2',
      [sinceMs || 0, limit || 500]);
    return r.rows.map(x => Object.assign({}, x, { tsMs: Number(x.tsMs) }));
  }
  return chFile().filter(x => (x.tsMs || 0) > (sinceMs || 0)).slice(0, limit || 500);
}

/* --- состояние каналов (для вкладки «Интеграции» в ERP) --- */
const chState = {
  avito:    { configured: !!(AVITO_ID && AVITO_SECRET), ok: null, error: null, lastPoll: 0 },
  telegram: { configured: !!TG_TOKEN, ok: null, error: null, lastPoll: 0 },
  vk:       { configured: !!VK_TOKEN, ok: null, error: null, lastPoll: 0 },
  max:      { configured: !!MAX_TOKEN, ok: null, error: null, lastPoll: 0 },
};

/* --- АВИТО (Messenger API) --- */
let avitoTok = null, avitoTokExp = 0, avitoUid = null;
async function avitoToken() {
  if (avitoTok && Date.now() < avitoTokExp - 60000) return avitoTok;
  const r = await fetch('https://api.avito.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(AVITO_ID) + '&client_secret=' + encodeURIComponent(AVITO_SECRET)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Авито не выдал токен: ' + JSON.stringify(j).slice(0, 150));
  avitoTok = j.access_token;
  avitoTokExp = Date.now() + (j.expires_in || 86400) * 1000;
  return avitoTok;
}
async function avitoApi(p, opts) {
  const t = await avitoToken();
  const o = opts || {};
  o.headers = Object.assign({ 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }, o.headers || {});
  const r = await fetch('https://api.avito.ru' + p, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Авито HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 150));
  return j;
}
async function avitoUserId() {
  if (avitoUid) return avitoUid;
  const j = await avitoApi('/core/v1/accounts/self');
  if (!j.id) throw new Error('Авито: не удалось получить id аккаунта');
  avitoUid = j.id;
  return avitoUid;
}
async function avitoPoll() {
  const uid = await avitoUserId();
  const cur = parseInt(await kvGet('avito_cursor')) || 0;   /* unix-секунды последнего обновления чата */
  let maxSeen = cur, added = 0;
  const j = await avitoApi('/messenger/v2/accounts/' + uid + '/chats?limit=30');
  for (const chat of (j.chats || [])) {
    const upd = chat.updated || 0;
    if (upd <= cur) continue;
    if (upd > maxSeen) maxSeen = upd;
    const other = (chat.users || []).find(u => u.id !== uid) || {};
    const item = (chat.context && chat.context.value && chat.context.value.title) || '';
    let mj = null;
    try { mj = await avitoApi('/messenger/v3/accounts/' + uid + '/chats/' + chat.id + '/messages/?limit=30'); }
    catch (e) { console.error('[авито] сообщения чата', chat.id, e.message); continue; }
    const msgs = Array.isArray(mj) ? mj : (mj.messages || []);
    for (const m of msgs) {
      if (m.author_id === uid) continue;                    /* наши ответы */
      if ((m.created || 0) <= cur) continue;
      const text = (m.content && (m.content.text ||
        (m.content.link && m.content.link.url) ||
        (m.content.location && 'Геолокация') ||
        (m.content.call && 'Звонок'))) ||
        (m.type === 'image' ? '[изображение]' : '');
      if (!text) continue;
      if (await chStore({ key: 'av_' + m.id, channel: 'avito', chatId: String(chat.id), dir: 'in',
        name: other.name || 'Клиент Авито', contact: '', item: String(item).slice(0, 120),
        text: String(text).slice(0, 2000), tsMs: (m.created || 0) * 1000 })) added++;
    }
    /* отмечаем чат прочитанным, чтобы счётчик в Авито не висел */
    try { await avitoApi('/messenger/v1/accounts/' + uid + '/chats/' + chat.id + '/read', { method: 'POST' }); } catch (e) {}
  }
  if (maxSeen > cur) await kvSet('avito_cursor', maxSeen);
  return added;
}
async function avitoSend(chatId, text) {
  const uid = await avitoUserId();
  await avitoApi('/messenger/v1/accounts/' + uid + '/chats/' + chatId + '/messages', {
    method: 'POST',
    body: JSON.stringify({ message: { text: String(text).slice(0, 2000) }, type: 'text' })
  });
  return { ok: true };
}

/* --- TELEGRAM-ЛИЧКА (клиенты пишут нашему боту) --- */
async function tgPoll() {
  const cur = parseInt(await kvGet('tg_offset')) || 0;
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?timeout=0' + (cur ? ('&offset=' + (cur + 1)) : ''));
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'ошибка'));
  let added = 0, maxU = cur;
  for (const u of (j.result || [])) {
    if (u.update_id > maxU) maxU = u.update_id;
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== 'private') continue;
    const cid = String(m.chat.id);
    if (TG_CHATS.includes(cid)) continue;                   /* владелец и директора — не заявки */
    const text = m.text || m.caption || '';
    if (!text || text.startsWith('/start')) continue;
    const name = (((m.from && m.from.first_name) || '') + ' ' + ((m.from && m.from.last_name) || '')).trim();
    if (await chStore({ key: 'tg_' + u.update_id, channel: 'telegram', chatId: cid, dir: 'in',
      name: name || 'Клиент Telegram',
      contact: (m.from && m.from.username) ? ('tg: @' + m.from.username) : '',
      item: '', text: String(text).slice(0, 2000), tsMs: (m.date || 0) * 1000 })) added++;
  }
  if (maxU > cur) await kvSet('tg_offset', maxU);
  return added;
}
async function tgSendTo(chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) })
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'не отправилось'));
  return { ok: true };
}

/* --- ВКОНТАКТЕ (сообщения сообщества) --- */
async function vkApi(method, params) {
  const qs = new URLSearchParams(Object.assign({ access_token: VK_TOKEN, v: '5.199' }, params || {}));
  const r = await fetch('https://api.vk.com/method/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs.toString()
  });
  const j = await r.json();
  if (j.error) throw new Error('ВК: ' + (j.error.error_msg || j.error.error_code));
  return j.response;
}
async function vkPoll() {
  const cur = parseInt(await kvGet('vk_cursor')) || 0;      /* unix-секунды */
  const resp = await vkApi('messages.getConversations', { count: 20, filter: 'all' });
  let added = 0, maxSeen = cur;
  const names = {};
  const needNames = [];
  for (const it of (resp.items || [])) {
    const lm = it.last_message || {};
    if ((lm.date || 0) > cur && !lm.out && lm.from_id > 0) needNames.push(lm.from_id);
  }
  if (needNames.length) {
    try {
      const us = await vkApi('users.get', { user_ids: needNames.join(',') });
      (us || []).forEach(u => { names[u.id] = ((u.first_name || '') + ' ' + (u.last_name || '')).trim(); });
    } catch (e) {}
  }
  for (const it of (resp.items || [])) {
    const peer = it.conversation && it.conversation.peer && it.conversation.peer.id;
    const lm = it.last_message || {};
    if (!peer || (lm.date || 0) <= cur) continue;
    if (lm.date > maxSeen) maxSeen = lm.date;
    /* берём историю переписки — клиент мог написать несколько сообщений подряд */
    let hist = [];
    try {
      const h = await vkApi('messages.getHistory', { peer_id: peer, count: 20 });
      hist = (h.items || []).filter(m => (m.date || 0) > cur && !m.out);
    } catch (e) { if (!lm.out) hist = [lm]; }
    for (const m of hist) {
      const mid = m.id || m.conversation_message_id || m.date;
      if (await chStore({ key: 'vk_' + peer + '_' + mid, channel: 'vk', chatId: String(peer), dir: 'in',
        name: names[m.from_id] || 'Клиент ВКонтакте', contact: 'vk.com/id' + (m.from_id || peer),
        item: '', text: String(m.text || '[вложение]').slice(0, 2000), tsMs: (m.date || 0) * 1000 })) added++;
    }
  }
  if (maxSeen > cur) await kvSet('vk_cursor', maxSeen);
  return added;
}
async function vkSend(peerId, text) {
  await vkApi('messages.send', { peer_id: peerId, message: String(text).slice(0, 4000), random_id: Date.now() % 2000000000 });
  return { ok: true };
}

/* --- MAX (бот-платформа) --- */
async function maxPoll() {
  const cur = await kvGet('max_marker');
  const r = await fetch('https://botapi.max.ru/updates?access_token=' + encodeURIComponent(MAX_TOKEN) +
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
    if (await chStore({ key: 'mx_' + ((m.body && m.body.mid) || (cid + '_' + u.timestamp)), channel: 'max', chatId: cid, dir: 'in',
      name: (m.sender && m.sender.name) || 'Клиент MAX',
      contact: (m.sender && m.sender.username) ? ('max: ' + m.sender.username) : '',
      item: '', text: String(text).slice(0, 2000), tsMs: u.timestamp || Date.now() })) added++;
  }
  if (j.marker != null) await kvSet('max_marker', j.marker);
  return added;
}
async function maxSend(chatId, text) {
  const r = await fetch('https://botapi.max.ru/messages?access_token=' + encodeURIComponent(MAX_TOKEN) + '&chat_id=' + encodeURIComponent(chatId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text).slice(0, 4000) })
  });
  const j = await r.json().catch(() => ({}));
  if (j.code || j.error) throw new Error('MAX: ' + JSON.stringify(j).slice(0, 150));
  return { ok: true };
}

/* --- общий опрос: не чаще раза в 20 сек на канал --- */
const CH_POLLERS = { avito: avitoPoll, telegram: tgPoll, vk: vkPoll, max: maxPoll };
async function channelsPollAll() {
  const now = Date.now();
  for (const ch of Object.keys(CH_POLLERS)) {
    const st = chState[ch];
    if (!st.configured) continue;
    if (now - st.lastPoll < 20000) continue;
    st.lastPoll = now;
    try {
      const n = await CH_POLLERS[ch]();
      st.ok = true; st.error = null;
      if (n) console.log('[канал ' + ch + '] новых сообщений: ' + n);
    } catch (e) {
      st.ok = false; st.error = String(e.message || e).slice(0, 200);
      console.error('[канал ' + ch + ']', st.error);
    }
  }
}
const CH_SENDERS = { avito: avitoSend, telegram: tgSendTo, vk: vkSend, max: maxSend };

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

  /* ---- Тестовая заявка одной ссылкой (по токену): полный боевой путь ---- */
  if (req.method === 'GET' && url.pathname === '/api/lead-test') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
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

  /* ---- Каналы воронки: опрос и выдача новых сообщений (по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/channels/poll') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      try {
        await channelsPollAll();
        const sinceMs = Number(b.sinceMs) || (Date.now() - 7 * 86400000);
        const msgs = await chList(sinceMs, 500);
        sendJson(res, 200, { ok: true, messages: msgs.filter(m => m.dir === 'in'), status: chState });
      } catch (e) {
        console.error('[каналы] опрос:', e.message);
        sendJson(res, 500, { error: e.message });
      }
    });
  }

  /* ---- Каналы воронки: ответ клиенту в его канал (по токену) ---- */
  if (req.method === 'POST' && url.pathname === '/api/channels/reply') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return readBody(req, async b => {
      const ch = String(b.channel || ''), cid = String(b.chatId || ''), text = String(b.text || '').trim();
      if (!CH_SENDERS[ch]) return sendJson(res, 400, { error: 'Канал не поддерживается: ' + ch });
      if (!cid || !text) return sendJson(res, 400, { error: 'Нужны chatId и text' });
      if (!chState[ch].configured) return sendJson(res, 500, { error: 'Ключи канала не заданы на сервере' });
      try {
        await CH_SENDERS[ch](cid, text);
        await chStore({ key: 'out_' + ch + '_' + cid + '_' + Date.now(), channel: ch, chatId: cid, dir: 'out',
          name: '', contact: '', item: '', text: text.slice(0, 2000), tsMs: Date.now() });
        console.log('[канал ' + ch + '] ответ отправлен в чат ' + cid);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error('[канал ' + ch + '] отправка:', e.message);
        sendJson(res, 500, { error: String(e.message || e).slice(0, 300) });
      }
    });
  }

  /* ---- Каналы воронки: состояние (по токену) ---- */
  if (req.method === 'GET' && url.pathname === '/api/channels/status') {
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'Неверный токен' });
    return sendJson(res, 200, { ok: true, status: chState });
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
