// src/scrape-whop-all.js
// Crawl Whop categories, discover all product pages, then reuse the same network-capture logic.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, '..', 'out');
const OUT_JSON = path.join(OUT_DIR, 'whop_popup_codes.json');
const OUT_CSV  = path.join(OUT_DIR, 'whop_popup_codes.csv');
const COOKIE_PATH = path.join(__dirname, '..', 'cookies.json');

const MAX_DISCOVER_PAGES_PER_CATEGORY = parseInt(process.env.WHOP_MAX_PAGES || '50', 10);
const CONCURRENCY = parseInt(process.env.WHOP_CONCURRENCY || '2', 10);
const HEADLESS = process.env.HEADLESS !== 'false';

const CATEGORY_SEEDS = [
  // Add/remove as you like. These are common Whop categories/collections.
  'https://whop.com/discover/trading/',
  'https://whop.com/discover/crypto/',
  'https://whop.com/discover/education/',
  'https://whop.com/discover/ai/',
  'https://whop.com/discover/tools/',
  'https://whop.com/discover/communities/'
];

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(OUT_JSON)) fs.writeFileSync(OUT_JSON, '[]', 'utf8');
  if (!fs.existsSync(OUT_CSV)) {
    fs.writeFileSync(
      OUT_CSV,
      'timestamp,productUrl,productId,productRoute,productTitle,amountOff,discountOff,code,promoId\n',
      'utf8'
    );
  }
}

function appendCsv(row) {
  const safe = v => (v ?? '').toString().replaceAll('"','""');
  const line = [
    new Date().toISOString(),
    row.productUrl,
    row.productId,
    row.productRoute,
    row.productTitle,
    row.amountOff,
    row.discountOff,
    row.code,
    row.promoId
  ].map(safe).map(v => `"${v}"`).join(',') + '\n';
  fs.appendFileSync(OUT_CSV, line, 'utf8');
}

function upsertJson(row) {
  const data = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  const k = `${row.productId}|${row.code}`;
  const idx = data.findIndex(r => `${r.productId}|${r.code}` === k);
  if (idx >= 0) data[idx] = row; else data.push(row);
  fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');
}

async function loadCookies(context) {
  if (fs.existsSync(COOKIE_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await context.addCookies(cookies);
  }
}

async function waitIdle(page, {networkQuietMs = 800, timeoutMs = 15000} = {}) {
  let idleResolve;
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idleResolve(), networkQuietMs);
  };

  await page.route('**/*', route => {
    route.continue();
  });

  const did = new Promise(res => (idleResolve = res));
  page.on('request', reset);
  page.on('response', reset);
  reset();

  await Promise.race([
    did,
    page.waitForTimeout(timeoutMs)
  ]);
}

// --- product discovery on category pages ---

async function discoverProductsInCategory(context, categoryUrl) {
  const page = await context.newPage();
  await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' });

  const productUrls = new Set();
  let pageCount = 0;

  while (pageCount < MAX_DISCOVER_PAGES_PER_CATEGORY) {
    pageCount += 1;

    // Scroll to load lazy items
    await page.evaluate(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      let prevHeight = 0;
      for (let i = 0; i < 8; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await delay(300);
        const h = document.body.scrollHeight;
        if (h === prevHeight) break;
        prevHeight = h;
      }
    });
    await waitIdle(page, { networkQuietMs: 800, timeoutMs: 10000 });

    // Grab all links on the page
    const links = await page.$$eval('a[href]', as => as.map(a => a.href));
    console.log(`  Page ${pageCount}: Found ${links.length} total links`);

    // Log some sample links to see what we're working with
    const sampleLinks = links.slice(0, 20);
    console.log(`  Sample links:`, sampleLinks);

    // Look for any pattern that might be product links
    const discoverLinks = links.filter(u => u.includes('/discover/'));
    const productIdLinks = links.filter(u => u.includes('productId='));
    const checkoutLinks = links.filter(u => u.includes('/checkout/'));

    console.log(`  Discover links: ${discoverLinks.length}`);
    console.log(`  ProductId links: ${productIdLinks.length}`);
    console.log(`  Checkout links: ${checkoutLinks.length}`);

    if (discoverLinks.length > 0) console.log(`  Sample discover:`, discoverLinks.slice(0, 5));
    if (productIdLinks.length > 0) console.log(`  Sample productId:`, productIdLinks.slice(0, 5));
    if (checkoutLinks.length > 0) console.log(`  Sample checkout:`, checkoutLinks.slice(0, 5));

    // Be more inclusive in what we consider product links
    for (const href of links) {
      if (href.includes('/discover/') && (href.includes('productId=') || href.includes('/prod_'))) {
        productUrls.add(href.split('#')[0]);
      }
      // Also include checkout links as they're definitely product pages
      if (href.includes('/checkout/prod_')) {
        productUrls.add(href.split('#')[0]);
      }
    }

    // Try "Next" button if present, else break after one pass (infinite scroll often loads all)
    const nextBtn = await page.$('a[rel="next"], button:has-text("Next"), a:has-text("Next")');
    if (nextBtn) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        nextBtn.click()
      ]);
      continue;
    } else {
      break;
    }
  }

  await page.close();
  return productUrls;
}

// --- capture popupPromoCode on a single product page ---

async function scrapePopupCodeFromProduct(context, productUrl) {
  const page = await context.newPage();

  const hits = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      // Only care about same-origin app/json or RSC streams likely to contain the product payload
      const ctype = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/json|octet|text\/x-component|stream|event-stream/.test(ctype)) return;

      let body;
      // Try JSON first
      try { body = await resp.json(); } catch { body = null; }
      let text = body ? JSON.stringify(body) : (await resp.text());

      // Fast substring check before any parsing
      if (!text || !text.includes('popupPromoCode')) return;

      // Extract with a light regex; fallback to JSON parse if it's plain
      const m = text.match(/"popupPromoCode"\s*:\s*\{[^}]+\}/);
      if (!m) return;

      const obj = JSON.parse('{' + m[0] + '}');
      if (!obj.popupPromoCode || !obj.popupPromoCode.code) return;

      hits.push(obj.popupPromoCode);
    } catch {}
  });

  await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
  await waitIdle(page, { networkQuietMs: 800, timeoutMs: 15000 });

  // Some pages stream more on reload; mimic your manual "refresh then search"
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitIdle(page, { networkQuietMs: 1000, timeoutMs: 15000 });

  // If found, enrich and save
  let saved = 0;
  for (const obj of hits) {
    const record = {
      productUrl,
      productId: (productUrl.match(/productId=([^&]+)/) || [,''])[1],
      productRoute: (productUrl.match(/\/discover\/([^/?#]+)/) || [,''])[1],
      productTitle: await page.title(),
      amountOff: obj.amountOff ?? '',
      discountOff: obj.discountOff ?? '',
      code: obj.code ?? '',
      promoId: obj.id ?? ''
    };
    if (record.code && record.code.startsWith('promo-')) {
      appendCsv(record);
      upsertJson(record);
      saved++;
    }
  }

  await page.close();
  return saved;
}

// --- simple pool for concurrency ---

async function runPool(items, worker, concurrency) {
  const q = [...items];
  let active = 0;
  let done = 0;
  return new Promise((resolve) => {
    const tick = () => {
      if (q.length === 0 && active === 0) return resolve();
      while (active < concurrency && q.length) {
        const item = q.shift();
        active++;
        worker(item)
          .catch(() => {})
          .finally(() => {
            active--; done++;
            process.stdout.write(`\rProcessed ${done}/${items.length}`);
            tick();
          });
      }
    };
    tick();
  });
}

// --- main ---

(async () => {
  ensureOut();

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  await loadCookies(context);

  // 1) Discover all product URLs from seed categories
  console.log('Discovering products…');
  const all = new Set();
  for (const seed of CATEGORY_SEEDS) {
    try {
      const urls = await discoverProductsInCategory(context, seed);
      urls.forEach(u => all.add(u));
      console.log(`  ${seed} → +${urls.size} products`);
    } catch (e) {
      console.warn(`  failed: ${seed}`, e.message);
    }
  }
  const productUrls = Array.from(all);
  console.log(`Total unique products: ${productUrls.length}`);

  // 2) Visit each product and capture popupPromoCode
  let found = 0;
  await runPool(productUrls, async (url) => {
    const n = await scrapePopupCodeFromProduct(context, url);
    if (n > 0) found += n;
    // small jitter to be polite
    await new Promise(r => setTimeout(r, 200 + Math.random()*300));
  }, CONCURRENCY);

  console.log(`\nDone. Promo codes found: ${found}`);
  console.log(`Output: ${OUT_CSV} & ${OUT_JSON}`);

  await browser.close();
})().catch(e => {
  console.error(e);
  process.exit(1);
});