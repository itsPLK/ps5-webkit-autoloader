# WebKit Autoloader architecture

This repository installs an offline homescreen app and bundles a standalone HTML
page built by `third_party/ps5-webkit-remote-loader`. Remote-loader owns WebKit,
firmware offsets, the ROP worker, Poops, Relapse, and the standalone runtime.
It also owns the shared native installer helpers and SDK Docker recipe. This
repository provides `include/installer_config.h` for its app name, title ID,
assets and log prefix. Remote-loader has no dependency on this repository.
The installer provides a cache progress bar and automatically caches the
autoloader page without requiring user intervention. The exploit runs directly in the
standalone page, without an iframe or generated-code patches.

## Runtime

`tools/build_modular_page.py` stages the modular frontend directory (`index.html`,
`style.css`, `app.js`, `src/`, `offsets/`, `shared/`, `payloads/`, and the payload ELF).
The entry page (`index.html`) is lightweight (~1.3 KB), while all scripts, firmware
offsets, and binary payloads are pre-cached individually via HTML5 AppCache (`cache.appcache`)
and requested via standard relative URLs. This keeps the JavaScript heap virtually empty
when `src/webkit.js` starts, avoiding Out-Of-Memory (OOM) crashes on the PS5.

The autoloader runs `payloads/autoloader.js` as its entry orchestrator payload:

1. `isElfldrRunning(api)` probes `127.0.0.1:9021` via loopback TCP connect. If an
   ELF loader is already accepting connections, the environment is already active:
   it logs success, skips the kernel exploit and autoload, and exits cleanly.
2. `isJailbroken(api)` probes if the process already has root privileges (`uid 0`
   via `syscall(24)`). If already jailbroken, it skips the kernel exploit and autoload.
3. If exploitation is needed, `selectExploit(api)` automatically selects the best
   exploit based on firmware version and network status:
   - **FW > 12.00 and FW <= 13.60**: `payloads/lua/relapse.lua` (Poops does not support > 12.00)
   - **FW == 9.05**: `payloads/poops.js` (Relapse does not support 9.05)
   - **Active network connection (`navigator.onLine`)**: `payloads/lua/relapse.lua` (faster, reliable)
   - **Offline (FW <= 12.00)**: `payloads/poops.js` (works without active network connection)
4. The orchestrator pre-fetches the chosen exploit code, `payloads/autoload.js`, and the target
   payload ELF into memory *before* running the kernel exploit, ensuring no post-kernel network
   requests are needed.
5. The orchestrator executes the chosen exploit via `await api.executePayload(exploitCode)`.
   This shares the underlying ROP chain, WebKit memory primitive, kernel R/W handle (`api.krw`),
   and on-screen logging. For `relapse.lua`, the WebAssembly Lua runtime VM executes the script
   and brings up `elfldr` on 9021.
6. The orchestrator then executes `autoload.js` via
   `await api.executePayload(autoloadCode, [elfName, elfBytes])`, which stages the pre-fetched
   ELF into anonymous memory and streams it to `elfldr` on loopback port 9021.

The installation and dispatch flow is fully automated:

1. The installer page loads. On all supported firmwares (7.00–13.60), caching
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

The upstream firmware table rejects unsupported firmware before running WebKit.
Supported versions are the remote-loader offset tables in the 7.00–13.60 range.
Poops works without an active network interface; Relapse needs a connected local
network interface, but no Internet access.

## Build

`Makefile` calls the upstream builders without transforming their output:

- `make page`: verify/download dependencies, then call `tools/build_standalone.py`
  with `payloads/autoloader.js::<payload_elf>`, `--elfldr`, and `--embed` for
  `poops.js`, `relapse.lua`, `autoload.js`, and the payload ELF.
  Output: `build/autoloader/index.html`.
- `make all`: stage the installer page, stable pointer and generated HTML; generate
  a compressed C registry and AppCache manifest; compile `installer.elf` with the
  PS5 SDK. Both installers compile remote-loader's `installer/common` sources;
  product-specific main loops and HTTP routing stay in their own repositories.
  Docker provides the SDK and libmicrohttpd from remote-loader's Docker recipe.
- `make host HOST_PAYLOAD=<installer.elf>`: build a single standalone setup page
  embedding that installer, then package it via remote-loader's `tools/build_host.py`
  into `webkit-autoloader-host.py`. At runtime, the single setup page auto-dispatches
  the optimal exploit based on FW and network.
  Use a versioned ELF path outside the native `installer.elf` target when building
  the host on a machine without the SDK.
- `make dev`: serve the generated page on localhost:8123.
- `make clean`: remove generated pages, registry and unversioned artifacts; retain
  verified downloads in `build/deps/` for offline rebuilds.

`PAGE_CSS` and `PAGE_JS` default to `frontend/autoloader/style.css` and `app.js`,
providing the log panel, progress bar, and status footer on the autoloader page and the
PC setup page. The script moves the existing console into the panel and observes
its log lines for progress; it never wraps the exploit or replaces its APIs.
Completion waits for the queue summary, including payload cleanup. An existing
ELF loader is shown as already running, and failures stay visible in the log.
`tools/gen_version.py --page-config` supplies the footer's version and build time
as an inline startup script. No additional network resources are needed.

Override `PAGE_CSS` and `PAGE_JS` to pass other files to the upstream HTML builder.
CSS is embedded after the default styles in the
head. Each JavaScript file runs in its own async function before module boot and
the exploit; use top-level `await` or return a promise for work that must finish
first. Multiple files run in argument order, and startup errors stop boot.

```sh
make page PAGE_CSS=path/to/theme.css PAGE_JS=path/to/setup.js
# Or build the upstream plain console:
make page PAGE_CSS= PAGE_JS=
```

The variables accept whitespace-separated lists of paths relative to the working
directory. Startup scripts can prepare the DOM and share state through `window`;
they have no payload `api`. Inline assets needed during offline startup. This
keeps appearance changes in CSS/JS files here instead of rewriting generated HTML
or changing the exploit sources.

`tools/download_deps.sh` downloads the pinned itsPLK elfldr and unified-autoloader
release assets, caching verified digest sidecars. kexp is the binary bundled by
remote-loader. Submodule initialization is non-recursive: remote-loader's nested
copy of this repository is not a build input.

`build_release.sh` pins `BUILD_VERSION` once across Docker, HTML/cache generation,
and PC host packaging, then writes versioned ELF/Python artifacts. GitHub Actions
also packages the Python host as a Windows executable.

Remote-loader changes live on `refactor/minimal-autoloader`: `--embed URL=FILE`
adds inline fetch resources, `--elfldr [URL=]FILE` overrides the loader binary without
editing generated HTML, and the host builder accepts `--page` and `--name`.
Its probe verifies embedded file sizes and input digests, including external assets.

The target payload ELF (`ps5-unified-autoloader` for offline autoloader pages, or
the installer ELF for the PC setup host) is embedded via `--embed`.

## Offline installation

The installer serves on `127.0.0.1:18181` only. On all supported firmwares
(7.00–13.60), caching begins immediately without manual selection prompts. The
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
/app/<version>/index.html    unified autoloader page (orchestrator + embedded exploits & payload)
/app/<version>/__complete__  version marker, last in CACHE
```

The pointer checks the marker before navigating, then navigates to `/app/<version>/index.html`.
Partial cache downloads cannot start the app. The HTTP server serves the standalone
page verbatim. It withholds the installer's manifest attribute only when the requesting
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

`make test` runs the four offline suites. `tools/test_elfldr_check.js` drives the
real check payload through the upstream queue, verifying accepted/refused sockets,
descriptor cleanup, and skipping the remaining payloads on a stop or unexpected
probe failure. `tools/test_autoload_payload.js` covers
the third payload: ELF staging into the mapping, the hand-off to elfldr, short
socket writes, the missing-`krw` refusal and cleanup on failure.
`tools/test_installer.js` checks the installer's cache events, the marker gate,
immediate automatic caching on bare load, error handling, repair confirmation and
pointer redirection.
`tools/test_selection_flow.js` checks that automatic caching begins across all
supported firmwares, that unsupported firmwares are gated and rejected, that the
pointer routes to `index.html`, that `selectExploit()` in `autoloader.js` automatically
selects the optimal exploit based on firmware and network status, that the orchestrator
skips when elfldr/root is already active, and that the single standalone `index.html`
page is staged and cached.

Upstream `third_party/ps5-webkit-remote-loader/tools/probe_standalone.js` and
`tools/boot_probe.js` check the generated HTML, inline resources, modules, firmware
offsets and boot order. `SIMULATE=1|2` builds and
`tools/build_cache_corruption_test_elfs.sh` cover failed-cache repair.

None of this can establish exploit reliability; that needs a PS5 hardware run.
