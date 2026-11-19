// Self-healing locator resolver. Order per step key:
//   1) locator saved in locators.json   2) the generated seed locator
//   3) ask the configured AI provider to pick one from the live DOM, then save it
//      back into locators.json so every later run reuses it.
const { load, save, toSelector } = require('./locators');
const { pickLocator, HEAL, PROVIDER } = require('./aiClient');
const { HARVEST_EXPR } = require('./harvest');

// Arabic-aware text normalization for assertText: the app's on-screen copy and
// the AI-authored expected keywords routinely differ ONLY in orthography —
// tashkeel/diacritics (عذرًا vs عذراً), alef variants (أ/إ/آ vs ا), teh marbuta
// vs heh (ة/ه), yaa variants (ى/ي) and tatweel. Exact substring matching failed
// live on 8 assertions in one run whose ACTIONS had all succeeded. Both sides
// are normalized before comparing.
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

// Visible option/suggestion by text (custom dropdowns, autocomplete lists):
// the same script QA Studio's live inspection used.
const PICK_FN = "function(want){function norm(s){return String(s||'').toLowerCase().replace(/\\s+/g,' ').trim();}function vis(e){var r=e.getBoundingClientRect();if(!r.width||!r.height)return false;var cs=getComputedStyle(e);return cs.visibility!=='hidden'&&cs.display!=='none';}var w=norm(want);if(!w)return null;var sels=['[role=option]','[role=menuitem]','[role=treeitem]','li','[class*=option]','[id*=option]','[class*=item]','[class*=suggest]'];for(var pass=0;pass<2;pass++){for(var i=0;i<sels.length;i++){var list=document.querySelectorAll(sels[i]);for(var j=0;j<list.length;j++){var e=list[j];if(!vis(e))continue;var t=norm(e.innerText||e.textContent);if(pass===0?t===w:(t.indexOf(w)===0&&t.length<=w.length+40))return e;}}}return null;}";
const SCROLL_MAX = 25;
// Drag & drop target by text, and the table-cell check (shared with QA Studio).
const DROP_FN = "function(want){function norm(s){return String(s||'').toLowerCase().replace(/\\s+/g,' ').trim();}function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}var w=norm(want);if(!w)return null;var all=document.body.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(vis(e)&&norm(e.innerText)===w)return e;}for(var i=0;i<all.length;i++){var e=all[i];var t=norm(e.innerText);if(vis(e)&&t.indexOf(w)===0&&t.length<=w.length+30)return e;}return null;}";
const TABLE_FN = "function(row,col,want){function n(s){return String(s||'').toLowerCase().replace(/\\s+/g,' ').trim();}var r=n(row),c=n(col),w=n(want);var tables=document.querySelectorAll('table,[role=table],[role=grid]');for(var i=0;i<tables.length;i++){var tb=tables[i];var hs=tb.querySelectorAll('thead th,thead td,[role=columnheader]');if(!hs.length){var fr=tb.querySelector('tr');hs=fr?fr.querySelectorAll('th,td'):[];}var idx=-1;for(var h=0;h<hs.length;h++){if(n(hs[h].innerText)===c){idx=h;break;}}if(idx<0){for(var h=0;h<hs.length;h++){if(c&&n(hs[h].innerText).indexOf(c)>-1){idx=h;break;}}}if(idx<0)continue;var rows=tb.querySelectorAll('tbody tr,[role=row]');for(var k=0;k<rows.length;k++){var tr=rows[k];var cells=tr.querySelectorAll('td,th,[role=cell],[role=gridcell]');if(cells.length<=idx||n(tr.innerText).indexOf(r)<0)continue;if(n(cells[idx].innerText).indexOf(w)>-1)return true;}}return false;}";
// Page-level checks (URL, title, counts, sort, pattern) and remember-and-reuse.
const PAGE_FN = "function(check, value, doc, loc) {\n  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase(); }\n  function shown(el) {\n    var r = el.getBoundingClientRect(), st = doc.defaultView.getComputedStyle(el);\n    return (r.width > 0 || r.height > 0) && st.visibility !== 'hidden' && st.display !== 'none';\n  }\n  function cmp(n, want, op) { return op === 'gte' ? n >= want : op === 'lte' ? n <= want : n === want; }\n  function bodyRows(tb) {\n    var rows = [];\n    if (tb.tBodies.length) { for (var b = 0; b < tb.tBodies.length; b++) rows = rows.concat([].slice.call(tb.tBodies[b].rows)); }\n    else rows = [].slice.call(tb.rows).slice(1);\n    return rows.filter(function (r) { return shown(r) && !r.querySelector('th'); });\n  }\n  var parts = String(value == null ? '' : value).split('|');\n  if (check === 'url') {\n    var href = String(loc.href), want = parts.slice(1).join('|');\n    if (parts[0] === 'is') return href.replace(/\\/+$/, '').toLowerCase() === want.replace(/\\/+$/, '').toLowerCase();\n    return href.toLowerCase().indexOf(want.toLowerCase()) >= 0;\n  }\n  if (check === 'title') {\n    var t = norm(doc.title), w = norm(parts.slice(1).join('|'));\n    return parts[0] === 'is' ? t === w : t.indexOf(w) >= 0;\n  }\n  if (check === 'count') {\n    if (parts[0] === 'rows') {\n      var want = parseInt(parts[1], 10), op = parts[2], tables = [].slice.call(doc.querySelectorAll('table')).filter(shown);\n      if (tables.length) return tables.some(function (tb) { return cmp(bodyRows(tb).length, want, op); });\n      var grid = [].slice.call(doc.querySelectorAll('[role=row]')).filter(function (r) { return shown(r) && !r.querySelector('[role=columnheader]'); });\n      return cmp(grid.length, want, op);\n    }\n    var text = norm(parts[1]), n = 0;\n    [].forEach.call(doc.querySelectorAll('body *'), function (el) {\n      if (norm(el.textContent) !== text || !shown(el)) return;\n      for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (norm(c.textContent) === text) return;\n      n++;\n    });\n    return cmp(n, parseInt(parts[2], 10), parts[3]);\n  }\n  if (check === 'sorted') {\n    var col = norm(parts[0]), dir = parts[1] === 'desc' ? -1 : 1, found = false, ok = false;\n    [].forEach.call(doc.querySelectorAll('table'), function (tb) {\n      if (found || !shown(tb)) return;\n      var head = tb.tHead && tb.tHead.rows.length ? tb.tHead.rows[0] : tb.rows[0];\n      if (!head) return;\n      var idx = -1;\n      [].forEach.call(head.cells, function (c, i) { if (idx < 0 && norm(c.textContent).indexOf(col) >= 0) idx = i; });\n      if (idx < 0) return;\n      found = true;\n      var vals = bodyRows(tb).map(function (r) { return r.cells[idx] ? r.cells[idx].textContent.trim() : ''; });\n      var num = vals.length > 0 && vals.every(function (v) { return v !== '' && !isNaN(parseFloat(v.replace(/[^0-9.\\-]/g, ''))); });\n      ok = true;\n      for (var i = 1; i < vals.length; i++) {\n        var a = vals[i - 1], b = vals[i];\n        var d = num ? parseFloat(a.replace(/[^0-9.\\-]/g, '')) - parseFloat(b.replace(/[^0-9.\\-]/g, ''))\n          : a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });\n        if (d * dir > 0) { ok = false; break; }\n      }\n    });\n    return found && ok;\n  }\n  if (check === 'pattern') {\n    try { return new RegExp(String(value)).test(doc.body ? doc.body.innerText : ''); } catch (e) { return false; }\n  }\n  if (check === 'attr') {\n    var nm = parts[0], attr = parts[1] || '', op = parts[2] || 'contains', wantA = norm(parts.slice(3).join('|'));\n    var cands = [];\n    if (/^[#.\\[]/.test(nm)) { try { cands = [].slice.call(doc.querySelectorAll(nm)); } catch (e) { cands = []; } }\n    if (!cands.length) {\n      var key = norm(nm);\n      cands = [].slice.call(doc.querySelectorAll('a,button,img,input,select,textarea,label,option,[role],[id],[name],[title],[aria-label]'))\n        .filter(function (el) {\n          return [el.textContent, el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),\n                  el.getAttribute('placeholder'), el.getAttribute('value'), el.id, el.getAttribute('name'),\n                  el.labels && el.labels[0] ? el.labels[0].textContent : null]\n            .some(function (x) { return x != null && norm(x) === key; });\n        });\n    }\n    return cands.some(function (el) {\n      var v = el.getAttribute(attr);\n      if (op === 'absent') return v == null;\n      if (op === 'present') return v != null;\n      // No such attribute: a DOM property of that name (naturalWidth, checked\u2026).\n      if (v == null && attr && el[attr] != null && typeof el[attr] !== 'object' && typeof el[attr] !== 'function') v = String(el[attr]);\n      if (v == null) return false;\n      var a = norm(v);\n      return op === 'is' ? a === wantA : op === 'not' ? a.indexOf(wantA) < 0 : a.indexOf(wantA) >= 0;\n    });\n  }\n  if (check === 'page') {\n    // The current page of a pagination bar: aria-current / active item, or ?page=N.\n    var pg = norm(value), boxes = [].slice.call(doc.querySelectorAll(\n      '[class*=paginat i],[class*=pager i],[aria-label*=paginat i],[id*=paginat i],nav,[role=navigation]'));\n    var cur = boxes.some(function (b) {\n      return [].slice.call(b.querySelectorAll('[aria-current],.active,.current,.selected,[class*=active],[class*=current]'))\n        .some(function (el) {\n          if (el.getAttribute('aria-current') === 'false') return false;\n          var t = norm(el.innerText || el.textContent);\n          return t === pg || t === 'page ' + pg || norm(el.getAttribute('aria-label')) === 'page ' + pg;\n        });\n    });\n    return cur || new RegExp('[?&](?:page|p|pg)=' + pg + '(?:&|#|$)', 'i').test(String(loc.href));\n  }\n  if (check === 'storage') {\n    // 'local|token|is|abc', 'session|cart|contains|2', 'local|token|exists', 'local|token|absent'\n    var store = doc.defaultView[parts[0] === 'session' ? 'sessionStorage' : 'localStorage'];\n    var sv = store.getItem(parts[1] || ''), sop = parts[2] || 'exists', swant = norm(parts.slice(3).join('|'));\n    if (sop === 'absent') return sv == null || sv === '';\n    if (sv == null) return false;\n    return sop === 'exists' ? true : sop === 'is' ? norm(sv) === swant : norm(sv).indexOf(swant) >= 0;\n  }\n  if (check === 'cookie') {\n    // Script-visible cookies only; the frameworks read cookies natively (HttpOnly too).\n    var cname = parts[0], cop = parts[1] || 'exists', cwant = norm(parts.slice(2).join('|')), cval = null;\n    String(doc.cookie || '').split(';').forEach(function (c) {\n      var i = c.indexOf('='), k = c.slice(0, i).trim();\n      if (k === cname) cval = decodeURIComponent(c.slice(i + 1).trim());\n    });\n    if (cop === 'absent') return cval == null;\n    if (cval == null) return false;\n    return cop === 'exists' ? true : cop === 'is' ? norm(cval) === cwant : norm(cval).indexOf(cwant) >= 0;\n  }\n  return false;\n}";
const REMEMBER_FN = "function(pattern, doc) {\n  try {\n    var m = new RegExp(String(pattern)).exec(doc.body ? doc.body.innerText : '');\n    return m ? String(m[1] !== undefined ? m[1] : m[0]).trim() : '';\n  } catch (e) { return ''; }\n}";
// API steps, one-time codes ({{OTP}}) and accessibility checks (axe-core).
const API_FN = "function(status, body, check, spec) {\n  function field(raw, path) {\n    var o;\n    try { o = JSON.parse(String(raw)); } catch (e) { return null; }\n    var p = String(path || '').trim().replace(/^\\$\\.?/, '');\n    var parts = p ? p.replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(function (x) { return x !== ''; }) : [];\n    for (var i = 0; i < parts.length; i++) {\n      if (o === null || typeof o !== 'object' || !(parts[i] in o)) return null;\n      o = o[parts[i]];\n    }\n    if (o === undefined) return null;\n    if (o === null) return 'null';\n    return typeof o === 'object' ? JSON.stringify(o) : String(o);\n  }\n  var s = String(spec == null ? '' : spec);\n  if (check === 'field') return field(body, s);\n  if (check === 'api_status') {\n    var want = s.trim().toLowerCase();\n    return /^\\dxx$/.test(want) ? String(status).charAt(0) === want.charAt(0) : String(status) === want;\n  }\n  var p = s.split('|');\n  if (p[0] === 'contains') {\n    return String(body == null ? '' : body).toLowerCase().indexOf(p.slice(1).join('|').toLowerCase()) >= 0;\n  }\n  if (p[0] === 'field') {\n    var v = field(body, p[1] || ''), op = p[2] || 'exists', w = p.slice(3).join('|');\n    if (op === 'absent') return v === null;\n    if (v === null) return false;\n    if (op === 'exists') return true;\n    if (op === 'is') return v.trim() === w.trim();\n    return v.toLowerCase().indexOf(w.toLowerCase()) >= 0;\n  }\n  return false;\n}";
const TOTP_FN = "function(secret, nowMs) {\n  var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = '', key = [], msg = [], i;\n  var s = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');\n  if (!s) return '';\n  for (i = 0; i < s.length; i++) bits += ('00000' + alpha.indexOf(s.charAt(i)).toString(2)).slice(-5);\n  for (i = 0; i + 8 <= bits.length; i += 8) key.push(parseInt(bits.substr(i, 8), 2));\n  var t = Math.floor((nowMs == null ? Date.now() : nowMs) / 30000);\n  for (i = 7; i >= 0; i--) { msg[i] = t % 256; t = Math.floor(t / 256); }\n  function sha1(bytes) {\n    var h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];\n    var m = bytes.slice(), len = bytes.length * 8, w = [], j, x;\n    m.push(0x80);\n    while (m.length % 64 !== 56) m.push(0);\n    for (j = 7; j >= 0; j--) m.push(j >= 4 ? 0 : (len >>> (j * 8)) & 255);\n    for (var off = 0; off < m.length; off += 64) {\n      for (x = 0; x < 16; x++) {\n        w[x] = (m[off + 4 * x] << 24) | (m[off + 4 * x + 1] << 16) | (m[off + 4 * x + 2] << 8) | m[off + 4 * x + 3];\n      }\n      for (x = 16; x < 80; x++) { var r = w[x - 3] ^ w[x - 8] ^ w[x - 14] ^ w[x - 16]; w[x] = (r << 1) | (r >>> 31); }\n      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];\n      for (x = 0; x < 80; x++) {\n        var f, k;\n        if (x < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }\n        else if (x < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }\n        else if (x < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }\n        else { f = b ^ c ^ d; k = 0xCA62C1D6; }\n        var tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[x]) | 0;\n        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;\n      }\n      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;\n    }\n    var out = [];\n    for (j = 0; j < 5; j++) out.push((h[j] >>> 24) & 255, (h[j] >>> 16) & 255, (h[j] >>> 8) & 255, h[j] & 255);\n    return out;\n  }\n  if (key.length > 64) key = sha1(key);\n  while (key.length < 64) key.push(0);\n  var ipad = key.map(function (v) { return v ^ 0x36; }), opad = key.map(function (v) { return v ^ 0x5c; });\n  var mac = sha1(opad.concat(sha1(ipad.concat(msg)))), o = mac[19] & 15;\n  var code = (((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1000000;\n  return ('000000' + code).slice(-6);\n}";
const A11Y_RUN_FN = "function(done) {\n  if (!window.axe) { done('ERR:axe-core is not loaded'); return; }\n  window.axe.run(document, { resultTypes: ['violations'] }).then(function (r) {\n    done(JSON.stringify(r.violations.map(function (v) {\n      return { id: v.id, impact: v.impact || 'minor', nodes: v.nodes.length, help: v.help };\n    })));\n  }, function (e) { done('ERR:' + e); });\n}";
const A11Y_FAILS_FN = "function(json, level) {\n  var rank = { minor: 1, moderate: 2, serious: 3, critical: 4 }, list;\n  var min = rank[String(level || 'serious').toLowerCase()] || 3;\n  if (String(json).indexOf('ERR:') === 0) return 'accessibility scan failed: ' + String(json).slice(4, 160);\n  try { list = JSON.parse(String(json)); } catch (e) { return 'accessibility scan failed'; }\n  return list.filter(function (v) { return (rank[v.impact] || 1) >= min; }).map(function (v) {\n    return v.id + ' (' + v.impact + ', ' + v.nodes + ' element' + (v.nodes === 1 ? '' : 's') + ')';\n  }).join(', ');\n}";
// Visual checks: screenshot vs visual-baselines/<test>-<name>-<browser>.png.
const VISUAL_PREP_FN = "function(ignore, on) {\n  var d = document, st = d.__qaVisual;\n  if (st) {\n    st.hidden.forEach(function (h) { h[0].style.setProperty('visibility', h[1], h[2]); });\n    if (st.sheet) d.adoptedStyleSheets = d.adoptedStyleSheets.filter(function (s) { return s !== st.sheet; });\n    if (st.tag && st.tag.parentNode) st.tag.parentNode.removeChild(st.tag);\n    d.__qaVisual = null;\n  }\n  if (!on) return true;\n  st = d.__qaVisual = { hidden: [], sheet: null, tag: null };\n  var css = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';\n  try {\n    st.sheet = new CSSStyleSheet();\n    st.sheet.replaceSync(css);\n    d.adoptedStyleSheets = d.adoptedStyleSheets.concat([st.sheet]);\n  } catch (e) {\n    st.sheet = null;\n    st.tag = d.createElement('style');\n    st.tag.textContent = css;\n    (d.head || d.documentElement).appendChild(st.tag);\n  }\n  if (ignore) {\n    var els = [];\n    try { els = d.querySelectorAll(ignore); } catch (e) { els = []; }\n    Array.prototype.forEach.call(els, function (el) {\n      st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);\n      el.style.setProperty('visibility', 'hidden', 'important');\n    });\n  }\n  try { if (d.activeElement && d.activeElement.blur) d.activeElement.blur(); } catch (e) { /* nothing focused */ }\n  return true;\n}";
const VISUAL_CMP_FN = "function(wasB64, nowB64, maxPct, delta, done) {\n  function bitmap(b64) {\n    var bin = atob(b64), bytes = new Uint8Array(bin.length);\n    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n    return createImageBitmap(new Blob([bytes], { type: 'image/png' }));\n  }\n  function pixels(img) {\n    var c = document.createElement('canvas');\n    c.width = img.width; c.height = img.height;\n    var x = c.getContext('2d');\n    x.drawImage(img, 0, 0);\n    return x.getImageData(0, 0, img.width, img.height).data;\n  }\n  Promise.all([bitmap(wasB64), bitmap(nowB64)]).then(function (imgs) {\n    var a = imgs[0], b = imgs[1];\n    if (a.width !== b.width || a.height !== b.height) {\n      done({ ok: false, pct: 100, diff: '', note: 'the screenshot size changed from ' + a.width + 'x' + a.height\n        + ' to ' + b.width + 'x' + b.height + ' (a different window size?)' });\n      return;\n    }\n    var pa = pixels(a), pb = pixels(b), n = 0, out = new Uint8ClampedArray(pb.length);\n    for (var i = 0; i < pb.length; i += 4) {\n      var dd = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));\n      if (dd > delta) { n++; out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; }\n      else { out[i] = out[i + 1] = out[i + 2] = 170 + (pb[i] + pb[i + 1] + pb[i + 2]) / 9; }\n      out[i + 3] = 255;\n    }\n    var pct = 100 * n / (pb.length / 4), ok = pct <= Number(maxPct);\n    if (ok || !n) { done({ ok: ok, pct: pct, diff: '', note: '' }); return; }\n    var c = document.createElement('canvas');\n    c.width = b.width; c.height = b.height;\n    c.getContext('2d').putImageData(new ImageData(out, b.width, b.height), 0, 0);\n    done({ ok: false, pct: pct, diff: c.toDataURL('image/png').split(',')[1], note: '' });\n  }).catch(function (e) { done({ ok: false, pct: 100, diff: '', note: 'could not compare the screenshots: ' + e }); });\n}";
const VISUAL_MAX = 1.0;
const VISUAL_DELTA = 32;
const qaApiFn = (...a) => (new Function('return ' + API_FN)())(...a);
const qaTotp = (secret) => (new Function('return ' + TOTP_FN)())(secret);
const qaA11yFails = (raw, level) => (new Function('return ' + A11Y_FAILS_FN)())(raw, level);
// "Close X if it is shown" (pop-ups, ads, cookie banners).
const DISMISS_FN = "function(name, doc) {\n  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase(); }\n  function shown(el) {\n    var r = el.getBoundingClientRect(), st = doc.defaultView.getComputedStyle(el);\n    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';\n  }\n  var want = norm(name);\n  var words = want ? [want] : ['close', 'dismiss', 'no thanks', 'not now', 'accept', 'accept all', 'got it', 'ok', '\\u00d7', 'x'];\n  var scope = want ? [doc] : [].slice.call(doc.querySelectorAll(\n    '[role=dialog],[aria-modal=true],.modal,.popup,.overlay,[class*=cookie],[id*=cookie],[class*=consent],[id*=consent],[class*=banner]'))\n    .filter(shown);\n  for (var w = 0; w < words.length; w++) {\n    for (var s = 0; s < scope.length; s++) {\n      var els = [].slice.call(scope[s].querySelectorAll(\n        'button,a,[role=button],input[type=button],input[type=submit],.close,.btn-close,[data-dismiss],[data-bs-dismiss],[aria-label]'));\n      for (var i = 0; i < els.length; i++) {\n        var el = els[i];\n        if (!shown(el)) continue;\n        var labels = [el.innerText || el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.value];\n        if (labels.some(function (x) { return x != null && norm(x) === words[w]; })) {\n          el.click();\n          return String(el.innerText || el.getAttribute('aria-label') || words[w]).trim() || words[w];\n        }\n      }\n    }\n  }\n  return '';\n}";
// Wait-and-scroll before every action, pagination and storage steps (the same
// scripts QA Studio's inspection uses).
const READY_FN = "function(el, mode) {\n  if (!el || !el.isConnected) return 'gone|';\n  var doc = el.ownerDocument, win = doc.defaultView;\n  var r = el.getBoundingClientRect(), cs = win.getComputedStyle(el);\n  var box = [r.left, r.top, r.width, r.height].map(Math.round).join(',');\n  if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') return 'hidden|' + box;\n  if (mode !== 'view' && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return 'disabled|' + box;\n  var vw = win.innerWidth || doc.documentElement.clientWidth, vh = win.innerHeight || doc.documentElement.clientHeight;\n  if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {\n    el.scrollIntoView({ block: 'center', inline: 'nearest' });\n    return 'offscreen|' + box;\n  }\n  if (mode !== 'click') return 'ok|' + box;\n  var x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);\n  var t = doc.elementFromPoint(x, y);\n  while (t && t.shadowRoot && t.shadowRoot.elementFromPoint) {\n    var inner = t.shadowRoot.elementFromPoint(x, y);\n    if (!inner || inner === t) break;\n    t = inner;\n  }\n  if (t && t !== el && !el.contains(t) && !t.contains(el)) {\n    var lb = el.labels && el.labels.length ? el.labels[0] : null;\n    if (!(lb && (lb === t || lb.contains(t)))) return 'covered|' + box;\n  }\n  return 'ok|' + box;\n}";
const SCROLL_PAGE_FN = "function(reset, doc) {\n  var se = doc.scrollingElement || doc.documentElement, box = se, win = doc.defaultView;\n  if (se.scrollHeight - se.clientHeight < 2) {\n    var best = null, room = 1, all = doc.querySelectorAll('body *');\n    for (var i = 0; i < all.length; i++) {\n      var n = all[i], d = n.scrollHeight - n.clientHeight;\n      if (d > room && n.clientHeight > 100) {\n        var o = win.getComputedStyle(n).overflowY;\n        if (o === 'auto' || o === 'scroll') { best = n; room = d; }\n      }\n    }\n    if (best) box = best;\n  }\n  if (reset) { box.scrollTop = 0; return 'top'; }\n  var before = box.scrollTop;\n  box.scrollTop = before + Math.max(200, Math.round((box === se ? win.innerHeight : box.clientHeight) * 0.85));\n  return box.scrollTop <= before + 1 ? 'end' : 'moved';\n}";
const PAGINATE_FN = "function(what, doc) {\n  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase(); }\n  function shown(el) {\n    var r = el.getBoundingClientRect(), st = doc.defaultView.getComputedStyle(el);\n    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';\n  }\n  function off(el) {\n    var li = el.closest ? el.closest('li') : null;\n    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' ||\n      /(^|\\s)disabled(\\s|$)/.test(String(el.className || '') + ' ' + String(li ? li.className : '')));\n  }\n  var w = norm(what);\n  var boxSel = '[class*=paginat i],[class*=pager i],[aria-label*=paginat i],[id*=paginat i],[class*=page-nav i],nav,[role=navigation]';\n  var all = [].slice.call(doc.querySelectorAll('a,button,[role=button],[role=link],input[type=button],input[type=submit]'))\n    .filter(shown);\n  function inBox(el) { try { return !!el.closest(boxSel); } catch (e) { return false; } }\n  function label(el) { return norm(el.innerText || el.textContent || el.value); }\n  var NEXT = ['next', 'next page', 'next \u203a', 'next \u00bb', '\u203a', '\u00bb', '>', '\u2192', 'next >', 'older'];\n  var PREV = ['previous', 'prev', 'previous page', '\u2039 previous', '\u00ab previous', '\u2039', '\u00ab', '<', '\u2190', 'newer'];\n  var hits;\n  if (w === 'next' || w === 'prev') {\n    var words = w === 'next' ? NEXT : PREV, rel = w === 'next' ? 'next' : 'prev';\n    hits = all.filter(function (el) {\n      var aria = norm(el.getAttribute('aria-label') || el.getAttribute('title'));\n      return norm(el.getAttribute('rel')) === rel || words.indexOf(label(el)) >= 0 ||\n        (aria && aria.indexOf(w === 'next' ? 'next' : 'prev') >= 0);\n    });\n  } else {\n    hits = all.filter(function (el) { return label(el) === w || norm(el.getAttribute('aria-label')) === 'page ' + w; });\n  }\n  hits.sort(function (a, b) { return (inBox(b) ? 1 : 0) - (inBox(a) ? 1 : 0); });\n  if (!hits.length) return '';\n  var el = hits[0];\n  if (off(el)) return 'end';\n  el.scrollIntoView({ block: 'center' });\n  el.click();\n  return label(el) || w;\n}";
const STORAGE_FN = "function(op, area, key, value, win) {\n  var areas = area === 'all' ? ['localStorage', 'sessionStorage']\n    : [area === 'session' ? 'sessionStorage' : 'localStorage'];\n  areas.forEach(function (a) {\n    if (op === 'clear') win[a].clear(); else win[a].setItem(key, value);\n  });\n  return true;\n}";
const SCROLL_SEARCH_STEPS = 15;
const PAGINATE_MAX = 20;
const READY = {"wait": 8000, "disabled": 10000, "covered": 3000};
// click: enabled + not covered; input: enabled; view: shown; null: no wait.
function readyMode(verb) {
  const v = String(verb || 'click');
  if (['upload', 'frame', 'navigate', 'wait', 'scroll_to'].includes(v)) return null;
  if (['type', 'clear', 'key_press'].includes(v)) return 'input';
  return v === 'set_value' ? 'view' : 'click';
}
function _n(s) { return String(s == null ? '' : s).trim().replace(/ +/g, ' ').toLowerCase(); }
function cookieOk(value, spec) {
  const p = String(spec || '').split('|');
  const op = p[1] || 'exists', want = _n(p.slice(2).join('|'));
  if (op === 'absent') return value == null;
  if (value == null) return false;
  let v = String(value);
  try { v = decodeURIComponent(v); } catch (e) {}
  v = _n(v);
  return op === 'exists' ? true : op === 'is' ? v === want : v.indexOf(want) >= 0;
}

// Real functions (sent to the browser by Playwright's evaluate).
const READY_F = new Function('return ' + READY_FN)();
const SCROLL_F = new Function('return function (html, reset) { return (' + SCROLL_PAGE_FN + ')(reset, html.ownerDocument); }')();

// QA Studio key names (ENTER, ARROWUP…) → Playwright key names (Enter, ArrowUp…).
const _PW_KEYS = { ENTER: 'Enter', ESCAPE: 'Escape', ESC: 'Escape', TAB: 'Tab', SPACE: 'Space',
  BACKSPACE: 'Backspace', DELETE: 'Delete', ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight', HOME: 'Home', END: 'End',
  PAGEUP: 'PageUp', PAGEDOWN: 'PageDown' };
function pwKey(value) {
  // 'CONTROL+A' -> 'Control+a', 'SHIFT+TAB' -> 'Shift+Tab', 'ENTER' -> 'Enter'.
  const mods = { CONTROL: 'Control', CTRL: 'Control', SHIFT: 'Shift', ALT: 'Alt', META: 'Meta', CMD: 'Meta' };
  return String(value || 'Enter').split('+').map((p) => {
    const k = p.trim().toUpperCase().replace(/[_\s]/g, '');
    if (mods[k]) return mods[k];
    if (_PW_KEYS[k]) return _PW_KEYS[k];
    return k.length === 1 ? k.toLowerCase() : p.trim();
  }).join('+');
}

// Data-driven runs: {{name}} placeholders take the current data row's value;
// {{random.email}}, {{random.number}}, {{random.text}}, {{today}}, {{today+3d}}
// and {{now}} are generated once per test. Unknown placeholders stay as written.
function qaDataKey(n) { return String(n || '').toLowerCase().replace(/[^0-9a-z]+/g, '_').replace(/^_+|_+$/g, ''); }
function qaDataFill(text, values, cache) {
  if (text == null || String(text).indexOf('{{') === -1) return text;
  const vals = {};
  Object.keys(values || {}).forEach((k) => { vals[qaDataKey(k)] = values[k]; });
  return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, raw) => {
    const key = qaDataKey(raw);
    if (key === 'app_user') return process.env.APP_USER || all;
    if (key === 'app_pass') return process.env.APP_PASS || all;
    if (Object.prototype.hasOwnProperty.call(vals, key)) return String(vals[key]);
    if (key === 'otp') {
      // The current authenticator code, computed when the value is typed.
      const secret = (typeof Cypress !== 'undefined' && Cypress.env('OTP_SECRET')) ||
        (typeof process !== 'undefined' && process.env && process.env.OTP_SECRET) || '';
      const code = qaTotp(secret);
      if (!code) throw new Error('OTP_SECRET is not set: add the authenticator secret (Base32) to .env.');
      return code;
    }
    const g = String(raw).toLowerCase().replace(/\s+/g, '');
    if (cache[g] != null) return cache[g];
    let v = null;
    if (g === 'random.email') v = 'qa.' + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
    else if (g === 'random.number') v = String(100000 + Math.floor(Math.random() * 900000));
    else if (g === 'random.text') v = 'QA ' + Math.random().toString(36).slice(2, 8);
    else if (g === 'now') v = String(Date.now());
    else {
      const m = g.match(/^today(?:([+-])(\d+)d)?$/);
      if (m) { const d = new Date(); d.setDate(d.getDate() + (m[1] === '-' ? -1 : 1) * Number(m[2] || 0)); v = d.toISOString().slice(0, 10); }
    }
    if (v == null) return all;
    cache[g] = v;
    return v;
  });
}

// axe-core for accessibility checks: AXE_SOURCE (file or URL), the axe-core
// package (npm install), a cached download, else the CDN.
let __qaAxeSrc = null;
async function qaAxeSource() {
  if (__qaAxeSrc) return __qaAxeSrc;
  const fs = require('fs'), path = require('path'), os = require('os');
  const want = String(process.env.AXE_SOURCE || '').trim();
  const cache = path.join(os.tmpdir(), 'qa-axe-4.10.2.min.js');
  if (want && fs.existsSync(want)) return (__qaAxeSrc = fs.readFileSync(want, 'utf8'));
  if (!want) {
    try { return (__qaAxeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')); } catch (e) { /* not installed */ }
    if (fs.existsSync(cache)) return (__qaAxeSrc = fs.readFileSync(cache, 'utf8'));
  }
  const res = await fetch(want || 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js');
  if (!res.ok) throw new Error('axe-core download failed (HTTP ' + res.status + ')');
  __qaAxeSrc = await res.text();
  if (!want) { try { fs.writeFileSync(cache, __qaAxeSrc); } catch (e) { /* read-only temp */ } }
  return __qaAxeSrc;
}

class Healer {
  constructor(page) { this.page = page; this.scope = page; this.store = load(); this.pendingPopup = null; this.data = {}; this.dataCache = {}; }

  // Data-driven test: the current row's values (see qaDataFill).
  useData(values) { this.data = values || {}; this.dataCache = {}; }
  fill(text) { return qaDataFill(text, this.data, this.dataCache); }

  async pickOption(text) {
    const end = Date.now() + 8000;
    do {
      const h = await this.page.evaluateHandle('(' + PICK_FN + ')(' + JSON.stringify(String(text)) + ')');
      const opt = h.asElement();
      if (opt) { await opt.click(); return; }
      await this.page.waitForTimeout(250);
    } while (Date.now() < end);
    throw new Error('Option "' + text + '" did not appear after opening the list');
  }

  // Infinite scroll / lazy load: scroll down until the step's element exists.
  async scrollTo(key, seed, intent) {
    const specs = [this.store[key], seed].concat((seed && seed.fallbacks) || []).filter(Boolean);
    for (let i = 0; i < SCROLL_MAX; i++) {
      for (const spec of specs) {
        if (await this._ok(spec, 500)) {
          try { await this._loc(spec).scrollIntoViewIfNeeded(); } catch (e) {}
          return;
        }
      }
      await this.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await this.page.waitForTimeout(1200);
    }
    await this.resolve(key, seed, intent);   // last chance: AI healing, or a clear failure
  }

  _loc(spec) { return this.scope.locator(toSelector(spec)).first(); }

  // Waits up to `ms` for the locator to be attached (count() alone never
  // waits, so a not-yet-rendered element went straight to AI healing).
  async _ok(spec, ms) {
    try {
      await this.scope.locator(toSelector(spec)).first().waitFor({ state: 'attached', timeout: ms || 0 });
      return true;
    } catch (e) { return false; }
  }

  // Order (same as the Selenium Healer): page load once -> saved locator
  // (short probe when a seed can back it up) -> seed (full wait) -> the
  // explorer's PROVEN fallbacks -> AI only as the last resort.
  async resolve(key, seed, intent) {
    try { await this.page.waitForLoadState('load', { timeout: 12000 }); } catch (e) {}
    const cached = this.store[key];
    if (cached && await this._ok(cached, seed ? 2000 : 12000)) return this._loc(cached);
    if (seed && await this._ok(seed, 12000)) return this._loc(seed);
    for (const fb of (seed && seed.fallbacks) || []) {
      if (await this._ok(fb, 2000)) return this._loc(fb);
    }
    // Lazy-loaded further down the page: scroll until it shows.
    const scrolled = await this._scrollSearch([cached, seed].concat((seed && seed.fallbacks) || []).filter(Boolean));
    if (scrolled) return scrolled;
    if (HEAL) {
      console.log('[heal] resolving ' + key + ' via AI (' + PROVIDER + ')');
      let dom = '[]';
      // ``scope`` is a Page at top level and a FrameLocator after enterFrame.
      // Both expose locator(), whereas FrameLocator has no page-level evaluate.
      try { dom = JSON.stringify(await this.scope.locator('html').evaluate(HARVEST_EXPR)); } catch (e) {}
      const picked = await pickLocator(intent, dom);
      if (picked && await this._ok(picked, 2000)) {
        this.store[key] = { by: picked.by, value: picked.value, source: 'healed',
                            resolvedAt: new Date().toISOString(), provider: PROVIDER };
        save(this.store, key);
        console.log('[heal] ' + key + ' -> ' + picked.by + '=' + picked.value);
        return this._loc(picked);
      }
    }
    // Honest failure message: "Set QA_AI_API_KEY" is only the cure when
    // healing was actually DISABLED — with a key set, this line used to blame
    // the key for what was really a transient AI/network failure or an
    // element that genuinely isn't on this page (confirmed live).
    throw new Error('Could not resolve step ' + key + (HEAL
      ? ' — cached/seed locators matched nothing and the AI heal attempt '
        + 'failed or found no match (see [heal] lines above; the element may '
        + 'not exist on this page at all).'
      : '. Set QA_AI_API_KEY to enable AI healing.'));
  }

  async _scrollStep(reset) {
    return this.scope.locator('html').evaluate(SCROLL_F, reset);
  }

  // Scroll down step by step until one of the locators matches; back to the top if not.
  async _scrollSearch(specs) {
    if (!specs.length) return null;
    for (let i = 0; i < SCROLL_SEARCH_STEPS; i++) {
      let moved;
      try { moved = await this._scrollStep(false); } catch (e) { return null; }
      await this.page.waitForTimeout(moved === 'end' ? 1100 : 350);
      for (const spec of specs) {
        if (await this._ok(spec, 200)) {
          console.log('[wait] found ' + (spec.value || '') + ' after scrolling the page');
          return this._loc(spec);
        }
      }
      if (moved === 'end') {
        try { if ((await this._scrollStep(false)) === 'end') break; } catch (e) { break; }
      }
    }
    try { await this._scrollStep(true); } catch (e) {}
    return null;
  }

  // Before an action: visible, centred, enabled, not moving and (for clicks)
  // not covered. Never throws - after the limit the action runs anyway.
  async _ready(el, verb) {
    const mode = readyMode(verb);
    try { await el.waitFor({ state: mode ? 'visible' : 'attached', timeout: READY.wait }); } catch (e) {}
    try { await el.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (e) {}
    if (!mode) return;
    const start = Date.now();
    let last = null;
    for (;;) {
      let raw = 'ok|';
      try { raw = String(await el.evaluate(READY_F, mode)); } catch (e) { return; }
      const state = raw.split('|')[0], box = raw.slice(state.length + 1);
      if (state === 'gone' || (state === 'ok' && box === last)) return;
      last = state === 'ok' ? box : null;
      const limit = state === 'disabled' ? READY.disabled : state === 'covered' ? READY.covered : READY.wait;
      if (Date.now() - start > limit) {
        console.log('[wait] element still ' + state + ' after ' + Math.round(limit / 1000) + ' s - acting anyway');
        return;
      }
      await this.page.waitForTimeout(150);
    }
  }

  async act(key, verb, seed, intent, value) {
    if (verb === 'navigate' || verb === 'wait') return;
    if (verb === 'scroll_to') return this.scrollTo(key, seed, intent);
    const el = await this.resolve(key, seed, intent);
    await this._ready(el, verb);
    switch (verb) {
      case 'type':   await el.fill(value == null ? '' : String(value)); break;
      case 'select': {
        const opts = String(value == null ? '' : value).split(';').map((o) => o.trim()).filter(Boolean);
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption(opts.length > 1 ? opts.map((label) => ({ label })) : { label: String(value) });
        } else {
          // Custom dropdown: open the trigger, then pick the option by its text.
          await el.click();
          await this.pickOption(String(value));
        }
        break;
      }
      case 'drag': {
        // Drop target = the element showing `value`; dragTo covers both mouse-
        // driven (jQuery UI, sortable lists) and HTML5 draggable items.
        let target = null;
        const end = Date.now() + 8000;
        while (!target && Date.now() < end) {
          target = (await this.page.evaluateHandle('(' + DROP_FN + ')(' + JSON.stringify(String(value)) + ')')).asElement();
          if (!target) await this.page.waitForTimeout(250);
        }
        if (!target) throw new Error('Drop target "' + value + '" not found');
        // Real mouse down / move / up: works for mouse-driven widgets and, in
        // Chromium, for HTML5 draggable items too.
        await el.hover();
        await this.page.mouse.down();
        const box = await target.boundingBox();
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
        await this.page.mouse.up();
        await this.page.waitForTimeout(300);
        break;
      }
      case 'autocomplete': {
        const raw = String(value == null ? '' : value);
        const cut = raw.indexOf('=>');
        const typed = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
        const pick = (cut >= 0 ? raw.slice(cut + 2) : raw).trim() || typed;
        await el.click();
        await el.fill('');
        await el.pressSequentially(typed || pick, { delay: 50 });   // real keystrokes fire the suggestions
        await this.pickOption(pick);
        break;
      }
      case 'hover':  await el.hover(); break;
      case 'double_click': await el.dblclick(); break;
      case 'right_click':
        // Fire the page's right-click handlers without the browser's native menu
        // (it cannot be closed from a test and stays open over the page in a
        // headed run). setTimeout lets evaluate return before an alert() opens.
        await el.hover();
        await el.evaluate((n) => {
          const r = n.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 2,
            buttons: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          setTimeout(() => { n.dispatchEvent(new MouseEvent('mousedown', o));
            n.dispatchEvent(new MouseEvent('mouseup', o));
            n.dispatchEvent(new MouseEvent('contextmenu', o)); }, 0);
        });
        await this.page.waitForTimeout(200);
        break;
      case 'set_value':
        // date/time/range/color: set the value and fire input + change
        await el.evaluate((node, v) => {
          const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
          if (d && d.set) d.set.call(node, v); else node.value = v;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value == null ? '' : value));
        break;
      case 'upload': await el.setInputFiles(String(value)); break;
      case 'key_press': await el.press(pwKey(value)); break;
      case 'clear': await el.fill(''); break;
      case 'click':
      default:
        try { await el.click({ timeout: 10000 }); }
        catch (e) {
          // Still blocked (an overlay that never goes away): JavaScript click,
          // like the Selenium tests - only for an element that is really shown.
          if (!(await el.isVisible())) throw e;
          console.log('[wait] click blocked - using a JavaScript click');
          await el.evaluate((n) => n.click());
        }
        break;
    }
  }

  async enterFrame(key, seed, intent) {
    const frame = await (await this.resolve(key, seed, intent)).contentFrame();
    if (!frame) throw new Error('Could not enter frame for ' + key);
    this.scope = frame;
  }

  prepareDialog(action, text) {
    this.page.once('dialog', async dialog => {
      if (action === 'dismiss') await dialog.dismiss();
      else await dialog.accept(text == null ? undefined : String(text));   // prompt answer
    });
  }

  exitFrame() { this.scope = this.page; }

  prepareWindow() {
    this.opener = this.page;
    this.pendingPopup = this.page.context().waitForEvent('page');
  }

  async backToOriginalWindow(closeCurrent) {
    const opener = this.opener || this.page.context().pages()[0];
    if (closeCurrent && this.page !== opener) await this.page.close();
    this.page = opener;
    this.scope = opener;
    await opener.bringToFront();
  }

  // In a table row containing `row`, the column headed `column` shows `expected`.
  /** URL / title / row or text count / column sort / text pattern, retried for 10 s. */
  async assertPage(check, value) {
    const end = Date.now() + 10000;
    if (check === 'api_status' || check === 'api_body') {
      return !!this.lastApi && !!qaApiFn(this.lastApi.status, this.lastApi.body, check, String(value));
    }
    if (check === 'a11y') {
      const bad = await this.accessibilityViolations(value);
      if (bad) throw new Error('Accessibility violations: ' + bad);
      return true;
    }
    if (check === 'visual') {
      const bad = await this.visualDiff(value);
      if (bad) throw new Error('Visual check failed: ' + bad);
      return true;
    }
    if (check === 'cookie') {
      // Read through the browser context, so HttpOnly cookies count too.
      const name = String(value).split('|')[0].trim();
      do {
        const c = (await this.page.context().cookies()).find((k) => k.name === name);
        if (cookieOk(c ? c.value : null, value)) return true;
        await this.page.waitForTimeout(300);
      } while (Date.now() < end);
      return false;
    }
    const args = [check, value].map((v) => JSON.stringify(String(v))).join(',');
    do {
      try {
        if (await this.page.evaluate('(' + PAGE_FN + ')(' + args + ', document, location)')) return true;
      } catch (e) {}
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    return false;
  }

  /** Reads the first page text matching `pattern`; later steps use it as {{name}}. */
  // Back / forward / refresh, and "close X if it is shown" (not a failure when
  // nothing is shown).
  async _paginate(what) {
    const end = Date.now() + 4000;
    let got = '';
    do {
      try { got = await this.page.evaluate('(' + PAGINATE_FN + ')(' + JSON.stringify(String(what)) + ', document)'); }
      catch (e) { got = ''; }
      if (got) return got;
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    return got;
  }

  async _afterPageChange() {
    await this.page.waitForTimeout(800);
    try { await this.page.waitForLoadState('load', { timeout: 10000 }); } catch (e) {}
  }

  // Next page (optionally until `target` is shown) or page number `target`.
  async _pages(verb, target) {
    if (verb === 'go_to_page' || !target) {
      const what = verb === 'go_to_page' ? target : 'next';
      const got = await this._paginate(what);
      if (!got) throw new Error('No "' + what + '" control in the pagination');
      if (got === 'end') throw new Error('Already on the last page');
      await this._afterPageChange();
      return;
    }
    for (let n = 0; n <= PAGINATE_MAX; n++) {
      const txt = await this.page.evaluate(() => (document.body ? document.body.innerText : ''));
      if (normText(txt).indexOf(normText(target)) >= 0) { console.log('[heal] found "' + target + '" on page ' + (n + 1)); return; }
      const got = await this._paginate('next');
      if (!got || got === 'end') throw new Error('"' + target + '" was not found on any page (' + (n + 1) + ' checked)');
      await this._afterPageChange();
    }
    throw new Error('"' + target + '" was not found within ' + PAGINATE_MAX + ' pages');
  }

  async pageAction(verb, value) {
    if (verb === 'next_page' || verb === 'go_to_page') return this._pages(verb, String(this.fill(value) || '').trim());
    if (verb === 'set_cookie') {
      const v = String(this.fill(value) || ''), i = v.indexOf('=');
      const name = (i < 0 ? v : v.slice(0, i)).trim();
      await this.page.context().addCookies([{ name, value: i < 0 ? '' : v.slice(i + 1).trim(), url: this.page.url() }]);
      return;
    }
    if (verb === 'delete_cookies') {
      const ctx = this.page.context(), name = String(value || '').trim();
      if (!name) { await ctx.clearCookies(); return; }
      const keep = (await ctx.cookies()).filter((c) => c.name !== name);
      await ctx.clearCookies();
      if (keep.length) await ctx.addCookies(keep);
      return;
    }
    if (verb === 'set_storage' || verb === 'clear_storage') {
      const p = String(this.fill(value) || '').split('|'), set = verb === 'set_storage';
      const args = [set ? 'set' : 'clear', p[0] || (set ? 'local' : 'all'), p[1] || '', p.slice(2).join('|')];
      await this.page.evaluate('(' + STORAGE_FN + ')(' + args.map((x) => JSON.stringify(x)).join(',') + ', window)');
      return;
    }
    if (verb === 'auth_open') {
      // Basic / digest auth: the browser answers the challenge (password never logged).
      const p = String(this.fill(value) || '').split('|');
      const cur = this.page.url();
      const u = new URL(p[0].trim(), /^https?:/i.test(cur) ? cur : (process.env.APP_BASE_URL || undefined));
      const ctx = this.page.context();
      const user = p[1] || '', pass = p[2] || '';
      // Ask the page which scheme it wants. Basic: send the header on that page
      // only (setHTTPCredentials mid-test is deprecated and was flaky: the
      // browser may reuse an earlier answer). Digest: the browser answers it.
      let www = '';
      try {
        const res = await ctx.request.get(u.toString(), { failOnStatusCode: false, maxRedirects: 0 });
        www = String(res.headers()['www-authenticate'] || '');
      } catch (e) { /* unreachable: try Basic */ }
      if (/^\s*digest/i.test(www) && typeof ctx.setHTTPCredentials === 'function') {
        await ctx.setHTTPCredentials({ username: user, password: pass });
        await this.page.goto(u.toString());
      } else {
        const target = u.origin + u.pathname;
        const header = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
        const handler = (route) => {
          const r = route.request();
          if ((r.url().split('?')[0]) !== target) return route.continue();
          return route.continue({ headers: Object.assign({}, r.headers(), { authorization: header }) });
        };
        await this.page.route('**/*', handler);
        try { await this.page.goto(u.toString()); }
        finally { await this.page.unroute('**/*', handler); }
      }
      console.log('[heal] opened ' + u.origin + u.pathname + ' with HTTP authentication');
      return;
    }
    if (verb === 'api_call') {
      // An API request in the same browser session (its cookies go along).
      const p = String(this.fill(value) || '').split('|');
      const method = (p[0] || 'GET').trim().toUpperCase(), body = p.slice(3).join('|');
      const cur = this.page.url();
      const u = new URL((p[1] || '').trim(), /^https?:/i.test(cur) ? cur : (process.env.APP_BASE_URL || undefined));
      const headers = {};
      String(p[2] || '').split('\n').forEach((h) => {
        const i = h.indexOf(':');
        if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      });
      const opts = { method, headers, failOnStatusCode: false, timeout: 30000 };
      if (body.trim()) {
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = /^[\[{]/.test(body.trim()) ? 'application/json' : 'text/plain';
        }
        opts.data = body;
      }
      const res = await this.page.context().request.fetch(u.toString(), opts);
      this.lastApi = { status: res.status(), body: await res.text() };
      console.log('[heal] ' + method + ' ' + u.pathname + ' -> ' + this.lastApi.status);
      return;
    }
    if (verb === 'go_back') { await this.page.goBack(); return; }
    if (verb === 'go_forward') { await this.page.goForward(); return; }
    if (verb === 'refresh') { await this.page.reload(); return; }
    const end = Date.now() + 4000;
    let got = '';
    do {
      try { got = await this.page.evaluate('(' + DISMISS_FN + ')(' + JSON.stringify(String(value || '')) + ', document)'); }
      catch (e) { got = ''; }
      if (got) break;
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    console.log(got ? '[heal] closed "' + got + '"' : '[heal] nothing to close (not shown)');
  }

  /** 'name|ignore selectors|max %': the visible page against
   *  visual-baselines/<test>-<name>-<browser>.png. The first run (or
   *  UPDATE_BASELINES=true) saves the baseline; a failing check writes a diff
   *  image (changed pixels in red) to test-results/visual-diffs. '' = the same. */
  async visualDiff(value) {
    const fs = require('fs'), path = require('path');
    const p = (String(value || '') + '||').split('|');
    const ignore = p[1].trim(), max = p[2].trim() ? Number(p[2]) : VISUAL_MAX;
    let info = null;
    try { info = require('@playwright/test').test.info(); } catch (e) { info = null; }
    const test = info ? info.title : 'test';
    let name = p[0].trim();
    this.visualCount = this.visualCount || {};
    if (!name) { this.visualCount[test] = (this.visualCount[test] || 0) + 1; name = 'check' + this.visualCount[test]; }
    const browser = info && info.project && info.project.name ? info.project.name : 'browser';
    // The OS is part of the name: fonts draw differently on Windows and on the
    // Linux CI machines, so each keeps its own baseline.
    const key = (test + '-' + name + '-' + browser + '-' + process.platform).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    const rel = (f) => path.relative(process.cwd(), f);
    const basePath = path.resolve('visual-baselines', key + '.png');
    const prep = (on) => '(' + VISUAL_PREP_FN + ')(' + JSON.stringify(ignore) + ', ' + on + ')';
    let shot;
    try {
      try { await this.page.evaluate(prep(true)); await this.page.waitForTimeout(300); } catch (e) { /* page busy */ }
      shot = (await this.page.screenshot({ animations: 'disabled', caret: 'hide' })).toString('base64');
    } finally {
      try { await this.page.evaluate(prep(false)); } catch (e) { /* page gone */ }
    }
    const update = String(process.env.UPDATE_BASELINES || '').trim().toLowerCase() === 'true';
    if (update || !fs.existsSync(basePath)) {
      fs.mkdirSync(path.dirname(basePath), { recursive: true });
      fs.writeFileSync(basePath, Buffer.from(shot, 'base64'));
      console.log('[visual] ' + (update ? 'updated' : 'saved') + ' the baseline ' + rel(basePath)
        + (update ? '' : ' (first run) - later runs compare against it'));
      return '';
    }
    const was = fs.readFileSync(basePath).toString('base64');
    let r;
    try {
      r = await this.page.evaluate('new Promise((done) => (' + VISUAL_CMP_FN + ')('
        + [was, shot, max, VISUAL_DELTA].map((v) => JSON.stringify(v)).join(', ') + ', done))');
    } catch (e) { r = { ok: false, pct: 100, diff: '', note: 'could not compare the screenshots: ' + e.message }; }
    if (r && r.ok) return '';
    let where = '';
    if (r && r.diff) {
      const dir = path.resolve('test-results', 'visual-diffs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, key + '-diff.png'), Buffer.from(r.diff, 'base64'));
      fs.writeFileSync(path.join(dir, key + '-actual.png'), Buffer.from(shot, 'base64'));
      where = ' - diff image: ' + rel(path.join(dir, key + '-diff.png'));
      if (info) {
        try { await info.attach('visual diff', { body: Buffer.from(r.diff, 'base64'), contentType: 'image/png' }); }
        catch (e) { /* no attachments */ }
      }
    }
    const what = r && r.note ? r.note
      : Number(r ? r.pct : 100).toFixed(2) + '% of the page changed (allowed ' + max + '%)';
    return what + ' against ' + rel(basePath) + where + '. Run with UPDATE_BASELINES=true if the change is intended.';
  }

  /** '' when the page passes, else the failing rules ("label (critical, 2 elements)"). */
  async accessibilityViolations(level) {
    try {
      if (!(await this.page.evaluate(() => !!window.axe))) await this.page.evaluate(await qaAxeSource());
      const raw = await this.page.evaluate('new Promise((done) => (' + A11Y_RUN_FN + ')(done))');
      return String(qaA11yFails(raw, String(level || 'serious')) || '');
    } catch (e) { return 'accessibility scan failed: ' + e.message; }
  }

  async remember(pattern, name) {
    if (String(pattern).indexOf('api:') === 0) {
      const field = String(pattern).slice(4);
      const v = this.lastApi ? qaApiFn(this.lastApi.status, this.lastApi.body, 'field', field) : null;
      if (v == null) throw new Error('The last API response has no field ' + field + ' to remember as ' + name);
      this.data = Object.assign({}, this.data || {}, { [name]: v });
      console.log('[heal] remembered ' + name + ' = ' + v);
      return;
    }
    const end = Date.now() + 10000;
    let v = '';
    do {
      try { v = await this.page.evaluate('(' + REMEMBER_FN + ')(' + JSON.stringify(String(pattern)) + ', document)'); } catch (e) { v = ''; }
      if (v) break;
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    if (!v) throw new Error('Nothing on the page matches ' + pattern + ' to remember as ' + name);
    this.data = Object.assign({}, this.data || {}, { [name]: v });
    console.log('[heal] remembered ' + name + ' = ' + v);
  }

  async assertTableCell(row, column, expected) {
    const end = Date.now() + 10000;
    do {
      try {
        const args = [row, column, expected].map((v) => JSON.stringify(String(v))).join(',');
        if (await this.page.evaluate('(' + TABLE_FN + ')(' + args + ')')) return true;
      } catch (e) {}
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    return false;
  }

  // Downloads: listen BEFORE the click that starts it, then check the file name.
  prepareDownload() {
    this.pendingDownload = this.page.waitForEvent('download', { timeout: 20000 });
  }

  async assertDownloaded(name) {
    try {
      const d = await this.pendingDownload;
      this.pendingDownload = null;
      const file = d.suggestedFilename();
      await d.saveAs(require('path').join('downloads', file));
      return file.toLowerCase().includes(String(name).toLowerCase());
    } catch (e) { console.log('[heal] assertDownloaded failed: ' + e.message); return false; }
  }

  async assertValue(key, seed, intent, expected) {
    try {
      const el = await this.resolve(key, seed, intent);
      const want = normText(expected);
      const end = Date.now() + 5000;
      do {
        // An input's value, or the text a custom dropdown shows.
        let shown = '';
        // A native <select> shows its selected option's text, not its value.
        try {
          shown = await el.evaluate((n) => n.tagName === 'SELECT'
            ? Array.from(n.selectedOptions).map((o) => o.text + ' ' + o.value).join(' ')
            : (('value' in n && n.value) || n.innerText || ''));
        } catch (e) { shown = await el.innerText(); }
        if (normText(shown).includes(want)) return true;
        await this.page.waitForTimeout(250);
      } while (Date.now() < end);
      return false;
    } catch (e) { console.log('[heal] assertValue ' + key + ' failed: ' + e.message); return false; }
  }

  async assertInvalid(key, seed, intent) {
    try {
      return await (await this.resolve(key, seed, intent))
        .evaluate((node) => (node.checkValidity ? !node.checkValidity() : false));
    } catch (e) { console.log('[heal] assertInvalid ' + key + ' failed: ' + e.message); return false; }
  }

  async switchWindow() {
    if (!this.pendingPopup) throw new Error('No popup was prepared before window switch');
    this.page = await this.pendingPopup;
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForFunction(() =>
      location.href !== 'about:blank' && !!(document.body && document.body.innerText.trim()));
    this.scope = this.page;
    this.pendingPopup = null;
  }

  // Late content ('Hello World!' after a loading bar): wait up to 10 s for
  // the element to become visible instead of reading its state once.
  async assertVisible(key, seed, intent) {
    try {
      const el = await this.resolve(key, seed, intent);
      await el.waitFor({ state: 'visible', timeout: 10000 });
      return true;
    } catch (e) { console.log('[heal] assertVisible ' + key + ' failed: ' + e.message); return false; }
  }

  async assertVisibleNow(key, seed, intent) {
    // The failure reason is LOGGED, not swallowed: without this, a step that
    // couldn't resolve at all surfaced in the report as a bare
    // "expect(received).toBeTruthy() — received false" with zero hint that
    // the element was never found (vs. found but hidden).
    try { return await (await this.resolve(key, seed, intent)).isVisible(); }
    catch (e) { console.log('[heal] assertVisible ' + key + ' failed: ' + e.message); return false; }
  }

  async assertChecked(key, seed, intent) {
    try { return await (await this.resolve(key, seed, intent)).isChecked(); }
    catch (e) { console.log('[heal] assertChecked ' + key + ' failed: ' + e.message); return false; }
  }

  async assertEnabled(key, seed, intent, enabled) {
    try {
      // Often enabled only after a loading bar: wait up to 10 s.
      const el = await this.resolve(key, seed, intent);
      const end = Date.now() + 10000;
      do {
        if ((await el.isEnabled()) === enabled) return true;
        await this.page.waitForTimeout(250);
      } while (Date.now() < end);
      return false;
    }
    catch (e) { console.log('[heal] assertEnabled ' + key + ' failed: ' + e.message); return false; }
  }

  async assertSelected(key, seed, intent, expected) {
    try {
      // A multi-select can have several checked options; read them all.
      const texts = await (await this.resolve(key, seed, intent)).locator('option:checked').allTextContents();
      return texts.some((t) => normText(t).includes(normText(expected)));
    } catch (e) { console.log('[heal] assertSelected ' + key + ' failed: ' + e.message); return false; }
  }

  async assertHidden(key, seed) {
    // Absence is not a healing problem: retrying an AI locator search after a
    // successful removal could bind a different, still-visible product. Test
    // only the exact locator captured immediately before the removing action.
    if (!seed || !seed.by || !seed.value) return false;
    // Removal is often async (a loading bar first): wait up to 10 s. Any
    // still-visible match counts (isVisible() alone throws on several matches).
    const end = Date.now() + 10000;
    do {
      let shown = false;
      try {
        shown = await this._loc(seed).evaluateAll((ns) =>
          ns.some((n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)));
      } catch (e) { shown = false; }
      if (!shown) return true;
      await this.page.waitForTimeout(250);
    } while (Date.now() < end);
    return false;
  }

  // Verify by PAGE TEXT (no locator, no AI): true if the page contains ANY
  // keyword — Arabic-normalized on both sides (see normText above).
  async assertText(keywords) {
    const end = Date.now() + 8000;
    do {
      let t = '';
      try { t = normText(await this.scope.locator('body').innerText()); }
      catch (e) {}
      for (const k of keywords) {
        if (k && t.includes(normText(k))) return true;
      }
      await this.page.waitForTimeout(300);
    } while (Date.now() < end);
    return false;
  }
}
module.exports = { Healer };
