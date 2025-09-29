// Test script to verify spillover prevention on specific Whop products
import { extractPopupPromoFromNetwork } from './src/utils/extractPromo.js';
import { chromium } from 'playwright';
import fs from 'fs';

const testUrls = [
  'https://whop.com/the-yard/?a=alexburnett21',
  'https://whop.com/deal-flip-formula-main/?a=alexburnett21',
  'https://whop.com/jdubtrades/?a=alexburnett21'
];

async function testSpecificWhops() {
  console.log('🧪 Testing spillover prevention on specific Whop products...\n');

  const browser = await chromium.launch({ headless: true });
  const storage = './auth/whop.json';

  const context = await browser.newContext({
    storageState: storage && fs.existsSync(storage) ? storage : undefined,
    bypassCSP: true,
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    locale: 'en-GB',
  });

  // Enable debug output
  process.env.DEBUG = '1';

  for (const url of testUrls) {
    const page = await context.newPage();

    try {
      // Extract route from URL
      const routeFromUrl = (u) => {
        try { return new URL(u).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; }
      };
      const currentRoute = routeFromUrl(url);

      console.log(`\n📍 Testing: ${url}`);
      console.log(`   Route: ${currentRoute}`);
      console.log('='.repeat(60));

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      console.log('🔍 Starting extraction with route-based spillover prevention...');
      const result = await extractPopupPromoFromNetwork(page, {
        timeoutMs: 15000,
        currentRoute
      });

      console.log('\n📊 RESULT:');
      if (result && result.code) {
        console.log(`✅ SUCCESS: Found code "${result.code}"`);
        console.log(`   Source: ${result.sourceUrl || 'N/A'}`);
        console.log(`   Type: ${result.type || 'N/A'}`);
        console.log(`   This should be specific to ${currentRoute}, not cross-contamination`);
      } else {
        console.log(`❌ No code found for ${currentRoute}`);
        console.log(`   This could mean: no popup promo, or spillover prevention is working`);
      }

    } catch (error) {
      console.error(`❌ Error testing ${url}: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log('\n🏁 Testing complete!');
}

testSpecificWhops().catch(console.error);