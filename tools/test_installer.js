// Exercise cache completion, failures, repair and the pointer without a PS5.
//
// The installer automatically caches both exploit pages on supported firmwares
// without requiring manual user selection. When the cache completes, the homescreen
// shortcut is installed. The pointer then automatically dispatches to relapse.html
// or poops.html at runtime based on firmware version and network status.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(file, options = {}) {
  const html = fs.readFileSync(file, 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version')
    .replaceAll('[[APP_DIR_PLACEHOLDER]]', 'test-version');
  const nodes = Object.fromEntries(['status', 'repair', 'progress', 'percent', 'detail', 'progressBar', 'logContainer',
    'cacheCorruptOverlay', 'cancelRepair', 'repairMessage']
    .map(key => [key, { hidden: true, className: '', textContent: '', style: {}, focus() {},
      setAttribute(key, value) { this[key] = String(value); },
      removeAttribute(key) { delete this[key]; } }]));
  // Seed the text the markup starts with, so a handler that writes nothing is
  // distinguishable from one that writes the expected message.
  nodes.status.textContent = 'Caching content...';
  nodes.progress.hidden = false;
  nodes.percent.hidden = false;
  nodes.progress['aria-valuenow'] = '0';
  const requests = [];
  const logRequests = [];
  const listeners = {};
  let swaps = 0;
  let target;
  const saved = new Map(Object.entries(options.seed || {}));
  const sandbox = {
    URLSearchParams,
    XMLHttpRequest: function () {
      this.open = (method, path) => { this.path = path; };
      this.send = () => { logRequests.push(this); };
      this.abort = () => { this.aborted = true; };
      this.getResponseHeader = () => '42';
    },
    document: { getElementById: key => nodes[key] },
    navigator: {
      userAgent: options.fw ? 'PlayStation 5/' + options.fw : (options.ua !== undefined ? options.ua : 'Mozilla/5.0'),
      onLine: options.onLine !== undefined ? options.onLine : true,
    },
    localStorage: {
      getItem: key => (saved.has(key) ? saved.get(key) : null),
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: key => { saved.delete(key); },
    },
    location: {
      search: options.search || '', pathname: '/', replace: path => { target = path; },
    },
    confirm: () => !!options.confirm,
    setTimeout: () => {},
    fetch: async path => {
      requests.push(path);
      if (path.endsWith('__complete__')) return { text: async () => options.incomplete ? 'wrong' : 'test-version' };
      return { ok: !options.requestFails };
    },
    applicationCache: options.noCache ? undefined : {
      // Real AppCache states. A re-run over an existing cache fires updateready
      // without necessarily leaving the cache in UPDATEREADY, and swapCache()
      // then throws InvalidStateError.
      UNCACHED: 0, CHECKING: 1, DOWNLOADING: 2, UPDATEREADY: 4, CACHED: 5, OBSOLETE: 3,
      status: options.status === undefined ? 4 : options.status,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      swapCache() {
        if (this.status !== this.UPDATEREADY) {
          const error = new Error('The object is in an invalid state');
          error.name = 'InvalidStateError';
          throw error;
        }
        swaps++;
        this.status = this.CACHED;
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, requests, logRequests, listeners, swaps: () => swaps, target: () => target, saved };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

const runInstaller = options => setup('frontend/installer-page/index.html',
  { fw: '11.00', ...options });

(async () => {
  // 1. On supported firmware, cache completion is enough to install automatically.
  for (const event of ['cached', 'noupdate', 'updateready']) {
    for (const status of [4, 5]) {
      const test = runInstaller({ status });
      test.listeners[event]();
      test.listeners[event]();
      await flush();
      assert.deepEqual(test.requests, ['/app/test-version/__complete__', '/install'],
        event + ' at status ' + status + ': should install');
      assert.equal(test.swaps(), event === 'updateready' && status === 4 ? 1 : 0,
        event + ' at status ' + status + ': unexpected number of swaps');
      assert.match(test.nodes.status.textContent, /Installed/);
      assert.equal(test.nodes.status.className, 'success');
      assert.equal(test.nodes.progress.className, 'success');
      assert.equal(test.logRequests[0].aborted, true, 'stop polling when the server shuts down');
      test.listeners.cached();
      assert.equal(test.nodes.progress.className, 'success', 'late cache events must preserve success');
    }
  }

  // Successful install clears both pending and legacy exploit keys.
  const rerun = setup('frontend/installer-page/index.html',
    { fw: '11.00', seed: { wkal_exploit: 'poops', wkal_pending: 'relapse' } });
  rerun.listeners.cached();
  await flush();
  assert.equal(rerun.saved.get('wkal_pending'), undefined, 'pending must be cleared');
  assert.equal(rerun.saved.get('wkal_exploit'), undefined, 'legacy exploit key must be cleared');

  // 2. On bare load, caching starts immediately without user prompt or clicks.
  const bare = setup('frontend/installer-page/index.html', { fw: '11.00' });
  assert(Object.keys(bare.listeners).length > 0, 'caching must start immediately on supported firmware');
  assert.equal(bare.nodes.progress.hidden, false);
  assert.equal(bare.logRequests[0].path, '/logs?pos=0');
  bare.logRequests[0].status = 200;
  bare.logRequests[0].responseText = '[WKALI] Caching content\n';
  bare.logRequests[0].onload();
  assert.equal(bare.nodes.logContainer.hidden, false);
  assert.match(bare.nodes.logContainer.textContent, /Caching content/);

  // 3. Unsupported firmware refuses outright and signals /exit to the server
  const unsupported = setup('frontend/installer-page/index.html', { fw: '5.50' });
  assert.match(unsupported.nodes.status.textContent, /Unsupported/);
  assert.equal(Object.keys(unsupported.listeners).length, 0, 'unsupported firmware must not start caching');
  assert(unsupported.requests.includes('/exit'), 'unsupported firmware must signal /exit');

  // Desktop preview testing via ?fw= parameter:
  const desktopUnsupported = setup('frontend/installer-page/index.html', { ua: 'Mozilla/5.0', search: '?fw=5.50' });
  assert.match(desktopUnsupported.nodes.status.textContent, /Unsupported/);
  assert.equal(Object.keys(desktopUnsupported.listeners).length, 0);
  assert(desktopUnsupported.requests.includes('/exit'));

  // 4. Failed install reports error and offers repair.
  const failed = runInstaller({ requestFails: true });
  failed.listeners.cached();
  await flush();
  assert.equal(failed.nodes.repair.hidden, false);

  // 5. Progress is reported, and never claims 100% before the cache is complete.
  const meter = runInstaller();
  meter.listeners.progress({ loaded: 1, total: 4 });
  assert.equal(meter.nodes.progress['aria-valuenow'], '25');
  assert.equal(meter.nodes.progressBar.style.transform, 'scaleX(0.25)');
  assert.equal(meter.nodes.percent.textContent, '25%');
  meter.listeners.progress({ loaded: 4, total: 4 });
  assert.equal(meter.nodes.progress['aria-valuenow'], '99', '100% requires completed cache');
  meter.listeners.progress({ loaded: 1, total: 0 });
  assert.equal(meter.nodes.progress['aria-valuenow'], undefined);
  assert.equal(meter.nodes.progress.className, 'indeterminate');
  meter.listeners.cached();
  await flush();
  assert.equal(meter.nodes.progress['aria-valuenow'], '100');
  assert.equal(meter.nodes.progressBar.style.transform, 'scaleX(1)');
  assert.equal(meter.nodes.progress.className, 'success');
  assert.equal(meter.nodes.percent.textContent, '100%');

  // 6. A download that finishes but whose marker does not match is a real failure.
  for (const options of [{ incomplete: true }, { requestFails: true }]) {
    const test = runInstaller(options);
    test.listeners.downloading();
    test.listeners.cached();
    await flush();
    assert.equal(test.nodes.repair.hidden, false, 'a bad marker must offer repair');
    if (options.incomplete) assert(!test.requests.includes('/install'));
  }

  // 7. An error during a download is corruption; one during the check is not, and
  // neither may be silent.
  const during = runInstaller();
  during.listeners.downloading();
  during.listeners.error();
  assert.equal(during.nodes.repair.hidden, false, 'a download failure must offer repair');
  assert.equal(during.nodes.cacheCorruptOverlay.hidden, false);
  assert.equal(during.nodes.status.className, 'error');
  assert.equal(during.logRequests[0].aborted, true, 'stop polling after a cache failure');
  during.nodes.cancelRepair.onclick();
  assert.equal(during.nodes.cacheCorruptOverlay.hidden, true);
  assert.deepEqual(during.requests, [], 'dismissing repair must not clear browser data');

  for (const event of ['error', 'obsolete']) {
    for (const phase of ['before', 'after']) {
      const quiet = runInstaller();
      if (phase === 'after') {
        quiet.listeners.downloading();
        quiet.listeners.cached();
        await flush();
        assert.match(quiet.nodes.status.textContent, /Installed/);
      }
      quiet.listeners[event]();
      await flush();
      assert.equal(quiet.nodes.repair.hidden, true,
        event + ' ' + phase + ' download must not offer WebKit-data repair');
      assert.equal(quiet.nodes.cacheCorruptOverlay.hidden, true);
      const expected = phase === 'after' ? /Installed/
        : event === 'obsolete' ? /superseded/
        : /could not be checked/;
      assert.match(quiet.nodes.status.textContent, expected,
        event + ' ' + phase + ' left the status as: ' + quiet.nodes.status.textContent);
    }
  }

  // 8. Repair is offered but does nothing until confirmed.
  const silent = runInstaller();
  silent.listeners.error();
  silent.nodes.repair.onclick();
  await flush();
  assert.equal(silent.requests.length, 0, 'Repair requires confirmation');

  const repair = runInstaller({ confirm: true });
  repair.listeners.downloading();
  repair.listeners.error();
  repair.nodes.repair.onclick();
  await flush();
  assert.deepEqual(repair.requests, ['/clear-webkit-data']);
  assert.match(repair.nodes.status.textContent, /cleared/);

  // 9. Without AppCache there is nothing to do and nothing is requested.
  const absent = runInstaller({ noCache: true });
  assert.equal(absent.requests.length, 0);
  assert.match(absent.nodes.status.textContent, /does not support/);

  // 10. The pointer redirects only on a complete cache to the unified index.html.
  for (const incomplete of [false, true]) {
    const pointer = setup('frontend/pointer/index.html', { incomplete, fw: '11.00', onLine: true });
    await flush();
    assert.equal(pointer.target(), incomplete ? undefined : '/app/test-version/index.html');
    if (incomplete) assert.match(pointer.nodes.status.textContent, /incomplete/);
  }

  const pUnsupported = setup('frontend/pointer/index.html', { fw: '5.50' });
  await flush();
  assert.equal(pUnsupported.target(), undefined);
  assert.match(pUnsupported.nodes.status.textContent, /Unsupported/);

  // Desktop preview testing via ?fw= query parameter:
  const pDesk = setup('frontend/pointer/index.html', { ua: 'Mozilla/5.0', search: '?fw=11.00' });
  await flush();
  assert.equal(pDesk.target(), '/app/test-version/index.html?fw=11.00', '?fw=11.00 desktop preserves fw parameter');

  const pDeskUnsupported = setup('frontend/pointer/index.html', { ua: 'Mozilla/5.0', search: '?fw=5.50' });
  await flush();
  assert.equal(pDeskUnsupported.target(), undefined, '?fw=5.50 desktop must not redirect');
  assert.match(pDeskUnsupported.nodes.status.textContent, /Unsupported/);

  console.log('Installer checks passed: cache events, marker, automatic caching, errors, repair and pointer.');
})().catch(error => { console.error(error); process.exitCode = 1; });
