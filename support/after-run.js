// Playwright reporter that runs AFTER the HTML report is written (it is listed
// after 'html' in playwright.config.js): writes QA Studio's summary report
// (playwright-report/qa-studio-report.html), opens it and emails both reports.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openFile, mailReport, writeReport, writeDetailed, siteOf, stripAnsi, detectIde } = require('./report-mailer');

function storyOf(test) {
  let s = test.parent;
  while (s && s.parent && s.parent.type !== 'file') s = s.parent;
  return s && s.type !== 'file' && s.title ? s.title : path.basename(test.location.file);
}

// The browser (project) a test ran in: "Chrome", "Firefox"...
function projectOf(test) {
  try { const p = test.parent.project(); return (p && p.name) || ''; } catch (e) { return ''; }
}

// "heal.assertSelected(..., {"target": "Ham selection", ...})" -> "assertSelected · Ham selection"
function stepOf(err) {
  const line = (stripAnsi(err && err.snippet).split('\n').find((l) => /^\s*>/.test(l)) || '')
    .replace(/^\s*>\s*\d*\s*\|?\s*/, '');
  const m = line.match(/heal\.(\w+)\([\s\S]*?"target":\s*"([^"]+)"/);
  if (m) return m[1] + ' · ' + m[2];
  const loc = err && err.location;
  return loc ? path.basename(loc.file) + ':' + loc.line : '';
}

class AfterRun {
  onBegin(config, suite) {
    this.config = config; this.suite = suite; this.ran = 0;
    this.startedAt = Date.now(); this.last = new Map();
  }

  onTestEnd(test, result) { this.ran++; this.last.set(test, result); }

  async onEnd(result) {
    // `--list` (or a run that executed nothing) has no report to open or mail.
    if (process.argv.includes('--list') || !this.ran) return;
    const stories = new Map();
    const multi = (this.config.projects || []).length > 1;
    for (const t of this.suite.allTests()) {
      const r = this.last.get(t) || {};
      const o = t.outcome();
      const status = o === 'expected' ? 'passed' : o === 'flaky' ? 'flaky'
        : o === 'skipped' ? 'skipped' : 'failed';
      const name = storyOf(t) + (multi && projectOf(t) ? ' · ' + projectOf(t) : '');
      if (!stories.has(name)) {
        stories.set(name, { name, file: path.basename(t.location.file),
          site: siteOf(t.location.file), tests: [] });
      }
      const shot = (r.attachments || []).find((a) => a.name === 'screenshot' && a.path);
      const video = (r.attachments || []).find((a) => a.name === 'video' && a.path);
      const err = r.error || (r.errors || [])[0];
      const down = [...(t.annotations || []), ...(r.annotations || [])]
        .find((a) => a && a.type === 'Site unavailable');
      const tsteps = (r.steps || []).filter((x) => x.category === 'test.step' && /^Step \d+ /.test(x.title));
      stories.get(name).tests.push({ title: t.title, status, duration: r.duration || 0,
        steps: tsteps.map((x) => x.title),
        failIdx: tsteps.findIndex((x) => x.error),
        fullError: err ? stripAnsi(err.message).slice(0, 4000) : '',
        stack: err && err.stack ? stripAnsi(err.stack).split('\n').filter((l) => /^\s*at /.test(l)).slice(0, 14).join('\n') : '',
        site: status === 'failed' && down ? String(down.description || '') : '',
        error: err ? stripAnsi(err.message).split('\n').filter(Boolean).slice(0, 6).join('\n').slice(0, 900) : '',
        step: status === 'failed' ? stepOf(err) : '',
        screenshot: shot ? shot.path : '', video: video ? video.path : '' });
    }
    const use = ((this.config.projects || [])[0] || {}).use || {};
    const browserNames = (this.config.projects || []).map((p) => p.name).filter(Boolean).join(', ');
    let pwVersion = '';
    try { pwVersion = require('@playwright/test/package.json').version; } catch (e) { /* optional */ }
    const run = { framework: 'Playwright', startedAt: this.startedAt, duration: result.duration,
      stories: Array.from(stories.values()),
      env: { frameworkVersion: pwVersion, browser: browserNames || use.channel || use.browserName || 'chromium',
        headless: use.headless, os: os.type() + ' ' + os.release(), host: os.hostname(),
        runtime: 'Node ' + process.version, ide: detectIde() } };
    const dir = path.resolve('playwright-report');
    const detailed = writeDetailed(run, dir, 'index.html');
    const summary = writeReport(run, dir, detailed ? 'qa-studio-detailed.html' : 'index.html');
    openFile(summary || path.join(dir, 'index.html'));
    await mailReport(run, summary, detailed || path.join(dir, 'index.html'));
  }
}
module.exports = AfterRun;
