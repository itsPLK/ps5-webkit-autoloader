// Offline checks for the final payload: stage the ELF and hand it to elfldr.
// The selected exploit starts elfldr directly, so this payload does not require a
// separately published api.krw handle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('payloads/autoload.js', 'utf8');

function pointer(low) {
  return { low, hi: 0, add32(n) { return pointer(this.low + n); } };
}

async function run(options = {}) {
  const bytes = new Uint8Array(0x1007);
  bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  for (let i = 4; i < bytes.length; i++) bytes[i] = i & 255;
  const memory = new Map();
  const events = [];
  const sent = [];
  const mapped = pointer(0x30000000);
  let next = 0x20000000;
  let connections = 0;
  let closed = 0;
  let unmapped = 0;
  const expectedElf = (options.args && options.args[0]) || 'autoload.elf';
  const api = {
    args: options.args || [],
    log: async () => {},
    p: {
      malloc(size) { const p = pointer(next); next += size; return p; },
      write1(p, n) { memory.set(p.low, n & 255); },
      write4(p, n) { for (let i = 0; i < 4; i++) memory.set(p.low + i, (n >>> (i * 8)) & 255); },
      read4(p) { return [0, 1, 2, 3].reduce((v, i) => v | (memory.get(p.low + i) << (i * 8)), 0); },
    },
    chain: { async syscall(n, a, b, c) {
      if (n === 0x61) return pointer(12);
      if (n === 0x62) {
        connections++;
        assert.deepEqual(Array.from({ length: 8 }, (_, i) => memory.get(b.low + i)), [16, 2, 0x23, 0x3d, 127, 0, 0, 1]);
        // The exploit brings elfldr up; options.loaderFails makes it never listen.
        return pointer(options.loaderFails ? -1 : 0);
      }
      if (n === 6) { closed++; return pointer(0); }
      if (n === 0x1dd) { events.push('map'); return pointer(options.mmapFails ? -1 : mapped.low); }
      if (n === 0x49) { unmapped++; return pointer(0); }
      if (n === 4) {
        if (options.writeFails) return pointer(-1);
        const count = Math.min(c, 113); // Exercise short writes and the final tail.
        for (let i = 0; i < count; i++) sent.push(memory.get(b.low + i));
        return pointer(count);
      }
      throw new Error('Unexpected syscall ' + n);
    } },
  };
  const sandbox = {
    api, console, DataView, Uint8Array,
    setTimeout(fn) { fn(); },
    fetch: async (path) => {
      events.push(path);
      assert.equal(path, expectedElf, 'only the embedded ELF is fetched');
      return {
        ok: !options.fetchFails,
        arrayBuffer: async () => options.badElf ? new ArrayBuffer(8) : bytes.buffer,
      };
    },
  };
  vm.createContext(sandbox);
  let error;
  try { await vm.runInContext(`(async function () { ${source}\n})().then(fn => fn(api))`, sandbox); }
  catch (e) { error = e; }
  return { error, events, sent, bytes, closed, unmapped, connections };
}

(async () => {
  // The happy path: the whole ELF arrives intact.
  const ok = await run();
  assert.ifError(ok.error);
  assert.deepEqual(ok.sent, [...ok.bytes]);
  assert.equal(ok.unmapped, 1);
  assert.equal(ok.closed, 1);
  assert.equal(ok.connections, 1);
  assert.deepEqual(ok.events, ['autoload.elf', 'map']);

  // Custom named payload passed via payload args.
  const custom = await run({ args: ['ps5-unified-autoloader-v0.1.6-e7093cd.elf'] });
  assert.ifError(custom.error);
  assert.deepEqual(custom.sent, [...custom.bytes]);
  assert.deepEqual(custom.events, ['ps5-unified-autoloader-v0.1.6-e7093cd.elf', 'map']);

  // Input and mapping failures send nothing.
  for (const options of [{ fetchFails: true }, { badElf: true }, { mmapFails: true }]) {
    const result = await run(options);
    assert(result.error, 'expected a failure for ' + JSON.stringify(options));
    assert.equal(result.sent.length, 0);
    assert.equal(result.unmapped, 0);
  }

  // Failures after the ELF is mapped must still clean up.
  for (const options of [{ loaderFails: true }, { writeFails: true }]) {
    const result = await run(options);
    assert(result.error, 'expected a failure for ' + JSON.stringify(options));
    assert.equal(result.sent.length, 0);
    assert.equal(result.unmapped, 1, 'the mapping must be released');
  }

  console.log('Autoload checks passed: ELF staging, hand-off to elfldr, short writes and cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
