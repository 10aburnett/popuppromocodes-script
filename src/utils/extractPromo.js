// src/utils/extractPromo.js
// Discount extractor (listener-first, URL-driven, code-anchored)

const textDecoder = new TextDecoder('utf-8');

function escapeRe(s) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

function readDiscountFromSnippet(snippet) {
  if (!snippet) return null;
  const s = snippet.replace(/\\"/g, '"').replace(/\\n|\\r/g, ' ').replace(/\s+/g, ' ');

  const pctStr  = /"discountOff"\s*:\s*"(?:\s*)?(\d{1,3}(?:\.\d+)?)(?:\s*)%"/i.exec(s)?.[1];
  const pctBare = /"discountOff"\s*:\s*(\d{1,3}(?:\.\d+)?)(?!\s*["%])/i.exec(s)?.[1];
  const decBare = /"discountOff"\s*:\s*(0?\.\d+)/i.exec(s)?.[1];

  const amtNum  = /"amountOff"\s*:\s*(\d+(?:\.\d+)?)/i.exec(s)?.[1];
  const amtStr  = /"amountOff"\s*:\s*"(\d+(?:\.\d+)?)"/i.exec(s)?.[1];
  const cents   = /"amountOffInCents"\s*:\s*(\d+)/i.exec(s)?.[1];

  let discountPercent = null;
  if (pctStr != null) discountPercent = Number(pctStr);
  else if (pctBare != null) {
    const n = Number(pctBare);
    discountPercent = n <= 1 ? Math.round(n * 1000) / 10 : n;
  } else if (decBare != null) {
    const n = Number(decBare);
    discountPercent = Math.round(n * 1000) / 10; // 0.3 -> 30.0
  } else if (amtNum != null || amtStr != null) {
    const n = Number(amtNum ?? amtStr);
    if (isFinite(n) && n > 0 && n <= 1) discountPercent = Math.round(n * 1000) / 10;
  }

  return {
    discountPercent: discountPercent ?? null,
    amountOff: amtNum != null ? Number(amtNum) : (amtStr != null ? Number(amtStr) : null),
    amountOffInCents: cents ? Number(cents) : null,
  };
}

function nearestJsonObject(text, startIndex) {
  let i = startIndex;
  while (i > 0 && text[i] !== '{') i--;
  if (text[i] !== '{') return null;

  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

function extractDiscountNearCodeFromBody(body, code) {
  if (!body || !code) return null;
  const text = body.replace(/\\"/g, '"');

  // 1) Try to capture the entire popupPromoCode object that mentions THIS code
  const blockRe = new RegExp(
    `"popupPromoCode"\\s*:\\s*\\{[\\s\\S]{0,20000}?"code"\\s*:\\s*"${escapeRe(code)}"[\\s\\S]{0,20000}?\\}`,
    "i"
  );
  const block = blockRe.exec(text)?.[0];
  if (block) {
    const parsed = readDiscountFromSnippet(block);
    if (parsed) return parsed;
  }

  // 2) Large window around the code, then balanced-object parse
  const hit = new RegExp(escapeRe(code), "i").exec(text);
  if (!hit) return null;
  const BEFORE = 20000, AFTER = 20000;
  const left = Math.max(0, hit.index - BEFORE);
  const right = Math.min(text.length, hit.index + code.length + AFTER);
  const win = text.slice(left, right);

  const startIdx = /"popupPromoCode"\s*:/i.exec(win)?.index ?? /"code"\s*:\s*"/i.exec(win)?.index;
  if (startIdx != null) {
    // find nearest balanced object from start
    let i = startIdx; while (i > 0 && win[i] !== '{') i--;
    if (win[i] === '{') {
      let depth = 0, str = false, esc = false;
      for (let j = i; j < win.length; j++) {
        const ch = win[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') str = !str;
        if (str) continue;
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          const obj = win.slice(i, j + 1);
          const parsedObj = readDiscountFromSnippet(obj);
          if (parsedObj) return parsedObj;
          break;
        }
      }
    }
  }

  // 3) Heuristic parse of the window
  const parsedWin = readDiscountFromSnippet(win);
  if (parsedWin) return parsedWin;

  // 4) Weak fallback: if only one discountOff appears in the whole body, accept it
  const only = [...text.matchAll(/"discountOff"\s*:\s*("?\s*\d{1,3}(?:\.\d+)?\s*%?"?)/ig)];
  if (only.length === 1) {
    const v = only[0][1].replace(/["\s%]/g, '');
    const n = Number(v);
    return { discountPercent: n <= 1 ? Math.round(n*1000)/10 : n, amountOff: null, amountOffInCents: null };
  }

  return null;
}

function scoreCandidate(x, currentRoute) {
  let s = 0;
  if (x.discountPercent != null) s += 50;
  if (/json|x-component/i.test(x.ct ?? '')) s += 20;
  if (currentRoute && x.sourceUrl && x.sourceUrl.includes(`/${currentRoute}`)) s += 10;
  if (x.sourceUrl && /MessagesFetchDmsChannels/i.test(x.sourceUrl)) s -= 15; // soft penalty on cross-feeds
  return s;
}

async function captureRun(page, url, onlyThisCode) {
  // Attach listeners BEFORE navigation
  const captured = [];

  const pwHandler = async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (/image|font|video|audio|css/i.test(ct)) return;
      const text = await resp.text().catch(() => '');
      if (!text) return;
      captured.push({ url: u, ct, body: text });
    } catch {}
  };
  page.on('response', pwHandler);

  // CDP capture (gets streamed bodies + cached)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', async (e) => {
    try {
      const { requestId, response } = e;
      if (!response || !response.url) return;
      if (/image|font|video|audio|css/i.test(response.mimeType || '')) return;
      const got = await cdp.send('Network.getResponseBody', { requestId }).catch(() => null);
      if (!got || !got.body) return;
      const text = got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body;
      captured.push({ url: response.url, ct: (response.mimeType || '').toLowerCase(), body: text });
    } catch {}
  });

  // Navigate → wait → hard reload
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(1200);

  // Also parse final HTML
  try {
    const html = await page.content();
    captured.push({ url: page.url(), ct: 'text/html', body: html });
  } catch {}

  // Process captured bodies
  const candidates = [];
  for (const item of captured) {
    if (onlyThisCode && !new RegExp(escapeRe(onlyThisCode), 'i').test(item.body)) continue;
    const res = extractDiscountNearCodeFromBody(item.body, onlyThisCode);
    if (res) candidates.push({ ...res, sourceUrl: item.url, ct: item.ct });
  }

  page.off('response', pwHandler);
  return candidates;
}

export async function extractPopupPromoFromNetwork(
  page,
  { url, timeoutMs = 15000, currentRoute = null, onlyThisCode = null } = {}
) {
  if (!url) throw new Error('extractPopupPromoFromNetwork: missing url');

  // Run 1: plain URL
  let candidates = await captureRun(page, url, onlyThisCode);

  // If nothing, Run 2: force materialization with ?promoCode=
  if (candidates.length === 0 && onlyThisCode) {
    const withCodeUrl = url.includes('promoCode=')
      ? url
      : url + (url.includes('?') ? '&' : '?') + 'promoCode=' + encodeURIComponent(onlyThisCode);
    candidates = await captureRun(page, withCodeUrl, onlyThisCode);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => scoreCandidate(b, currentRoute) - scoreCandidate(a, currentRoute));
  const best = candidates[0];

  return {
    code: onlyThisCode || null,
    discountPercent: best.discountPercent ?? null,
    amountOff: best.amountOff ?? null,
    amountOffInCents: best.amountOffInCents ?? null,
    sourceUrl: best.sourceUrl ?? null,
    type: best.ct ?? null,
  };
}