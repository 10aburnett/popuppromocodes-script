// src/extract_discounts.js
// Revisits all URLs with promo codes to extract discount percentages/amounts

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from './utils/extractPromoWithDiscounts.js';

const VISITED_FILE = path.join(process.cwd(), 'data', 'visited.jsonl');
const DISCOUNTS_FILE = path.join(process.cwd(), 'data', 'discounts.jsonl');
const ERRORS_FILE = path.join(process.cwd(), 'data', 'discount_errors.jsonl');
const HEARTBEAT_FILE = path.join(process.cwd(), 'data', 'discount_heartbeat.json');

function routeFromUrl(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; }
}

function loadPromoUrls() {
  const lines = readFileSync(VISITED_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(r => r.found && r.url);
  return lines.map(r => ({ url: r.url, code: r.code }));
}

function loadProcessed() {
  if (!existsSync(DISCOUNTS_FILE)) return new Set();
  const lines = readFileSync(DISCOUNTS_FILE, 'utf8').split('\n').filter(Boolean);
  return new Set(lines.map(l => JSON.parse(l).url));
}

function saveResult(result) {
  appendFileSync(DISCOUNTS_FILE, JSON.stringify(result) + '\n');
}

function saveError(error) {
  appendFileSync(ERRORS_FILE, JSON.stringify(error) + '\n');
}

function updateHeartbeat(data) {
  writeFileSync(HEARTBEAT_FILE, JSON.stringify(data, null, 2));
}

(async () => {
  const allUrls = loadPromoUrls();
  const processed = loadProcessed();
  const toProcess = allUrls.filter(item => !processed.has(item.url));

  console.log(`📊 Total URLs with promo codes: ${allUrls.length}`);
  console.log(`✅ Already processed: ${processed.size}`);
  console.log(`🔄 To process: ${toProcess.length}`);

  if (toProcess.length === 0) {
    console.log('✅ All URLs already processed!');
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: process.env.WHOP_STORAGE || 'auth/whop.json',
    serviceWorkers: 'block'
  });

  let completed = processed.size;
  let withDiscounts = 0;
  let noDiscounts = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const page = await context.newPage();

    try {
      console.log(`\n[${i + 1}/${toProcess.length}] Processing: ${item.url}`);

      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const route = routeFromUrl(item.url);

      const res = await extractPopupPromoFromNetwork(page, { timeoutMs: 15000, currentRoute: route });

      if (res && res.code) {
        const result = {
          url: item.url,
          code: res.code,
          percent_off: res.percent_off ?? null,
          amount_off: res.amount_off ?? null,
          currency: res.currency ?? null,
          source_url: res.sourceUrl,
          checkedAt: new Date().toISOString()
        };

        saveResult(result);
        completed++;

        if (res.percent_off != null || res.amount_off != null) {
          withDiscounts++;
          const disc = [];
          if (res.percent_off != null) disc.push(`${res.percent_off}% off`);
          if (res.amount_off != null) disc.push(`${res.currency || ''}${res.amount_off} off`);
          console.log(`  ✅ Found discount: ${disc.join(', ')}`);
        } else {
          noDiscounts++;
          console.log(`  ℹ️  Code found but no discount info: ${res.code}`);
        }
      } else {
        noDiscounts++;
        saveResult({
          url: item.url,
          code: item.code,
          percent_off: null,
          amount_off: null,
          currency: null,
          source_url: null,
          checkedAt: new Date().toISOString()
        });
        completed++;
        console.log(`  ℹ️  No discount data found`);
      }

      updateHeartbeat({
        idx: completed,
        withDiscounts,
        noDiscounts,
        errors,
        progress: `${completed}/${allUrls.length}`,
        status: 'running',
        at: new Date().toISOString()
      });

    } catch (e) {
      errors++;
      console.log(`  ❌ Error: ${e.message}`);
      saveError({
        url: item.url,
        error: e.message,
        at: new Date().toISOString()
      });
    } finally {
      await page.close().catch(() => {});
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await browser.close();

  updateHeartbeat({
    idx: completed,
    withDiscounts,
    noDiscounts,
    errors,
    progress: `${completed}/${allUrls.length}`,
    status: 'completed',
    at: new Date().toISOString()
  });

  console.log('\n🎉 DISCOUNT EXTRACTION COMPLETE!');
  console.log(`📊 Total processed: ${completed}`);
  console.log(`✅ With discounts: ${withDiscounts}`);
  console.log(`ℹ️  No discount data: ${noDiscounts}`);
  console.log(`❌ Errors: ${errors}`);
})();