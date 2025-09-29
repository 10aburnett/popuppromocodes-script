// src/utils/extractPromo.js
// Hardened extractor with improved consistency following ChatGPT recommendations

const textDecoder = new TextDecoder('utf-8');

// Only skip obvious static assets; keep everything else (including graphql/messages)
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|woff2?|ttf|map|mp4|webm|m4s|mp3|wav)(\?|$)/i;

function discoverContext(s) {
  // Extract product/company/route context from response body - more flexible patterns
  const pid = /"productId"\s*:\s*"([^"]+)"/i.exec(s)?.[1] ||
             /"product"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(s)?.[1];
  const cid = /"companyId"\s*:\s*"([^"]+)"/i.exec(s)?.[1] ||
             /"company"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(s)?.[1];
  const route = /"route"\s*:\s*"([^"]+)"/i.exec(s)?.[1];

  // Also try to extract from URL patterns in the body
  if (!route) {
    const urlMatch = /whop\.com\/([^"/?]+)/i.exec(s);
    if (urlMatch && urlMatch[1] !== 'api' && urlMatch[1] !== '_next') {
      return { productId: pid, companyId: cid, route: urlMatch[1] };
    }
  }

  return { productId: pid, companyId: cid, route };
}

function calculateScore(body, ctx, url) {
  // Simplified, effective scoring system
  let score = 0;

  // High-value signals
  if (body.includes('popupPromoCode')) score += 10;
  if (ctx?.route && (body.includes(`"route":"${ctx.route}"`) || body.includes(`whop.com/${ctx.route}`))) score += 10;

  // Content type preferences
  const ct = url.toLowerCase();
  if (ct.includes('application/json') || ct.includes('text/x-component')) score += 5;
  if (url.includes('graphql')) score += 3;

  return Math.max(score, 1); // Minimum score of 1
}

const PROMO_REGEXES = [
  // Direct field extraction
  /"popupPromoCode"\s*:\s*\{[^}]*"code"\s*:\s*"(promo-[a-z0-9-]{6,})"/i,

  // URL parameter extraction
  /[?&]promoCode=(promo-[a-z0-9-]{6,})/i,

  // Quoted string extraction (global to catch multiple)
  /"(promo-[a-z0-9-]{6,})"/gi,

  // Bare token extraction (global to catch multiple)
  /\b(promo-[a-z0-9-]{6,})\b/gi
];

function tryExtractWithRegex(s) {
  for (const re of PROMO_REGEXES) {
    const m = s.match(re);
    if (m && m.length > 0) {
      // For regex with groups, return the first group; otherwise return the full match
      return m[1] || m[0];
    }
  }
  return null;
}

function unescapeRsc(s) {
  // minimal unescape just for \" → "
  return s.replace(/\\"/g, '"');
}

function maybeJsonGetCode(s) {
  try {
    const obj = JSON.parse(s);
    // direct JSON envelope
    if (obj?.popupPromoCode?.code) return obj.popupPromoCode.code;
    // RSC array-like strings sometimes embed JSON-as-string
    const str = typeof obj === 'string' ? obj : null;
    if (str) {
      const code = tryExtractWithRegex(str) || tryExtractWithRegex(unescapeRsc(str));
      if (code) return code;
    }
  } catch (_) {}
  return null;
}

async function readResponseBody(resp) {
  try {
    // text() usually handles brotli/gzip; body() is a fallback
    const ct = resp.headers()['content-type'] || '';
    if (/^application\/octet-stream/.test(ct)) {
      const buf = await resp.body();
      return textDecoder.decode(buf);
    }
    return await resp.text();
  } catch {
    try {
      const buf = await resp.body();
      return textDecoder.decode(buf);
    } catch { return ''; }
  }
}

export async function extractPopupPromoFromNetwork(page, { timeoutMs = 15000 } = {}) {
  const hits = [];
  let pageCtx = null;

  // Try to get basic context from the page URL first
  try {
    const currentUrl = await page.url();
    const urlMatch = /whop\.com\/([^/?]+)/.exec(currentUrl);
    if (urlMatch && urlMatch[1] !== 'api' && urlMatch[1] !== '_next') {
      pageCtx = { route: urlMatch[1] };
      if (process.env.DEBUG) {
        console.log('🔍 Initial context from URL:', pageCtx);
      }
    }
  } catch {}

  const handler = async (resp) => {
    try {
      const url = new URL(resp.url());

      // Prefer whop.com, but allow cdn subdomains too
      if (!/whop\.com$/i.test(url.hostname) && !/\.whop\.com$/i.test(url.hostname)) return;

      // Skip obvious static assets
      if (SKIP_EXT.test(url.pathname)) return;

      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const body = await readResponseBody(resp);
      if (!body) return;

      if (process.env.DEBUG) {
        console.log(`📡 Response: ${resp.url()}`);
        console.log(`   Status: ${resp.status()}`);
        console.log(`   Content-Type: ${ct}`);
        console.log(`   Body length: ${body.length}`);

        // Check for any promo-related content
        const hasPromo = body.includes('promo');
        const hasPopup = body.includes('popup');
        const hasPopupPromoCode = body.includes('popupPromoCode');
        const hasPromoPattern = /promo-[a-z0-9]{6,}/i.test(body);

        if (hasPromo || hasPopup) {
          console.log(`   ⚡ Contains promo-related content: promo=${hasPromo}, popup=${hasPopup}, popupPromoCode=${hasPopupPromoCode}, pattern=${hasPromoPattern}`);

          // If this looks promising, show more details
          if (hasPopupPromoCode || hasPromoPattern) {
            const promoMatches = body.match(/promo-[a-z0-9]{6,}/gi) || [];
            console.log(`   🎯 Potential codes found: ${promoMatches.slice(0, 3).join(', ')}${promoMatches.length > 3 ? '...' : ''}`);
          }
        }
      }

      // Opportunistically capture page context once
      if (!pageCtx && (body.includes('"product"') || body.includes('"company"'))) {
        pageCtx = { ...discoverContext(body) };
        if (process.env.DEBUG) {
          console.log('🔍 Discovered page context:', pageCtx);
        }
      }

      // Focus on data-carrying responses, including edge cases
      const isDataResponse =
        ct.includes('text/x-component') ||
        ct.includes('text/html') ||
        ct.includes('application/json') ||
        ct.includes('text/plain') ||
        ct === ''; // no header, but still useful (JS chunks / edge)
      const hasPromoCode = body.includes('popupPromoCode') || /promo-[a-z0-9]{6,}/i.test(body);

      if (process.env.DEBUG && hasPromoCode) {
        console.log(`🔍 Found potential promo in response from ${resp.url()}`);
        console.log(`   Content-Type: ${ct}`);
        console.log(`   Body length: ${body.length}`);
        console.log(`   Contains 'popupPromoCode': ${body.includes('popupPromoCode')}`);
        console.log(`   Contains promo pattern: ${/promo-[a-z0-9]{6,}/i.test(body)}`);
      }

      if (hasPromoCode) {
        // Extract all possible codes using multi-pattern approach
        for (const rx of PROMO_REGEXES) {
          const matches = [...(body.matchAll(rx) || [])].map(x => x[1] || x[0]);

          if (process.env.DEBUG && matches.length > 0) {
            console.log(`🔍 Pattern ${rx} found ${matches.length} matches: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''}`);
          }

          for (const code of matches) {
            if (process.env.DEBUG) {
              console.log(`🧪 Testing code: "${code}" (length: ${code?.length}, starts with promo-: ${code?.startsWith('promo-')})`);
            }
            if (code && code.startsWith('promo-') && code.length >= 11) {
              const score = calculateScore(body, pageCtx, resp.url());

              if (process.env.DEBUG) {
                console.log(`➕ Hit: ${code} (score=${score}) from ${resp.url()}`);
              }

              hits.push({
                code,
                url: resp.url(),
                ct,
                ts: Date.now(),
                bodyLen: body.length,
                isDataResponse,
                score
              });
            }
          }
        }
      }
    } catch (e) {
      if (process.env.DEBUG) {
        console.log(`Error handling response ${resp.url()}:`, e.message);
      }
    }
  };

  page.on('response', handler);

  try {
    // This function will be called AFTER page.goto() from the runner
    // Wait for page to be fully loaded first
    await page.waitForTimeout(1500);

    // Mimic manual "refresh after DevTools open" flow
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for RSC/GraphQL streams to finish
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    // If no hits, try one more cycle
    if (hits.length === 0) {
      await page.waitForTimeout(500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    console.warn('Error during extraction cycles:', e.message);
  }

  // stop listening
  page.off('response', handler);

  if (hits.length === 0) return null;

  // Deduplicate and prefer highest scoring hit per code
  const uniq = new Map();
  for (const h of hits) {
    const key = h.code.toLowerCase();
    const prev = uniq.get(key);
    if (!prev || (h.score ?? 0) > (prev.score ?? 0) || h.ts > prev.ts) {
      uniq.set(key, h);
    }
  }

  // Rank by score first, then by timestamp
  const ranked = [...uniq.values()].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) || b.ts - a.ts
  );

  const preferred = ranked[0];

  if (process.env.DEBUG) {
    console.log(`🏆 Selected: ${preferred.code} (score=${preferred.score}) from ${preferred.url}`);
    if (ranked.length > 1) {
      console.log(`📊 Other candidates:`);
      for (let i = 1; i < Math.min(ranked.length, 5); i++) {
        console.log(`   ${ranked[i].code} (score=${ranked[i].score})`);
      }
    }
  }

  // best-effort percent detection (optional)
  const percent =
    /(\d{1,2}(\.\d+)?)\s*%/.exec(preferred.ct + ' ' /* seed */) ? RegExp.$1 :
    undefined;

  return { code: preferred.code, percent, type: preferred.ct, sourceUrl: preferred.url };
}