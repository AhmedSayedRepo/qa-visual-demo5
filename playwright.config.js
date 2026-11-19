// Playwright config. baseURL and everything environment-specific come from the
// environment (.env, git-ignored) or real env vars — nothing is baked in, so the
// same project runs against any environment with no regeneration.
require('dotenv').config();
const { defineConfig } = require('@playwright/test');
const browsers = require('./support/browsers');
// PARALLEL=false in .env runs everything one test at a time (one worker);
// true (default) lets Playwright run browsers and spec files side by side.
const parallel = !['false', 'off', '0', 'no'].includes(String(process.env.PARALLEL || 'true').trim().toLowerCase());
// One worker per browser (at least 2). Playwright's default (half the CPU
// cores) opened up to 8 visible browsers all recording video: closing one
// (saving its video) then ran past the test timeout ("Tearing down context").
const workerCount = Math.max(2, browsers.projects().length);

module.exports = defineConfig({
  testDir: './tests',
  // Includes closing the browser and saving its video after the last step.
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: parallel ? workerCount : 1,
  retries: 0,
  // Logs in ONCE before the whole run and saves the session to .auth/state.json
  // (see global-setup.js). Playwright gives every test a fresh isolated browser
  // context — nothing survives from one test to the next — so a login performed
  // inside one test can NEVER carry over; this global setup + storageState is
  // the supported way for app-page tests to start already authenticated.
  globalSetup: require.resolve('./global-setup'),
  // A rich HTML report is written to ./playwright-report on EVERY run (pass or
  // fail), listing every test with status, steps, screenshots and traces. Open it
  // with `npx playwright show-report` (or `npm run report`).
  // After the html report is written, support/after-run.js opens it and emails it.
  // support/progress-reporter.js shows a live progress window while tests run
  // (PROGRESS=off in .env turns it off; never on CI).
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }],
             ['./support/progress-reporter.js'], ['./support/after-run.js']],
  use: {
    baseURL: process.env.APP_BASE_URL || '',
    storageState: '.auth/state.json',   // every test starts logged in (see global-setup.js)
    // The browser is visible while tests run; HEADLESS=true (or CI) hides it.
    headless: !!process.env.CI || String(process.env.HEADLESS).toLowerCase() === 'true',
    screenshot: 'on',              // capture a screenshot for EVERY test (not only failures)
    // A video of EVERY test in the report; VIDEO=retain-on-failure keeps only
    // failed ones (smaller report), VIDEO=off records none.
    video: process.env.VIDEO || 'on',
    trace: 'retain-on-failure',
    actionTimeout: 15000,
  },
  // A failed test is run once more (a site blip shouldn't fail the run); the
  // report marks a test that passed on the retry as "flaky". RETRIES=0 turns it off.
  retries: Number(process.env.RETRIES ?? 1),
  // Browsers (one project each): BROWSER = chromium (default), chrome, edge,
  // firefox, a list (chrome,firefox) or all. See support/browsers.js.
  projects: browsers.projects(),
});
