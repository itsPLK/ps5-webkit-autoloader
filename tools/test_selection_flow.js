// The autoloader builds a single standalone index.html page carrying
// payloads/autoloader.js as a unified orchestrator. At runtime:
//   1. It probes 127.0.0.1:9021 for an active ELF loader.
//   2. It probes if the process is already jailbroken (uid 0).
//   3. If exploitation is needed, it selects Wobkot Relapse or Poops from
//      firmware and network status.
//   4. It dynamically executes the selected exploit via api.executePayload().
//   5. It dynamically executes autoload.js to stream autoload.elf to elfldr.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const FW = ['5.00', '5.02', '5.10', '5.50', '6.00', '6.72', '7.00', '7.61', '8.60', '9.00', '9.05', '9.60',
  '10.01', '11.00', '11.40', '12.00', '12.02', '12.70', '13.00', '13.60'];

/* ---- installer page: frontend/installer-page/index.html ------------------- */

function loadPage(options) {
  const html = fs.readFileSync('frontend/installer-page/index.html', 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version');
  const nodes = Object.fromEntries(['status', 'repair', 'progress', 'percent', 'detail', 'progressBar', 'logContainer',
    'cacheCorruptOverlay', 'cancelRepair', 'repairMessage']
    .map(key => [key, { hidden: true, className: '', textContent: '', style: {}, focus() {},
      setAttribute(key, value) { this[key] = String(value); },
      removeAttribute(key) { delete this[key]; } }]));
  nodes.status.textContent = 'Caching content...';
  nodes.progress.hidden = false;
  nodes.percent.hidden = false;
  nodes.progress['aria-valuenow'] = '0';
  const saved = new Map(Object.entries(options.seed || {}));
  const listeners = {};
  const requests = [];
  const logRequests = [];
  let swaps = 0;
  let target;
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
    location: { search: options.search || '', pathname: '/', replace: p => { target = p; } },
    confirm: () => !!options.confirm, setTimeout: () => {},
    fetch: async (path) => {
      requests.push(path);
      if (path.endsWith('__complete__')) return { text: async () => options.incomplete ? 'wrong' : 'test-version' };
      return { ok: !options.requestFails };
    },
    applicationCache: options.noCache ? undefined : {
      UNCACHED: 0, UPDATEREADY: 4, CACHED: 5,
      status: options.status === undefined ? 4 : options.status,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      swapCache() { if (this.status !== this.UPDATEREADY) throw new Error('The object is in an invalid state'); swaps++; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, listeners, saved, requests, logRequests, swaps: () => swaps, target: () => target };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/* ---- pointer page: frontend/pointer/index.html ----------------------------- */

function loadPointer(options) {
  const html = fs.readFileSync('frontend/pointer/index.html', 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version')
    .replaceAll('[[APP_DIR_PLACEHOLDER]]', 'test-version');
  const nodes = { status: { textContent: '' } };
  const saved = new Map(Object.entries(options.seed || {}));
  let target;
  const sandbox = {
    URLSearchParams,
    document: { getElementById: key => nodes[key] },
    navigator: {
      userAgent: options.fw ? 'PlayStation 5/' + options.fw : (options.ua !== undefined ? options.ua : 'Mozilla/5.0'),
      onLine: options.onLine !== undefined ? options.onLine : true,
    },
    localStorage: { getItem: key => (saved.has(key) ? saved.get(key) : null) },
    location: { search: options.search || '', replace: path => { target = path; } },
    fetch: async () => ({ text: async () => (options.incomplete ? 'wrong' : 'test-version') }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, target: () => target };
}

/* ---- autoloader orchestrator: payloads/autoloader.js ----------------------- */

const autoloaderSrc = fs.readFileSync('payloads/autoloader.js', 'utf8');

function testSelectExploit(options) {
  const sandbox = {
    URLSearchParams,
    location: { search: options.search || '' },
    navigator: {
      userAgent: options.fw ? 'PlayStation 5/' + options.fw : (options.ua !== undefined ? options.ua : 'Mozilla/5.0'),
      onLine: options.onLine !== undefined ? options.onLine : true,
    },
  };
  vm.createContext(sandbox);
  const code = `(function() {
    ${autoloaderSrc.replace('return async function', 'return selectExploit; return async function')}
  })()(${JSON.stringify(options.api || {})})`;
  return vm.runInContext(code, sandbox);
}

(async () => {
  // 1. All Wobkot-supported firmwares start caching immediately on bare load without
  //    requiring user interaction or manual selection.
  for (const fw of FW) {
    const page = loadPage({ fw });
    assert(Object.keys(page.listeners).length > 0,
      fw + ': caching must start immediately without user intervention');
    assert.equal(page.nodes.progress.hidden, false);
    assert.equal(page.logRequests[0].path, '/logs?pos=0');
  }

  // 2. Unsupported firmware refuses outright and signals /exit to the server.
  for (const deadFw of ['4.50', '14.00']) {
    const dead = loadPage({ fw: deadFw });
    assert.match(dead.nodes.status.textContent, /Unsupported/);
    assert.equal(Object.keys(dead.listeners).length, 0, deadFw + ': unsupported firmware must not cache');
    assert(dead.requests.includes('/exit'), 'unsupported firmware must request /exit to stop the installer daemon');
  }

  // 3. Cache completion finishes the installation and requests /install.
  for (const event of ['cached', 'noupdate', 'updateready']) {
    const page = loadPage({ fw: '11.00' });
    page.listeners[event]();
    await flush();
    assert.deepEqual(page.requests, ['/app/test-version/__complete__', '/install'],
      event + ': should install once the cache completes');
    assert.match(page.nodes.status.textContent, /Installed/);
  }

  // 4. Pointer redirects directly to the single index.html on complete cache.
  const pOnline = loadPointer({ fw: '11.00', onLine: true });
  await flush();
  assert.equal(pOnline.target(), '/app/test-version/index.html');

  const pOffline = loadPointer({ fw: '11.00', onLine: false });
  await flush();
  assert.equal(pOffline.target(), '/app/test-version/index.html');

  const pDeskFw = loadPointer({ ua: 'Mozilla/5.0', search: '?fw=9.05' });
  await flush();
  assert.equal(pDeskFw.target(), '/app/test-version/index.html?fw=9.05');

  for (const badFw of ['4.50', '14.00']) {
    const bad = loadPointer({ fw: badFw });
    await flush();
    assert.equal(bad.target(), undefined, badFw + ' must not redirect');
    assert.match(bad.nodes.status.textContent, /Unsupported/);
  }

  const incomplete = loadPointer({ fw: '11.00', incomplete: true });
  await flush();
  assert.equal(incomplete.target(), undefined, 'Incomplete cache must not redirect');
  assert.match(incomplete.nodes.status.textContent, /incomplete/);

  // 5. Automatic exploit dispatch mirrors the pre-Wobkot policy.
  for (const fw of ['12.02', '12.70', '13.00', '13.60']) {
    for (const onLine of [true, false]) {
      const choice = testSelectExploit({ fw, onLine });
      assert(choice.file.endsWith('relapse.js'), fw + ' must choose Wobkot Relapse');
      assert.deepEqual([...choice.args], []);
    }
  }

  for (const fw of ['5.00', '5.02', '5.10', '5.50', '6.00', '6.72']) {
    for (const onLine of [true, false]) {
      const choice = testSelectExploit({ fw, onLine });
      assert(choice.file.endsWith('relapse.js'), fw + ' has no Poops profile');
    }
  }

  for (const fw of ['7.00', '7.61', '8.60', '9.00', '9.05', '9.60', '10.01', '11.00',
                    '11.40', '12.00']) {
    const online = testSelectExploit({ fw, onLine: true });
    assert(online.file.endsWith('relapse.js'), fw + ' online must choose Relapse');
    const offline = testSelectExploit({ fw, onLine: false });
    assert(offline.file.endsWith('poops.js'), fw + ' offline must choose Poops');
  }

  // Desktop query parameters follow the same firmware rules.
  const desk905 = testSelectExploit({ ua: 'Mozilla/5.0', search: '?fw=9.05', onLine: true });
  assert(desk905.file.endsWith('relapse.js'));
  assert.deepEqual([...desk905.args], []);
  const desk905Offline = testSelectExploit({
    ua: 'Mozilla/5.0', search: '?fw=9.05', onLine: false,
  });
  assert(desk905Offline.file.endsWith('poops.js'));

  const desk1300 = testSelectExploit({ ua: 'Mozilla/5.0', search: '?fw=13.00', onLine: false });
  assert(desk1300.file.endsWith('relapse.js'));
  assert.deepEqual([...desk1300.args], []);

  // 6. Test the orchestrator execution flow in payloads/autoloader.js
  const AsyncFunction = (async function () {}).constructor;
  const runner = new AsyncFunction('api', autoloaderSrc);

  function makeMockApi(options = {}) {
    const executed = [];
    const logs = [];
    const memory = new Map();
    let next = 0x20000000;
    function pointer(low) {
      return { low: low >>> 0, hi: 0, add32(n) { return pointer(this.low + n); } };
    }
    return {
      executed,
      logs,
      args: ['custom.elf'],
      log: async (msg, type) => { logs.push({ msg, type }); },
      p: {
        malloc: size => { const p = pointer(next); next += size; return p; },
        write1: (p, v) => { memory.set(p.low, v); },
      },
      chain: {
        syscall: async (nr, ...args) => {
          if (nr === 0x61) return pointer(10); // socket fd 10
          if (nr === 0x62) return pointer(options.elfldrRunning ? 0 : -1); // connect 9021
          if (nr === 6) return pointer(0); // close
          if (nr === 24) return pointer(options.jailbroken ? 0 : 1000); // getuid
          throw new Error('Unexpected syscall: ' + nr);
        },
      },
      executePayload: async (code, payloadArgs) => {
        executed.push({ code, payloadArgs });
        return { failed: !!options.exploitFails && executed.length === 1 };
      },
    };
  }

  // Flow A: ELF loader already running on 9021 -> skips exploit and autoload
  {
    const api = makeMockApi({ elfldrRunning: true });
    const run = await runner(api);
    if (typeof run === 'function') await run(api);
    assert.equal(api.executed.length, 0, 'Must not execute any sub-payload if elfldr is running');
    assert(api.logs.some(l => l.msg.includes('ELF loader is already active')));
  }

  // Flow B: Process is already root / jailbroken -> skips exploit and autoload
  {
    const api = makeMockApi({ elfldrRunning: false, jailbroken: true });
    const run = await runner(api);
    if (typeof run === 'function') await run(api);
    assert.equal(api.executed.length, 0, 'Must not execute any sub-payload if already jailbroken');
    assert(api.logs.some(l => l.msg.includes('Process is already jailbroken')));
  }

  // Flow C: Neither -> executes the selected exploit, then autoload.js.
  for (const selection of [
    { fw: '11.00', onLine: true, exploit: /relapse\.js/ },
    { fw: '11.00', onLine: false, exploit: /poops\.js/ },
    { fw: '9.05', onLine: true, exploit: /relapse\.js/ },
    { fw: '9.05', onLine: false, exploit: /poops\.js/ },
  ]) {
    const api = makeMockApi({ elfldrRunning: false, jailbroken: false });
    // Mock global fetch for embedded files
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => '// code for ' + url,
    });
    const oldUA = globalThis.navigator;
    const oldLocation = globalThis.location;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'PlayStation 5/' + selection.fw, onLine: selection.onLine },
        configurable: true,
      });
      globalThis.location = { search: '' };
      const run = await runner(api);
      if (typeof run === 'function') await run(api);
      assert.equal(api.executed.length, 2, 'Must execute exploit then autoload.js');
      assert.match(api.executed[0].code, selection.exploit);
      assert.deepEqual(api.executed[0].payloadArgs, []);
      assert.match(api.executed[1].code, /code for .*?autoload\.js/);
      assert.equal(api.executed[1].payloadArgs[0], 'custom.elf');
    } finally {
      globalThis.fetch = origFetch;
      if (oldUA === undefined) delete globalThis.navigator;
      else Object.defineProperty(globalThis, 'navigator', {
        value: oldUA, configurable: true,
      });
      if (oldLocation === undefined) delete globalThis.location;
      else globalThis.location = oldLocation;
    }
  }

  // A failed kernel exploit must leave autoload.js last and unexecuted.
  {
    const api = makeMockApi({ elfldrRunning: false, jailbroken: false, exploitFails: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => ({ ok: true, text: async () => '// code for ' + url });
    try {
      const run = await runner(api);
      if (typeof run === 'function') await assert.rejects(run(api), /failed; refusing/);
      assert.equal(api.executed.length, 1);
      assert.match(api.executed[0].code, /relapse\.js/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 7. Modular AppCache build architecture:
  const makefile = fs.readFileSync('Makefile', 'utf8');
  assert(makefile.includes('build/autoloader'),
    'Makefile must stage the modular autoloader');
  assert(!makefile.includes('build/autoloader/$$chain.html'),
    'Makefile should not build separate chain pages');

  // Generated frontend/dist may belong to an older build. The modular staging
  // test constructs a clean tree and verifies both active exploit assets.

  // 8. The server holds no selection state and gates manifest per request:
  const httpServer = fs.readFileSync('src/http_server.c', 'utf8');
  for (const gone of ['selected_exploit', 'active_exploit', '# selected exploit']) {
    assert(!httpServer.includes(gone), 'src/http_server.c still references ' + gone);
  }
  assert(!/^static atomic_int .*exploit/m.test(httpServer),
    'the server must not keep a remembered choice');
  for (const present of [
    'static int firmware_supported(struct MHD_Connection *conn) {',
    'return fw >= 5.00f && fw <= 13.60f;',
    'int cache_allowed = firmware_supported(conn);',
    'if (entry_page && !cache_allowed) {',
  ]) {
    assert(httpServer.includes(present),
      'src/http_server.c should still gate the manifest per request: ' + present);
  }

  console.log('Selection flow passed: firmware/network auto-dispatch, ' +
    'orchestrator-first/autoload-last execution, and one modular index page.');
})().catch(error => { console.error(error); process.exitCode = 1; });
