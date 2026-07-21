import { spawn } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const port = Number(process.env.TEST_PORT || 3417);
const baseUrl = `http://127.0.0.1:${port}`;
const token = 'test-token';
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
  }
}

function scannerNormalize(code) {
  return String(code || '').trim().replace(/\s+/g, '').toUpperCase();
}

function scannerDigits(code) {
  return String(code || '').replace(/\D/g, '');
}

function scannerImeiLuhnValid(code) {
  const digits = String(code || '');
  if (!/^\d{15}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    let n = parseInt(digits[i], 10);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return ((sum + parseInt(digits[14], 10)) % 10) === 0;
}

function scannerExtractImei(raw) {
  const text = String(raw || '');
  const chunks = text.match(/\d{15}/g) || [];
  const valid = chunks.find(scannerImeiLuhnValid);
  if (valid) return valid;
  const digits = scannerDigits(text);
  for (let i = 0; i <= digits.length - 15; i += 1) {
    const candidate = digits.slice(i, i + 15);
    if (scannerImeiLuhnValid(candidate)) return candidate;
  }
  if (/^\d{15}$/.test(digits)) return digits;
  return '';
}

function scannerAnalyzeCode(raw) {
  const original = String(raw || '').trim();
  const normalized = scannerNormalize(raw);
  const digits = scannerDigits(raw);
  const imei = scannerExtractImei(raw);
  const weird = /[^\dA-Za-zА-Яа-яЁё\-_.:/?=&+%]/.test(original);
  const nonAscii = /[^\x20-\x7E]/.test(original);
  const looksLikeQuery = /[?=&]/.test(original) && digits.length > 8;
  if (!normalized) return { type: 'empty', tab: 'accessories', canCreate: false };
  if (/^01\d{14}21/.test(digits) || /^02\d{14}/.test(digits)) return { type: 'gs1', canonical: normalized, tab: 'tech', canCreate: false };
  if (/^\d{15}$/.test(digits) && normalized === digits) return { type: 'imei', canonical: digits, tab: 'tech', canCreate: true };
  if (weird || nonAscii || looksLikeQuery) return { type: 'service', canonical: normalized, tab: 'accessories', canCreate: false };
  if (imei) return { type: 'imei_embedded', canonical: imei, tab: 'tech', canCreate: true };
  if (/^\d{13}$/.test(digits) && normalized === digits) return { type: 'ean13', canonical: digits, tab: 'accessories', canCreate: true };
  if (/^\d{12}$/.test(digits) && normalized === digits) return { type: 'upc', canonical: digits, tab: 'accessories', canCreate: true };
  if (/^\d{14}$/.test(digits) && normalized === digits) return { type: 'gtin14', canonical: digits, tab: 'accessories', canCreate: true };
  if (/^\d{16,30}$/.test(digits) && normalized === digits) return { type: 'long_digits', canonical: digits, tab: 'tech', canCreate: false };
  if (/^(PRT|PART|BAT|DISPLAY|MOD)/.test(normalized)) return { type: 'part_sku', canonical: normalized, tab: 'parts', canCreate: true };
  if (/^(ACC|CASE|GLASS|CABLE|CHG)/.test(normalized)) return { type: 'accessory_sku', canonical: normalized, tab: 'accessories', canCreate: true };
  if (/^TRD/.test(normalized)) return { type: 'tradein_sku', canonical: normalized, tab: 'tradein', canCreate: true };
  return { type: 'sku', canonical: normalized, tab: 'accessories', canCreate: true };
}

function scannerGuessTab(raw) {
  return scannerAnalyzeCode(raw).tab || 'accessories';
}

function catalogSearchText(item) {
  return String([item.title, item.brand, item.category, item.memory, item.color, item.slug].filter(Boolean).join(' ')).toLowerCase();
}

function findCatalogItem(items, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return items.find(item => String(item.title || '').trim().toLowerCase() === needle) ||
    items.find(item => String(item.slug || '').trim().toLowerCase() === needle);
}

function createMemoryDb() {
  return { products: [], stockUnits: [], stockBatches: [], stockMovements: [] };
}

function receiveScanInMemory(db, tab, item, code) {
  const normalizedCode = scannerNormalize(code);
  const stockMode = (tab === 'tech' || tab === 'tradein') ? 'unit' : 'batch';
  const productKey = `${tab}|${String(item.model || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  let product = db.products.find(row => row.key === productKey);
  if (!product) {
    product = {
      id: `prd_${db.products.length + 1}`,
      key: productKey,
      name: item.model,
      category: tab,
      stockMode,
      defaultSalePrice: item.price || 0,
      minStock: item.minStock || (stockMode === 'batch' ? 2 : 1),
    };
    db.products.push(product);
  }

  if (stockMode === 'unit') {
    let unit = db.stockUnits.find(row => row.unitCode === normalizedCode);
    if (!unit) {
      unit = { id: `unit_${db.stockUnits.length + 1}`, productId: product.id, unitCode: normalizedCode, imei: normalizedCode, model: item.model };
      db.stockUnits.push(unit);
    }
  } else {
    let batch = db.stockBatches.find(row => row.barcode === normalizedCode);
    if (!batch) {
      batch = { id: `batch_${db.stockBatches.length + 1}`, productId: product.id, barcode: normalizedCode, qty: Math.max(1, item.qty || 1), model: item.model };
      db.stockBatches.push(batch);
    } else {
      batch.qty = Math.max(batch.qty, Math.max(1, item.qty || 1));
    }
  }

  if (!db.stockMovements.some(row => row.code === normalizedCode)) {
    db.stockMovements.push({ code: normalizedCode, model: item.model, category: tab, qty: stockMode === 'unit' ? 1 : Math.max(1, item.qty || 1) });
  }
}

async function waitForServer() {
  const deadline = Date.now() + 12000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('server did not start');
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  return { response, body, text };
}

async function startServer() {
  const tempDir = await mkdtemp(join(tmpdir(), 'store-control-test-'));
  const envPath = join(tempDir, '.env');
  await writeFile(envPath, [
    `PORT=${port}`,
    `STORE_TOKEN=${token}`,
    'DATABASE_URL=',
    'OPENAI_API_KEY=',
    'OPENAI_MODEL=gpt-4o-mini',
  ].join('\n'));

  const child = spawn(process.execPath, [join(rootPath, 'storecontrolapi.js')], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port), STORE_TOKEN: token, DATABASE_URL: '', OPENAI_API_KEY: '' },
    stdio: 'ignore',
  });

  await waitForServer();
  return {
    child,
    tempDir,
    stop: async () => {
      child.kill();
      await new Promise(resolve => setTimeout(resolve, 500));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

await test('Файлы приложения существуют', async () => {
  assert(existsSync(new URL('../store-control-erp.html', import.meta.url)), 'store-control-erp.html not found');
  assert(existsSync(new URL('../storecontrolapi.js', import.meta.url)), 'storecontrolapi.js not found');
  assert(existsSync(new URL('../imagnate-catalog.json', import.meta.url)), 'imagnate-catalog.json not found');
  assert(existsSync(new URL('../database/schema.sql', import.meta.url)), 'database/schema.sql not found');
});

await test('HTML содержит валидный основной JavaScript', async () => {
  const html = await readFile(new URL('../store-control-erp.html', import.meta.url), 'utf8');
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert(start > -1 && end > start, 'main script not found');
  const js = html.slice(start + '<script>'.length, end);
  new Function(js);
  assert(html.includes('scanCatalogOptions'), 'catalog datalist hook not found');
  assert(html.includes('scanCatalogResults'), 'visible catalog picker not found');
  assert(html.includes('imagnateCatalogMatches'), 'catalog matching helper not found');
  assert(!html.includes('Товар из iMagnate'), 'extra catalog field returned');
  assert(html.includes('crmQuickAiTestBtn'), 'quick AI order button not found');
  assert(html.includes('openCrmQuickAiOrderModal'), 'quick AI order modal not found');
  assert(html.includes('quickAiQuestion'), 'quick AI order question field not found');
  assert(html.includes('Форма ничего не отправляет'), 'quick AI safety hint not found');
  assert(html.includes('scannerServerDbHtml'), 'scanner server DB panel not found');
  assert(html.includes('scannerUpdateScanLogServer'), 'scanner server sync log updater not found');
  assert(html.includes('serverDbLastSyncAt'), 'server DB sync timestamp not found');
  assert(html.includes('scannerLookupPostgres'), 'scanner server lookup not found');
  assert(html.includes('scannerApplyLookupEntry'), 'scanner lookup merge not found');
  assert(html.includes('openScannerCreateModalV2'), 'compact scanner intake modal not found');
  assert(html.includes('warehouseScannerPanelHtml'), 'warehouse scanner panel not found');
  assert(!html.includes("'warehouse','scanner'"), 'scanner returned as a separate sidebar menu item');
  assert(html.includes('crmAgentCustomerSalesReply'), 'customer sales reply composer not found');
  assert(html.includes('Гарантия магазина обычно 14 дней'), 'customer warranty phrase not found');
  assert(html.includes('Цена по базе сейчас'), 'customer price phrase not found');
});

await test('AI-продавец отвечает на наличие, цену и гарантию без канцелярита', async () => {
  const html = await readFile(new URL('../store-control-erp.html', import.meta.url), 'utf8');
  const buyIntentIndex = html.indexOf("if(/цен|сколько|налич|есть|купить|заказ|резерв/.test(q))");
  const trustIntentIndex = html.indexOf("if(/гарант|оригинал|провер/.test(q))");
  assert(buyIntentIndex > -1 && trustIntentIndex > -1 && buyIntentIndex < trustIntentIndex, 'buy intent must win over warranty-only intent');
  assert(html.includes('crmAgentCleanProductName'), 'product name cleanup is missing');
  assert(!html.includes('По новому {товар}'), 'old awkward warranty template returned');
});

await test('Серверный AI-промпт использует чистый русский текст', async () => {
  const api = await readFile(new URL('../storecontrolapi.js', import.meta.url), 'utf8');
  assert(api.includes('buildAiInstructionsV2'), 'clean AI instructions are missing');
  assert(api.includes('Если клиент спрашивает одновременно наличие, цену и гарантию'), 'combined sales question instruction is missing');
  assert(api.includes('buildAiInputV2(body)'), 'API must use clean AI input builder');
});

await test('Каталог iMagnate валиден', async () => {
  const catalog = JSON.parse(await readFile(new URL('../imagnate-catalog.json', import.meta.url), 'utf8'));
  assert(catalog.count === catalog.items.length, 'catalog count mismatch');
  assert(catalog.items.length >= 1000, 'too few catalog items');
  assert(catalog.items.every(item => item.title && item.slug && item.url && item.imageUrl), 'catalog item misses required fields');
  assert(catalog.items.filter(item => Number(item.price) > 0).length >= 900, 'too few priced items');
  assert(catalog.items.some(item => /iphone/i.test(item.title) && Number(item.price) > 0), 'priced iPhone not found');
  assert(catalog.items.some(item => /dyson/i.test(item.title)), 'Dyson not found');
  assert(catalog.items.some(item => /playstation|ps5/i.test(item.title)), 'PlayStation not found');
});

await test('Unit: нормализация и определение категории сканера', async () => {
  assert(scannerNormalize(' 35 123 456 ') === '35123456', 'normalize spaces failed');
  assert(scannerGuessTab('356789012345678') === 'tech', 'IMEI should be tech');
  assert(scannerGuessTab('BAT-IPHONE-13') === 'parts', 'BAT should be parts');
  assert(scannerGuessTab('GLASS-IP15') === 'accessories', 'GLASS should be accessories');
  assert(scannerGuessTab('TRD-001') === 'tradein', 'TRD should be tradein');
});

await test('Unit: сканер отличает IMEI от служебных кодов коробки', async () => {
  assert(scannerAnalyzeCode('356789012345678').type === 'imei', '15 digits should be treated as IMEI-like code');
  assert(scannerAnalyzeCode('4680656321474').type === 'ean13', 'EAN-13 should not be treated as IMEI');
  assert(scannerAnalyzeCode('0104603934000779215SERIAL').type === 'gs1', 'GS1 box code should be detected');
  assert(scannerAnalyzeCode('e=20260712E1503.bl=98246h000.at=7381440901203663').canCreate === false, 'URL/query service scan should be blocked');
  assert(scannerAnalyzeCode('240bГЙэян/Ф').canCreate === false, 'binary/non-ascii scan should be blocked');
  assert(scannerAnalyzeCode('C02ZK0ABCDE1').canCreate === true, 'normal serial should be allowed');
});

await test('Unit: поиск товара из справочника', async () => {
  const catalog = JSON.parse(await readFile(new URL('../imagnate-catalog.json', import.meta.url), 'utf8'));
  const iphone = catalog.items.find(item => /iphone/i.test(item.title) && Number(item.price) > 0);
  assert(iphone, 'iPhone fixture not found');
  assert(findCatalogItem(catalog.items, iphone.title)?.slug === iphone.slug, 'exact title lookup failed');
  assert(catalog.items.filter(item => catalogSearchText(item).includes('iphone')).length > 50, 'iPhone search too small');
});

await test('Unit/stress: 1500 сканов в памяти без дублей', async () => {
  const db = createMemoryDb();
  for (let i = 0; i < 1000; i += 1) {
    receiveScanInMemory(db, 'tech', { model: `iPhone Test ${i % 20}`, price: 100000 + i }, `35${String(1000000000000 + i).padStart(13, '0')}`);
  }
  for (let i = 0; i < 500; i += 1) {
    receiveScanInMemory(db, 'accessories', { model: `Glass Test ${i % 10}`, price: 900, qty: 3 }, `GLASS-${i}`);
  }
  receiveScanInMemory(db, 'tech', { model: 'iPhone Test 0', price: 1 }, '351000000000000');
  assert(db.stockUnits.length === 1000, 'unit duplicate handling failed');
  assert(db.stockBatches.length === 500, 'batch count mismatch');
  assert(db.stockMovements.length === 1500, 'movement dedupe failed');
  assert(db.products.length <= 30, 'product grouping failed');
});

let serverHandle = null;
await test('Integration: локальный сервер отвечает', async () => {
  serverHandle = await startServer();
  const { response, body } = await jsonFetch('/api/health');
  assert(response.status === 200 && body.ok, 'health failed');
  assert(body.app === 'Store Control ERP', 'wrong app name');
});

await test('Integration: статика и каталог отдаются сервером', async () => {
  const page = await fetch(`${baseUrl}/store-control-erp.html`);
  const catalog = await jsonFetch('/imagnate-catalog.json');
  assert(page.status === 200, 'html status not 200');
  assert(catalog.response.status === 200, 'catalog status not 200');
  assert(catalog.body.count >= 1000, 'server catalog too small');
});

await test('Integration: API защищает серверную БД токеном', async () => {
  const noToken = await jsonFetch('/api/stock');
  const badToken = await jsonFetch('/api/stock', { headers: { Authorization: 'Bearer wrong' } });
  const noLookupToken = await jsonFetch('/api/scan/lookup?code=356789012345678');
  assert(noToken.response.status === 401, 'stock without token should be 401');
  assert(badToken.response.status === 401, 'stock with bad token should be 401');
  assert(noLookupToken.response.status === 401, 'scan lookup without token should be 401');
});

await test('Integration: lookup сканера без PostgreSQL явно недоступен', async () => {
  const result = await jsonFetch('/api/scan/lookup?code=356789012345678', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(result.response.status === 503, 'scan lookup without DATABASE_URL should return 503');
  assert(result.body.ok === false, 'scan lookup dry run should be explicit failure');
});

await test('Integration: scan endpoint не пишет без PostgreSQL и не падает', async () => {
  const result = await jsonFetch('/api/scan/receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: '359999999999999', model: 'E2E Scanner Test', category: 'tech', price: 1 }),
  });
  assert(result.response.status === 503, 'scan without DATABASE_URL should return 503 in dry run');
  assert(result.body.ok === false, 'scan dry run should be explicit failure');
});

await test('Stress: 250 параллельных запросов к серверу', async () => {
  const started = Date.now();
  const requests = Array.from({ length: 250 }, (_, index) => {
    const path = index % 3 === 0 ? '/api/health' : (index % 3 === 1 ? '/imagnate-catalog.json' : '/store-control-erp.html');
    return fetch(`${baseUrl}${path}`).then(response => response.status);
  });
  const statuses = await Promise.all(requests);
  const ok = statuses.filter(status => status === 200).length;
  assert(ok === statuses.length, `stress had non-200 responses: ${statuses.join(',')}`);
  assert(Date.now() - started < 15000, 'stress test took too long');
});

if (serverHandle) await serverHandle.stop();

const failed = results.filter(result => !result.ok);
console.log('\nStore Control ERP test report');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.ms} ms)${result.error ? ' - ' + result.error : ''}`);
}
console.log(`\nTotal: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);

if (failed.length) process.exit(1);
