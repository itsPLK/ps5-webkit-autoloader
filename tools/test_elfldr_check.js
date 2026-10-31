// Exercise the real check payload through the upstream standalone queue runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync('payloads/elfldr-check.js', 'utf8');

function pointer(low) {
  return { low: low >>> 0, hi: low < 0 ? 0xffffffff : 0,
    add32(n) { return pointer(this.low + n); } };
}

(async () => {
  const loaderPath = fs.existsSync('third_party/ps5-webkit-remote-loader/src/standalone.js')
    ? 'third_party/ps5-webkit-remote-loader/src/standalone.js'
    : '../../src/standalone.js';
  const { runPayloadQueue } = await import(pathToFileURL(path.resolve(loaderPath)).href);

  async function run(options = {}) {
    const memory = new Map(), calls = [], logs = [];
    let next = 0x20000000;
    globalThis.window = globalThis;
    globalThis.fw_str = '11.00';
    globalThis.writeLog = (message, type) => logs.push({ message, type });
    const p = {
      malloc(size) { const addr = pointer(next); next += size; return addr; },
      write1(addr, value) { memory.set(addr.low, value); },
    };
    const chain = { async syscall(nr, ...args) {
      calls.push({ nr, args });
      if (nr === 0x61) {
        assert.deepEqual(args, [2, 1, 0]);
        return pointer(options.socketFails ? -1 : (options.fd ?? 12));
      }
      if (nr === 0x62) {
        assert.equal(args[0], options.fd ?? 12);
        assert.equal(args[2], 16);
        assert.deepEqual(Array.from({ length: 16 }, (_, i) => memory.get(args[1].low + i)),
          [16, 2, 0x23, 0x3d, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        if (options.connectThrows) throw new Error('connect failed unexpectedly');
        return pointer(options.listening ? 0 : -1);
      }
      if (nr === 6) {
        assert.equal(args[0], options.fd ?? 12);
        if (options.closeThrows) throw new Error('close failed unexpectedly');
        return pointer(options.closeFails ? -1 : 0);
      }
      throw new Error('Probe must not send data or run another syscall: ' + nr);
    } };
    const summary = await runPayloadQueue({ p, chain, payloads: [
      { name: 'elfldr-check.js', source },
      { name: 'kernel.js', source: `return async function (api) {
        if (api.krw) throw new Error('check must run before kernel access');
        api.krw = {}; await api.log('kernel marker');
      };` },
      { name: 'autoload.js', source: `return async function (api) {
        if (!api.krw) throw new Error('kernel must run before autoload');
        await api.log('autoload marker');
      };` },
    ] });
    return { summary, calls, text: logs.map(log => log.message).join('\n') };
  }

  // A successful TCP connect stops both following payloads, sends nothing, and
  // closes its socket even when the returned descriptor is zero.
  for (const fd of [0, 12]) {
    const result = await run({ listening: true, fd });
    assert.equal(result.summary.stopped, true);
    assert.equal(result.summary.run, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.skipped, 2);
    assert.equal(result.summary.ok, true);
    assert(!result.text.includes('kernel marker'));
    assert(!result.text.includes('autoload marker'));
    assert.deepEqual(result.calls.map(call => call.nr), [0x61, 0x62, 6]);
  }

  // Refusal allows the kernel exploit and autoload to run in order.
  const absent = await run();
  assert.equal(absent.summary.run, 3);
  assert.equal(absent.summary.failed, 0);
  assert(!absent.summary.stopped);
  assert(absent.text.indexOf('kernel marker') < absent.text.indexOf('autoload marker'));
  assert.deepEqual(absent.calls.map(call => call.nr), [0x61, 0x62, 6]);

  // An unexpected probe/cleanup failure must not lead to a blind kernel retry.
  for (const options of [{ socketFails: true }, { connectThrows: true },
    { closeThrows: true }, { closeFails: true },
    { listening: true, closeThrows: true }, { listening: true, closeFails: true }]) {
    const result = await run(options);
    assert.equal(result.summary.stopped, true);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.skipped, 2);
    assert(!result.text.includes('kernel marker'));
    assert(!result.text.includes('autoload marker'));
    assert.equal(result.calls.filter(call => call.nr === 6).length, options.socketFails ? 0 : 1);
  }
  console.log('ELF loader check passed: accepted sockets stop the queue; refused sockets continue; no data sent; descriptors closed; unexpected failures stop safely.');
})().catch(error => { console.error(error); process.exitCode = 1; });
