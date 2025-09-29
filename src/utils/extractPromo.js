// src/utils/extractPromo.js
// Hardened extractor with ChatGPT's surgical fix for anchor-based context attribution

const textDecoder = new TextDecoder('utf-8');

// Only skip obvious static assets; keep everything else (including graphql/messages)
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|woff2?|ttf|map|mp4|webm|m4s|mp3|wav)(\?|$)/i;

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

export async function extractPopupPromoFromNetwork(page, { timeoutMs = 15000, currentRoute = null } = {}) {
  const hits = [];
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
    const url = resp.url();
    const isGraphQL = /graphql/i.test(url);
    if (isGraphQL && req) {
      const post = req.postData() || '';
      const op = /"operationName"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';
      const varRoute = /"route"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';
      const varPid   = /"productId"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';
      const varCid   = /"companyId"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';

      const routeMatch = ctx.route && varRoute && varRoute.toLowerCase() === ctx.route.toLowerCase();
      const pidMatch   = ctx.productId && varPid && varPid === ctx.productId;
      const cidMatch   = ctx.companyId && varCid && varCid === ctx.companyId;

      // Only accept if variables tie to this page (route or ids)
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

  const handler = async (request) => {
    try {
      const resp = await request.response();
      if (!resp) return;

      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      // Skip static junk early
      if (/image|font|video|audio|css/.test(ct)) return;

      // Read response text safely
      let body = '';
      try { body = await resp.text(); } catch {}
      if (!body) return;

      // quick check: avoid scanning huge blobs that can't possibly contain 'promo-'
      if (!/promo-|popupPromoCode|promoCode/i.test(body) && !/promoCode=/i.test(resp.url())) return;

      // Gather candidates
      const codes = new Set();
      for (const c of findCodes(body)) codes.add(c.toLowerCase());

      // If URL has promoCode param
      const urlParam = /[?&]promoCode=(promo-[a-z0-9-]{6,})/i.exec(resp.url());
      if (urlParam) codes.add(urlParam[1].toLowerCase());

      if (codes.size === 0) return;

      // Decide per code
      for (const code of codes) {
        const ok = accept({ code, req: request, resp, body, ct, now: Date.now() });
        if (!ok) {
          if (process.env.DEBUG) {
            console.log(`❌ reject ${code} from ${resp.url()} (route=${ctx.route})`);
          }
          continue;
        }
        const hit = {
          code,
          url: resp.url(),
          ct,
          ts: Date.now(),
          route: ctx.route || null
        };
        if (process.env.DEBUG) {
          console.log(`✅ accept ${code} @ ${resp.url()} (route=${ctx.route})`);
        }
        hits.push(hit);
      }
    } catch (e) {
      if (process.env.DEBUG) console.log('handler error:', e.message);
    }
  };

  page.on('requestfinished', handler);

  // You already do this, but make sure flow mirrors your manual steps:
  // - disable cache
  // - goto
  // - wait a bit (quiet network), then *hard* reload, then wait again
  await page.route('**/*', route => route.continue());
  await page.goto(await page.url(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(700);

  page.off('requestfinished', handler);

  if (!hits.length) return null;

  // de-dupe and pick best by "structured > same-route > JSON/RSC > recency"
  const byCode = new Map();
  for (const h of hits) {
    const prev = byCode.get(h.code);
    if (!prev) byCode.set(h.code, h);
    else if (h.ts > prev.ts) byCode.set(h.code, h);
  }
  const ranked = [...byCode.values()].sort((a, b) => {
    const s = (x) =>
      (x.ct.includes('application/json') || x.ct.includes('text/x-component') ? 40 : 0) +
      (x.route && currentRoute && x.route.toLowerCase() === currentRoute.toLowerCase() ? 30 : 0) +
      x.ts / 1e6; // slight recency tie-break
    return s(b) - s(a);
  });

  return { code: ranked[0].code, type: ranked[0].ct, sourceUrl: ranked[0].url }; // "bottom-most meaningful" equivalent
}