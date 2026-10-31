// The autoloader builds a single standalone index.html page carrying
// payloads/autoloader.js as a unified orchestrator. At runtime:
//   1. It probes 127.0.0.1:9021 for an active ELF loader.
//   2. It probes if the process is already jailbroken (uid 0).
//   3. If exploit is needed, it auto-dispatches based on FW and network:
//      - FW > 12.00 and FW <= 13.60 -> relapse.lua
//      - FW == 9.05 -> poops.js
//      - Active network connection (navigator.onLine) -> relapse.lua
//      - Otherwise (offline, FW <= 12.00) -> poops.js
//   4. It dynamically executes the chosen exploit via api.executePayload().
//   5. It dynamically executes autoload.js to stream autoload.elf to elfldr.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const FW = [
  // fw,      poops, relapse  (as computed by the firmware checks)
  ['7.00', true, true], ['7.61', true, true], ['8.60', true, true],
  ['9.00', true, true], ['9.05', true, false], ['9.60', true, true],
  ['10.01', true, true], ['11.00', true, true], ['11.40', true, true],
  ['12.00', true, true], ['12.02', false, true], ['12.70', false, true],
  ['13.00', false, true], ['13.60', false, true],
];

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
  // 1. All supported firmwares start caching immediately on bare load without
  //    requiring user interaction or manual selection.
  for (const [fw] of FW) {
    const page = loadPage({ fw });
    assert(Object.keys(page.listeners).length > 0,
      fw + ': caching must start immediately without user intervention');
    assert.equal(page.nodes.progress.hidden, false);
    assert.equal(page.logRequests[0].path, '/logs?pos=0');
  }

  // 2. Unsupported firmware refuses outright and signals /exit to the server.
  for (const deadFw of ['5.50', '6.72', '14.00']) {
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

  for (const badFw of ['5.50', '6.72', '14.00']) {
    const bad = loadPointer({ fw: badFw });
    await flush();
    assert.equal(bad.target(), undefined, badFw + ' must not redirect');
    assert.match(bad.nodes.status.textContent, /Unsupported/);
  }

  const incomplete = loadPointer({ fw: '11.00', incomplete: true });
  await flush();
  assert.equal(incomplete.target(), undefined, 'Incomplete cache must not redirect');
  assert.match(incomplete.nodes.status.textContent, /incomplete/);

  // 5. Automatic exploit dispatch logic in payloads/autoloader.js:
  //    Rule 1: FW > 12.00 and FW <= 13.60 -> relapse.lua (both online and offline)
  for (const fw of ['12.02', '12.70', '13.00', '13.60']) {
    for (const onLine of [true, false]) {
      const choice = testSelectExploit({ fw, onLine });
      assert(choice.file.endsWith('relapse.lua'), fw + ' (onLine: ' + onLine + ') must choose relapse.lua');
      assert.deepEqual([...choice.args], ['compat=remote_lua_loader'], 'relapse.lua must receive compat=remote_lua_loader');
    }
  }

  //    Rule 2: FW == 9.05 -> poops.js (both online and offline)
  for (const onLine of [true, false]) {
    const choice = testSelectExploit({ fw: '9.05', onLine });
    assert(choice.file.endsWith('poops.js'), '9.05 (onLine: ' + onLine + ') must choose poops.js');
    assert.deepEqual([...choice.args], [], 'poops.js does not need compat args');
  }

  //    Rule 3 & 4: Dual-supported firmwares (7.00 - 12.00 except 9.05):
  //    Online -> relapse.lua (faster, reliable)
  //    Offline -> poops.js (works without network)
  for (const fw of ['7.00', '7.61', '8.60', '9.00', '9.60', '10.01', '11.00', '11.40', '12.00']) {
    const choiceOnline = testSelectExploit({ fw, onLine: true });
    assert(choiceOnline.file.endsWith('relapse.lua'), fw + ' online must choose relapse.lua');
    assert.deepEqual([...choiceOnline.args], ['compat=remote_lua_loader'], 'online relapse.lua must receive compat=remote_lua_loader');

    const choiceOffline = testSelectExploit({ fw, onLine: false });
    assert(choiceOffline.file.endsWith('poops.js'), fw + ' offline must choose poops.js');
    assert.deepEqual([...choiceOffline.args], [], 'offline poops.js does not need compat args');
  }

  //    Desktop query param ?fw= selection:
  const desk905 = testSelectExploit({ ua: 'Mozilla/5.0', search: '?fw=9.05', onLine: true });
  assert(desk905.file.endsWith('poops.js'));
  assert.deepEqual([...desk905.args], []);

  const desk1300 = testSelectExploit({ ua: 'Mozilla/5.0', search: '?fw=13.00', onLine: false });
  assert(desk1300.file.endsWith('relapse.lua'));
  assert.deepEqual([...desk1300.args], ['compat=remote_lua_loader']);

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

  // Flow C: Neither -> executes chosen exploit, then autoload.js
  {
    const api = makeMockApi({ elfldrRunning: false, jailbroken: false });
    // Mock global fetch for embedded files
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => '// code for ' + url,
    });
    try {
      const run = await runner(api);
      if (typeof run === 'function') await run(api);
      assert.equal(api.executed.length, 2, 'Must execute exploit then autoload.js');
      assert.match(api.executed[0].code, /code for .*?(relapse\.lua|poops\.js)/);
      if (api.executed[0].code.includes('relapse.lua')) {
        assert.deepEqual(api.executed[0].payloadArgs, ['compat=remote_lua_loader'],
          'relapse.lua must be executed with compat=remote_lua_loader');
      }
      assert.match(api.executed[1].code, /code for .*?autoload\.js/);
      assert.equal(api.executed[1].payloadArgs[0], 'custom.elf');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // 7. Modular AppCache build architecture:
  const makefile = fs.readFileSync('Makefile', 'utf8');
  assert(makefile.includes('build/autoloader'),
    'Makefile must stage the modular autoloader');
  assert(!makefile.includes('build/autoloader/$$chain.html'),
    'Makefile should not build separate chain pages');

  const dist = 'frontend/dist/cache.appcache';
  if (fs.existsSync(dist)) {
    const manifest = fs.readFileSync(dist, 'utf8');
    assert(manifest.includes('/index.html'), 'index.html must be cached');
    assert(!manifest.includes('/poops.html') && !manifest.includes('/relapse.html'),
      'manifest should not contain obsolete poops.html or relapse.html');
  }

  // 8. The server holds no selection state and gates manifest per request:
  const httpServer = fs.readFileSync('src/http_server.c', 'utf8');
  for (const gone of ['selected_exploit', 'active_exploit', '# selected exploit']) {
    assert(!httpServer.includes(gone), 'src/http_server.c still references ' + gone);
  }
  assert(!/^static atomic_int .*exploit/m.test(httpServer),
    'the server must not keep a remembered choice');
  for (const present of [
    'static int supported_chains(struct MHD_Connection *conn) {',
    'int poops = fw >= 7 && fw <= 12;',
    'int relapse = fw >= 7 && fw <= 13.60f && fw != 9.05f;',
    'int cache_allowed = chains != 0;',
    'if (entry_page && !cache_allowed) {',
  ]) {
    assert(httpServer.includes(present),
      'src/http_server.c should still gate the manifest per request: ' + present);
  }

  console.log('Selection flow passed: automatic caching on all supported firmwares, ' +
    'auto-dispatch in autoloader.js based on FW and network, single standalone index.html page.');
})().catch(error => { console.error(error); process.exitCode = 1; });
