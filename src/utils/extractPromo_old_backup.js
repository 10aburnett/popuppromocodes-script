// src/utils/extractPromo.js
// Hardened extractor with ChatGPT's surgical fix for anchor-based context attribution

import { extractDiscountNearCode } from './discountParse.js';

const textDecoder = new TextDecoder('utf-8');

// Only skip obvious static assets; keep everything else (including graphql/messages)
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|woff2?|ttf|map|mp4|webm|m4s|mp3|wav)(\?|$)/i;

// —— NEW: Bulletproof discount extraction helpers ——

// pull a small window around an index, but safely
function sliceAround(s, idx, pad = 800) {
  const start = Math.max(0, idx - pad);
  const end   = Math.min(s.length, idx + pad);
  return s.slice(start, end);
}

// Try to find the nearest { ... } block around a code occurrence.
// We walk backwards to the previous '{' and forwards to the matching '}'.
function extractNearestJsonObject(text, codeIndex) {
  let start = codeIndex, end = codeIndex;
  while (start > 0 && text[start] !== '{') start--;
  if (text[start] !== '{') return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end <= start) return null;

  const raw = text.slice(start, end);
  // RSC often escapes quotes; try both raw and unescaped
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/\\"/g, '"')); } catch {}
  return null;
}

function extractDiscountFieldsFromSnippet(snippet) {
  // Accepts an object OR a string snippet
  if (snippet && typeof snippet === 'object') {
    const o = snippet;
    // Direct popupPromoCode object
    if (o.popupPromoCode && typeof o.popupPromoCode === 'object') {
      return {
        discountPercent: normPercent(o.popupPromoCode.discountOff),
        amountOff: numOrNull(o.popupPromoCode.amountOff),
        amountOffInCents: intOrNull(o.popupPromoCode.amountOffInCents),
      };
    }
    // Already the { ... "code":"promo-..." ... } object
    return {
      discountPercent: normPercent(o.discountOff),
      amountOff: numOrNull(o.amountOff),
      amountOffInCents: intOrNull(o.amountOffInCents),
    };
  }

  // String fallback: regex within a local window
  const s = String(snippet || '');
  const pct = /"discountOff"\s*:\s*"(?:\s*)?(\d{1,3}(?:\.\d+)?)\s*%"/i.exec(s)?.[1];
  const amt = /"amountOff"\s*:\s*(\d+(?:\.\d+)?)/i.exec(s)?.[1];
  const cents = /"amountOffInCents"\s*:\s*(\d+)/i.exec(s)?.[1];

  return {
    discountPercent: pct ? Number(pct) : null,
    amountOff: amt ? Number(amt) : null,
    amountOffInCents: cents ? Number(cents) : null,
  };
}

function normPercent(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/(\d+(?:\.\d+)?)\s*%?/);
  return m ? Number(m[1]) : null;
}
function numOrNull(x){ return x == null ? null : Number(x); }
function intOrNull(x){ return x == null ? null : parseInt(String(x), 10); }

function firstWhopRouteIn(text) {
  // finds the first whop.com/<slug> mention embedded in JSON/HTML/etc
  const m = /https?:\/\/(?:www\.)?whop\.com\/([^"\/\s?]+)/i.exec(text);
  return m ? m[1] : null;
}

function routeFromUrl(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; }
}

async function getPageContext(page, fallbackRoute) {
  const url = await page.url();
  const route = routeFromUrl(url) || fallbackRoute || null;

  // Try to sniff IDs from the DOM (covers Next/RSC + inline data blobs)
  const ctx = await page.evaluate(() => {
    const out = {};
    try {
      // Look for inline JSON blobs that often carry product/company ids
      const scripts = [...document.querySelectorAll('script')];
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!t) continue;
        // productId
        let m = /"productId"\s*:\s*"([^"]+)"/i.exec(t) || /"product"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(t);
        if (m) out.productId = m[1];
        // companyId
        m = /"companyId"\s*:\s*"([^"]+)"/i.exec(t) || /"company"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(t);
        if (m) out.companyId = m[1];
        if (out.productId || out.companyId) break;
      }
    } catch {}
    return out;
  });

  return { route, productId: ctx.productId || null, companyId: ctx.companyId || null };
}

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
  /"popupPromoCode"\s*:\s*\{[^}]*"code"\s*:\s*"(promo-[a-z0-9-]{6,})"/gi,   // structured
  /[?&]promoCode=(promo-[a-z0-9-]{6,})/gi,                                   // URL param
  /"(promo-[a-z0-9-]{6,})"/gi,                                               // quoted occurrences
  /(?:^|[^a-z0-9])(promo-[a-z0-9-]{6,})(?=[^a-z0-9]|$)/gi                    // bare token
];

function* findCodes(s) {
  for (const re of PROMO_REGEXES) {
    const it = s.matchAll(re);
    for (const m of it) yield m[1];
  }
}

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

export async function extractPopupPromoFromNetwork(page, { timeoutMs = 15000, currentRoute = null, onlyThisCode = null } = {}) {
  const hits = [];
  const responseCache = []; // NEW: cache responses for cross-response rescue
  const ctx = await getPageContext(page, currentRoute); // {route, productId, companyId}

  const accept = ({ code, req, resp, body, ct, now }) => {
    // 1) must be whop.com
    let hn = '';
    try { hn = new URL(resp.url()).hostname; } catch {}
    if (!/whop\.com$/i.test(hn)) return false;

    // 2) strong belonging checks
    // 2a) structured popupPromoCode on this page → always accept
    if (/popupPromoCode/i.test(body)) {
      // If we can see the current route in body or URL, attribute strongly
      if ((ctx.route && (body.includes(`whop.com/${ctx.route}`) || resp.url().includes(`/${ctx.route}`)))) {
        return true;
      }
      // If structured code object exists but no route, still accept (page-local RSC often omits route)
      if (/"popupPromoCode"\s*:/.test(body)) return true;
    }

    // 2b) GraphQL POST with variables tied to this page
    // NOTE: With response listener we can't check POST data, so we rely on body content matching
    const url = resp.url();
    const isGraphQL = /graphql/i.test(url);
    if (isGraphQL) {
      // Check if response body contains this route/productId/companyId
      const routeMatch = ctx.route && (body.includes(`"route":"${ctx.route}"`) || body.includes(`whop.com/${ctx.route}`));
      const pidMatch   = ctx.productId && body.includes(`"productId":"${ctx.productId}"`);
      const cidMatch   = ctx.companyId && body.includes(`"companyId":"${ctx.companyId}"`);

      // Only accept if body references this page (route or ids)
      if (routeMatch || pidMatch || cidMatch) return true;

      // Otherwise reject (this is where bleed happens: DM channels, feed, etc.)
      return false;
    }

    // 2c) HTML/JSON responses for THIS route
    if ((/text\/html|application\/json|text\/x-component/i.test(ct)) &&
        ctx.route &&
        (resp.url().includes(`/${ctx.route}`) || body.includes(`whop.com/${ctx.route}`))) {
      return true;
    }

    // 3) fallback: don't accept stray JS chunks or cross-product messages
    return false;
  };

  const handler = async (resp) => {
    try {
      const urlStr = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();

      // Skip only obvious static assets
      if (/image|font|video|audio|css/.test(ct)) return;

      // Always attempt to read text (covers html, json, js, x-component, octet-stream)
      let body = '';
      try {
        body = await resp.text();
      } catch {
        try {
          body = textDecoder.decode(await resp.body());
        } catch {}
      }
      if (!body) return;

      // fast precheck
      if (!/promo-|popupPromoCode|promoCode=/.test(body) && !/promoCode=/.test(urlStr)) return;

      // NEW: If caller passed a known code, ignore responses that don't contain it
      if (onlyThisCode) {
        const hasIt = body.toLowerCase().includes(onlyThisCode.toLowerCase()) ||
                      urlStr.toLowerCase().includes(`promoCode=${onlyThisCode.toLowerCase()}`);
        if (!hasIt) return;
      }

      // NEW: Cache response for cross-response rescue
      if (/popupPromoCode|promo-[a-z0-9-]{6,}|promoCode=/i.test(body) || /graphql/i.test(urlStr)) {
        responseCache.push({ body, url: urlStr, ct });
      }

      // Gather candidates
      const codes = new Set();
      for (const c of findCodes(body)) codes.add(c.toLowerCase());

      // If URL has promoCode param
      const urlParam = /[?&]promoCode=(promo-[a-z0-9-]{6,})/i.exec(urlStr);
      if (urlParam) codes.add(urlParam[1].toLowerCase());

      if (codes.size === 0) return;

      // Decide per code
      for (const code of codes) {
        const ok = accept({ code, req: null, resp, body, ct, now: Date.now() });
        if (!ok) {
          if (process.env.DEBUG) {
            console.log(`❌ reject ${code} from ${resp.url()} (route=${ctx.route})`);
          }
          continue;
        }

        // —— NEW: Bulletproof discount extraction from local JSON around the code ——
        const codeIdx = body.toLowerCase().indexOf(code.toLowerCase());
        let discount = { discountPercent: null, amountOff: null, amountOffInCents: null };

        if (codeIdx >= 0) {
          // Try to parse nearest JSON object enclosing this code
          const obj = extractNearestJsonObject(body, codeIdx);
          if (obj) {
            discount = extractDiscountFieldsFromSnippet(obj);
          } else {
            // Fallback: regex scan on a local slice (works for minified blobs & RSC strings)
            const windowText = sliceAround(body, codeIdx, 1200);
            discount = extractDiscountFieldsFromSnippet(windowText);
          }
        }

        const hit = {
          code,
          url: resp.url(),
          ct,
          ts: Date.now(),
          route: ctx.route || null,
          // —— NEW: Bulletproof discount fields ——
          discountPercent: discount.discountPercent,
          amountOff: discount.amountOff,
          amountOffInCents: discount.amountOffInCents
        };
        if (process.env.DEBUG) {
          const dbg = [];
          if (discount.discountPercent) dbg.push(`${discount.discountPercent}%`);
          if (discount.amountOff) dbg.push(`amountOff=${discount.amountOff}`);
          if (discount.amountOffInCents) dbg.push(`${discount.amountOffInCents}¢`);
          console.log(`✅ accept ${code} @ ${resp.url()} (route=${ctx.route})${dbg.length ? ' ['+dbg.join(', ')+']' : ''}`);
        }
        hits.push(hit);
      }
    } catch (e) {
      if (process.env.DEBUG) console.log('handler error:', e.message);
    }
  };

  page.on('response', handler);

  // Bulletproof capture flow
  await page.route('**/*', r => r.continue());
  await page.goto(await page.url(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);

  // hard reload & idle
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(1500);

  page.off('response', handler);

  // HTML fallback: some codes are injected into document or inline scripts
  const html = await page.content();
  if (html && (/promo-|popupPromoCode|promoCode=/.test(html))) {
    // Gather candidates from HTML
    const htmlCodes = new Set();
    for (const c of findCodes(html)) htmlCodes.add(c.toLowerCase());

    // Process HTML codes
    for (const code of htmlCodes) {
      const ok = accept({ code, req: null, resp: { url: () => page.url() }, body: html, ct: 'text/html', now: Date.now() });
      if (!ok) continue;

      const codeIdx = html.toLowerCase().indexOf(code.toLowerCase());
      let discount = { discountPercent: null, amountOff: null, amountOffInCents: null };

      if (codeIdx >= 0) {
        const obj = extractNearestJsonObject(html, codeIdx);
        if (obj) {
          discount = extractDiscountFieldsFromSnippet(obj);
        } else {
          const windowText = sliceAround(html, codeIdx, 1200);
          discount = extractDiscountFieldsFromSnippet(windowText);
        }
      }

      hits.push({
        code,
        url: page.url(),
        ct: 'text/html',
        ts: Date.now(),
        route: ctx.route || null,
        discountPercent: discount.discountPercent,
        amountOff: discount.amountOff,
        amountOffInCents: discount.amountOffInCents
      });
    }
  }

  if (!hits.length) {
    // rescue: if we didn't record a "hit", try to pull discount for onlyThisCode using bulletproof extraction
    if (onlyThisCode) {
      for (const r of responseCache) {
        if (!r.body.toLowerCase().includes(onlyThisCode.toLowerCase())) continue;

        // Use bulletproof extraction
        const codeIdx = r.body.toLowerCase().indexOf(onlyThisCode.toLowerCase());
        if (codeIdx >= 0) {
          const obj = extractNearestJsonObject(r.body, codeIdx);
          let discount = { discountPercent: null, amountOff: null, amountOffInCents: null };

          if (obj) {
            discount = extractDiscountFieldsFromSnippet(obj);
          } else {
            const windowText = sliceAround(r.body, codeIdx, 1200);
            discount = extractDiscountFieldsFromSnippet(windowText);
          }

          if (discount.discountPercent || discount.amountOff || discount.amountOffInCents) {
            return {
              code: onlyThisCode,
              type: r.ct,
              sourceUrl: r.url,
              discountPercent: discount.discountPercent ?? null,
              amountOff: discount.amountOff ?? null,
              amountOffInCents: discount.amountOffInCents ?? null,
            };
          }
        }
      }
    }
    return null;
  }

  // de-dupe and pick best by "has discount > structured > same-route > JSON/RSC > recency"
  const byCode = new Map();
  for (const h of hits) {
    const prev = byCode.get(h.code);
    if (!prev) byCode.set(h.code, h);
    else if (h.ts > prev.ts) byCode.set(h.code, h);
  }
  const ranked = [...byCode.values()].sort((a, b) => {
    const score = (x) =>
      (x.discountPercent != null || x.amountOff != null || x.amountOffInCents != null ? 100 : 0) +
      (x.ct.includes('application/json') || x.ct.includes('text/x-component') ? 40 : 0) +
      (x.route && currentRoute && x.route.toLowerCase() === currentRoute.toLowerCase() ? 30 : 0) +
      x.ts / 1e6; // slight recency tie-break
    return score(b) - score(a);
  });

  const best = ranked[0];

  return {
    code: best.code,
    type: best.ct,
    sourceUrl: best.url,
    discountPercent: best.discountPercent ?? null,
    amountOff: best.amountOff ?? null,
    amountOffInCents: best.amountOffInCents ?? null
  };
}