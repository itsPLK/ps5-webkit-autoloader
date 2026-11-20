# WebKit Autoloader architecture

This repository installs an offline homescreen app and bundles a modular HTML
page built by `third_party/ps5-webkit-remote-loader`. Remote-loader owns WebKit,
the Wobkot firmware implementation, native-call ROP, Relapse, Poops, and the payload runtime.
It also owns the shared native installer helpers and SDK Docker recipe. This
repository provides `include/installer_config.h` for its app name, title ID,
assets and log prefix. Remote-loader has no dependency on this repository.
The installer provides a cache progress bar and automatically caches the
autoloader page without requiring user intervention. The exploit runs directly in the
modular page, without an iframe or generated-code patches.

## Runtime

`tools/build_modular_page.py` stages the modular frontend directory (`index.html`,
`style.css`, `app.js`, `src/`, `vendor/wobkot/`, `offsets/`, `shared/`,
`payloads/`, and the payload ELF).
The entry page (`index.html`) is lightweight (~1.3 KB), while all scripts, Wobkot
firmware data, and binary payloads are pre-cached individually via HTML5 AppCache (`cache.appcache`)
and requested via standard relative URLs. This keeps the JavaScript heap virtually empty
when Wobkot starts, avoiding Out-Of-Memory (OOM) crashes on the PS5.

The autoloader runs `payloads/autoloader.js` first as its selection orchestrator:

1. `isElfldrRunning(api)` probes `127.0.0.1:9021` via loopback TCP connect. If an
   ELF loader is already accepting connections, the environment is already active:
   it logs success, skips the kernel exploit and autoload, and exits cleanly.
2. `isJailbroken(api)` probes if the process already has root privileges (`uid 0`
   via `syscall(24)`). If already jailbroken, it skips the kernel exploit and autoload.
3. If exploitation is needed, `selectExploit(api)` applies the automatic policy:
   - **5.00–6.x**: Wobkot Relapse (Poops profiles begin at 7.00)
   - **12.02–13.60**: Wobkot Relapse
   - **7.00–12.00 with an active network interface**: Wobkot Relapse
   - **7.00–12.00 offline**: Poops
4. The orchestrator pre-fetches the chosen exploit code, `payloads/autoload.js`,
   and the target payload ELF before running the kernel exploit. Wobkot's deferred
   scripts and binaries are separate AppCache entries.
5. The orchestrator executes the chosen exploit via `await api.executePayload(exploitCode)`.
   Both choices share Wobkot's userland and on-screen logging. Poops lazily starts
   its isolated worker-chain backend only when selected. The exploit performs
   jailbreak patching and starts `elfldr` on port 9021.
6. The orchestrator then executes `autoload.js` via
   `await api.executePayload(autoloadCode, [elfName, elfBytes])`, which stages the pre-fetched
   ELF into anonymous memory and streams it to `elfldr` on loopback port 9021.

The installation and dispatch flow is fully automated:

1. The installer page loads. On all supported firmwares (5.00–13.60), caching
   starts immediately without user intervention or manual exploit pickers.
2. The server withholds `manifest="/cache.appcache"` only when the requesting
   firmware is unsupported, stopping AppCache before it begins. Supported
   firmwares are served with the attribute immediately.
3. The modular files are downloaded individually into AppCache.
4. Once the cache completes, the page checks the `__complete__` marker and calls
   `/install` to create the homescreen shortcut.
5. On subsequent launches from the homescreen, the pointer page (`/app/index.html`)
   checks cache completeness and navigates directly to `/app/<version>/index.html`.

The server's only selection logic is deciding per request whether to include the
`manifest="/cache.appcache"` attribute on `/index.html`. It stores no selection state
in memory or C variables.

The Wobkot adapter rejects unsupported firmware before running WebKit. The active
range is 5.00–13.60. Poops' compatibility offsets cover 7.00–13.60; selection
uses it only through 12.00. The former Lua translation layer is not packaged.

## Build

The build stages the upstream remote-loader sources without patching them:

- `make page`: verify/download dependencies, then stage remote-loader's Wobkot
  runtime, Poops compatibility assets, both exploit payloads, `autoloader.js`,
  `autoload.js`, and the target ELF into `build/autoloader/`.
- `make all`: stage the installer page, stable pointer and generated HTML; generate
  a compressed C registry and AppCache manifest; compile `installer.elf` with the
  PS5 SDK. Both installers compile remote-loader's `installer/common` sources;
  product-specific main loops and HTTP routing stay in their own repositories.
  Docker provides the SDK and libmicrohttpd from remote-loader's Docker recipe.
- `make host HOST_PAYLOAD=<installer.elf>`: build the modular setup page carrying
  that installer, then package it via remote-loader's `tools/build_host.py` into
  `webkit-autoloader-host.py`.
  Use a versioned ELF path outside the native `installer.elf` target when building
  the host on a machine without the SDK.
- `make dev`: serve the generated page on localhost:8123.
- `make clean`: remove generated pages, registry and unversioned artifacts; retain
  verified downloads in `build/deps/` for offline rebuilds.

`frontend/autoloader/style.css` and `app.js` provide the log panel, progress bar,
and status footer on the autoloader page and the PC setup page. The script moves the existing console into the panel and observes
its log lines for progress; it never wraps the exploit or replaces its APIs.
Completion waits for the queue summary, including payload cleanup. An existing
ELF loader is shown as already running, and failures stay visible in the log.
The page template supplies the footer's version and build time. No external web
resources are required after the AppCache installation completes.

`tools/download_deps.sh` downloads the pinned itsPLK elfldr and unified-autoloader
release assets, caching verified digest sidecars. kexp is the binary bundled by
remote-loader. Initialize submodules recursively because remote-loader pins Wobkot
as its own submodule:

```sh
git submodule update --init --recursive
```

`build_release.sh` pins `BUILD_VERSION` once across Docker, HTML/cache generation,
and PC host packaging, then writes versioned ELF/Python artifacts. GitHub Actions
also packages the Python host as a Windows executable.

The target payload ELF is copied into the modular AppCache tree: unified-autoloader
for offline pages, or the installer ELF for the PC setup host.

## Offline installation

The installer serves on `127.0.0.1:18181` only. On all supported firmwares
(5.00–13.60), caching begins immediately without manual selection prompts. The
page displays AppCache download progress and calls `/install` once caching completes
(`cached`, `noupdate`, or `updateready`). The unified autoloader page (`index.html`)
is cached. The installer validates the version marker before creating the homescreen
shortcut. Cache errors leave the installer running and offer a user-confirmed
WebKit-data clear; the native installer then reopens the browser to retry.

The cache layout is:

```text
/index.html                  installer/cache entry
/logo.svg                    installer logo asset
/cache.appcache              generated manifest
/app/index.html              stable homescreen pointer
/app/<version>/index.html    unified autoloader page (orchestrator + exploit assets)
/app/<version>/__complete__  version marker, last in CACHE
```

The pointer checks the marker before navigating, then navigates to `/app/<version>/index.html`.
Partial cache downloads cannot start the app. The HTTP server serves the modular
files verbatim. It withholds the installer's manifest attribute only when the requesting
firmware is unsupported, stopping AppCache before it begins.

`SIMULATE=1|2` and `tools/build_cache_corruption_test_elfs.sh` are available for
hardware testing of failed-cache repair.

## Verification

`make test-native` runs remote-loader's common native helper tests on Linux (or
inside the SDK container). PS5 services are stubbed and all `/user` filesystem
operations are redirected into a temporary tree. The tests cover installation
and updates with two app configurations, embedded resources, service errors,
notifications, browser launch, foreground-user cleanup, long-log truncation and
raw DEFLATE. Native ELF compilation still uses the PS5 SDK.

`make test` runs five offline suites. `tools/test_modular_build.py` verifies a clean
Wobkot staging tree with Poops' isolated compatibility assets and no Lua runtime.
`tools/test_elfldr_check.js` verifies
the loopback probe and queue-stop behavior. `tools/test_autoload_payload.js` covers
the final payload: ELF staging, hand-off to elfldr, short socket writes, and cleanup.
`tools/test_installer.js` checks the installer's cache events, the marker gate,
immediate automatic caching on bare load, error handling, repair confirmation and
pointer redirection.
`tools/test_selection_flow.js` checks that automatic caching begins across all
supported firmwares, that unsupported firmwares are gated and rejected, that the
pointer routes to `index.html`, that `selectExploit()` follows the firmware/network
policy, that `autoloader.js` runs first and refuses to execute the final
`autoload.js` handoff after an exploit failure, and that the modular Wobkot files
are staged and cached. `SIMULATE=1|2` builds and
`tools/build_cache_corruption_test_elfs.sh` cover failed-cache repair.

None of this can establish exploit reliability; that needs a PS5 hardware run.
