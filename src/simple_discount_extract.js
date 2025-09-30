// src/simple_discount_extract.js
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from './utils/extractPromo.js';

const VISITED = path.join(process.cwd(), 'data', 'visited.jsonl');
const OUT     = path.join(process.cwd(), 'data', 'discount_results.jsonl');

function routeFromUrl(u){ try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; } }

// Product discovery helper - finds product-level routes where popupPromoCode actually lives
async function discoverProductCandidates(context, baseUrl) {
  const page = await context.newPage();
  const candidates = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle').catch(()=>{});

    const base = new URL(baseUrl);
    const route = base.pathname.split('/').filter(Boolean)[0] || null;
    if (!route) return [];

    // 1) DOM anchors that look like /<route>/<product>
    const hrefs = await page.$$eval('a[href]', as =>
      as.map(a => a.getAttribute('href')).filter(Boolean)
    );

    for (const href of hrefs) {
      try {
        // normalize to absolute
        const url = new URL(href, base);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0] === route) {
          // filter out obvious non-product paths
          if (!/^(api|_next|discover|blog|pricing)$/i.test(parts[1])) {
            candidates.add(url.toString());
          }
        }
      } catch {}
    }

    // 2) Inline JSON: look for product slugs in scripts
    const scripts = await page.$$eval('script', ss => ss.map(s => s.textContent || '').filter(Boolean));
    for (const t of scripts) {
      // catch strings like "whop.com/<route>/<productSlug>"
      const re = new RegExp(`whop\\.com\\/${route}\\/(?!api|_next)([a-z0-9-]+)`, 'ig');
      let m;
      while ((m = re.exec(t))) {
        const u = `https://whop.com/${route}/${m[1]}`;
        candidates.add(u);
      }
      // also try to catch "route":"<route>","slug":"<product>"
      const m2 = t.match(new RegExp(`"route"\\s*:\\s*"${route}"[\\s\\S]{0,400}"slug"\\s*:\\s*"([a-z0-9-]+)"`, 'i'));
      if (m2 && m2[1]) {
        candidates.add(`https://whop.com/${route}/${m2[1]}`);
      }
    }
  } catch (_) {
    // ignore; we'll just return whatever we found
  } finally {
    await page.close().catch(()=>{});
  }

  // limit to a few to stay fast
  return Array.from(candidates).slice(0, 5);
}

// Retry extraction with backoff for flaky loads
async function tryExtract(page, url, opts, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await extractPopupPromoFromNetwork(page, { url, ...opts });
    if (last && (last.discountPercent != null || last.amountOff != null || last.amountOffInCents != null)) return last;
    if (i < attempts - 1) {
      await page.waitForTimeout(500 + Math.random() * 750);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
      await page.waitForLoadState('networkidle').catch(()=>{});
    }
  }
  return last;
}

(async () => {
  const rows = readFileSync(VISITED, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const codeRows = rows.filter(r => r.found && r.code && r.url);

  const unique = [];
  const seen = new Set();
  for (const r of codeRows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    unique.push(r);
  }

  // Resume support: skip already-processed (URL + code) pairs
  const redoNull = process.env.REDO_NULL === '1';
  const redoFail = process.env.REDO_FAIL === '1';
  const processed = new Set();

  if (existsSync(OUT)) {
    try {
      const existing = readFileSync(OUT, 'utf8').split('\n').filter(Boolean);
      for (const line of existing) {
        try {
          const r = JSON.parse(line);
          if (!r.url || !r.code) continue;

          // Skip if error and not redoing failures
          if (r.error && !redoFail) {
            processed.add(`${r.url}||${r.code}`);
            continue;
          }

          // Skip if has discount OR (is null and not redoing nulls)
          const hasDiscount = r.discountPercent != null || r.amountOff != null || r.amountOffInCents != null;
          if (hasDiscount || !redoNull) {
            processed.add(`${r.url}||${r.code}`);
          }
        } catch {}
      }
      console.log(`📂 Resuming with ${processed.size} completed items`);
    } catch {
      // File corrupt or missing, start fresh
      writeFileSync(OUT, '');
    }
  } else {
    writeFileSync(OUT, '');
  }

  const remaining = unique.filter(r => !processed.has(`${r.url}||${r.code}`));
  console.log(`🎯 Processing ${remaining.length} remaining of ${unique.length} total`);

  // Graceful shutdown
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; console.log('\n🛑 Stopping after current item...'); });
  process.on('SIGTERM', () => { stopping = true; });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: process.env.WHOP_STORAGE || 'auth/whop.json',
    bypassCSP: true,
    serviceWorkers: 'block',
  });
  await context.route('**/*', route => route.continue());
  await context.addInitScript(() => localStorage.clear());
  await context.setDefaultTimeout(45000);

  let i = 0;
  for (const rec of remaining) {
    if (stopping) break;

    i++;
    let page = await context.newPage();
    try {
      const route = routeFromUrl(rec.url);

      // Attempt 1: base URL with retry
      let hit = await tryExtract(page, rec.url, {
        timeoutMs: 18000,
        currentRoute: route,
        onlyThisCode: rec.code,
      });

      // If no discount, Attempt 2: discover product pages and try them
      if (!hit?.discountPercent && !hit?.amountOff && !hit?.amountOffInCents) {
        const products = await discoverProductCandidates(context, rec.url);

        for (const prodUrl of products) {
          // IMPORTANT: new page per attempt so listeners attach before nav
          await page.close().catch(()=>{});
          const p2 = await context.newPage();

          try {
            hit = await tryExtract(p2, prodUrl, {
              timeoutMs: 18000,
              currentRoute: route,
              onlyThisCode: rec.code,
            });
            if (hit?.discountPercent || hit?.amountOff || hit?.amountOffInCents) {
              // found; assign page reference so finally{} can close
              page = p2;
              break;
            }
          } finally {
            if (p2 !== page) await p2.close().catch(()=>{});
          }
        }
      }

      const out = {
        url: rec.url,
        code: rec.code,
        discountPercent: hit?.discountPercent ?? null,
        amountOff: hit?.amountOff ?? null,
        amountOffInCents: hit?.amountOffInCents ?? null,
        sourceUrl: hit?.sourceUrl ?? null,
        checkedAt: new Date().toISOString(),
      };

      const ok = out.discountPercent != null || out.amountOff != null || out.amountOffInCents != null;
      const already = unique.length - remaining.length;
      console.log(`[${already + i}/${unique.length}] ${rec.url}  ${rec.code}  ${ok ? '✅' : '—'}`);

      appendFileSync(OUT, JSON.stringify(out) + '\n');
    } catch (e) {
      const already = unique.length - remaining.length;
      console.log(`[${already + i}/${unique.length}] ${rec.url} ❌ ${e.message}`);
      appendFileSync(OUT, JSON.stringify({
        url: rec.url, code: rec.code, error: e.message, checkedAt: new Date().toISOString()
      }) + '\n');
    } finally {
      await page.close().catch(()=>{});
      await new Promise(r => setTimeout(r, 350));
    }
  }

  await context.close();
  await browser.close();
  console.log(`\n✅ Resume-safe: progress saved to ${OUT}`);
})();
