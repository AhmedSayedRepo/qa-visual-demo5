// Load/save the committed locators.json and translate a stored {by,value} into a
// Playwright selector string.
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.cwd(), 'locators.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
// One writer at a time across workers / browser processes: a lock file next to
// locators.json (a lock older than 5 s is a crashed run's and is taken over).
function withLock(fn) {
  const lock = FILE + '.lock';
  const until = Date.now() + 3000;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch (x) { /* gone */ }
      if (Date.now() > until) break;                       // write anyway rather than lose the heal
      const t = Date.now() + 15; while (Date.now() < t) { /* brief spin */ }
    }
  }
  try { return fn(); }
  finally { if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch (e) { /* gone */ } } }
}
// Parallel workers and browsers share the file: save merges `key` into what is
// on disk now and swaps the file in whole (a reader never sees half a file).
function save(store, key) {
  try {
    withLock(() => {
      const out = key ? Object.assign(load(), { [key]: store[key] }) : store;
      const tmp = FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      try { fs.renameSync(tmp, FILE); }
      catch (e) { fs.writeFileSync(FILE, JSON.stringify(out, null, 2)); try { fs.unlinkSync(tmp); } catch (x) { /* gone */ } }
    });
  } catch (e) {}
}
function toSelector(spec) {
  const by = (spec && spec.by) || 'css';
  const v = (spec && spec.value) || '';
  switch (by) {
    case 'id':          return '[id="' + v + '"]';   // valid even when the id starts with a digit
    case 'name':        return '[name="' + v + '"]';
    case 'className':   return '.' + v;
    case 'tagName':     return v;
    case 'linkText':
    case 'text':        return 'text=' + v;
    case 'xpath':       return 'xpath=' + v;
    // Shadow DOM "host >>> inner": each part is a CSS query inside the previous
    // element; Playwright's CSS engine pierces open shadow roots.
    case 'shadow':      return v.split(' >>> ').map((p) => 'css=' + p).join(' >> ');
    case 'css':
    case 'cssSelector':
    default:            return v;
  }
}
module.exports = { load, save, toSelector };
