// src/scrape-from-whpcodes.js
// Crawl whpcodes.com listing pages, follow "Go to page" links to Whop, capture popupPromoCode.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from './utils/extractPromo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, '..', 'out');
const OUT_JSON = path.join(OUT_DIR, 'whop_popup_codes.json');
const OUT_CSV  = path.join(OUT_DIR, 'whop_popup_codes.csv');
const COOKIE_PATH = path.join(__dirname, '..', 'cookies.json');
const STORAGE_STATE_PATH = process.env.WHOP_STORAGE || path.join(__dirname, '..', 'storageState.json');

// ---- config ----
const START_URL   = process.env.WHPCODES_START_URL || 'https://whpcodes.com/';
const MAX_LIST_PAGES = parseInt(process.env.WHPCODES_MAX_PAGES || '50', 10);   // how many list pages to traverse
const CONCURRENCY = parseInt(process.env.WHOP_CONCURRENCY || '2', 10);        // how many Whop pages in parallel
const HEADED      = !!process.env.HEADED;                                     // headed mode for debugging
const SLOWMO      = parseInt(process.env.SLOWMO || '0', 10);                  // slow motion for debugging
const HEADLESS    = process.env.HEADLESS !== 'false' && !HEADED;
const DELAY_MS    = parseInt(process.env.WHOP_DELAY_MS || '250', 10);         // polite delay between item visits
const AUTH_MODE   = process.env.WHOP_AUTH || 'auto';                          // 'storage', 'cookies', 'auto'

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
  const esc = v => (v ?? '').toString().replaceAll('"','""');
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
  ].map(esc).map(v => `"${v}"`).join(',') + '\n';
  fs.appendFileSync(OUT_CSV, line, 'utf8');
}

function upsertJson(row) {
  const data = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  const key = `${row.productId}|${row.code}`;
  const i = data.findIndex(r => `${r.productId}|${r.code}` === key);
  if (i >= 0) data[i] = row; else data.push(row);
  fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');
}

async function loadAuth(browser) {
  const useStorage = fs.existsSync(STORAGE_STATE_PATH) ? { storageState: STORAGE_STATE_PATH } : {};

  const context = await browser.newContext({
    ...useStorage,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });

  console.log(useStorage.storageState ? `🔐 Using storage state: ${STORAGE_STATE_PATH}` : '⚠️ No storage state in use');

  // Verify authentication by checking login status
  const page = await context.newPage();
  try {
    await page.goto('https://whop.com/', { waitUntil: 'domcontentloaded' });
    const loggedIn = await page.locator('a[href*="/profile"], [data-testid="user-menu"], .avatar, [href*="/dashboard"]').first().isVisible().catch(() => false);
    console.log(loggedIn ? '✅ Logged in session detected' : '⚠️ Not logged in – some payloads may be hidden');
  } catch (e) {
    console.log('⚠️ Could not verify login status');
  } finally {
    await page.close();
  }

  // Fallback to cookies if no storage state
  if (!useStorage.storageState && fs.existsSync(COOKIE_PATH)) {
    console.log('🍪 Loading cookies from cookies.json');
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await context.addCookies(cookies);
  }

  return context;
}

async function waitNetworkIdle(page, { quiet = 800, timeout = 15000 } = {}) {
  let resolveIdle;
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => resolveIdle(), quiet);
  };
  const idle = new Promise(res => (resolveIdle = res));
  page.on('request', reset);
  page.on('response', reset);
  reset();
  await Promise.race([idle, page.waitForTimeout(timeout)]);
}

// --- helper: find the next page href inside common pagination containers ---
async function getNextPageHref(page) {
  // find a likely pagination root
  const container = await page.$(
    [
      'nav[aria-label*="pagination" i]',
      'nav[role="navigation"] .pagination',
      'nav .pagination',
      '.pagination',
      '.page-numbers',
      '.pagination-nav',
      'ul.pagination',
      '.wp-pagenavi'
    ].join(', ')
  );

  // if we can't even find a container, try global rel/aria first
  if (!container) {
    // global fallbacks
    const relNext = await page.$('a[rel="next"]');
    if (relNext) return await relNext.getAttribute('href');

    const ariaNext = await page.$('a[aria-label="Next"], button[aria-label="Next"]');
    if (ariaNext && await ariaNext.getAttribute('href')) {
      return await ariaNext.getAttribute('href');
    }

    const textNext = await page.$('a:has-text("Next"), button:has-text("Next")');
    if (textNext && await textNext.getAttribute('href')) {
      return await textNext.getAttribute('href');
    }

    return null;
  }

  // 1) direct "next" anchors inside the container
  const directNext = await container.$('a[rel="next"], a[aria-label="Next"], a:has-text("Next")');
  if (directNext) {
    const href = await directNext.getAttribute('href');
    if (href && href.trim()) return href;
  }

  // 2) numbered pagination: find current active page and use its next sibling anchor
  const active = await container.$(
    'li.is-active a, li.active a, a.page-numbers.current, .current > a, .active > a, .pagination__link.is-current'
  );
  if (active) {
    // try next sibling anchor
    const nextSibling = await active.evaluateHandle(el => {
      let n = el.parentElement;
      while (n && n.nextElementSibling) {
        const a = n.nextElementSibling.querySelector('a[href]');
        if (a) return a;
        n = n.nextElementSibling;
      }
      return null;
    });
    if (nextSibling) {
      const href = await nextSibling.getAttribute('href');
      if (href && href.trim()) return href;
    }
  }

  // 3) heuristic: collect all page-number anchors, pick the one with number = current+1
  const pages = await container.$$eval('a[href]', as => {
    return as.map(a => ({
      href: a.getAttribute('href'),
      num: (a.textContent || '').trim()
    })).filter(x => x.href);
  });

  // find largest numeric label as "last", and current by .current if we can't parse
  const numeric = pages
    .map(p => ({ ...p, n: parseInt(p.num.replace(/[^\d]/g, ''), 10) }))
    .filter(p => !Number.isNaN(p.n));

  if (numeric.length) {
    // detect current from "current" class first
    let currentN = null;
    if (active) {
      const t = await active.textContent();
      const n = parseInt((t || '').replace(/[^\d]/g, ''), 10);
      if (!Number.isNaN(n)) currentN = n;
    }
    if (currentN != null) {
      const next = numeric.find(p => p.n === currentN + 1);
      if (next) return next.href;
    }

    // fallback: choose next higher number than min visited count
    // (not perfect, but better than nothing)
    const maxN = Math.max(...numeric.map(p => p.n));
    const minN = Math.min(...numeric.map(p => p.n));
    // if we're at the start, prefer the smallest > min
    const candidate = numeric.find(p => p.n === minN + 1);
    if (candidate) return candidate.href;
  }

  return null;
}

async function collectAllWhopLinksFromWhpCodes(context, baseUrl = 'https://whpcodes.com/') {
  const page = await context.newPage();
  const maxPages = parseInt(process.env.WHPCODES_MAX_PAGES || '200', 10);

  // helper: extract "Go to page" links that point to whop.com
  async function extractWhopLinks() {
    return await page.$$eval('a', as =>
      Array.from(new Set(
        as
          .filter(a =>
            a.href &&
            /whop\.com/i.test(a.href) &&
            /go to page/i.test(a.textContent || '')
          )
          .map(a => a.href.trim())
      ))
    );
  }

  // helper: load a page URL and return the extracted links
  async function loadAndGrab(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // brief settle for client-side content
    await page.waitForTimeout(600);
    try {
      await page.waitForLoadState('networkidle', { timeout: 3500 });
    } catch (_) {}
    return await extractWhopLinks();
  }

  // 1) Detect which pagination scheme works: /?page=N vs /page/N
  const schemes = [
    (n) => new URL(`/?page=${n}`, baseUrl).toString(),
    (n) => new URL(`/page/${n}`, baseUrl).toString(),
  ];

  let makePageUrl = null;

  // probe page 2 with each scheme
  for (const scheme of schemes) {
    try {
      // load page 1 to get a baseline
      await loadAndGrab(scheme(1));
      const before = page.url();
      const links2 = await loadAndGrab(scheme(2));
      const after  = page.url();

      // scheme "works" if URL actually changed and we didn't get bounced back
      if (after !== before) {
        makePageUrl = scheme;
        console.log(`Detected pagination scheme: ${scheme(2)}`);
        // If page 2 produced some links (or even 0), it's still a valid scheme
        break;
      }
    } catch (_) {
      // try next scheme
    }
  }

  // fallback: if neither worked, just use base without paging
  if (!makePageUrl) {
    console.warn('Could not detect pagination scheme. Falling back to single page.');
    const links = await loadAndGrab(baseUrl);
    await page.close();
    return Array.from(new Set(links));
  }

  // 2) Iterate pages deterministically until we run out
  const collected = new Set();
  let lastNonEmptyPage = 0;

  for (let n = 1; n <= maxPages; n++) {
    const url = makePageUrl(n);
    const links = await loadAndGrab(url);

    // If the site bounces invalid pages back to page 1, detect and stop
    const effective = page.url();
    if (n > 1 && /[?&/]page(\=|\/)1\b/i.test(effective)) {
      console.log(`Pagination bounced back to page 1 at n=${n}. Stopping.`);
      break;
    }

    // If this page produced zero whop links, consider it the end
    if (!links.length) {
      // allow one trailing empty (in case of sparse pages), then stop
      if (lastNonEmptyPage && n > lastNonEmptyPage + 1) {
        console.log(`No links found on page ${n}. Stopping.`);
        break;
      }
    } else {
      lastNonEmptyPage = n;
      links.forEach(href => collected.add(href));
    }

    console.log(`Page ${n}: ${links.length} links (total: ${collected.size})`);

    // small random delay to be polite
    await page.waitForTimeout(300 + Math.floor(Math.random() * 400));
  }

  await page.close();
  return Array.from(collected);
}

async function scrapePopupFromWhop(context, productUrl) {
  const page = await context.newPage();

  try {
    // Set realistic headers and referrer
    await context.setExtraHTTPHeaders({
      'Referer': 'https://whop.com/discover/',
      'Sec-CH-UA-Platform': '"macOS"',
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // Navigate to product page
    await page.goto(productUrl, { waitUntil: 'domcontentloaded' });

    // Use the robust network extraction utility
    const promo = await extractPopupPromoFromNetwork(page);

    let saved = 0;
    if (promo && (promo.code || promo.amountOff || promo.discountOff)) {
      const record = {
        productUrl,
        productId: (productUrl.match(/productId=([^&]+)/) || [,''])[1] ||
                   (productUrl.match(/\/([^/?]+)\/?(?:\?|$)/) || [,''])[1],
        productRoute: (productUrl.match(/\/([^/?#]+)/) || [,''])[1],
        productTitle: await page.title().catch(() => ''),
        amountOff: promo.amountOff ?? '',
        discountOff: promo.discountOff ?? '',
        code: promo.code ?? '',
        promoId: promo.promoId ?? '',
        sourceUrl: promo.url || ''
      };

      appendCsv(record);
      upsertJson(record);
      saved++;
      console.log(`🎉 Found popup code for ${productUrl}: ${record.code || 'discount'} (${record.amountOff || record.discountOff}) via ${promo.type}`);
    } else {
      console.log(`— No promo found for ${productUrl}`);
    }

    await page.close();
    return saved;

  } catch (err) {
    console.warn(`Error scraping ${productUrl}: ${err.message}`);
    await page.close();
    return 0;
  }
}

async function runPool(items, worker, concurrency) {
  const queue = [...items];
  let active = 0;
  let done = 0;
  return new Promise(resolve => {
    const tick = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length) {
        const item = queue.shift();
        active++;
        worker(item)
          .catch(() => {})
          .finally(() => {
            active--; done++;
            process.stdout.write(`\rProcessed ${done}/${items.length}`);
            setTimeout(tick, 0);
          });
      }
    };
    tick();
  });
}

(async () => {
  ensureOut();

  console.log('🚀 Starting WHP Codes scraper with enhanced authentication and parsing...');
  if (HEADED) console.log('👁️  Running in headed mode for debugging');

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: SLOWMO,
    args: HEADED ? ['--start-maximized'] : []
  });

  const context = await loadAuth(browser);

  // 1) Collect Whop product links from whpcodes.com
  console.log(`📋 Collecting product links from ${START_URL}`);
  const productUrls = await collectAllWhopLinksFromWhpCodes(context, START_URL);
  console.log(`✅ Found ${productUrls.length} Whop links via whpcodes.com`);

  if (productUrls.length === 0) {
    console.log('❌ No product URLs found. Check whpcodes.com connectivity.');
    await browser.close();
    return;
  }

  // 2) Visit each product page and capture popupPromoCode
  console.log(`🔍 Scanning ${productUrls.length} products for popup promo codes...`);
  let found = 0;
  let processed = 0;

  await runPool(productUrls, async (url) => {
    const n = await scrapePopupFromWhop(context, url);
    if (n > 0) found += n;
    processed++;

    if (processed % 10 === 0 || n > 0) {
      console.log(`📊 Progress: ${processed}/${productUrls.length}, codes found: ${found}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS + Math.random()*DELAY_MS)); // polite jitter
  }, CONCURRENCY);

  console.log(`\n🎉 Scraping complete!`);
  console.log(`📈 Products scanned: ${processed}/${productUrls.length}`);
  console.log(`🎫 Popup promo codes found: ${found}`);
  console.log(`📁 Output files:`);
  console.log(`   CSV: ${OUT_CSV}`);
  console.log(`   JSON: ${OUT_JSON}`);

  if (found === 0) {
    console.log(`\n💡 Tips to find more codes:`);
    console.log(`   1. Run 'npm run login:capture' to authenticate`);
    console.log(`   2. Try during promotional periods/campaigns`);
    console.log(`   3. Use HEADED=1 to debug individual products`);
  }

  await browser.close();
})().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});