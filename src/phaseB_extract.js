// src/phaseB_extract.js
// Phase B: Extraction - Process queue with checkpointing and crash recovery

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from './utils/extractPromo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(__dirname, '..', 'out');
const Q = path.join(DATA, 'queue.jsonl');
const VIS = path.join(DATA, 'visited.jsonl');
const ERR = path.join(DATA, 'errors.jsonl');
const HEART = path.join(DATA, 'heartbeat.json');

function loadSet(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l).url));
}

async function* iterateQueue() {
  if (!fs.existsSync(Q)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(Q, 'utf8'),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

async function extractAll({ concurrency = 2, storage = process.env.WHOP_STORAGE }) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const done = loadSet(VIS);
  const failed = loadSet(ERR);

  // Build list of URLs to process
  const toProcess = [];
  for await (const item of iterateQueue()) {
    if (!item?.url) continue;
    if (done.has(item.url) || failed.has(item.url)) continue;
    toProcess.push(item.url);
  }

  console.log(`🚀 Starting extraction phase`);
  console.log(`📊 Queue status:`);
  console.log(`   - Total in queue: ${done.size + failed.size + toProcess.length}`);
  console.log(`   - Already completed: ${done.size}`);
  console.log(`   - Previous errors: ${failed.size}`);
  console.log(`   - To process: ${toProcess.length}`);

  if (toProcess.length === 0) {
    console.log(`✅ Nothing to process! All URLs have been visited.`);
    return;
  }

  // Setup browser with authentication
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    storageState: storage && fs.existsSync(storage) ? storage : undefined,
    bypassCSP: true,
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    locale: 'en-GB',
  });

  // Setup routing and timeouts to mirror DevTools behavior
  await context.route('**/*', route => route.continue());
  await context.setDefaultTimeout(45000);
  await context.setDefaultNavigationTimeout(45000);
  await context.addInitScript(() => localStorage.setItem('devtools:disableCache','1'));

  console.log(storage && fs.existsSync(storage)
    ? `🔐 Using authenticated session: ${storage}`
    : '⚠️ No authentication - some promos may be hidden');

  // Verify authentication
  const testPage = await context.newPage();
  try {
    await testPage.goto('https://whop.com/', { waitUntil: 'domcontentloaded' });
    const loggedIn = await testPage.locator('a[href*="/profile"], [data-testid="user-menu"], .avatar, [href*="/dashboard"]').first().isVisible().catch(() => false);
    console.log(loggedIn ? '✅ Authenticated session verified' : '⚠️ Not logged in - proceeding unauthenticated');
  } catch (e) {
    console.log('⚠️ Could not verify authentication status');
  } finally {
    await testPage.close();
  }

  // Progress tracking
  let active = 0, idx = 0, found = 0, empty = 0, errors = 0;

  // Open file descriptors for append-only writes
  const visFd = fs.openSync(VIS, 'a');
  const errFd = fs.openSync(ERR, 'a');

  // Graceful shutdown handler
  let stopping = false;
  const gracefulShutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n⏳ Graceful shutdown initiated...');
    console.log(`📊 Final stats: processed ${idx}/${toProcess.length}, found ${found}, empty ${empty}, errors ${errors}`);

    // Wait for active workers to finish
    while (active > 0) {
      console.log(`⏳ Waiting for ${active} active workers to finish...`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Close file descriptors
    fs.closeSync(visFd);
    fs.closeSync(errFd);

    // Write final heartbeat
    fs.writeFileSync(HEART, JSON.stringify({
      idx, found, empty, errors, active: 0,
      status: 'shutdown',
      at: new Date().toISOString()
    }, null, 2));

    await context.close();
    await browser.close();
    console.log('✅ Graceful shutdown complete. Progress saved.');
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Worker function for processing individual URLs
  async function worker(url) {
    active++;
    const page = await context.newPage();

    try {
      // Extract route from URL for spillover prevention
      const routeFromUrl = (u) => {
        try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; }
      };
      const currentRoute = routeFromUrl(url);

      // Navigate to product page
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Extract popup promo using our robust utility with route-based spillover prevention
      const hit = await extractPopupPromoFromNetwork(page, { timeoutMs: 15000, currentRoute });

      // Create visit record
      const record = {
        url,
        found: !!(hit?.code || hit?.amountOff || hit?.discountOff),
        code: hit?.code || null,
        amountOff: hit?.amountOff || null,
        discountOff: hit?.discountOff || null,
        promoId: hit?.promoId || null,
        type: hit?.type || null,
        sourceUrl: hit?.url || null,
        checkedAt: new Date().toISOString()
      };

      if (record.found) {
        found++;
        console.log(`🎉 Found popup code: ${record.code || 'discount'} (${record.amountOff || record.discountOff}) at ${url}`);
      } else {
        empty++;
        if (process.env.DEBUG) {
          console.log(`— No promo found at ${url}`);
        }
      }

      // Write to visited log
      fs.writeSync(visFd, JSON.stringify(record) + '\n');

    } catch (error) {
      errors++;
      const errorRecord = {
        url,
        error: String(error?.message || error),
        at: new Date().toISOString()
      };
      fs.writeSync(errFd, JSON.stringify(errorRecord) + '\n');
      console.warn(`❌ Error processing ${url}: ${error.message}`);

    } finally {
      await page.close().catch(() => {});
      active--;
      idx++;

      // Update heartbeat every 10 URLs
      if ((idx % 10) === 0 || idx === toProcess.length) {
        fs.writeFileSync(HEART, JSON.stringify({
          idx, found, empty, errors, active,
          progress: `${idx}/${toProcess.length}`,
          status: 'running',
          at: new Date().toISOString()
        }, null, 2));

        console.log(`📊 Progress: ${idx}/${toProcess.length} (found: ${found}, empty: ${empty}, errors: ${errors}, active: ${active})`);
      }
    }
  }

  // Process queue with limited concurrency
  let queueIndex = 0;

  async function processQueue() {
    while (queueIndex < toProcess.length && !stopping) {
      // Wait if we're at max concurrency
      while (active >= concurrency && !stopping) {
        await new Promise(r => setTimeout(r, 100));
      }

      if (!stopping) {
        const url = toProcess[queueIndex++];
        worker(url);
        // Small delay between spawning workers
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }
    }

    // Wait for all workers to complete
    while (active > 0 && !stopping) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await processQueue();

  if (!stopping) {
    console.log(`\n🎉 Extraction complete!`);
    console.log(`📈 Final results:`);
    console.log(`   - Processed: ${idx}/${toProcess.length}`);
    console.log(`   - Popup codes found: ${found}`);
    console.log(`   - No codes: ${empty}`);
    console.log(`   - Errors: ${errors}`);
    console.log(`📁 Data files: ${DATA}`);

    await gracefulShutdown();
  }
}

// Run if called directly
if (process.argv[1] === __filename) {
  const concurrency = Number(process.env.WHOP_CONCURRENCY || 2);
  const storage = process.env.WHOP_STORAGE;

  extractAll({ concurrency, storage }).catch(error => {
    console.error('❌ Extraction failed:', error);
    process.exit(1);
  });
}

export { extractAll };