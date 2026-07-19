/* ============================================================
   STORE CONTROL — СЕРВЕР ПРИЁМА ЗАЯВОК С САЙТА (Node.js)
   Без зависимостей: ничего устанавливать не нужно.

   Что делает:
   • POST /api/lead   — принимает заявку с формы сайта (публично)
   • GET  /api/leads  — отдаёт заявки в ERP (только с секретным токеном)
   Заявки хранятся в файле leads.json рядом с этим скриптом.

   Запуск:
     1) Создайте .env по примеру .env.example
     2) node storecontrolapi.js
   Адрес API для формы и для ERP: http://ваш-сервер:3000/api
============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine.startsWith('#')) return;
    const eq = cleanLine.indexOf('=');
    if (eq === -1) return;
    const key = cleanLine.slice(0, eq).trim();
    let value = cleanLine.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  });
}
loadEnvFile();

/* ===== НАСТРОЙКИ ===== */
const PORT = process.env.PORT || 3000;
const STORE_TOKEN = process.env.STORE_TOKEN || 'ПОМЕНЯЙТЕ-МЕНЯ-длинный-случайный-секрет';
const DB_FILE = path.join(__dirname, 'leads.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_CONFIGURED = Boolean(OPENAI_API_KEY && !/^paste-|^your-|^change-/i.test(OPENAI_API_KEY));
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || '260', 10);
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '15000', 10);
/* ===================== */

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { nextId: 1, leads: [] }; }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* Простейшая защита от флуда: не больше 5 заявок в минуту с одного IP */
const hits = new Map();
function floodOk(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 5) return false;
  arr.push(now); hits.set(ip, arr);
  return true;
}

const clean = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, { error: 'Файл не найден' });
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
  });
}

function readJsonBody(req, maxBytes = 120000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', ch => {
      raw += ch;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function cleanList(items, limit, mapper) {
  return (Array.isArray(items) ? items : []).slice(0, limit).map(mapper).filter(Boolean);
}

function buildAiInstructions() {
  return [
    'Ты AI-продавец и внутренний помощник сети магазинов iMagnate.',
    'Отвечай как живой продавец: спокойно, по делу, коротко, без канцелярита и без выдуманных фактов.',
    'Главное правило: не придумывай наличие, цену, гарантию, комплектацию, состояние и адрес. Используй только данные из запроса и контекста CRM.',
    'Если товар найден и есть свободный остаток, подтверди наличие, цену, комплект/проверку и предложи резерв или приезд.',
    'Если товар занят резервом, на проверке или не найден, честно скажи, что нужно сверить/предложить альтернативу.',
    'Если вопрос про trade-in или выкуп, попроси модель, память, состояние, процент аккумулятора, комплект и фото.',
    'Если вопрос про ремонт, попроси модель, неисправность, был ли ремонт, включается ли устройство, и передай к мастеру.',
    'Если вопрос внутренний для сотрудника, отвечай как помощник CRM, но не отправляй клиенту спорные инструкции.',
    'Не упоминай, что ты нейросеть, API, модель или демо. Пиши от лица продавца iMagnate.',
    'Ответ должен быть готовым текстом для отправки клиенту. Максимум 4 коротких предложения.'
  ].join('\n');
}

function buildAiInput(body) {
  const stock = cleanList(body.stock, 80, item => {
    const name = clean(item.name || item.model || item.title, 140);
    if (!name) return '';
    const price = Number(item.price || 0) ? String(item.price) : 'нет цены';
    const qty = item.qty == null ? '' : String(item.qty);
    const status = clean(item.status || '', 40);
    const tab = clean(item.tab || item.kind || item.category || '', 40);
    return `- ${name}; раздел: ${tab || 'не указан'}; цена: ${price}; остаток: ${qty || 'не указан'}; статус: ${status || 'не указан'}`;
  }).join('\n');
  const knowledge = cleanList(body.knowledge, 24, item => {
    const topic = clean(item.topic || item.intent || item.question || '', 120);
    const answer = clean(item.answer || '', 500);
    return topic && answer ? `- ${topic}: ${answer}` : '';
  }).join('\n');
  const product = body.product || {};
  const availability = body.availability || {};
  const lead = body.lead || {};
  return [
    `Канал клиента: ${clean(body.channel || lead.channel || 'crm', 40)}`,
    `Имя клиента: ${clean(lead.name || body.customer || 'Клиент', 80)}`,
    `Вопрос клиента: ${clean(body.question, 1500)}`,
    `Товар из заявки: ${clean(body.item || lead.item || '', 160) || 'не указан'}`,
    `Распознанный товар: ${clean(product.name || '', 160) || 'не найден'}`,
    `Цена из CRM: ${Number(product.price || 0) ? product.price + ' руб.' : 'нет точной цены'}`,
    `Наличие из CRM: ${clean(availability.label || '', 80) || 'неизвестно'}; ${clean(availability.detail || '', 220)}`,
    `Локальный черновик CRM: ${clean(body.localDraft || '', 1200)}`,
    '',
    'Остатки CRM:',
    stock || '- нет переданных остатков',
    '',
    'Базовые правила/ответы магазина:',
    knowledge || '- нет дополнительных правил',
    '',
    'Сформируй один финальный ответ клиенту. Если данных не хватает, попроси ровно то, что нужно уточнить.'
  ].join('\n');
}

function extractOpenAiText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  (data.output || []).forEach(part => {
    (part.content || []).forEach(c => {
      if (typeof c.text === 'string') chunks.push(c.text);
      if (typeof c.output_text === 'string') chunks.push(c.output_text);
    });
  });
  if (chunks.length) return chunks.join('\n').trim();
  const legacy = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return typeof legacy === 'string' ? legacy.trim() : '';
}

function postJson(targetUrl, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const u = new URL(targetUrl);
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      },
      timeout: OPENAI_TIMEOUT_MS
    }, r => {
      let raw = '';
      r.on('data', ch => raw += ch);
      r.on('end', () => {
        let data = {};
        try { data = JSON.parse(raw || '{}'); }
        catch (e) { return reject(new Error('bad_openai_json')); }
        resolve({ statusCode: r.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('openai_timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      app: 'Store Control ERP',
      aiConfigured: OPENAI_CONFIGURED,
      at: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    return send(res, 200, {
      ok: true,
      provider: 'openai',
      configured: OPENAI_CONFIGURED,
      model: OPENAI_MODEL
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/reply') {
    return send(res, 405, {
      ok: false,
      error: 'Этот AI-адрес работает только из CRM через POST-запрос. Для проверки откройте /api/ai/status или задайте вопрос в диалоге CRM.'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/reply') {
    readJsonBody(req, 180000).then(async body => {
      if (!OPENAI_CONFIGURED) return send(res, 503, { ok: false, error: 'OPENAI_API_KEY не задан на сервере' });
      const question = clean(body.question, 1500);
      if (!question) return send(res, 400, { ok: false, error: 'Нет вопроса клиента' });

      const payload = {
        model: OPENAI_MODEL,
        instructions: buildAiInstructions(),
        input: buildAiInput(body),
        max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        temperature: 0.35
      };

      try {
        const result = await postJson(OPENAI_API_BASE + '/responses', payload, {
          Authorization: 'Bearer ' + OPENAI_API_KEY
        });
        if (result.statusCode < 200 || result.statusCode >= 300) {
          const detail = result.data && result.data.error && result.data.error.message
            ? clean(result.data.error.message, 500)
            : 'OpenAI вернул ошибку';
          return send(res, 502, { ok: false, error: detail });
        }
        const text = extractOpenAiText(result.data);
        if (!text) return send(res, 502, { ok: false, error: 'OpenAI вернул пустой ответ' });
        return send(res, 200, {
          ok: true,
          provider: 'openai',
          model: OPENAI_MODEL,
          text,
          usage: result.data.usage || null
        });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message || 'OpenAI недоступен' });
      }
    }).catch(e => {
      send(res, e.message === 'body_too_large' ? 413 : 400, {
        ok: false,
        error: e.message === 'bad_json' ? 'Неверный JSON' : 'Слишком большой запрос'
      });
    });
    return;
  }

  /* ---- Сайт отправляет заявку (без токена — форма публичная) ---- */
  if (req.method === 'POST' && url.pathname === '/api/lead') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if (!floodOk(ip)) return send(res, 429, { error: 'Слишком часто. Попробуйте через минуту.' });

    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 50000) req.destroy(); });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { error: 'Неверный JSON' }); }
      const name = clean(b.name, 80);
      const phone = clean(b.phone, 30);
      if (!name || !phone) return send(res, 400, { error: 'Нужны имя и телефон' });

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
      send(res, 200, { ok: true, id: lead.id });
    });
    return;
  }

  /* ---- ERP забирает новые заявки (только с токеном) ---- */
  if (req.method === 'GET' && url.pathname === '/api/leads') {
    const auth = req.headers.authorization || ('Bearer ' + (url.searchParams.get('token') || ''));
    if (auth !== 'Bearer ' + STORE_TOKEN) return send(res, 401, { error: 'Неверный токен' });

    const since = parseInt(url.searchParams.get('since')) || 0;
    const db = readDb();
    return send(res, 200, { leads: db.leads.filter(l => l.id > since) });
  }

  if (req.method === 'GET') {
    let requested = url.pathname === '/' ? '/store-control-erp.html' : url.pathname;
    try { requested = decodeURIComponent(requested); }
    catch (e) { requested = '/store-control-erp.html'; }
    const root = path.resolve(__dirname);
    const filePath = path.resolve(root, requested.replace(/^\/+/, ''));
    const insideRoot = filePath === root || filePath.startsWith(root + path.sep);
    if (insideRoot && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return sendFile(res, filePath);
    }
  }

  send(res, 404, { error: 'Неизвестный запрос' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Store Control API запущен: http://localhost:' + PORT + '/api');
  console.log('Не забудьте поменять STORE_TOKEN!');
});
