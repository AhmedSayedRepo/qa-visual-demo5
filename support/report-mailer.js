// QA Studio — after every run (pass or fail): writes the branded summary report
// (qa-studio-report.html: results per story, failures with screenshots, run
// environment), opens it, and emails it with the detailed framework report.
// Settings come from .env:
//   OPEN_REPORT=false            don't open the report (always off when CI is set)
//   REPORT_EMAIL_TO=a@x.com,b@y.com
//   SMTP_USER=sender@gmail.com   SMTP_PASS=<Gmail App Password>
//   SMTP_HOST=smtp.gmail.com     SMTP_PORT=465
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const QA_VERSION = '4.0.5';
const LOGO = path.join(__dirname, 'qa-logo.png');
const C = { paper: '#EEF0F4', card: '#FFFFFF', tint: '#F7F8FA', ink: '#1B1A22', ink2: '#5F5D6B',
  ink3: '#9C9AA6', line: '#E6E7EC', brand: '#0E9CC0', brandInk: '#0B6E86', brandSoft: '#D6F4FB',
  green: '#1F8A52', greenSoft: '#E7F4ED', red: '#D6414A', redSoft: '#FBEAEC',
  amber: '#AB780C', amberSoft: '#F7EFD8', grey: '#6B6975', greySoft: '#EFEFF3' };
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = 'Consolas,Menlo,monospace';
const MAX_SHOTS = 6;

function openFile(file) {
  if (process.env.CI || String(process.env.OPEN_REPORT).toLowerCase() === 'false') return;
  if (!file || !fs.existsSync(file)) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', '"' + file + '"'],
        { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file],
        { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { console.log('[report] could not open the report: ' + e.message); }
}

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function stripAnsi(s) { return String(s || '').replace(/\u001b\[[0-9;]*m/g, ''); }
function secs(ms) {
  const s = Math.round((ms || 0) / 1000);
  return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
}
function exists(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
function dataUri(p) {
  try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch (e) { return ''; }
}

// The first absolute URL a spec opens = the site that story tests.
// Every site a spec opens (page.goto / cy.visit with a full URL), in order;
// falls back to APP_BASE_URL when the spec only uses relative paths.
function sitesOf(specFile) {
  const out = [];
  try {
    const re = /(?:goto|visit)\(\s*["'`](https?:\/\/[^"'`/]+)/g;
    const text = fs.readFileSync(specFile, 'utf8');
    let m;
    while ((m = re.exec(text))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  } catch (e) { /* fall back */ }
  if (!out.length && process.env.APP_BASE_URL) out.push(process.env.APP_BASE_URL);
  return out;
}
function siteOf(specFile) { return sitesOf(specFile).join(', '); }

// Headline shared by the summary and detailed reports.
function verdict(total, failed, skipped) {
  if (failed) return failed + ' of ' + total + ' tests failed';
  if (total && skipped === total) return 'None of the ' + total + ' tests ran (all skipped)';
  if (skipped) return (total - skipped) + ' of ' + total + ' tests passed, ' + skipped + ' skipped';
  return 'All ' + total + ' tests passed';
}

function totals(run) {
  const t = { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0 };
  for (const s of run.stories) {
    s.counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, duration: 0 };
    for (const x of s.tests) {
      const k = x.status === 'flaky' ? 'flaky' : x.status;
      s.counts[k] = (s.counts[k] || 0) + 1;
      if (x.status === 'flaky') s.counts.passed++;
      s.counts.duration += x.duration || 0;
    }
    t.passed += s.counts.passed; t.failed += s.counts.failed;
    t.skipped += s.counts.skipped; t.flaky += s.counts.flaky;
    t.total += s.tests.length;
  }
  return t;
}

// ---- HTML (table + inline styles: renders the same in Gmail/Outlook/browser) ----
function pill(status) {
  const m = { passed: [C.green, C.greenSoft, 'Passed'], failed: [C.red, C.redSoft, 'Failed'],
    skipped: [C.grey, C.greySoft, 'Skipped'], flaky: [C.amber, C.amberSoft, 'Flaky'] }[status]
    || [C.grey, C.greySoft, status];
  return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;'
    + 'font-weight:700;color:' + m[0] + ';background:' + m[1] + '">' + m[2] + '</span>';
}
function kpi(label, value, color) {
  return '<td width="20%" style="padding:12px 6px;text-align:center;border-right:1px solid ' + C.line + '">'
    + '<div style="font-size:22px;font-weight:800;color:' + (color || C.ink) + '">' + esc(value) + '</div>'
    + '<div style="font-size:11px;color:' + C.ink3 + ';text-transform:uppercase;letter-spacing:.4px">'
    + label + '</div></td>';
}
function section(title, inner) {
  return '<tr><td style="padding:22px 28px 0">'
    + '<div style="font-size:13px;font-weight:800;color:' + C.brandInk + ';text-transform:uppercase;'
    + 'letter-spacing:.6px;margin-bottom:10px">' + title + '</div>' + inner + '</td></tr>';
}
const TH = 'style="padding:8px 10px;text-align:left;font-size:11px;color:' + C.ink3
  + ';text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid ' + C.line + '"';
const TD = 'style="padding:9px 10px;font-size:13px;color:' + C.ink + ';border-bottom:1px solid ' + C.line + ';vertical-align:top"';

// mode 'email': images by cid:; mode 'file': images inlined (self-contained page).
function buildHtml(run, mode, detailName) {
  const t = totals(run);
  // A run where every test was skipped did NOT pass.
  const ok = !t.failed && !(t.total && t.skipped === t.total);
  const rate = t.total ? Math.round(((t.passed) / t.total) * 100) : 0;
  const logo = mode === 'email' ? (exists(LOGO) ? 'cid:qa-logo' : '') : (exists(LOGO) ? dataUri(LOGO) : '');
  const when = new Date(run.startedAt || Date.now());
  const stamp = when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const head = '<tr><td style="padding:22px 28px;border-bottom:1px solid ' + C.line + '">'
    + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
    + (logo ? '<td width="46" valign="middle"><img src="' + logo + '" width="38" height="38" alt="QA Studio" style="display:block;border:0"></td>' : '')
    + '<td valign="middle"><div style="font-size:17px;font-weight:800;color:' + C.ink + '">QA Studio</div>'
    + '<div style="font-size:12px;color:' + C.ink2 + '">' + esc(run.framework) + ' automation run'
    + ((run.env || {}).ide ? ' · run from <b>' + esc(run.env.ide) + '</b>' : '') + '</div></td>'
    + '<td valign="middle" align="right" style="font-size:12px;color:' + C.ink2 + '">' + esc(stamp) + '</td>'
    + '</tr></table></td></tr>';
  const banner = '<tr><td style="padding:22px 28px 6px">'
    + '<div style="font-size:24px;font-weight:800;color:' + (ok ? C.green : C.red) + '">'
    + verdict(t.total, t.failed, t.skipped) + '</div>'
    + '<div style="font-size:13px;color:' + C.ink2 + ';margin-top:4px">Pass rate ' + rate + '% · '
    + run.stories.length + ' stor' + (run.stories.length === 1 ? 'y' : 'ies') + ' · ' + secs(run.duration) + '</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-radius:5px;overflow:hidden"><tr>'
    + (t.passed ? '<td height="8" width="' + Math.max(1, Math.round(t.passed / t.total * 100)) + '%" style="background:' + C.green + ';font-size:0;line-height:0">&nbsp;</td>' : '')
    + (t.failed ? '<td height="8" width="' + Math.max(1, Math.round(t.failed / t.total * 100)) + '%" style="background:' + C.red + ';font-size:0;line-height:0">&nbsp;</td>' : '')
    + (t.skipped ? '<td height="8" width="' + Math.max(1, Math.round(t.skipped / t.total * 100)) + '%" style="background:' + C.ink3 + ';font-size:0;line-height:0">&nbsp;</td>' : '')
    + '</tr></table></td></tr>';
  const kpis = '<tr><td style="padding:14px 28px 0"><table width="100%" cellpadding="0" cellspacing="0" '
    + 'style="border:1px solid ' + C.line + ';border-radius:8px;background:' + C.tint + '"><tr>'
    + kpi('Passed', t.passed, C.green) + kpi('Failed', t.failed, t.failed ? C.red : C.ink)
    + kpi('Skipped', t.skipped) + kpi('Flaky', t.flaky, t.flaky ? C.amber : C.ink)
    + kpi('Duration', secs(run.duration)) + '</tr></table></td></tr>';

  const storyRows = run.stories.map((s) => '<tr><td ' + TD + '><b>' + esc(s.name) + '</b>'
    + '<div style="font-size:11px;color:' + C.ink3 + '">' + esc(s.file) + (s.site ? ' · ' + esc(s.site) : '') + '</div></td>'
    + '<td ' + TD + ' align="center" style="color:' + C.green + '">' + s.counts.passed + '</td>'
    + '<td ' + TD + ' align="center">' + (s.counts.failed ? '<b style="color:' + C.red + '">' + s.counts.failed + '</b>' : '0') + '</td>'
    + '<td ' + TD + ' align="center">' + s.counts.skipped + '</td>'
    + '<td ' + TD + ' align="right" nowrap>' + secs(s.counts.duration) + '</td></tr>').join('');
  const stories = section('Results by story', '<table width="100%" cellpadding="0" cellspacing="0">'
    + '<tr><th ' + TH + '>Story</th><th ' + TH + '>Passed</th><th ' + TH + '>Failed</th><th ' + TH + '>Skipped</th>'
    + '<th ' + TH + ' style="text-align:right">Time</th></tr>' + storyRows + '</table>');

  let shots = 0;
  const failedTests = [];
  run.stories.forEach((s) => s.tests.forEach((x) => { if (x.status === 'failed') failedTests.push([s, x]); }));
  const failures = failedTests.length ? section('Failures', failedTests.map(([s, x], i) => {
    let img = '';
    if (x.screenshot && exists(x.screenshot) && shots < MAX_SHOTS) {
      const src = mode === 'email' ? 'cid:shot' + i : dataUri(x.screenshot);
      if (src) { img = '<img src="' + src + '" alt="Screenshot" style="display:block;max-width:100%;width:560px;margin-top:10px;border:1px solid ' + C.line + ';border-radius:6px">'; shots++; x._cid = 'shot' + i; }
    }
    return '<div style="border:1px solid ' + C.line + ';border-left:4px solid ' + C.red + ';border-radius:6px;padding:12px 14px;margin-bottom:12px;background:' + C.card + '">'
      + '<div style="font-size:14px;font-weight:700;color:' + C.ink + '">' + esc(x.title) + '</div>'
      + '<div style="font-size:11px;color:' + C.ink3 + ';margin-top:2px">' + esc(s.name) + '</div>'
      + (x.site ? '<div style="font-size:12px;font-weight:700;color:#8A5A00;background:#FFF4DB;border:1px solid #F1D9A6;border-radius:5px;padding:6px 9px;margin-top:8px">Site unavailable — ' + esc(x.site) + '</div>' : '')
      + (x.step ? '<div style="font-size:12px;color:' + C.ink2 + ';margin-top:8px"><b>Failing step:</b> ' + esc(x.step) + '</div>' : '')
      + (x.error ? '<pre style="white-space:pre-wrap;word-break:break-word;font-family:' + MONO + ';font-size:12px;color:' + C.red + ';background:' + C.redSoft + ';padding:8px 10px;border-radius:5px;margin:8px 0 0">' + esc(x.error) + '</pre>' : '')
      + img + '</div>';
  }).join('')) : '';

  const allTests = mode === 'file' ? section('All tests', run.stories.map((s) =>
    '<div style="font-size:13px;font-weight:700;color:' + C.ink + ';margin:8px 0 4px">' + esc(s.name) + '</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0">' + s.tests.map((x) =>
      '<tr><td ' + TD + '>' + esc(x.title) + '</td><td ' + TD + ' width="80">' + pill(x.status) + '</td>'
      + '<td ' + TD + ' width="60" align="right" nowrap>' + secs(x.duration) + '</td></tr>').join('') + '</table>').join('')) : '';

  const e = run.env || {};
  const sites = Array.from(new Set([].concat(...run.stories.map((s) => String(s.site || '').split(', ')))
    .filter(Boolean)));
  const envRows = [['Run from', e.ide], ['Framework', run.framework + (e.frameworkVersion ? ' ' + e.frameworkVersion : '')],
    ['Browser', (e.browser || '') + (e.browserVersion ? ' ' + e.browserVersion : '')],
    ['Mode', e.headless == null ? '' : (e.headless ? 'Headless' : 'Headed (browser visible)')],
    ['Sites', sites.join(', ')], ['OS', e.os], ['Machine', e.host], ['Runtime', e.runtime]]
    .filter((r) => r[1]).map((r) => '<tr><td ' + TD + ' width="110" style="color:' + C.ink2 + '">' + r[0]
      + '</td><td ' + TD + '>' + esc(r[1]) + '</td></tr>').join('');
  const env = section('Environment', '<table width="100%" cellpadding="0" cellspacing="0">' + envRows + '</table>');

  const detail = mode === 'file' && detailName
    ? '<a href="' + esc(detailName) + '" style="color:' + C.brand + ';font-weight:700">Open the detailed report</a> (every test with its steps and screenshot).'
    : 'Attached: <b>qa-studio-report.html</b> (this summary with screenshots) and <b>qa-studio-detailed.html</b> (every test with its steps and screenshot).';
  const foot = '<tr><td style="padding:22px 28px 24px"><div style="font-size:12px;color:' + C.ink2 + ';margin-bottom:12px">' + detail + '</div>'
    + '<div style="font-size:11.5px;font-weight:600;color:' + C.ink3 + ';border-top:1px solid ' + C.line + ';padding-top:12px">'
    + 'Generated by QA Studio' + (QA_VERSION.indexOf('__') === -1 ? ' v' + QA_VERSION : '') + ' · ' + esc(run.framework) + '</div></td></tr>';

  const body = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.paper + ';padding:24px 0">'
    + '<tr><td align="center"><table role="presentation" width="680" cellpadding="0" cellspacing="0" '
    + 'style="max-width:680px;width:100%;background:' + C.card + ';border-radius:12px;font-family:' + FONT + ';border:1px solid ' + C.line + '">'
    + head + banner + kpis + failures + stories + allTests + env + foot + '</table></td></tr></table>';
  if (mode !== 'file') return body;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>QA Studio — ' + esc(run.framework) + ' report</title></head><body style="margin:0;background:' + C.paper + '">'
    + body + '</body></html>';
}

// Writes the self-contained summary next to the framework report; returns its path.
function writeReport(run, dir, detailName) {
  const file = path.join(dir, 'qa-studio-report.html');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buildHtml(run, 'file', detailName), 'utf8');
    return file;
  } catch (e) { console.log('[report] could not write the summary: ' + e.message); return ''; }
}

async function mailReport(run, summaryFile, detailFile) {
  const to = (process.env.REPORT_EMAIL_TO || '').split(/[,;\s]+/).filter(Boolean);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (!to.length || !user || !pass) {
    console.log('[report] email skipped — set REPORT_EMAIL_TO, SMTP_USER and SMTP_PASS in .env');
    return;
  }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { console.log('[report] email skipped — run npm install (nodemailer missing)'); return; }
  const t = totals(run);
  const html = buildHtml(run, 'email');
  const ide = (run.env || {}).ide;
  const subject = (t.failed ? '✗ ' : '✓ ') + 'QA Studio — ' + run.framework + ' run'
    + (ide ? ' from ' + ide : '') + ': ' + t.passed + '/' + t.total
    + ' passed' + (t.failed ? ', ' + t.failed + ' failed' : '') + (t.skipped ? ', ' + t.skipped + ' skipped' : '');
  const attachments = [];
  if (exists(LOGO)) attachments.push({ filename: 'qa-logo.png', path: LOGO, cid: 'qa-logo' });
  run.stories.forEach((s) => s.tests.forEach((x) => {
    if (x._cid) attachments.push({ filename: x._cid + '.png', path: x.screenshot, cid: x._cid });
  }));
  let budget = 20 * 1024 * 1024;
  for (const [f, name] of [[summaryFile, 'qa-studio-report.html'],
                           [detailFile, path.basename(detailFile || '').indexOf('qa-studio') === 0 ? 'qa-studio-detailed.html'
                             : run.framework.toLowerCase() + '-report.html']]) {
    try {
      const size = exists(f) ? fs.statSync(f).size : 0;
      if (size && size < budget) { attachments.push({ filename: name, path: f }); budget -= size; }
    } catch (e) { /* attach is best effort */ }
  }
  try {
    const port = Number(process.env.SMTP_PORT || 465);
    const tr = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port,
      secure: port === 465, auth: { user, pass } });
    await tr.sendMail({ from: '"QA Studio" <' + user + '>', to: to.join(', '), subject, html, attachments });
    console.log('[report] emailed to ' + to.join(', '));
  } catch (e) { console.log('[report] email failed: ' + e.message); }
}

// Where the run was started — shown in the report and the email subject.
// QA_IDE in .env overrides it; otherwise CI variables, the IDE's terminal
// variables, then the parent processes (an IDE's Run button sets no variable).
const IDE_NAMES = [
  [/^idea(64)?(\.exe)?$|intellij/i, 'IntelliJ IDEA'], [/^webstorm/i, 'WebStorm'],
  [/^pycharm/i, 'PyCharm'], [/^rider/i, 'Rider'], [/^goland/i, 'GoLand'],
  [/^eclipse/i, 'Eclipse'], [/^cursor/i, 'Cursor'], [/^windsurf/i, 'Windsurf'],
  [/^code( - insiders)?(\.exe)?$|^code-insiders/i, 'VS Code'], [/^devenv(\.exe)?$/i, 'Visual Studio'],
];
function ideFromParents() {
  try {
    const { execFileSync } = require('child_process');
    const procs = new Map();
    const out = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }"],
      { encoding: 'utf8', timeout: 15000, windowsHide: true })
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 });
    out.split(/\r?\n/).forEach((line) => {
      const m = process.platform === 'win32' ? line.trim().split('|') : line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return;
      const parts = process.platform === 'win32' ? m : m.slice(1);
      if (parts.length >= 3) procs.set(Number(parts[0]), { ppid: Number(parts[1]), name: path.basename(String(parts[2]).trim()) });
    });
    let pid = process.ppid;
    for (let i = 0; i < 12 && procs.has(pid); i++) {
      const p = procs.get(pid);
      const hit = IDE_NAMES.find(([re]) => re.test(p.name));
      if (hit) return hit[1];
      pid = p.ppid;
    }
  } catch (e) { /* unknown is fine */ }
  return '';
}
function detectIde() {
  const e = process.env;
  if (e.QA_IDE) return e.QA_IDE;
  if (e.GITHUB_ACTIONS) return 'GitHub Actions';
  if (e.TF_BUILD) return 'Azure Pipelines';
  if (e.GITLAB_CI) return 'GitLab CI';
  if (e.JENKINS_URL) return 'Jenkins';
  if (e.CI) return 'CI';
  const fromParents = ideFromParents();
  if (fromParents) return fromParents;
  if (e.CURSOR_TRACE_ID) return 'Cursor';
  if (e.TERM_PROGRAM === 'vscode' || e.VSCODE_PID || e.VSCODE_IPC_HOOK_CLI) return 'VS Code';
  if (/jetbrains/i.test(e.TERMINAL_EMULATOR || '')) return 'JetBrains IDE';
  return 'Terminal';
}

// ---- Detailed report (qa-studio-detailed.html): every test with its steps,
// error, screenshot and retries — same layout as the Selenium one. ----
const DETAIL_CSS = ":root{--bg:#F3F5F8;--card:#FFFFFF;--ink:#16151C;--ink2:#5D5B69;--ink3:#9896A3;--line:#E4E6EC;--tint:#F8F9FB;--brand:#0E9CC0;--brand2:#0B6E86;--pass:#1F8A52;--pass-s:#E5F4EC;--fail:#D6414A;--fail-s:#FCEBEC;--skip:#8E8C99;--skip-s:#EFEFF3;--flaky:#B7791F;--flaky-s:#FFF4DB;--shadow:0 1px 2px rgba(20,20,40,.05),0 4px 14px rgba(20,20,40,.05)}\n@media (prefers-color-scheme:dark){:root{--bg:#0F1117;--card:#171A22;--ink:#ECEDF2;--ink2:#A9ABB8;--ink3:#737584;--line:#262A35;--tint:#1C202A;--pass:#3DBB78;--pass-s:#15301F;--fail:#F0656D;--fail-s:#3A1A1D;--skip:#9A99A6;--skip-s:#23262F;--flaky:#E2A845;--flaky-s:#382B12;--shadow:none}}\n*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}\nbody{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 'Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif}\n.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px max(16px,calc((100% - 1040px)/2));background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}\n.brand{display:flex;align-items:center;gap:12px}.brand img{width:36px;height:36px;border-radius:9px}\n.name{font-weight:800;font-size:16px}.sub{font-size:12px;color:var(--ink2)}.when{font-size:12px;color:var(--ink2);text-align:right}\nmain{max-width:1040px;margin:0 auto;padding:20px 16px 8px}\n.hero{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);border-top:4px solid var(--pass)}\n.hero.bad{border-top-color:var(--fail)}.hero h1{margin:0;font-size:24px;letter-spacing:-.3px}.hero.ok h1{color:var(--pass)}.hero.bad h1{color:var(--fail)}\n.meta{color:var(--ink2);font-size:13px;margin-top:2px}\n.bar{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--skip-s);margin:16px 0}\n.bar span{display:block;height:100%}.bar .pass{background:var(--pass)}.bar .fail{background:var(--fail)}.bar .skip{background:var(--skip)}\n.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}\n.kpi{background:var(--tint);border:1px solid var(--line);border-radius:10px;padding:10px 12px}\n.kv{font-size:21px;font-weight:800}.kl{font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px}\n.kpi.pass .kv{color:var(--pass)}.kpi.fail .kv{color:var(--fail)}.kpi.flaky .kv{color:var(--flaky)}\n.tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:18px 0 6px;position:sticky;top:65px;z-index:4;background:var(--bg);padding:8px 0}\n.chips{display:flex;gap:6px;flex-wrap:wrap}\n.chip,.ghost{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--ink2);border-radius:999px;padding:6px 12px;cursor:pointer}\n.chip b{color:var(--ink);margin-left:3px}.chip.on{background:var(--brand);border-color:var(--brand);color:#fff}.chip.on b{color:#fff}\n.ghost{border-radius:8px}.chip:hover,.ghost:hover{border-color:var(--brand)}\n#q{flex:1;min-width:180px;font:inherit;font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}\n#q:focus{outline:2px solid var(--brand);outline-offset:-1px}\n.story{margin-top:16px}.sh{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 2px 8px}\n.sh h2{font-size:13px;margin:0;color:var(--brand2);text-transform:uppercase;letter-spacing:.6px}\n@media (prefers-color-scheme:dark){.sh h2{color:var(--brand)}}\n.sc{display:flex;gap:10px;font-size:12px;color:var(--ink3)}.c.pass{color:var(--pass)}.c.fail{color:var(--fail);font-weight:700}\ndetails.t{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--pass);border-radius:10px;margin-bottom:8px;box-shadow:var(--shadow)}\ndetails.t.failed{border-left-color:var(--fail)}details.t.skipped{border-left-color:var(--skip)}\ndetails.t>summary{list-style:none;display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer}\ndetails.t>summary::-webkit-details-marker{display:none}\ndetails.t>summary::after{content:'';width:7px;height:7px;border-right:2px solid var(--ink3);border-bottom:2px solid var(--ink3);transform:rotate(-45deg);transition:transform .15s;margin-left:2px}\ndetails.t[open]>summary::after{transform:rotate(45deg)}\n.dot{width:9px;height:9px;border-radius:50%;background:var(--pass);flex:none}.failed .dot{background:var(--fail)}.skipped .dot{background:var(--skip)}\n.tt{flex:1;font-weight:600;min-width:0}\n.badge{font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}\n.badge.data{background:var(--tint);color:var(--ink2);border:1px solid var(--line)}\n.badge.flaky,.badge.site{background:var(--flaky-s);color:var(--flaky)}\n.st{font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px}.st.passed{background:var(--pass-s);color:var(--pass)}\n.st.failed{background:var(--fail-s);color:var(--fail)}.st.skipped{background:var(--skip-s);color:var(--skip)}\n.ms{font-size:12px;color:var(--ink3);width:56px;text-align:right;font-variant-numeric:tabular-nums}\n.body{padding:2px 16px 16px 33px;border-top:1px solid var(--line)}\n.lbl{font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}\n.steps{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);margin-left:9px}\n.steps li{display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px 0;position:relative;left:-10px}\n.n{flex:none;min-width:20px;height:20px;border-radius:10px;background:var(--tint);border:1px solid var(--line);font-size:11px;font-weight:700;color:var(--ink2);display:flex;align-items:center;justify-content:center;padding:0 5px}\n.x{padding-top:1px}.steps li.bad .n{background:var(--fail);border-color:var(--fail);color:#fff}.steps li.bad .x{color:var(--fail);font-weight:600}\n.here{font-size:11px;font-weight:700;color:var(--fail);background:var(--fail-s);border-radius:999px;padding:1px 8px;margin-top:1px}\npre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 Consolas,Menlo,monospace}\n.err{color:var(--fail);background:var(--fail-s);padding:10px 12px;border-radius:8px}\n.stack{margin-top:8px}.stack summary{cursor:pointer;font-size:12px;color:var(--ink2)}\n.stack pre{margin-top:6px;color:var(--ink2);background:var(--tint);border:1px solid var(--line);padding:10px 12px;border-radius:8px;max-height:260px;overflow:auto}\n.down{margin-top:12px;background:var(--flaky-s);color:var(--flaky);border-radius:8px;padding:9px 12px;font-size:13px}\n.shot{display:block;max-width:100%;width:560px;border:1px solid var(--line);border-radius:8px;cursor:zoom-in}\n.vid{display:block;max-width:100%;width:720px;border:1px solid var(--line);border-radius:8px;background:#000}\n.vnote{font-size:12px;color:var(--ink3);margin-top:4px}\n.none{margin-top:12px;color:var(--ink3);font-size:13px}.empty{text-align:center;color:var(--ink3);padding:30px}\n.env{margin-top:22px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;box-shadow:var(--shadow)}\n.env h2{font-size:13px;margin:0 0 6px;color:var(--ink2);text-transform:uppercase;letter-spacing:.6px}\n.env table{width:100%;border-collapse:collapse;font-size:13px}.env th{text-align:left;color:var(--ink3);font-weight:600;width:120px;padding:6px 0;vertical-align:top}\n.env td{padding:6px 0;word-break:break-word}.env tr+tr th,.env tr+tr td{border-top:1px solid var(--line)}\nfooter{text-align:center;color:var(--ink3);font-size:12px;padding:18px 16px 28px}\n.zoom{position:fixed;inset:0;background:rgba(8,10,16,.82);display:flex;align-items:center;justify-content:center;padding:20px;z-index:10;cursor:zoom-out}\n.zoom img{max-width:100%;max-height:100%;border-radius:8px}\n[hidden]{display:none!important}\n@media (max-width:760px){.kpis{grid-template-columns:repeat(3,1fr)}.top{position:static}.tools{top:0}.ms{display:none}.body{padding-left:16px}.hero h1{font-size:20px}}\n@media print{.tools,.zoom{display:none!important}details.t{break-inside:avoid}.top{position:static}}\n";
const DETAIL_JS = "(function(){\nvar tests=[].slice.call(document.querySelectorAll('details.t'));\nvar chips=[].slice.call(document.querySelectorAll('.chip'));\nvar q=document.getElementById('q'),empty=document.getElementById('empty'),filter='all';\nfunction apply(){var term=(q.value||'').trim().toLowerCase(),shown=0;\ntests.forEach(function(t){var ok=(filter==='all'||t.getAttribute('data-s')===filter)&&(!term||t.getAttribute('data-q').indexOf(term)>=0);t.hidden=!ok;if(ok)shown++;});\n[].forEach.call(document.querySelectorAll('section.story'),function(s){s.hidden=!s.querySelector('details.t:not([hidden])');});\nempty.hidden=shown>0;}\nchips.forEach(function(c){c.addEventListener('click',function(){chips.forEach(function(x){x.classList.remove('on');});c.classList.add('on');filter=c.getAttribute('data-f');apply();});});\nq.addEventListener('input',apply);\nvar xp=document.getElementById('xp'),open=false;\nxp.addEventListener('click',function(){open=!open;tests.forEach(function(t){if(!t.hidden)t.open=open;});xp.textContent=open?'Collapse all':'Expand all';});\nvar zoom=document.getElementById('zoom'),zimg=zoom.querySelector('img');\ndocument.addEventListener('click',function(e){if(e.target.classList&&e.target.classList.contains('shot')){zimg.src=e.target.src;zoom.hidden=false;}});\nzoom.addEventListener('click',function(){zoom.hidden=true;});\ndocument.addEventListener('keydown',function(e){if(e.key==='Escape')zoom.hidden=true;});\n})();";
function dur(ms) { return ms < 1000 ? Math.round(ms || 0) + ' ms' : secs(ms); }
function detailedHtml(run, frameworkReport, dir) {
  const t = totals(run);
  const total = t.total, failed = t.failed, skipped = t.skipped, flaky = t.flaky;
  const passed = Math.max(0, total - failed - skipped);
  const rate = total ? Math.round(passed * 100 / total) : 0;
  const seg = (cls, n) => n > 0 ? "<span class='" + cls + "' style='width:" + (n * 100 / total) + "%'></span>" : '';
  const kpiCard = (label, v, cls) => "<div class='kpi " + (cls || '') + "'><div class='kv'>" + esc(v) + "</div><div class='kl'>" + label + '</div></div>';
  const e = run.env || {};
  const started = new Date(run.startedAt || Date.now());
  let budget = 8 * 1024 * 1024;   // screenshots are embedded up to this size, then linked
  const out = [];
  out.push("<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
    '<title>QA Studio - ' + esc(run.framework) + ' detailed report</title><style>' + DETAIL_CSS + '</style></head><body>',
    "<header class='top'><div class='brand'>" + (exists(LOGO) ? "<img src='" + dataUri(LOGO) + "' alt=''>" : ''),
    "<div><div class='name'>QA Studio</div><div class='sub'>" + esc(run.framework) + ' detailed report' + (e.ide ? ' &middot; run from <b>' + esc(e.ide) + '</b>' : '') + '</div></div></div>',
    "<div class='when'>" + esc(started.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</div></header><main>');
  const allSkipped = total > 0 && skipped === total;
  out.push("<section class='hero " + (failed || allSkipped ? 'bad' : 'ok') + "'><div class='verdict'><h1>"
    + verdict(total, failed, skipped) + "</h1><div class='meta'>"
    + run.stories.length + (run.stories.length === 1 ? ' story' : ' stories') + ' &middot; ' + secs(run.duration || 0)
    + (e.browser ? ' &middot; ' + esc(e.browser) : '') + "</div></div><div class='bar'>"
    + seg('pass', passed) + seg('fail', failed) + seg('skip', skipped) + "</div><div class='kpis'>"
    + kpiCard('Pass rate', rate + '%', failed ? '' : 'pass') + kpiCard('Passed', passed, 'pass')
    + kpiCard('Failed', failed, failed ? 'fail' : '') + kpiCard('Skipped', skipped, '')
    + kpiCard('Flaky', flaky, flaky ? 'flaky' : '') + kpiCard('Duration', secs(run.duration || 0), '') + '</div></section>');
  const st = (x) => x.status === 'flaky' ? 'passed' : x.status;
  out.push("<div class='tools'><div class='chips'>",
    "<button class='chip on' data-f='all'>All <b>" + total + '</b></button>',
    "<button class='chip' data-f='failed'>Failed <b>" + failed + '</b></button>',
    "<button class='chip' data-f='passed'>Passed <b>" + passed + '</b></button>',
    "<button class='chip' data-f='skipped'>Skipped <b>" + skipped + '</b></button>',
    "</div><input id='q' type='search' placeholder='Search tests, steps or errors'>",
    "<button class='ghost' id='xp' type='button'>Expand all</button></div>");
  for (const s of run.stories) {
    const c = s.counts || {};
    out.push("<section class='story'><div class='sh'><h2>" + esc(s.name) + "</h2><div class='sc'>"
      + "<span class='c pass'>" + (c.passed || 0) + ' passed</span>'
      + (c.failed ? "<span class='c fail'>" + c.failed + ' failed</span>' : '')
      + (c.skipped ? "<span class='c skip'>" + c.skipped + ' skipped</span>' : '')
      + "<span class='c'>" + secs(c.duration || 0) + '</span></div></div>');
    for (const x of s.tests) {
      const status = st(x);
      const steps = x.steps || [];
      const search = (x.title + ' ' + steps.join(' ') + ' ' + (x.fullError || x.error || '')).toLowerCase();
      out.push("<details class='t " + status + "' data-s='" + status + "' data-q='" + esc(search) + "'" + (status === 'failed' ? ' open' : '') + '>'
        + "<summary><span class='dot'></span><span class='tt'>" + esc(x.title) + '</span>'
        + (x.status === 'flaky' ? "<span class='badge flaky'>Passed on retry</span>" : '')
        + (x.site ? "<span class='badge site'>Site unavailable</span>" : '')
        + "<span class='st " + status + "'>" + status.charAt(0).toUpperCase() + status.slice(1) + '</span>'
        + "<span class='ms'>" + dur(x.duration) + "</span></summary><div class='body'>");
      if (x.site) out.push("<div class='down'><b>Site unavailable</b> &mdash; " + esc(x.site) + '</div>');
      if (steps.length) {
        const bad = status === 'failed' ? (x.failIdx != null && x.failIdx >= 0 ? x.failIdx : steps.length - 1) : -1;
        out.push("<div class='lbl'>Steps</div><ol class='steps'>");
        steps.forEach((line, i) => {
          const m = /^Step (\d+) · (.*)$/.exec(line);
          out.push('<li' + (i === bad ? " class='bad'" : '') + "><span class='n'>" + esc(m ? m[1] : String(i + 1))
            + "</span><span class='x'>" + esc(m ? m[2] : line) + '</span>'
            + (i === bad ? "<span class='here'>Failed here</span>" : '') + '</li>');
        });
        out.push('</ol>');
      }
      const err = x.fullError || x.error;
      if (err) {
        out.push("<div class='lbl'>Error</div><pre class='err'>" + esc(err) + '</pre>');
        if (x.stack) out.push("<details class='stack'><summary>Stack trace</summary><pre>" + esc(x.stack) + '</pre></details>');
      }
      if (x.screenshot && exists(x.screenshot)) {
        let src = '';
        try {
          const size = fs.statSync(x.screenshot).size;
          if (size <= budget) { src = dataUri(x.screenshot); budget -= size; }
        } catch (e2) { /* link instead */ }
        if (!src) src = 'file:///' + path.resolve(x.screenshot).replace(/\\/g, '/');
        out.push("<div class='lbl'>Screenshot</div><img class='shot' loading='lazy' alt='Screenshot' src='" + src + "'>");
      }
      const hasVideo = !!(x.video && exists(x.video));
      if (hasVideo) {
        // Linked, not embedded (videos are large); the path is relative to the report.
        let rel = path.relative(dir || '.', path.resolve(x.video));
        rel = path.isAbsolute(rel) ? 'file:///' + rel.replace(/\\/g, '/') : encodeURI(rel.split(path.sep).join('/'));
        out.push("<div class='lbl'>Video</div><video class='vid' controls preload='metadata' src='" + esc(rel) + "'></video>"
          + (x.videoNote ? "<div class='vnote'>" + esc(x.videoNote) + '</div>' : ''));
      }
      if (!steps.length && !err && !hasVideo && !(x.screenshot && exists(x.screenshot)))
        out.push("<div class='none'>No steps or screenshot were recorded for this test.</div>");
      out.push('</div></details>');
    }
    out.push('</section>');
  }
  out.push("<div class='empty' id='empty' hidden>No tests match.</div>");
  const sites = [];
  run.stories.forEach((s) => String(s.site || '').split(', ').forEach((u) => { if (u && sites.indexOf(u) === -1) sites.push(u); }));
  const rows = [['Run from', e.ide], ['Framework', run.framework + (e.frameworkVersion ? ' ' + e.frameworkVersion : '')],
    ['Browser', [e.browser, e.browserVersion].filter(Boolean).join(' ')],
    ['Mode', e.headless === undefined ? '' : e.headless ? 'Headless' : 'Headed (browser visible)'],
    ['Retries', process.env.RETRIES || '1'], ['Sites', sites.join(', ')], ['OS', e.os], ['Machine', e.host], ['Runtime', e.runtime]]
    .filter((r) => r[1]).map((r) => '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('');
  out.push("<section class='env'><h2>Environment</h2><table>" + rows + '</table></section>');
  if (frameworkReport) out.push("<p style='text-align:center;margin:16px 0 0'><a href='" + esc(frameworkReport)
    + "' style='color:var(--brand);font-weight:700'>Open the " + esc(run.framework) + " report</a> (traces, videos, every command).</p>");
  out.push('</main><footer>Generated by QA Studio' + (QA_VERSION.indexOf('__') === -1 ? ' v' + QA_VERSION : '')
    + ' &middot; ' + esc(run.framework) + "</footer><div class='zoom' id='zoom' hidden><img alt=''></div><script>" + DETAIL_JS + '</script></body></html>');
  return out.join('');
}
function writeDetailed(run, dir, frameworkReport) {
  const file = path.join(dir, 'qa-studio-detailed.html');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, detailedHtml(run, frameworkReport, dir), 'utf8');
    return file;
  } catch (e) { console.log('[report] could not write the detailed report: ' + e.message); return ''; }
}

module.exports = { writeDetailed, openFile, mailReport, writeReport, buildHtml, siteOf, stripAnsi, detectIde };

// `node report-mailer.js --open <file>` opens a report on demand (npm run report).
if (require.main === module) {
  const i = process.argv.indexOf('--open');
  if (i > -1 && process.argv[i + 1]) {
    process.env.OPEN_REPORT = 'true';
    openFile(path.resolve(process.argv[i + 1]));
  }
}
