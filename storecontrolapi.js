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
const DATABASE_URL = process.env.DATABASE_URL || '';
const PG_SSL_MODE = process.env.PG_SSL_MODE || 'require';
const PG_POOL_MAX = parseInt(process.env.PG_POOL_MAX || '5', 10);
/* ===================== */

let PgPool = null;
let PG_DRIVER_SOURCE = '';
try {
  PgPool = require('pg').Pool;
  PG_DRIVER_SOURCE = 'node_modules';
} catch (e) {
  try {
    PgPool = require('./vendor/node_modules/pg').Pool;
    PG_DRIVER_SOURCE = 'vendor';
  } catch (fallbackError) {
    PgPool = null;
    PG_DRIVER_SOURCE = '';
  }
}

const POSTGRES_DRIVER_INSTALLED = Boolean(PgPool);
const POSTGRES_CONFIGURED = Boolean(DATABASE_URL && POSTGRES_DRIVER_INSTALLED);
const pgPool = POSTGRES_CONFIGURED ? new PgPool({
  connectionString: DATABASE_URL,
  max: PG_POOL_MAX,
  ssl: PG_SSL_MODE === 'disable' ? false : { rejectUnauthorized: false }
}) : null;

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { nextId: 1, leads: [] }; }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function dbReadyMessage() {
  if (!DATABASE_URL) return 'DATABASE_URL не задан';
  if (!POSTGRES_DRIVER_INSTALLED) return 'Драйвер pg не установлен';
  return 'PostgreSQL подключен';
}

function requireStoreAuth(req, url) {
  const token = url.searchParams.get('token') || '';
  const auth = req.headers.authorization || (token ? 'Bearer ' + token : '');
  return auth === 'Bearer ' + STORE_TOKEN;
}

async function pgQuery(sql, params = []) {
  if (!pgPool) throw new Error(dbReadyMessage());
  return pgPool.query(sql, params);
}

async function initPostgresSchema() {
  if (!POSTGRES_CONFIGURED) return false;
  const schemaPath = path.join(__dirname, 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pgQuery(sql);
  return true;
}

function normalizeCode(value) {
  return clean(value, 120).replace(/\s+/g, '').toUpperCase();
}

function normalizeCategory(value) {
  const category = clean(value, 40).toLowerCase();
  return ['tech', 'tradein', 'accessories', 'parts'].includes(category) ? category : 'tech';
}

function categoryLabel(category) {
  return { tech: 'Техника', tradein: 'Trade-in', accessories: 'Аксессуары', parts: 'Запчасти' }[category] || category;
}

function productKey(name, category) {
  return (category + '|' + String(name || '').toLowerCase()).replace(/\s+/g, ' ').trim();
}

function moneyValue(value) {
  return Math.max(0, Number(value || 0) || 0);
}

function intValue(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > 8000) return {};
  return value;
}

function receiveMetadata(body) {
  const source = safeMetadata(body.metadata);
  const metadata = { ...source };
  const pairs = [
    ['memory', body.memory],
    ['color', body.color],
    ['condition', body.condition],
    ['kit', body.kit || body.complectation],
    ['warrantyDays', body.warrantyDays],
    ['batteryPercent', body.batteryPercent || body.battery],
    ['comment', body.comment],
    ['minStock', body.minStock]
  ];
  pairs.forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') metadata[key] = value;
  });
  return metadata;
}

async function receiveScanInPostgres(body) {
  const category = normalizeCategory(body.category || body.tab);
  const code = normalizeCode(body.code || body.imei || body.sku || body.barcode);
  const model = clean(body.model || body.name, 180);
  if (!code || !model) throw new Error('Нужны код и название товара');

  const stockMode = category === 'tech' || category === 'tradein' ? 'unit' : 'batch';
  const metadata = receiveMetadata(body);
  const qty = stockMode === 'unit' ? 1 : Math.max(1, intValue(body.qty || '1', 1));
  const purchase = moneyValue(body.purchase || body.purchasePrice);
  const price = moneyValue(body.price || body.salePrice);
  const minStock = Math.max(0, intValue(body.minStock || metadata.minStock, stockMode === 'batch' ? 2 : 1));
  const status = clean(body.status || (category === 'tradein' ? 'check' : 'instock'), 40);
  const location = clean(body.location || 'Склад', 120);
  const actor = clean(body.actor || body.scannedBy || 'system', 120);
  const now = new Date();
  const key = productKey(model, category);

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const productResult = await client.query(`
      INSERT INTO products
        (product_key, name, category, category_label, stock_mode, default_purchase_price, default_sale_price, min_stock, source, metadata, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scanner',$9::jsonb,now())
      ON CONFLICT (product_key) DO UPDATE SET
        name=EXCLUDED.name,
        default_purchase_price=EXCLUDED.default_purchase_price,
        default_sale_price=EXCLUDED.default_sale_price,
        min_stock=EXCLUDED.min_stock,
        metadata=products.metadata || EXCLUDED.metadata,
        updated_at=now()
      RETURNING id
    `, [key, model, category, categoryLabel(category), stockMode, purchase, price, minStock, JSON.stringify(metadata)]);
    const productId = productResult.rows[0].id;

    let unitId = null;
    let batchId = null;
    if (stockMode === 'unit') {
      const unitResult = await client.query(`
        INSERT INTO stock_units
          (product_id, unit_code, imei, category, status, purchase_price, sale_price, location, scanned_at, scanned_by, source, metadata, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scanner',$11::jsonb,now())
        ON CONFLICT (unit_code) DO UPDATE SET
          product_id=EXCLUDED.product_id,
          status=EXCLUDED.status,
          purchase_price=EXCLUDED.purchase_price,
          sale_price=EXCLUDED.sale_price,
          location=EXCLUDED.location,
          scanned_by=EXCLUDED.scanned_by,
          metadata=stock_units.metadata || EXCLUDED.metadata,
          updated_at=now()
        RETURNING id
      `, [productId, code, code, category, status, purchase, price, location, now, actor, JSON.stringify(metadata)]);
      unitId = unitResult.rows[0].id;
    } else {
      const batchResult = await client.query(`
        INSERT INTO stock_batches
          (product_id, sku, barcode, category, qty, status, purchase_price, sale_price, location, scanned_at, scanned_by, source, metadata, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scanner',$12::jsonb,now())
        ON CONFLICT (barcode) DO UPDATE SET
          product_id=EXCLUDED.product_id,
          sku=EXCLUDED.sku,
          qty=GREATEST(stock_batches.qty, EXCLUDED.qty),
          status=EXCLUDED.status,
          purchase_price=EXCLUDED.purchase_price,
          sale_price=EXCLUDED.sale_price,
          location=EXCLUDED.location,
          scanned_by=EXCLUDED.scanned_by,
          metadata=stock_batches.metadata || EXCLUDED.metadata,
          updated_at=now()
        RETURNING id
      `, [productId, code, code, category, qty, status, purchase, price, location, now, actor, JSON.stringify(metadata)]);
      batchId = batchResult.rows[0].id;
    }

    const dedupeKey = `scan_receive:${code}`;
    await client.query(`
      INSERT INTO stock_movements
        (dedupe_key, movement_type, product_id, unit_id, batch_id, code, model, category, qty, amount, location, actor, note, metadata, happened_at)
      VALUES ($1,'scan_receive',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
      ON CONFLICT (dedupe_key) DO NOTHING
    `, [dedupeKey, productId, unitId, batchId, code, model, category, qty, purchase * qty, location, actor, 'Добавление товара через сканер', JSON.stringify(metadata), now]);

    await client.query(`
      INSERT INTO audit_log (entity_type, entity_id, action, actor, after_data)
      VALUES ('stock', $1, 'scan_receive', $2, $3::jsonb)
    `, [unitId || batchId || productId, actor, JSON.stringify({ code, model, category, qty, purchase, price, status, location, metadata })]);

    await client.query('COMMIT');
    return { productId, unitId, batchId, code, category, qty };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function localDateTime(value) {
  const iso = isoDate(value);
  if (!iso) return '';
  return iso.slice(0, 19).replace('T', ' ');
}

async function stockSnapshotFromPostgres() {
  if (!POSTGRES_CONFIGURED) throw new Error(dbReadyMessage());
  const [productsResult, unitsResult, batchesResult, movementsResult] = await Promise.all([
    pgQuery(`
      SELECT id, product_key, name, category, category_label, stock_mode,
             default_purchase_price, default_sale_price, min_stock, source,
             metadata, created_at, updated_at
      FROM products
      ORDER BY updated_at DESC, name ASC
    `),
    pgQuery(`
      SELECT u.*, p.name AS product_name, p.min_stock AS product_min_stock, p.metadata AS product_metadata
      FROM stock_units u
      JOIN products p ON p.id = u.product_id
      ORDER BY u.updated_at DESC
    `),
    pgQuery(`
      SELECT b.*, p.name AS product_name, p.min_stock AS product_min_stock, p.metadata AS product_metadata
      FROM stock_batches b
      JOIN products p ON p.id = b.product_id
      ORDER BY b.updated_at DESC
    `),
    pgQuery(`
      SELECT id, movement_type, product_id, unit_id, batch_id, code, model, category,
             qty, amount, location, actor, note, metadata, happened_at
      FROM stock_movements
      ORDER BY happened_at DESC
      LIMIT 300
    `)
  ]);

  const warehouse = { tech: [], tradein: [], accessories: [], parts: [] };
  const scannerStock = { tech: [], tradein: [], accessories: [], parts: [] };

  const products = productsResult.rows.map(row => ({
    id: String(row.id),
    key: row.product_key,
    name: row.name,
    category: row.category,
    categoryLabel: row.category_label,
    stockMode: row.stock_mode,
    defaultPurchasePrice: moneyValue(row.default_purchase_price),
    defaultSalePrice: moneyValue(row.default_sale_price),
    minStock: intValue(row.min_stock, 0),
    source: row.source,
    metadata: safeMetadata(row.metadata),
    createdAt: localDateTime(row.created_at),
    updatedAt: localDateTime(row.updated_at)
  }));

  const stockUnits = unitsResult.rows.map(row => {
    const metadata = safeMetadata({ ...(row.product_metadata || {}), ...(row.metadata || {}) });
    const item = {
      imei: row.unit_code || row.imei || row.serial_number || '',
      unitCode: row.unit_code || '',
      serialNumber: row.serial_number || '',
      model: row.product_name,
      purchase: moneyValue(row.purchase_price),
      price: moneyValue(row.sale_price),
      status: row.status || 'instock',
      location: row.location || 'Склад',
      scannerTracked: true,
      scannedAt: localDateTime(row.scanned_at),
      scannedBy: row.scanned_by || 'system',
      source: row.source || 'server',
      postgresId: String(row.id),
      dbProductId: String(row.product_id),
      dbUnitId: String(row.id),
      metadata,
      ...metadata
    };
    const category = normalizeCategory(row.category);
    warehouse[category].push({ ...item });
    scannerStock[category].push({ ...item });
    return {
      id: String(row.id),
      productId: String(row.product_id),
      unitCode: row.unit_code || '',
      imei: row.imei || row.unit_code || '',
      serialNumber: row.serial_number || '',
      category,
      status: row.status || 'instock',
      purchasePrice: moneyValue(row.purchase_price),
      salePrice: moneyValue(row.sale_price),
      location: row.location || 'Склад',
      scannedAt: localDateTime(row.scanned_at),
      scannedBy: row.scanned_by || 'system',
      source: row.source || 'server',
      metadata
    };
  });

  const stockBatches = batchesResult.rows.map(row => {
    const metadata = safeMetadata({ ...(row.product_metadata || {}), ...(row.metadata || {}) });
    const category = normalizeCategory(row.category);
    const item = {
      sku: row.sku || row.barcode || '',
      barcode: row.barcode || row.sku || '',
      model: row.product_name,
      purchase: moneyValue(row.purchase_price),
      price: moneyValue(row.sale_price),
      qty: Math.max(0, intValue(row.qty, 0)),
      minStock: intValue(row.product_min_stock, 0),
      status: row.status || 'instock',
      location: row.location || 'Склад',
      scannerTracked: true,
      scannedAt: localDateTime(row.scanned_at),
      scannedBy: row.scanned_by || 'system',
      source: row.source || 'server',
      postgresId: String(row.id),
      dbProductId: String(row.product_id),
      dbBatchId: String(row.id),
      metadata,
      ...metadata
    };
    warehouse[category].push({ ...item });
    scannerStock[category].push({ ...item });
    return {
      id: String(row.id),
      productId: String(row.product_id),
      sku: row.sku || row.barcode || '',
      barcode: row.barcode || row.sku || '',
      category,
      qty: Math.max(0, intValue(row.qty, 0)),
      status: row.status || 'instock',
      purchasePrice: moneyValue(row.purchase_price),
      salePrice: moneyValue(row.sale_price),
      location: row.location || 'Склад',
      scannedAt: localDateTime(row.scanned_at),
      scannedBy: row.scanned_by || 'system',
      source: row.source || 'server',
      metadata
    };
  });

  const stockMovements = movementsResult.rows.map(row => ({
    id: String(row.id),
    type: row.movement_type,
    productId: row.product_id ? String(row.product_id) : null,
    unitId: row.unit_id ? String(row.unit_id) : null,
    batchId: row.batch_id ? String(row.batch_id) : null,
    code: row.code,
    model: row.model,
    category: normalizeCategory(row.category),
    qty: intValue(row.qty, 0),
    amount: moneyValue(row.amount),
    location: row.location || 'Склад',
    by: row.actor || 'system',
    note: row.note || '',
    at: localDateTime(row.happened_at),
    metadata: safeMetadata(row.metadata)
  }));

  return {
    ok: true,
    source: 'postgres',
    exportedAt: new Date().toISOString(),
    stats: {
      products: products.length,
      units: stockUnits.length,
      batches: stockBatches.length,
      batchQty: stockBatches.reduce((sum, row) => sum + (row.qty || 0), 0),
      movements: stockMovements.length
    },
    warehouse,
    scannerStock,
    coreDb: {
      version: 1,
      products,
      stockUnits,
      stockBatches,
      stockMovements,
      updatedAt: new Date().toISOString()
    }
  };
}

function importPayloadsFromBody(body) {
  const items = [];
  if (Array.isArray(body.items)) items.push(...body.items);
  const db = body.db || body.coreDb;
  if (db && typeof db === 'object') {
    const productsById = new Map((Array.isArray(db.products) ? db.products : []).map(product => [String(product.id), product]));
    (Array.isArray(db.stockUnits) ? db.stockUnits : []).forEach(unit => {
      const product = productsById.get(String(unit.productId)) || {};
      items.push({
        code: unit.unitCode || unit.imei || unit.serialNumber,
        category: unit.category || product.category || 'tech',
        model: product.name || unit.model,
        purchase: unit.purchasePrice,
        price: unit.salePrice,
        qty: 1,
        status: unit.status,
        location: unit.location,
        actor: unit.scannedBy,
        metadata: { ...(product.metadata || {}), ...(unit.metadata || {}) }
      });
    });
    (Array.isArray(db.stockBatches) ? db.stockBatches : []).forEach(batch => {
      const product = productsById.get(String(batch.productId)) || {};
      items.push({
        code: batch.barcode || batch.sku,
        category: batch.category || product.category || 'accessories',
        model: product.name || batch.model,
        purchase: batch.purchasePrice,
        price: batch.salePrice,
        qty: batch.qty,
        status: batch.status,
        location: batch.location,
        actor: batch.scannedBy,
        minStock: product.minStock,
        metadata: { ...(product.metadata || {}), ...(batch.metadata || {}) }
      });
    });
  }
  return items
    .map(item => ({ ...item, code: normalizeCode(item.code || item.imei || item.sku || item.barcode), model: clean(item.model || item.name, 180) }))
    .filter(item => item.code && item.model)
    .slice(0, 1000);
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

function buildAiInstructionsV2() {
  return [
    'Ты AI-продавец и внутренний помощник сети магазинов iMagnate.',
    'Отвечай как живой продавец: спокойно, по делу, коротко, без канцелярита и без выдуманных фактов.',
    'Главное правило: не придумывай наличие, цену, гарантию, комплектацию, состояние и адрес. Используй только данные из запроса и контекста CRM.',
    'Если клиент спрашивает одновременно наличие, цену и гарантию, ответь по структуре: наличие по CRM, цена по CRM, гарантия/проверка, следующий шаг.',
    'Если товар найден и есть свободный остаток, подтверди наличие, цену, комплект/проверку и предложи резерв или приезд.',
    'Если товар занят резервом, на проверке или не найден, честно скажи это и предложи подобрать альтернативу или оформить под заказ.',
    'Если вопрос про trade-in или выкуп, попроси модель, память, состояние, процент аккумулятора, комплект и фото.',
    'Если вопрос про ремонт, попроси модель, неисправность, был ли ремонт, включается ли устройство, и передай к мастеру.',
    'Если вопрос внутренний для сотрудника, отвечай как помощник CRM, но не отправляй клиенту спорные инструкции.',
    'Не упоминай, что ты нейросеть, API, модель или демо. Пиши от лица продавца iMagnate.',
    'Ответ должен быть готовым текстом для отправки клиенту. Максимум 4 коротких предложения.'
  ].join('\n');
}

function buildAiInputV2(body) {
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
      postgresConfigured: POSTGRES_CONFIGURED,
      postgresDriverSource: PG_DRIVER_SOURCE || null,
      at: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/db/status') {
    if (!POSTGRES_CONFIGURED) {
      return send(res, 200, {
        ok: true,
        configured: false,
        driverInstalled: POSTGRES_DRIVER_INSTALLED,
        driverSource: PG_DRIVER_SOURCE || null,
        hasDatabaseUrl: Boolean(DATABASE_URL),
        message: dbReadyMessage()
      });
    }
    pgQuery(`
      select
        now() as server_time,
        to_regclass('public.products') is not null as schema_ready
    `)
      .then(result => send(res, 200, {
        ok: true,
        configured: true,
        driverInstalled: true,
        driverSource: PG_DRIVER_SOURCE,
        hasDatabaseUrl: true,
        schemaReady: result.rows[0].schema_ready,
        serverTime: result.rows[0].server_time
      }))
      .catch(e => send(res, 503, {
        ok: false,
        configured: false,
        driverInstalled: true,
        hasDatabaseUrl: true,
        error: clean(e.message, 500)
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/db/init') {
    if (!requireStoreAuth(req, url)) return send(res, 401, { ok: false, error: 'Неверный токен' });
    if (!POSTGRES_CONFIGURED) return send(res, 503, { ok: false, error: dbReadyMessage() });
    const schemaPath = path.join(__dirname, 'database', 'schema.sql');
    fs.readFile(schemaPath, 'utf8', async (err, sql) => {
      if (err) return send(res, 500, { ok: false, error: 'Не найден database/schema.sql' });
      try {
        await pgQuery(sql);
        return send(res, 200, { ok: true, message: 'Схема PostgreSQL готова' });
      } catch (e) {
        return send(res, 500, { ok: false, error: clean(e.message, 800) });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stock') {
    if (!requireStoreAuth(req, url)) return send(res, 401, { ok: false, error: 'Неверный токен' });
    if (!POSTGRES_CONFIGURED) return send(res, 503, { ok: false, error: dbReadyMessage() });
    stockSnapshotFromPostgres()
      .then(snapshot => send(res, 200, snapshot))
      .catch(e => send(res, 500, { ok: false, error: clean(e.message, 800) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/db/export') {
    if (!requireStoreAuth(req, url)) return send(res, 401, { ok: false, error: 'Неверный токен' });
    if (!POSTGRES_CONFIGURED) return send(res, 503, { ok: false, error: dbReadyMessage() });
    stockSnapshotFromPostgres()
      .then(snapshot => send(res, 200, {
        schema: 'imagnate_store_postgres_v1',
        ...snapshot
      }))
      .catch(e => send(res, 500, { ok: false, error: clean(e.message, 800) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/db/import') {
    if (!requireStoreAuth(req, url)) return send(res, 401, { ok: false, error: 'Неверный токен' });
    if (!POSTGRES_CONFIGURED) return send(res, 503, { ok: false, error: dbReadyMessage() });
    readJsonBody(req, 1600000).then(async body => {
      const items = importPayloadsFromBody(body);
      const failed = [];
      let imported = 0;
      for (const item of items) {
        try {
          await receiveScanInPostgres(item);
          imported += 1;
        } catch (e) {
          failed.push({ code: item.code || '', model: item.model || '', error: clean(e.message, 300) });
        }
      }
      return send(res, failed.length ? 207 : 200, {
        ok: failed.length === 0,
        imported,
        failed,
        total: items.length
      });
    }).catch(e => {
      send(res, e.message === 'body_too_large' ? 413 : 400, {
        ok: false,
        error: e.message === 'bad_json' ? 'Неверный JSON' : 'Слишком большой запрос'
      });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/scan/receive') {
    if (!requireStoreAuth(req, url)) return send(res, 401, { ok: false, error: 'Неверный токен' });
    if (!POSTGRES_CONFIGURED) return send(res, 503, { ok: false, error: dbReadyMessage() });
    readJsonBody(req, 80000).then(async body => {
      try {
        const saved = await receiveScanInPostgres(body);
        return send(res, 200, { ok: true, saved });
      } catch (e) {
        return send(res, 400, { ok: false, error: clean(e.message, 800) });
      }
    }).catch(e => {
      send(res, e.message === 'body_too_large' ? 413 : 400, {
        ok: false,
        error: e.message === 'bad_json' ? 'Неверный JSON' : 'Слишком большой запрос'
      });
    });
    return;
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
        instructions: buildAiInstructionsV2(),
        input: buildAiInputV2(body),
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
  initPostgresSchema()
    .then(done => {
      if (done) console.log('PostgreSQL schema is ready');
    })
    .catch(e => {
      console.error('PostgreSQL schema init failed:', e.message);
    });
});
