import { chromium } from 'playwright';
import { extractPopupPromoFromNetwork } from '../src/utils/extractPromo.js';

const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/verify-one.mjs <whop-product-url>'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: process.env.WHOP_STORAGE || 'auth/whop.json',
  serviceWorkers: 'block'
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
const route = new URL(url).pathname.split('/').filter(Boolean)[0] || null;
const res = await extractPopupPromoFromNetwork(page, { timeoutMs: 15000, currentRoute: route });
console.log('RESULT:', res);
await browser.close();