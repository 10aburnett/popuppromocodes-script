// src/update_discounts.js
// Re-extracts discount data for existing promo codes

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from './utils/extractPromo.js';

const VISITED_FILE = path.join(process.cwd(), 'data', 'visited.jsonl');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'visited_with_discounts.jsonl');
const HEARTBEAT_FILE = path.join(process.cwd(), 'data', 'discount_update_heartbeat.json');

function routeFromUrl(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; }
}

function loadRecords() {
  const lines = readFileSync(VISITED_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

function updateHeartbeat(data) {
  writeFileSync(HEARTBEAT_FILE, JSON.stringify(data, null, 2));
}

(async () => {
  const allRecords = loadRecords();
  const withCodes = allRecords.filter(r => r.found && r.code);

  console.log(`📊 Total records: ${allRecords.length}`);
  console.log(`🎯 Records with codes: ${withCodes.length}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: process.env.WHOP_STORAGE || 'auth/whop.json',
    serviceWorkers: 'block'
  });

  let processed = 0;
  let withDiscounts = 0;
  let noDiscounts = 0;

  // Write all records without codes first
  const recordsWithoutCodes = allRecords.filter(r => !r.found || !r.code);
  for (const rec of recordsWithoutCodes) {
    appendFileSync(OUTPUT_FILE, JSON.stringify(rec) + '\n');
  }

  for (const oldRecord of withCodes) {
    const page = await context.newPage();

    try {
      console.log(`\n[${processed + 1}/${withCodes.length}] ${oldRecord.url}`);
      console.log(`  Original code: ${oldRecord.code}`);

      await page.goto(oldRecord.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const route = routeFromUrl(oldRecord.url);

      const hit = await extractPopupPromoFromNetwork(page, { timeoutMs: 15000, currentRoute: route });

      const updatedRecord = {
        ...oldRecord,
        discountPercent: hit?.discountPercent || null,
        amountOff: hit?.amountOff || null,
        amountOffInCents: hit?.amountOffInCents || null,
        sourceUrl: hit?.sourceUrl || oldRecord.sourceUrl,
        updatedAt: new Date().toISOString()
      };

      if (hit?.discountPercent || hit?.amountOff || hit?.amountOffInCents) {
        withDiscounts++;
        const disc = [];
        if (hit.discountPercent) disc.push(`${hit.discountPercent}%`);
        if (hit.amountOff) disc.push(`amountOff=${hit.amountOff}`);
        if (hit.amountOffInCents) disc.push(`${hit.amountOffInCents}¢`);
        console.log(`  ✅ Discount found: ${disc.join(', ')}`);
      } else {
        noDiscounts++;
        console.log(`  ℹ️  No discount data found`);
      }

      appendFileSync(OUTPUT_FILE, JSON.stringify(updatedRecord) + '\n');
      processed++;

      updateHeartbeat({
        processed,
        total: withCodes.length,
        withDiscounts,
        noDiscounts,
        progress: `${processed}/${withCodes.length}`,
        status: 'running',
        at: new Date().toISOString()
      });

    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      // Write original record on error
      appendFileSync(OUTPUT_FILE, JSON.stringify(oldRecord) + '\n');
      processed++;
    } finally {
      await page.close().catch(() => {});
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  await browser.close();

  updateHeartbeat({
    processed,
    total: withCodes.length,
    withDiscounts,
    noDiscounts,
    progress: `${processed}/${withCodes.length}`,
    status: 'completed',
    at: new Date().toISOString()
  });

  console.log('\n🎉 DISCOUNT UPDATE COMPLETE!');
  console.log(`📊 Processed: ${processed}`);
  console.log(`✅ With discounts: ${withDiscounts}`);
  console.log(`ℹ️  No discount data: ${noDiscounts}`);
  console.log(`\n💾 Updated data saved to: ${OUTPUT_FILE}`);
  console.log(`\nTo replace original: mv ${OUTPUT_FILE} ${VISITED_FILE}`);
})();