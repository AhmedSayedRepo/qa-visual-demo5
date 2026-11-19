// Login helpers. Credentials come from the environment, never hard-coded.
require('dotenv').config();

// The language the LOGIN PAGE should render in — must match the language of
// the generated test cases' expected messages. The frozen APP_LOGIN_URL can
// carry a stale ui_locales=… (confirmed live: ui_locales=en forced the page
// into English while every assertion expected the Arabic version of the SAME
// message — behavior passed, language failed). Baked from QA Studio's output
// language at generation time; override per-environment via APP_UI_LOCALE.
const UI_LOCALE = process.env.APP_UI_LOCALE || 'ar';

function _withLocale(url) {
  if (!UI_LOCALE || !/^https?:/.test(url)) return url;
  if (/[?&]ui_locales=/.test(url)) {
    return url.replace(/([?&])ui_locales=[^&]*/, '$1ui_locales=' + UI_LOCALE);
  }
  return url + (url.includes('?') ? '&' : '?') + 'ui_locales=' + UI_LOCALE;
}

async function openLoginPage(page) {
  await page.goto(_withLocale(process.env.APP_LOGIN_URL || process.env.APP_BASE_URL || '/'));
}

async function performLogin(page) {
  await openLoginPage(page);
  // Same breadth as QA Studio's explorer login: also '#user-name'-style fields.
  const user = page.locator('#username, input[type=email], input[name=email], input[name=username], '
                            + 'input[name*=user i], input[id*=user i]').first();
  const pass = page.locator('#password, input[type=password]').first();
  try { await user.fill(process.env.APP_USER || ''); } catch (e) {}
  try { await pass.fill(process.env.APP_PASS || ''); } catch (e) {}
  await page.locator('#kc-login, button[type=submit], input[type=submit]').first().click();
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch (e) {}
}
// App cases start here: the app's base URL, logging in first when that URL
// shows the login form (some sites' root IS the login page even with a
// session, e.g. SauceDemo) — the login then lands on the app's home.
async function openAppHome(page) {
  await page.goto(process.env.APP_BASE_URL || '/');
  let loginForm = false;
  try {
    await page.locator('input[type=password]').first().waitFor({ state: 'visible', timeout: 2000 });
    // A real login form also has a username/email field; a page with only a
    // password input (a form under test) is not a login.
    loginForm = (await page.locator('#username, #user-name, input[type=email], input[name=email], '
      + 'input[name=username], input[name*=user i], input[id*=user i]').count()) > 0;
  } catch (e) {}
  if (loginForm) await performLogin(page);
}
module.exports = { openLoginPage, performLogin, openAppHome };
