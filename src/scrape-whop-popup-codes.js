import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium, devices } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URL_LIST_FILE = process.env.WHOP_URL_LIST || path.join(__dirname, '..', 'product_urls.txt');
const START_SOURCE  = process.env.WHOP_START_URL || ''; // optional discover/search URL
const COOKIES_FILE  = process.env.WHOP_COOKIES || path.join(__dirname, '..', 'cookies.json');

const OUT_DIR  = path.join(__dirname, '..', 'out');
const OUT_JSON = path.join(OUT_DIR, 'whop_popup_codes.json');
const OUT_CSV  = path.join(OUT_DIR, 'whop_popup_codes.csv');

const MAX_CONCURRENCY = Number(process.env.WHOP_CONCURRENCY || 2);
const REQUEST_TIMEOUT = 45000;

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(OUT_JSON)) fs.writeFileSync(OUT_JSON, '[]');
  if (!fs.existsSync(OUT_CSV)) {
    fs.writeFileSync(OUT_CSV, 'timestamp,productUrl,productId,productRoute,productTitle,amountOff,discountOff,code,promoId\n');
  }
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function rand(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function appendCSV(rec){
  const esc = s => (s==null?'':String(s).replace(/\n/g,' ').replace(/"/g,'""'));
  const line = [
    rec.timestamp, rec.productUrl, rec.productId, rec.productRoute,
    `"${esc(rec.productTitle)}"`, rec.amountOff ?? '', rec.discountOff ?? '',
    rec.code ?? '', rec.promoId ?? ''
  ].join(',');
  fs.appendFileSync(OUT_CSV, line + '\n');
}
function readUrlList(){
  if (!fs.existsSync(URL_LIST_FILE)) return [];
  return fs.readFileSync(URL_LIST_FILE,'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
}
async function discoverFrom(page){
  if (!START_SOURCE) return [];
  await page.goto(START_SOURCE, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT });
  // Wait a bit for dynamic content to load
  await page.waitForTimeout(3000);
  // Look for product links in the page
  const links = await page.$$eval('a[href]', as => as.map(a=>a.href));
  const uniq = Array.from(new Set(
    links.filter(h =>
      h.includes('whop.com/discover/') &&
      h !== START_SOURCE &&
      !h.includes('/login') &&
      !h.includes('/dashboard')
    )
  ));
  return uniq;
}
async function loadCookies(ctx){
  if (!fs.existsSync(COOKIES_FILE)) return;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE,'utf8'));
    if (Array.isArray(cookies) && cookies.length) await ctx.addCookies(cookies);
  } catch {}
}

/** tolerant extraction for JSON or streamed RSC blobs */
function extractPromoFromBody(body){
  if (!body || !body.includes('popupPromoCode')) return null;

  // 1) Try full JSON parse & DFS
  try {
    const json = JSON.parse(body);
    const stack = [json];
    while (stack.length){
      const x = stack.pop();
      if (x && typeof x === 'object'){
        if (x.popupPromoCode && (x.popupPromoCode.code || x.popupPromoCode.amountOff != null || x.popupPromoCode.discountOff)){
          return x.popupPromoCode;
        }
        for (const k in x) stack.push(x[k]);
      }
    }
  } catch {
    // 2) Try to pull out the object with a regex and parse that fragment
    const m = body.match(/"popupPromoCode"\s*:\s*\{[^}]*\}/);
    if (m){
      try {
        // Wrap to make valid JSON
        const wrapped = `{${m[0]}}`;
        const parsed = JSON.parse(wrapped);
        if (parsed.popupPromoCode) return parsed.popupPromoCode;
      } catch {}
    }
  }
  return null;
}

async function scrapeOne(context, url){
  const page = await context.newPage();
  let lastPromo = null;  // store the *latest* match (equivalent to "bottom result")
  let productTitle = '';
  let productId = '';
  let productRoute = '';

  page.on('response', async (resp) => {
    try {
      const headers = resp.headers();
      const ct = (headers['content-type'] || headers['Content-Type'] || '');
      if (!(ct.includes('json') || ct.includes('text'))) return;
      const txt = await resp.text();
      const promo = extractPromoFromBody(txt);
      if (promo && (promo.code || promo.amountOff != null || promo.discountOff)){
        lastPromo = promo; // overwrite, keeping the most recent one seen
      }
    } catch {}
  });

  // Load + Reload (mirrors the manual "refresh" step)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT });

  // Minimal human-like activity; some responses load after scroll/idle
  try {
    await page.mouse.move(rand(100,800), rand(120,700));
    await page.mouse.wheel(0, rand(400,1400));
    await page.waitForTimeout(rand(1200,2500));
  } catch {}

  // Collect a few meta fields
  try { productTitle = (await page.locator('h1,[data-testid="product-title"]').first().textContent({ timeout: 1200 })) || ''; } catch {}
  try {
    const u = new URL(page.url());
    productRoute = u.pathname.replace(/^\/+/,'');
    productId = u.searchParams.get('productId') || (u.pathname.match(/prod_[A-Za-z0-9]+/)||[])[0] || '';
  } catch {}

  await page.close();

  if (!lastPromo) return null;

  return {
    timestamp: new Date().toISOString(),
    productUrl: url,
    productId,
    productRoute,
    productTitle: (productTitle||'').trim(),
    amountOff: lastPromo.amountOff ?? null,
    discountOff: lastPromo.discountOff ?? null,
    code: lastPromo.code ?? null,
    promoId: lastPromo.id ?? null,
  };
}

async function main(){
  ensureOut();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 768 }
  });
  await loadCookies(context);

  // Seed discovery (optional)
  const boot = await context.newPage();
  const discovered = await discoverFrom(boot);
  await boot.close();

  const explicit = readUrlList();
  const urls = Array.from(new Set([...explicit, ...discovered]));
  if (!urls.length){
    console.error('No product URLs. Provide product_urls.txt or set WHOP_START_URL.');
    process.exit(2);
  }

  const results = JSON.parse(fs.readFileSync(OUT_JSON,'utf8'));
  const q = urls.slice(); // queue

  async function worker(id){
    while (q.length){
      const url = q.shift();
      try {
        const rec = await scrapeOne(context, url);
        if (rec){
          results.push(rec);
          fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
          appendCSV(rec);
          console.log(`Worker ${id}: ✅ ${rec.code || '(no-code)'} @ ${rec.productRoute}`);
        } else {
          console.log(`Worker ${id}: – no popupPromoCode @ ${url}`);
        }
      } catch (e){
        console.warn(`Worker ${id}: Error on ${url}: ${e.message}`);
      }
      await sleep(rand(600,1600));
    }
  }

  const workers = Math.min(MAX_CONCURRENCY, urls.length);
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i+1)));

  await browser.close();
  console.log('Done. Outputs at:', OUT_JSON, OUT_CSV);
}

main().catch(e => { console.error(e); process.exit(1); });