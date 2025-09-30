// src/utils/extractPromoWithDiscounts.js
// Hardened extractor with anchor-based context attribution + DISCOUNT BUNDLE extraction

const textDecoder = new TextDecoder('utf-8');

// Only skip obvious static assets; keep everything else (including graphql/messages)
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|woff2?|ttf|map|mp4|webm|m4s|mp3|wav)(\?|$)/i;

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
  const pid = /"productId"\s*:\s*"([^"]+)"/i.exec(s)?.[1] ||
             /"product"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(s)?.[1];
  const cid = /"companyId"\s*:\s*"([^"]+)"/i.exec(s)?.[1] ||
             /"company"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i.exec(s)?.[1];
  const route = /"route"\s*:\s*"([^"]+)"/i.exec(s)?.[1];

  if (!route) {
    const urlMatch = /whop\.com\/([^"/?]+)/i.exec(s);
    if (urlMatch && urlMatch[1] !== 'api' && urlMatch[1] !== '_next') {
      return { productId: pid, companyId: cid, route: urlMatch[1] };
    }
  }

  return { productId: pid, companyId: cid, route };
}

function calculateScore(body, ctx, url) {
  let score = 0;
  if (body.includes('popupPromoCode')) score += 10;
  if (ctx?.route && (body.includes(`"route":"${ctx.route}"`) || body.includes(`whop.com/${ctx.route}`))) score += 10;
  const ct = url.toLowerCase();
  if (ct.includes('application/json') || ct.includes('text/x-component')) score += 5;
  if (url.includes('graphql')) score += 3;
  return Math.max(score, 1);
}

// ---------- NEW: helpers for discount bundle extraction ----------

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Find a balanced JSON object containing the code (works for JSON/RSC blobs)
function sliceEnclosingJsonObject(text, codeIndex, maxSpan = 4000) {
  const start = Math.max(0, codeIndex - maxSpan);
  const end   = Math.min(text.length, codeIndex + maxSpan);
  const window = text.slice(start, end);

  let left = window.lastIndexOf('{', codeIndex - start);
  if (left === -1) return null;

  let depth = 0;
  for (let i = left; i < window.length; i++) {
    const ch = window[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = window.slice(left, i + 1);
        return candidate;
      }
    }
  }
  return null;
}

function normalizeDiscountFromObject(obj) {
  let percent_off = null;
  let amount_off  = null;
  let currency    = null;

  if (typeof obj.amountOff === 'number' && obj.amountOff > 0 && obj.amountOff <= 1.0) {
    percent_off = obj.amountOff * 100;
  }
  if (typeof obj.percentOff === 'number') {
    percent_off = obj.percentOff;
  }
  if (typeof obj.discountOff === 'string') {
    const m = obj.discountOff.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) percent_off = parseFloat(m[1]);
  }

  const moneyObj =
    obj.amountOffMoney ||
    obj.priceOff ||
    obj.fixedOff ||
    (obj.amount && obj.currency && { amount: obj.amount, currency: obj.currency });

  if (moneyObj && typeof moneyObj.amount === 'number') {
    amount_off = moneyObj.amount;
    currency = moneyObj.currency || null;
  }

  if (amount_off == null && typeof obj.note === 'string') {
    const m2 = obj.note.match(/([$£€])\s*(\d+(?:\.\d+)?)/);
    if (m2) {
      amount_off = parseFloat(m2[2]);
      currency = m2[1] === '$' ? 'USD' : m2[1] === '£' ? 'GBP' : 'EUR';
    }
  }

  if (percent_off == null && amount_off == null) return null;
  return { percent_off, amount_off, currency };
}

function extractBundleFromBody(body, codeIndex) {
  const jsonSlice = sliceEnclosingJsonObject(body, codeIndex);
  if (!jsonSlice) return null;
  const obj = safeJsonParse(jsonSlice);
  if (!obj) return null;

  function dfs(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.code === 'string' && /^promo-[a-z0-9-]{6,}$/i.test(node.code)) {
      const disc = normalizeDiscountFromObject(node);
      return { code: node.code.toLowerCase(), ...disc };
    }
    if (node.popupPromoCode && typeof node.popupPromoCode === 'object') {
      const p = node.popupPromoCode;
      if (typeof p.code === 'string' && /^promo-[a-z0-9-]{6,}$/i.test(p.code)) {
        const disc = normalizeDiscountFromObject(p);
        return { code: p.code.toLowerCase(), ...disc };
      }
    }
    for (const k of Object.keys(node)) {
      const found = dfs(node[k]);
      if (found) return found;
    }
    return null;
  }
  return dfs(obj);
}

// ---------- existing patterns (kept) ----------

const PROMO_REGEXES = [
  /"popupPromoCode"\s*:\s*\{[^}]*"code"\s*:\s*"(promo-[a-z0-9-]{6,})"/gi,   // structured
  /[?&]promoCode=(promo-[a-z0-9-]{6,})/gi,                                   // URL param
  /"(promo-[a-z0-9-]{6,})"/gi,                                               // quoted occurrences
  /(?:^|[^a-z0-9])(promo-[a-z0-9-]{6,})(?=[^a-z0-9]|$)/gi                    // bare token
];

// Yield { code, index } so we can anchor discount scan
function* findCodesWithIndex(s) {
  for (const re of PROMO_REGEXES) {
    // reset lastIndex for global regexes
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const code = m[1] || m[0];
      yield { code: code.toLowerCase(), index: m.index ?? -1 };
    }
  }
}

function unescapeRsc(s) {
  return s.replace(/\\"/g, '"');
}

async function readResponseBody(resp) {
  try {
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
    if (/popupPromoCode/i.test(body)) {
      if ((ctx.route && (body.includes(`whop.com/${ctx.route}`) || resp.url().includes(`/${ctx.route}`)))) {
        return true;
      }
      if (/"popupPromoCode"\s*:/.test(body)) return true;
    }

    // GraphQL POST with variables tied to this page
    const url = resp.url();
    const isGraphQL = /graphql/i.test(url);
    if (isGraphQL && req) {
      const post = req.postData() || '';
      const varRoute = /"route"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';
      const varPid   = /"productId"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';
      const varCid   = /"companyId"\s*:\s*"([^"]+)"/i.exec(post)?.[1] || '';

      const routeMatch = ctx.route && varRoute && varRoute.toLowerCase() === ctx.route.toLowerCase();
      const pidMatch   = ctx.productId && varPid && varPid === ctx.productId;
      const cidMatch   = ctx.companyId && varCid && varCid === ctx.companyId;

      if (routeMatch || pidMatch || cidMatch) return true;
      return false;
    }

    // HTML/JSON responses for THIS route
    if ((/text\/html|application\/json|text\/x-component/i.test(ct)) &&
        ctx.route &&
        (resp.url().includes(`/${ctx.route}`) || body.includes(`whop.com/${ctx.route}`))) {
      return true;
    }

    return false;
  };

  const handler = async (request) => {
    try {
      const resp = await request.response();
      if (!resp) return;

      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (SKIP_EXT.test(url) || /image|font|video|audio|css/.test(ct)) return;

      let body = '';
      try { body = await readResponseBody(resp); } catch {}
      if (!body) return;

      if (!/promo-|popupPromoCode|promoCode/i.test(body) && !/promoCode=/i.test(url)) return;

      // Gather candidates WITH ANCHORS
      const candidates = [];
      for (const item of findCodesWithIndex(body)) {
        candidates.push(item); // { code, index }
      }

      // promoCode in URL
      {
        const u = /[?&]promoCode=(promo-[a-z0-9-]{6,})/i.exec(url);
        if (u) candidates.push({ code: u[1].toLowerCase(), index: body.indexOf(u[1]) });
      }

      if (candidates.length === 0) return;

      for (const cand of candidates) {
        const ok = accept({ code: cand.code, req: request, resp, body, ct, now: Date.now() });
        if (!ok) {
          if (process.env.DEBUG) console.log(`❌ reject ${cand.code} from ${url} (route=${ctx.route})`);
          continue;
        }

        // ---------- DISCOUNT BUNDLE ATTEMPT ----------
        let percent_off = null, amount_off = null, currency = null;

        if (typeof cand.index === 'number' && cand.index >= 0) {
          const bundle = extractBundleFromBody(body, cand.index);
          if (bundle && bundle.code === cand.code) {
            percent_off = bundle.percent_off ?? null;
            amount_off  = bundle.amount_off  ?? null;
            currency    = bundle.currency    ?? null;
          }
        }

        // Fallback: Nearby window (still SAME response)
        if (percent_off == null && amount_off == null) {
          const i = Math.max(0, (cand.index ?? 0) - 600);
          const j = Math.min(body.length, (cand.index ?? 0) + 600);
          const win = body.slice(i, j);

          const p = win.match(/(\d{1,2}(?:\.\d+)?)\s*%/);
          if (p) percent_off = parseFloat(p[1]);

          const a = win.match(/([$£€])\s*(\d+(?:\.\d+)?)/);
          if (a) {
            amount_off = parseFloat(a[2]);
            currency   = a[1] === '$' ? 'USD' : a[1] === '£' ? 'GBP' : 'EUR';
          }

          const frac = win.match(/"amountOff"\s*:\s*(0?\.\d+)/);
          if (frac && percent_off == null) percent_off = parseFloat(frac[1]) * 100;
        }
        // --------------------------------------------

        const hit = {
          code: cand.code,
          url,
          ct,
          ts: Date.now(),
          route: ctx.route || null,
          percent_off,
          amount_off,
          currency
        };
        if (process.env.DEBUG) {
          const dbg = [];
          if (percent_off != null) dbg.push(`percent=${percent_off}`);
          if (amount_off  != null) dbg.push(`amount=${amount_off} ${currency||''}`);
          console.log(`✅ accept ${cand.code} @ ${url} (route=${ctx.route}) ${dbg.length? '['+dbg.join(', ')+']' : ''}`);
        }
        hits.push(hit);
      }
    } catch (e) {
      if (process.env.DEBUG) console.log('handler error:', e.message);
    }
  };

  page.on('requestfinished', handler);

  await page.route('**/*', route => route.continue());
  await page.goto(await page.url(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(700);

  page.off('requestfinished', handler);

  if (!hits.length) return null;

  // De-dupe by code, pick best by structured/route/ct/recency
  const byCode = new Map();
  for (const h of hits) {
    const prev = byCode.get(h.code);
    if (!prev) byCode.set(h.code, h);
    else {
      // Prefer ones that actually have discount info; else recency
      const scorePrev =
        (prev.percent_off != null || prev.amount_off != null ? 1000 : 0) +
        (prev.ct.includes('application/json') || prev.ct.includes('text/x-component') ? 40 : 0) +
        (prev.route && currentRoute && prev.route.toLowerCase() === currentRoute.toLowerCase() ? 30 : 0) +
        prev.ts / 1e6;
      const scoreNew =
        (h.percent_off != null || h.amount_off != null ? 1000 : 0) +
        (h.ct.includes('application/json') || h.ct.includes('text/x-component') ? 40 : 0) +
        (h.route && currentRoute && h.route.toLowerCase() === currentRoute.toLowerCase() ? 30 : 0) +
        h.ts / 1e6;
      if (scoreNew > scorePrev) byCode.set(h.code, h);
    }
  }

  const ranked = [...byCode.values()].sort((a, b) => {
    const s = (x) =>
      (x.percent_off != null || x.amount_off != null ? 1000 : 0) +
      (x.ct.includes('application/json') || x.ct.includes('text/x-component') ? 40 : 0) +
      (x.route && currentRoute && x.route.toLowerCase() === currentRoute.toLowerCase() ? 30 : 0) +
      x.ts / 1e6;
    return s(b) - s(a);
  });

  const best = ranked[0];
  return {
    code: best.code,
    type: best.ct,
    sourceUrl: best.url,
    percent_off: best.percent_off ?? null,
    amount_off: best.amount_off ?? null,
    currency: best.currency ?? null
  };
}