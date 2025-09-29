// src/capture-whop-session.js
// Interactive script to login to Whop and capture session state

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_STATE_PATH = path.join(__dirname, '..', 'storageState.json');

async function captureWhopSession() {
  console.log('🚀 Opening browser for Whop login...');
  console.log('📝 Please log into your Whop account in the browser that opens');
  console.log('✅ When logged in, press Enter in this terminal to capture the session');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  // Navigate to Whop login
  await page.goto('https://whop.com/login', { waitUntil: 'domcontentloaded' });

  // Wait for user to complete login
  await new Promise(resolve => {
    process.stdout.write('\nPress Enter after you have successfully logged in: ');
    process.stdin.once('data', resolve);
  });

  // Verify login by checking for user-specific elements
  try {
    // Wait for login to complete and redirect
    await page.waitForTimeout(2000);

    // Check if we're logged in by looking for user avatar or dashboard elements
    const isLoggedIn = await page.evaluate(() => {
      // Look for common logged-in indicators
      return !!(
        document.querySelector('[data-testid="user-avatar"]') ||
        document.querySelector('.avatar') ||
        document.querySelector('[href*="/dashboard"]') ||
        document.querySelector('[href*="/profile"]') ||
        document.querySelector('img[alt*="avatar"]') ||
        window.location.pathname.includes('/dashboard') ||
        window.location.pathname.includes('/home-feed')
      );
    });

    if (isLoggedIn) {
      console.log('✅ Login detected! Capturing session...');
    } else {
      console.log('⚠️  Login not fully detected, but capturing session anyway...');
    }

  } catch (e) {
    console.log('⚠️  Could not verify login status, but proceeding...');
  }

  // Save the storage state
  await context.storageState({ path: STORAGE_STATE_PATH });

  console.log(`✅ Session captured to: ${STORAGE_STATE_PATH}`);
  console.log('🔧 You can now run: npm run scrape:whpcodes');
  console.log('💡 The scraper will automatically use your logged-in session');

  await browser.close();
}

captureWhopSession().catch(e => {
  console.error('❌ Error capturing session:', e);
  process.exit(1);
});