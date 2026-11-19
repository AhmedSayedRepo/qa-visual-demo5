// Playwright reporter: feeds the progress window (support/progress.js) while the
// tests run - which test is running in which browser, and the counts.
const progress = require('./progress');

class ProgressReporter {
  onBegin(config, suite) {
    const tests = suite.allTests();
    progress.start(tests.length);
    // One progress row per browser (project): how many tests each runs.
    const per = {};
    for (const t of tests) {
      let name = '';
      try { name = t.parent.project().name; } catch (e) { /* older Playwright */ }
      if (name) per[name] = (per[name] || 0) + 1;
    }
    for (const name of Object.keys(per)) progress.expect(name, per[name]);
  }

  onTestBegin(test) {
    let browser = '';
    try { browser = test.parent.project().name; } catch (e) { /* older Playwright */ }
    progress.testStarted(test.title, browser);
  }

  onTestEnd(test, result) {
    const bad = ['failed', 'timedOut', 'interrupted'].includes(result.status);
    if (bad && result.retry < test.retries) return;   // it runs again; count the last try
    let browser = '';
    try { browser = test.parent.project().name; } catch (e) { /* older Playwright */ }
    progress.testDone(result.status === 'passed' ? 'passed' : bad ? 'failed' : 'skipped', browser);
  }

  async onEnd() {
    progress.wrapUp();
    await progress.finish();
  }

  printsToStdio() { return false; }
}

module.exports = ProgressReporter;
