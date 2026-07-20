const SITEMAP_URL = 'https://imagnate.ru/sitemap.xml';
const OUTPUT_FILE = new URL('../imagnate-catalog.json', import.meta.url);
const CONCURRENCY = Number(process.env.IMAGNATE_CATALOG_CONCURRENCY || 6);
const LIMIT = Number(process.env.IMAGNATE_CATALOG_LIMIT || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeHtml(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFlightText(html) {
  return String(html || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u002F/g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, ' ');
}

function readCartField(body, field) {
  const quoted = body.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i'));
  if (quoted) return decodeHtml(quoted[1]);
  const numeric = body.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'i'));
  if (numeric) return Number(numeric[1]);
  return '';
}

function slugToTitle(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => {
      if (part === 'i') return 'i';
      if (part === 'gb') return 'GB';
      if (part === 'tb') return 'TB';
      if (part === 'pro') return 'Pro';
      if (part === 'max') return 'Max';
      if (part === 'e') return 'e';
      if (part === 's') return 'S';
      if (part === 'vr') return 'VR';
      if (part === 'usb') return 'USB';
      if (part === 'c') return 'C';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/\bI Phone\b/g, 'iPhone')
    .replace(/\bI Pad\b/g, 'iPad')
    .replace(/\bI Mac\b/g, 'iMac')
    .replace(/\bMac Book\b/g, 'MacBook');
}

function inferTab(title, slug) {
  const text = `${title} ${slug}`.toLowerCase();
  if (/дисплей|аккумулятор|модуль|шлейф|камера|корпус|динамик|микрофон|разъем|разъём|запчаст/.test(text)) return 'parts';
  if (/стекл|чехол|кабель|пленк|плёнк|адаптер|заряд|блок питания|magsafe|ремеш|держател|защитн|накладк|case|cover|glass/.test(text)) return 'accessories';
  return 'tech';
}

function inferCategory(title, slug) {
  const text = `${title} ${slug}`.toLowerCase();
  if (/iphone|смартфон|galaxy|redmi|xiaomi|samsung/.test(text)) return 'Смартфоны';
  if (/ipad|планшет|tab /.test(text)) return 'Планшеты';
  if (/macbook|ноутбук/.test(text)) return 'Ноутбуки';
  if (/imac|моноблок/.test(text)) return 'Моноблоки';
  if (/watch|часы/.test(text)) return 'Умные часы';
  if (/airpods|наушник|гарнитур|beats|marshall|jbl/.test(text)) return 'Аудио';
  if (/playstation|xbox|nintendo|vr|игров/.test(text)) return 'Игровые системы';
  if (/dyson|стайлер|фен|пылесос/.test(text)) return 'Dyson';
  if (/стекл|чехол|кабель|заряд|адаптер|ремеш|magsafe/.test(text)) return 'Аксессуары';
  if (/дисплей|аккумулятор|модуль|шлейф|запчаст/.test(text)) return 'Запчасти';
  return 'Техника';
}

function inferBrand(title, slug) {
  const text = `${title} ${slug}`.toLowerCase();
  const brands = [
    ['Apple', /apple|iphone|ipad|macbook|imac|airpods|watch|airtag|vision pro/],
    ['Samsung', /samsung|galaxy/],
    ['Xiaomi', /xiaomi|redmi|poco/],
    ['Sony', /sony|playstation|ps5|ps4/],
    ['Microsoft', /microsoft|xbox/],
    ['Nintendo', /nintendo|switch/],
    ['Dyson', /dyson/],
    ['JBL', /jbl/],
    ['Marshall', /marshall/],
    ['Meta', /meta quest/],
    ['GoPro', /gopro/],
  ];
  return brands.find(([, rx]) => rx.test(text))?.[0] || '';
}

function inferMemory(title) {
  const match = String(title || '').match(/(\d+(?:\.\d+)?)\s*(ГБ|GB|ТБ|TB)\b/i);
  return match ? `${match[1]} ${match[2].toUpperCase().replace('ГБ', 'GB').replace('ТБ', 'TB')}` : '';
}

function inferColor(title) {
  const text = String(title || '');
  const parens = [...text.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]).filter(Boolean);
  const lastParen = parens.at(-1) || '';
  const colorWords = [
    'Black', 'White', 'Blue', 'Pink', 'Green', 'Yellow', 'Purple', 'Silver', 'Gold',
    'Graphite', 'Titanium', 'Ultramarine', 'Teal', 'Natural', 'Desert', 'Orange',
    'Space', 'Gray', 'Grey', 'Midnight', 'Starlight', 'Sky', 'Cosmic', 'Deep',
    'черный', 'чёрный', 'белый', 'синий', 'голубой', 'розовый', 'зеленый', 'зелёный',
    'желтый', 'жёлтый', 'серебристый', 'золотой', 'фиолетовый', 'титановый',
  ];
  if (lastParen && colorWords.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(lastParen))) return lastParen;
  const match = text.match(new RegExp(`\\b(${colorWords.join('|')})(?:\\s+(${colorWords.join('|')}))?\\b`, 'i'));
  return match ? [match[1], match[2]].filter(Boolean).join(' ') : '';
}

function extractMetaProduct(html, slug, url) {
  const clean = normalizeFlightText(html);
  const schemaProduct = extractSchemaProduct(clean, slug);
  const cartMatches = [...clean.matchAll(/"cart"\s*:\s*\{([^{}]{20,1200})\}/g)].map((match) => {
    const body = match[1];
    return {
      slug: readCartField(body, 'slug'),
      documentId: readCartField(body, 'documentId'),
      title: readCartField(body, 'title'),
      imageUrl: readCartField(body, 'imageUrl'),
      price: Number(readCartField(body, 'price') || 0),
      oldPrice: Number(readCartField(body, 'oldPrice') || 0) || null,
    };
  }).filter((item) => item.slug && item.title);

  const exact = cartMatches.find((item) => item.slug === slug) || cartMatches.find((item) => url.endsWith(`/${item.slug}`));
  const metaTitle = decodeHtml((clean.match(/<title>(.*?)\s*\|\s*iMagnate<\/title>/i) || [])[1] || '');
  const metaDescription = decodeHtml((clean.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || '');
  const title = schemaProduct?.title || exact?.title || metaTitle.replace(/^Купить\s+/i, '') || slugToTitle(slug);
  const imageFromPreload = decodeHtml((clean.match(/<link rel="preload" as="image" href="([^"]+)"/i) || [])[1] || '');

  return {
    id: exact?.documentId || schemaProduct?.id || slug,
    slug,
    title,
    price: Number(schemaProduct?.price || exact?.price || 0),
    oldPrice: exact?.oldPrice || null,
    category: inferCategory(title, slug),
    tab: inferTab(title, slug),
    brand: schemaProduct?.brand || inferBrand(title, slug),
    memory: inferMemory(title),
    color: inferColor(title),
    imageUrl: schemaProduct?.imageUrl || exact?.imageUrl || imageFromPreload,
    url,
    description: schemaProduct?.description || metaDescription,
  };
}

function extractSchemaProduct(clean, slug) {
  const scripts = [...clean.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const data = JSON.parse(script[1]);
      const items = Array.isArray(data) ? data : [data];
      const product = items.find((item) => item?.['@type'] === 'Product' && (!item.sku || item.sku === slug));
      if (!product) continue;
      const image = Array.isArray(product.image) ? product.image[0] : product.image;
      return {
        id: product.sku || slug,
        title: decodeHtml(product.name || ''),
        price: Number(product.offers?.price || 0),
        brand: decodeHtml(product.brand?.name || ''),
        imageUrl: decodeHtml(image || ''),
        description: decodeHtml(product.description || ''),
      };
    } catch {
      // Some Next.js chunks duplicate JSON-LD in escaped strings. The normal script tag is enough when present.
    }
  }
  return null;
}

async function fetchText(url, tries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'StoreControlCatalogBot/1.0 (+https://imagnate-assistant.onrender.com)',
          accept: 'text/html,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

async function runPool(items, worker) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const sitemap = await fetchText(SITEMAP_URL);
  const productUrls = [...new Set([...sitemap.matchAll(/https:\/\/imagnate\.ru\/product\/[^<\s]+/g)].map((m) => m[0]))];
  const urls = LIMIT ? productUrls.slice(0, LIMIT) : productUrls;
  const startedAt = Date.now();
  let failed = 0;

  const items = await runPool(urls, async (url, index) => {
    const slug = decodeURIComponent(url.split('/').pop());
    try {
      const html = await fetchText(url);
      if ((index + 1) % 100 === 0) {
        console.log(`Loaded ${index + 1}/${urls.length}`);
      }
      return extractMetaProduct(html, slug, url);
    } catch (error) {
      failed += 1;
      return {
        id: slug,
        slug,
        title: slugToTitle(slug),
        price: 0,
        oldPrice: null,
        category: inferCategory(slug, slug),
        tab: inferTab(slug, slug),
        brand: inferBrand(slug, slug),
        memory: inferMemory(slug),
        color: inferColor(slug),
        imageUrl: '',
        url,
        description: '',
        importError: String(error?.message || error),
      };
    }
  });

  const sorted = items
    .filter((item) => item?.slug && item?.title)
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));

  const payload = {
    source: 'https://imagnate.ru/sitemap.xml',
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    failed,
    elapsedMs: Date.now() - startedAt,
    items: sorted,
  };

  await import('node:fs/promises').then((fs) => fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf8'));
  console.log(`Saved ${sorted.length} products to ${OUTPUT_FILE.pathname}. Failed: ${failed}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
