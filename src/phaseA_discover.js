// src/phaseA_discover.js
// Phase A: Discovery - Build queue of all WHOP product URLs from whpcodes.com

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA = path.join(__dirname, '..', 'data');
const Q = path.join(DATA, 'queue.jsonl');
const VIS = path.join(DATA, 'visited.jsonl');

function loadSet(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l).url));
}

async function discoverAll({ start = 'https://whpcodes.com/', maxPages = 100 }) {
  fs.mkdirSync(DATA, { recursive: true });
  const seen = loadSet(Q);
  const done = loadSet(VIS);
  const already = new Set([...seen, ...done]);

  console.log(`🔍 Starting discovery from ${start}`);
  console.log(`📊 Already processed: ${done.size}, in queue: ${seen.size}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let totalAdded = 0;

  // Use the same pagination detection from our working scraper
  // 1) Detect which pagination scheme works: /?page=N vs /page/N
  const schemes = [
    (n) => new URL(`/?page=${n}`, start).toString(),
    (n) => new URL(`/page/${n}`, start).toString(),
  ];

  let makePageUrl = null;

  // Probe page 2 with each scheme
  for (const scheme of schemes) {
    try {
      // Load page 1 to get a baseline
      await page.goto(scheme(1), { waitUntil: 'domcontentloaded' });
      const before = page.url();
      await page.goto(scheme(2), { waitUntil: 'domcontentloaded' });
      const after = page.url();

      // Scheme "works" if URL actually changed and we didn't get bounced back
      if (after !== before) {
        makePageUrl = scheme;
        console.log(`Detected pagination scheme: ${scheme(2)}`);
        break;
      }
    } catch (_) {
      // Try next scheme
    }
  }

  // Fallback: if neither worked, just use base without paging
  if (!makePageUrl) {
    console.warn('Could not detect pagination scheme. Using single page.');
    makePageUrl = (n) => n === 1 ? start : null;
    maxPages = 1;
  }

  // 2) Iterate pages deterministically until we run out
  let lastNonEmptyPage = 0;

  for (let n = 1; n <= maxPages; n++) {
    const url = makePageUrl(n);
    if (!url) break;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      try {
        await page.waitForLoadState('networkidle', { timeout: 3500 });
      } catch (_) {}

      // Use EXACT same extraction logic as working scraper
      const links = await page.$$eval('a', as =>
        Array.from(new Set(
          as.filter(a =>
            a.href &&
            /whop\.com/i.test(a.href) &&
            /go to page/i.test(a.textContent || '')
          ).map(a => a.href.trim())
        ))
      );

      // If this page produced zero whop links, consider it the end
      if (!links.length) {
        // Allow one trailing empty (in case of sparse pages), then stop
        if (lastNonEmptyPage && n > lastNonEmptyPage + 1) {
          console.log(`No links found on page ${n}. Stopping.`);
          break;
        }
      } else {
        lastNonEmptyPage = n;
      }

      let added = 0;
      const fd = fs.openSync(Q, 'a');

      for (const u of links) {
        if (already.has(u)) continue;
        fs.writeSync(fd, JSON.stringify({
          url: u,
          discoveredAt: new Date().toISOString(),
          fromPage: n
        }) + '\n');
        already.add(u);
        added++;
        totalAdded++;
      }

      fs.closeSync(fd);
      console.log(`📄 Page ${n}: found ${links.length} links, added ${added} new (total: ${already.size})`);

      // Small delay to be polite
      await page.waitForTimeout(300 + Math.floor(Math.random() * 400));

    } catch (error) {
      console.warn(`⚠️  Error on page ${n}: ${error.message}`);
    }
  }

  await browser.close();

  console.log(`\n✅ Discovery complete!`);
  console.log(`📈 Total URLs added this run: ${totalAdded}`);
  console.log(`📊 Total unique URLs in queue: ${already.size}`);
  console.log(`📁 Queue file: ${Q}`);
}

// Run if called directly
if (process.argv[1] === __filename) {
  const max = Number(process.env.WHPCODES_MAX_PAGES || 100);
  const start = process.env.WHPCODES_START_URL || 'https://whpcodes.com/';

  discoverAll({ start, maxPages: max }).catch(error => {
    console.error('❌ Discovery failed:', error);
    process.exit(1);
  });
}

export { discoverAll };