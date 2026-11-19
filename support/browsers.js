// Which browsers a run uses (one Playwright project each). BROWSER (env or
// .env) = chromium (default: Playwright's own), chrome (installed Google Chrome),
// edge (installed Microsoft Edge), firefox, a list (chrome,firefox) or all
// (chrome, edge and firefox). `node support/browsers.js --install` (npm's pretest)
// downloads the Playwright browsers the choice needs.
require('dotenv').config();
const BROWSERS = {
  chromium: { label: 'Chromium', use: { browserName: 'chromium' }, install: 'chromium' },
  chrome: { label: 'Chrome', use: { browserName: 'chromium', channel: 'chrome' }, install: '' },
  edge: { label: 'Edge', use: { browserName: 'chromium', channel: 'msedge' }, install: '' },
  firefox: { label: 'Firefox', use: { browserName: 'firefox' }, install: 'firefox' },
};
const ALIASES = { msedge: 'edge', 'microsoft-edge': 'edge', ff: 'firefox', 'google-chrome': 'chrome', googlechrome: 'chrome' };

function selected() {
  const raw = String(process.env.BROWSER || '').trim().toLowerCase();
  if (!raw) return ['chromium'];
  if (raw === 'all') return ['chrome', 'edge', 'firefox'];
  const out = [];
  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    const b = ALIASES[part] || part;
    if (!BROWSERS[b]) { console.log('[browser] unknown browser "' + part + '" - use chrome, edge, firefox or chromium'); continue; }
    if (!out.includes(b)) out.push(b);
  }
  return out.length ? out : ['chromium'];
}

// GRID (env or .env) = local (default), browserstack, lambdatest, a Playwright
// server (ws://host:port) or a Selenium Grid URL (Chromium browsers only).
// Cloud accounts: BROWSERSTACK_USERNAME + BROWSERSTACK_ACCESS_KEY or LT_USERNAME +
// LT_ACCESS_KEY; GRID_PLATFORM (e.g. "Windows 11") and GRID_BUILD are optional.
const CLOUD = {
  browserstack: { chromium: 'playwright-chromium', chrome: 'chrome', edge: 'edge', firefox: 'playwright-firefox' },
  lambdatest: { chromium: 'Chrome', chrome: 'Chrome', edge: 'MicrosoftEdge', firefox: 'pw-firefox' },
};
let gridNoted = false;
function gridNote(msg) { if (!gridNoted) console.log('[grid] ' + msg); gridNoted = true; }
function gridEndpoint(b) {
  const g = String(process.env.GRID || '').trim(), low = g.toLowerCase();
  if (!low || low === 'local') return null;
  if (low.startsWith('ws://') || low.startsWith('wss://')) { gridNote('browsers run on ' + g); return g; }
  if (low.startsWith('http://') || low.startsWith('https://')) {
    process.env.SELENIUM_REMOTE_URL = g;    // Playwright's Selenium Grid mode (Chromium / Chrome / Edge)
    gridNote('Chromium browsers run on the Selenium Grid ' + g);
    return null;
  }
  const need = (k) => {
    const v = String(process.env[k] || '').trim();
    if (!v) throw new Error('[grid] GRID=' + low + ' needs ' + k + ' in .env or the environment');
    return v;
  };
  let pw = '';
  try { pw = require('@playwright/test/package.json').version; } catch (e) { /* unknown */ }
  const build = process.env.GRID_BUILD || 'QA Studio';
  const platform = String(process.env.GRID_PLATFORM || 'Windows 11');
  if (low === 'browserstack') {
    const os = platform.split(' ');
    const caps = { browser: CLOUD.browserstack[b], os: os[0], os_version: os.slice(1).join(' ') || '11',
      'browserstack.username': need('BROWSERSTACK_USERNAME'), 'browserstack.accessKey': need('BROWSERSTACK_ACCESS_KEY'),
      project: 'QA Studio', build, 'client.playwrightVersion': pw };
    gridNote('browsers run on BrowserStack');
    return 'wss://cdp.browserstack.com/playwright?caps=' + encodeURIComponent(JSON.stringify(caps));
  }
  if (low === 'lambdatest') {
    const caps = { browserName: CLOUD.lambdatest[b], browserVersion: 'latest',
      'LT:Options': { platform, build, name: 'QA Studio', user: need('LT_USERNAME'), accessKey: need('LT_ACCESS_KEY'),
        playwrightClientVersion: pw } };
    gridNote('browsers run on LambdaTest');
    return 'wss://cdp.lambdatest.com/playwright?capabilities=' + encodeURIComponent(JSON.stringify(caps));
  }
  if (low === 'sauce' || low === 'saucelabs') {
    gridNote('Sauce Labs runs Playwright with its own tool (npx saucectl run), not GRID - running on this machine');
    return null;
  }
  gridNote('unknown GRID "' + g + '" - use local, browserstack, lambdatest, ws://... or a Selenium Grid URL; running on this machine');
  return null;
}

function projects() {
  return selected().map((b) => {
    const ws = gridEndpoint(b);
    const use = ws ? Object.assign({}, BROWSERS[b].use, { connectOptions: { wsEndpoint: ws } }) : BROWSERS[b].use;
    return { name: BROWSERS[b].label, use };
  });
}

module.exports = { selected, projects, BROWSERS, gridEndpoint };

if (require.main === module && process.argv.includes('--install')) {
  const need = new Set(['chromium']);   // global-setup.js logs in with Chromium
  for (const b of selected()) if (BROWSERS[b].install) need.add(BROWSERS[b].install);
  require('child_process').execSync('npx playwright install ' + Array.from(need).join(' '), { stdio: 'inherit' });
}
