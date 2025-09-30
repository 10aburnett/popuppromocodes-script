// utils/discountParse.js
export function extractDiscountNearCode(body, code) {
  if (!body || !code) return null;

  // Unescape common RSC-escaped quotes: \"  → "
  const text = body.replace(/\\"/g, '"');
  const lower = text.toLowerCase();
  const needle = code.toLowerCase();

  // Where in this response does the code (or promoCode=code) appear?
  let idx = lower.indexOf(needle);
  if (idx === -1) idx = lower.indexOf(`promocode=${needle}`);
  if (idx === -1) return null;

  // Grab a local window around the code to avoid unrelated matches
  const start = Math.max(0, idx - 800);
  const end   = Math.min(text.length, idx + 800);
  const win   = text.slice(start, end);

  // Patterns (robust to spacing/casing)
  const pctStr = /"discountOff"\s*:\s*"(\d{1,2}(?:\.\d+)?)%/i.exec(win);
  const pctNum = /"discount(?:Percent|Percentage)"\s*:\s*(\d{1,2}(?:\.\d+)?)/i.exec(win);
  const pctDec = /"discount(?:Percent|Percentage)"\s*:\s*(0?\.\d+)/i.exec(win); // e.g. 0.15

  const amtCents = /"amountOffInCents"\s*:\s*(\d{2,7})/i.exec(win);
  const amtOff   = /"amountOff"\s*:\s*(-?\d+(?:\.\d+)?)/i.exec(win); // 0.1 (10%) or 25

  let discountPercent = null;
  if (pctStr)       discountPercent = parseFloat(pctStr[1]);
  else if (pctNum)  discountPercent = parseFloat(pctNum[1]);               // 10 => 10%
  else if (pctDec)  discountPercent = Math.round(parseFloat(pctDec[1]) * 100 * 100) / 100; // 0.1 => 10

  let amountOff = null;
  if (amtOff) amountOff = parseFloat(amtOff[1]); // caller can interpret (fraction vs absolute)

  let amountOffInCents = null;
  if (amtCents) amountOffInCents = parseInt(amtCents[1], 10);

  if (discountPercent != null || amountOff != null || amountOffInCents != null) {
    return { discountPercent, amountOff, amountOffInCents };
  }
  return null;
}