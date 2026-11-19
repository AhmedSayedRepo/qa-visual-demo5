// Runs ONCE before the whole suite: performs a real login and saves the browser
// storage state (cookies + localStorage) to .auth/state.json. playwright.config.js
// points use.storageState at that file, so every app-page test starts ALREADY
// AUTHENTICATED. Login-page specs opt back out per-group with
// test.use({ storageState: { cookies: [], origins: [] } }).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { performLogin, openLoginPage } = require('./support/auth');

module.exports = async () => {
  const dir = path.join(__dirname, '.auth');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const loggedOut = (why) => {
    fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
    console.log('[auth] ' + why + ' — tests run logged out');
  };
  if (!String(process.env.APP_USER || '').trim()) return loggedOut('no APP_USER in .env');
  console.log('[auth] logging in once before the tests...');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  try {
    // A site without a login form (or APP_LOGIN_URL pointing at a page without
    // one) skips the login in seconds instead of waiting on missing fields.
    await openLoginPage(page);
    const form = await page.locator('input[type=password]').first()
      .waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
    if (!form) return loggedOut('no login form at APP_LOGIN_URL');
    await performLogin(page);
    await page.context().storageState({ path: file });
    console.log('[auth] logged in once for the run — session saved to .auth/state.json');
  } catch (e) {
    // Fail soft with a LOUD message: tests still run (logged out), and every
    // app-page failure that follows traces back to this one line instead of
    // looking like dozens of unrelated locator failures.
    fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
    console.log('[auth] GLOBAL LOGIN FAILED (' + e.message + ') — app-page tests will run logged out. Check APP_USER/APP_PASS/APP_LOGIN_URL in .env');
  } finally {
    await browser.close();
  }
};
