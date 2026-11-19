// Extends Playwright's test with a `heal` fixture — a self-healing locator
// resolver available to every spec as ({ page, heal }).
const base = require('@playwright/test');
const { Healer } = require('./support/healer');

// A failed test whose page is a host/server error page (Heroku "Application
// error", 502/503/504, the browser's "can't be reached") is labelled "Site
// unavailable": the site was down, not the test. Only short pages are checked,
// so a real page that merely mentions an error isn't mislabelled.
function qaSiteDown(title, text) {
  const body = String(text || '');
  if (body.length > 2500) return '';
  const s = (String(title || '') + ' ' + body).toLowerCase();
  const rules = [
    ['application error', 'the page showed "Application error" (the Heroku app is down)'],
    ['502 bad gateway', 'the server answered 502 Bad Gateway'],
    ['503 service', 'the server answered 503 Service Unavailable'],
    ['service unavailable', 'the server answered Service Unavailable'],
    ['504 gateway', 'the server answered 504 Gateway Timeout'],
    ['gateway time-out', 'the server answered 504 Gateway Timeout'],
    ['internal server error', 'the server answered 500 Internal Server Error'],
    ["this site can't be reached", 'the browser could not reach the site'],
    ['this site can’t be reached', 'the browser could not reach the site'],
    ['this page isn’t working', 'the site returned a server error page'],
    ["this page isn't working", 'the site returned a server error page'],
    ['err_name_not_resolved', 'the site address could not be resolved (DNS)'],
    ['err_connection_refused', 'the site refused the connection'],
    ['err_connection_timed_out', 'the connection to the site timed out'],
  ];
  for (const [needle, why] of rules) if (s.includes(needle)) return why;
  return '';
}

async function pageText(page) {
  const title = await page.title().catch(() => '');
  const text = await page.evaluate(() => {
    const out = [document.body ? document.body.innerText : ''];
    document.querySelectorAll('iframe').forEach((f) => {
      try { out.push(f.contentDocument.body.innerText); } catch (e) { /* cross-origin */ }
    });
    return out.join(' ');
  }).catch(() => '');
  return { title, text };
}

const test = base.test.extend({
  heal: async ({ page }, use, testInfo) => {
    await use(new Healer(page));
    if (testInfo.status !== testInfo.expectedStatus) {
      const { title, text } = await pageText(page);
      const why = qaSiteDown(title, text);
      if (why) testInfo.annotations.push({ type: 'Site unavailable',
        description: why + ' — the site was down or erroring, not a test problem.' });
    }
  },
});

module.exports = { test, expect: base.expect, qaSiteDown };
