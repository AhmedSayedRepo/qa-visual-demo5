// Live progress window while tests run from the IDE (or npm test on a desktop):
// current test and browser, a progress bar split into passed / failed /
// skipped, counts and time left. It is the same frameless window as the
// Selenium projects (QaProgressWindow.java, run with Java 11+), or a small
// Edge / Chrome app window without Java, fed by a tiny server inside this test
// run; the run never depends on it. PROGRESS=off (.env or environment)
// turns it off; CI never shows it. With several browsers in one `npm test`
// (Cypress), the parent run owns the window and each browser run reports to it.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

const state = { total: 0, done: 0, passed: 0, failed: 0, skipped: 0, current: '', browser: '',
  started: Date.now(), ended: 0, wrapping: false, finished: false, verdict: '', browsers: {} };

// One progress row per browser (shown with two or more).
function laneOf(name) {
  if (!state.browsers[name]) state.browsers[name] = { total: 0, done: 0, passed: 0, failed: 0, skipped: 0 };
  return state.browsers[name];
}
function lanesText() {
  return Object.keys(state.browsers).map((n) => {
    const l = state.browsers[n];
    return [String(n).replace(/[|;]/g, ' '), l.total, l.passed, l.failed, l.skipped].join('|');
  }).join(';');
}
let server = null;
let child = null;
let enabled = null;
const parentPort = Number(process.env.QA_PROGRESS_PORT || 0);

function isOn() {
  if (enabled === null) {
    const m = String(process.env.PROGRESS || 'on').trim().toLowerCase();
    enabled = !['off', 'false', '0', 'no'].includes(m) && !process.env.CI;
  }
  return enabled;
}

function forward(msg) {
  try {
    const body = JSON.stringify(msg);
    const req = http.request({ host: '127.0.0.1', port: parentPort, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.end(body);
  } catch (e) { /* the window is optional */ }
}

function apply(msg) {
  if (!msg) return;
  if (msg.op === 'test') {
    state.current = String(msg.title || '');
    state.browser = String(msg.browser || '');
    state.ended = 0;                                  // more tests than counted: the clock runs on
  } else if (msg.op === 'done') {
    state.done++;
    if (msg.status === 'passed') state.passed++;
    else if (msg.status === 'failed') state.failed++;
    else state.skipped++;
    if (state.done > state.total) state.total = state.done;
    if (state.done >= state.total && !state.ended) state.ended = Date.now();   // 100%: the clock stops
    if (msg.browser) {
      const l = laneOf(String(msg.browser));
      l.done++;
      l[msg.status === 'passed' ? 'passed' : msg.status === 'failed' ? 'failed' : 'skipped']++;
      if (l.done > l.total) l.total = l.done;
    }
  } else if (msg.op === 'expect' && msg.browser) {
    laneOf(String(msg.browser)).total = Math.max(Number(msg.count) || 0, 0);
  }
}

function event(msg) {
  if (!isOn()) return;
  if (parentPort) forward(msg); else apply(msg);
}
function testStarted(title, browser) { event({ op: 'test', title, browser }); }
function testDone(status, browser) { event({ op: 'done', status, browser: browser || '' }); }
/** How many tests a browser will run (one progress row per browser). */
function expect(browser, count) { if (browser) event({ op: 'expect', browser, count }); }

function verdict() {
  const t = state.done;
  if (!t) return 'No tests ran';
  return state.failed ? state.failed + ' of ' + t + ' tests failed' : 'All ' + t + ' tests passed';
}

function browserExe() {
  const e = process.env;
  const win = [e['ProgramFiles(x86)'], e.ProgramFiles, e.LOCALAPPDATA].filter(Boolean);
  const cands = process.platform === 'win32'
    ? win.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
        .concat(win.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')))
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
         '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return cands.find((p) => { try { return fs.existsSync(p); } catch (err) { return false; } });
}

// Java 11+ runs the same frameless window as the Selenium projects
// (QaProgressWindow.java next to this file). No Java, an older one, or a JRE
// without the compiler: fall back to an Edge / Chrome app window.
// `java` (not javaw) with a hidden console: an old javaw showed a "JNI error"
// dialog box instead of just failing.
let fellBack = false;
function javaVersion(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const m = String((r.stderr || '') + (r.stdout || '')).match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    const major = Number(m[1]);
    return major === 1 ? Number(m[2] || 0) : major;     // "1.8.0_381" is Java 8
  } catch (e) { return 0; }
}
function javaExe() {
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(path.join(process.env.JAVA_HOME, 'bin', name));
  cands.push('java');
  for (const c of cands) {
    if (c !== 'java' && !fs.existsSync(c)) continue;
    if (javaVersion(c) >= 11 && hasCompiler(c)) return c;
  }
  return null;
}
// A JRE (runtime only) can't run a .java source file: it needs a JDK.
function hasCompiler(exe) {
  try {
    const r = spawnSync(exe, ['--list-modules'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return /\bjdk\.compiler\b/.test(String(r.stdout || '') + String(r.stderr || ''));
  } catch (e) { return false; }
}

function openWindow(url) {
  const src = path.join(__dirname, 'QaProgressWindow.java');
  const java = fs.existsSync(src) ? javaExe() : null;
  if (!java) { openBrowserWindow(url); return; }
  const fallBack = () => {
    if (fellBack || state.finished) return;
    fellBack = true;
    child = null;
    openBrowserWindow(url);
  };
  try {
    child = spawn(java, [src, url], { stdio: 'ignore', windowsHide: true,
      detached: process.platform !== 'win32' });
    child.on('error', fallBack);
    child.on('exit', (code) => { if (code) fallBack(); });
    child.unref();
  } catch (e) { fallBack(); }
}

function openBrowserWindow(url) {
  const exe = browserExe();
  if (!exe) { console.log('[progress] no Edge or Chrome found - progress window skipped'); return; }
  const profile = path.join(os.tmpdir(), 'qa-studio-progress-profile');
  try {
    child = spawn(exe, ['--app=' + url, '--window-size=460,270', '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions'],
      { stdio: 'ignore', detached: process.platform !== 'win32' });
    child.on('error', () => { child = null; });
    child.unref();
  } catch (e) { child = null; }
}

function closeWindow() {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid);
  } catch (e) { try { child.kill(); } catch (err) { /* already closed */ } }
  child = null;
}

/** Opens the window; resolves with its server's port (0 when off). */
function start(total) {
  if (!isOn() || parentPort || server) return Promise.resolve(port());
  state.total = Math.max(Number(total) || 0, 1);
  state.started = Date.now();
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/event') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { try { apply(JSON.parse(body)); } catch (e) { /* ignore */ } res.end('ok'); });
      return;
    }
    if (req.url && req.url.indexOf('/state') === 0) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(Object.assign({}, state, { elapsed: (state.ended || Date.now()) - state.started,
        lanes: lanesText() })));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.on('error', () => { server = null; resolve(0); });
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      openWindow('http://127.0.0.1:' + p + '/');
      resolve(p);
    });
    server.unref();
  });
}

/** The port the window's server listens on (for child runs), or 0. */
function port() { return server && server.address() ? server.address().port : 0; }

/** Every test ran: the clock stops and the window says the report is being written. */
function wrapUp() {
  if (!isOn() || parentPort || !server) return;
  if (!state.ended) state.ended = Date.now();
  state.wrapping = true;
}

/** Shows the verdict briefly, then closes the window. */
async function finish(text) {
  if (!isOn() || parentPort || !server) return;
  if (!state.ended) state.ended = Date.now();
  state.finished = true;
  state.verdict = text || verdict();
  await new Promise((r) => setTimeout(r, 1500));
  closeWindow();
  try { server.close(); } catch (e) { /* closed */ }
  server = null;
}

/** Number of tests in the given spec files (it( calls), for the bar's total. */
function countTests(files) {
  let n = 0;
  for (const f of files || []) {
    try { n += (fs.readFileSync(f, 'utf8').match(/\bit\s*\(/g) || []).length; } catch (e) { /* unreadable */ }
  }
  return n;
}

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>QA Studio - running tests</title>',
  '<style>',
  ':root{--bg:#111727;--card:#1c243a;--line:#303a56;--ink:#e8ecf4;--ink2:#a4adc0;--ink3:#707a91;',
  '--teal:#22b8c7;--green:#3fb950;--red:#f85149;--grey:#76809a}',
  'html,body{margin:0;background:var(--bg);color:var(--ink);font:13px "Segoe UI",system-ui,sans-serif;overflow:hidden}',
  '.wrap{padding:12px 18px 14px}',
  '.hd{display:flex;align-items:center;gap:8px}',
  '.dot{width:8px;height:8px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 0 rgba(34,184,199,.6);animation:p 1.5s infinite}',
  '.dot.ok{background:var(--green);animation:none}.dot.bad{background:var(--red);animation:none}',
  '@keyframes p{0%{box-shadow:0 0 0 0 rgba(34,184,199,.55)}100%{box-shadow:0 0 0 9px rgba(34,184,199,0)}}',
  '.name{font-weight:700}.st{color:var(--ink2);flex:1}',
  '.btn{background:none;border:0;color:var(--ink2);cursor:pointer;width:28px;height:24px;border-radius:7px;font-size:14px}',
  '.btn:hover{background:#28324c}',
  '.lbl{margin-top:10px;font-size:10px;font-weight:700;color:var(--ink3);letter-spacing:.4px}',
  '.cur{margin-top:4px;font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.meta{display:flex;justify-content:space-between;align-items:center;margin-top:10px}',
  '.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:11px;color:var(--teal);background:rgba(34,184,199,.18)}',
  '.pill.firefox{color:#ff8c32;background:rgba(255,140,50,.18)}.pill.edge,.pill.msedge{color:#4296ff;background:rgba(66,150,255,.18)}',
  '.pill:empty{display:none}',
  '.ratio{font-weight:700;color:var(--ink2);font-size:12px}',
  '.bar{display:flex;height:10px;border-radius:5px;background:var(--card);overflow:hidden;margin-top:8px}',
  '.bar i{display:block;height:100%;transition:width .3s}.bar .p{background:var(--green)}.bar .f{background:var(--red)}.bar .s{background:var(--grey)}',
  '.chips{display:flex;gap:8px;margin-top:12px}',
  '.chip{background:var(--card);border-radius:13px;padding:4px 11px 4px 9px;font-weight:700;font-size:12px}',
  '.chip b{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}',
  '.el{margin-top:10px;font-size:11px;color:var(--ink3)}',
  '.lanes{margin-top:12px}.lanes:empty{display:none}.ln{display:flex;align-items:center;gap:8px;margin-top:6px}',
  '.ln .pill{width:58px;text-align:center}.ln .bar{flex:1;height:6px;margin-top:0}.ln .c{width:48px;text-align:right;font-weight:700;color:var(--ink2);font-size:11px}',
  'body.compact .full{display:none}body.compact .bar{height:4px;margin-top:9px}',
  '</style></head><body><div class="wrap">',
  '<div class="hd"><span class="dot" id="dot"></span><span class="name">QA Studio</span>',
  '<span class="st" id="st">Running tests</span>',
  '<button class="btn" id="cmp" title="Compact view">&#8964;</button></div>',
  '<div class="full"><div class="lbl" id="lbl">NOW RUNNING</div><div class="cur" id="cur">Starting the browser...</div>',
  '<div class="meta"><span class="pill" id="pill"></span><span class="ratio" id="ratio"></span></div></div>',
  '<div class="bar"><i class="p" id="bp"></i><i class="f" id="bf"></i><i class="s" id="bs"></i></div>',
  '<div class="full"><div class="chips"><span class="chip"><b style="background:var(--green)"></b><span id="np">0</span> passed</span>',
  '<span class="chip"><b style="background:var(--red)"></b><span id="nf">0</span> failed</span>',
  '<span class="chip"><b style="background:var(--grey)"></b><span id="ns">0</span> skipped</span></div>',
  '<div class="lanes" id="lanes"></div>',
  '<div class="el" id="el"></div></div></div>',
  '<script>',
  'var $=function(i){return document.getElementById(i)},compact=false,full=[460,270],small=[460,110];',
  'function clock(ms){var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s/60)%60,x=s%60;',
  ' return (h?h+":"+(m<10?"0":""):"")+m+":"+(x<10?"0":"")+x}',
  '$("cmp").onclick=function(){compact=!compact;document.body.className=compact?"compact":"";',
  ' $("cmp").innerHTML=compact?"&#8963;":"&#8964;";$("cmp").title=compact?"Full view":"Compact view";',
  ' try{var z=compact?small:full;window.resizeTo(z[0],z[1])}catch(e){}};',
  'document.querySelector(".hd").ondblclick=function(){$("cmp").onclick()};',
  'function draw(s){var t=Math.max(s.total,1),pct=Math.round(100*s.done/t);',
  ' $("bp").style.width=(100*s.passed/t)+"%";$("bf").style.width=(100*s.failed/t)+"%";$("bs").style.width=(100*s.skipped/t)+"%";',
  ' $("np").textContent=s.passed;$("nf").textContent=s.failed;$("ns").textContent=s.skipped;',
  ' $("ratio").textContent=s.done+" / "+t+"   "+pct+"%";',
  ' var p=$("pill");p.textContent=s.browser||"";p.className="pill "+String(s.browser||"").toLowerCase().split(" ")[0];',
  ' var left=(!s.finished&&!s.ended&&s.done>0&&s.done<t)?"   ·   about "+clock(s.elapsed/s.done*(t-s.done))+" left":"";',
  ' $("el").textContent="Elapsed "+clock(s.elapsed)+left;',
  ' if(s.finished){$("st").textContent="Finished";$("lbl").textContent="RESULT";$("cur").textContent=s.verdict;',
  '  $("dot").className="dot "+(s.failed?"bad":"ok");}',
  ' else if(s.wrapping){$("st").textContent=compact?"Writing the report...":"All tests ran";',
  '  $("lbl").textContent="ALL TESTS RAN";$("cur").textContent="Writing the report...";}',
  ' else{$("cur").textContent=s.current||"Starting the browser...";$("cur").title=s.current||"";',
  '  $("st").textContent=s.ended?(compact?s.done+" / "+t+"  ·  wrapping up":"Wrapping up")',
  '   :compact?(s.done+" / "+t+(s.failed?"  ·  "+s.failed+" failed":"  ·  running")):"Running tests";}',
  ' var names=Object.keys(s.browsers||{}),h="";',
  ' if(names.length>1)names.forEach(function(n){var l=s.browsers[n],lt=Math.max(l.total,1);',
  '  h+="<div class=\\"ln\\"><span class=\\"pill "+n.toLowerCase()+"\\">"+n+"</span><div class=\\"bar\\">"',
  '   +"<i class=\\"p\\" style=\\"width:"+(100*l.passed/lt)+"%\\"></i><i class=\\"f\\" style=\\"width:"+(100*l.failed/lt)+"%\\"></i>"',
  '   +"<i class=\\"s\\" style=\\"width:"+(100*l.skipped/lt)+"%\\"></i></div><span class=\\"c\\">"+l.done+" / "+l.total+"</span></div>";});',
  ' $("lanes").innerHTML=h;',
  ' if(names.length>1&&!window.qaSized&&!compact){window.qaSized=1;full=[460,280+28*names.length];try{window.resizeTo(full[0],full[1])}catch(e){}}',
  ' document.title=(s.finished?"Finished":s.done+"/"+t)+" - QA Studio";}',
  'function tick(){fetch("/state",{cache:"no-store"}).then(function(r){return r.json()}).then(draw).catch(function(){',
  ' $("st").textContent="Finished";});}',
  'tick();setInterval(tick,500);',
  '</script></body></html>'].join('\n');

module.exports = { start, testStarted, testDone, expect, event, wrapUp, finish, countTests, port, verdict, _state: state, _page: PAGE };
