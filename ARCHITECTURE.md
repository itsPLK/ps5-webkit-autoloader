# PS5 WebKit Autoloader: Architecture

A persistent entry point for PS5 payloads that runs a WebKit/kernel exploit chain
and autoloads your payloads fully offline. Four exploit chains are bundled and
selected by firmware:

- **umtx2** (FW 1.00–5.50) — idlesauce umtx2 chain (`umtx2/`).
- **relapse** (FW 7.00–13.60) — ntfargo Relapse-Exploit chain (`relapse/`). **The
  default chain** for the 7.00+ range.
- **poops** (FW 7.00–12.00) — slopkit poops chain (`slopkit/poops.html`). Fallback
  for the two firmwares Relapse doesn't list (9.05, 11.40); otherwise force-only.
- **p2jb** (FW 12.02–12.70) — slopkit P2JB chain (`slopkit/p2jb.html`). Takes ~1
  hour; superseded by relapse, force-only.

All four converge on the same result: a `WKAL00001` homescreen app that runs the
exploit, boots elfldr, and autoloads your payload through it.

## Repository layout

| Path | Purpose |
|---|---|
| `frontend/autoloader/` | The autoloader UI, served by both the installer and the PC host |
| `frontend/installer-page/` | Wrapper page that drives the one-time AppCache caching |
| `frontend/pointer/` | Stable `/app/index.html` entry that verifies the cache and points into the versioned app dir |
| `pc-host/` | The PC host script (`host.py`) + overrides for the bootstrap flow |
| `src/` | Native installer ELF (HTTP server, app installer, browser launcher) |
| `include/` | Headers, incl. generated `wkali_version.h` and `file_registry.{h,c}` |
| `patches/` | The slopkit, umtx2 and relapse autoloader patch files |
| `tools/` | Build, version, icon, registry scripts, and dependency downloader |
| `assets/` | Icon source and PS5 app metadata templates |
| `third_party/` | `slopkit`, `umtx2`, `relapse`, `ps5-elfldr` and `ps5-unified-autoloader` submodules (pinned) |

## Two setup flows

**Installer ELF (already jailbroken).** Send `webkit-autoloader-installer_v*.elf` to the console
(elfldr or Payload Manager). It opens the browser once to cache the frontend via AppCache,
creates the `WKAL00001` app only after that cache succeeds, then exits. From then on the app
runs the chain offline from the cache.

**PC host (not jailbroken).** Run `webkit-autoloader-host_v*.py` / `.exe` on a PC, point the
console's DNS at it, and open the User's Guide. The host spoofs `manuals.playstation.net`
(DNS + self-signed HTTPS) and serves the same frontend, but autoloads the **installer ELF**
instead of the unified-autoloader — so this flow installs the homescreen app.

## Frontend (`frontend/autoloader/`)

- A splash screen, a log terminal and a progress bar. The exploit runs in a **hidden**
  same-origin iframe. On load, `app.js` picks the chain from the firmware in
  the user-agent (`PlayStation 5/x.xx`): **umtx2** for 1.00–5.50, **relapse** for
  7.00–13.60 (the default for the 7.00+ range), and **poops** as the fallback for the
  two firmwares Relapse doesn't list (9.05, 11.40). p2jb is a force-only fallback.
- A `FORCE_EXPLOIT` build-time override (`auto | umtx2 | relapse | poops | p2jb`; or a
  `?force=` query) bypasses the table so a specific chain can be exercised on any
  firmware; the exploit's own firmware guard still applies.
- umtx2 auto-runs its chain via the `on_load_autorun` sessionStorage key (set by
  `app.js` before arming); relapse auto-runs on load (no `?go=` needed); poops and p2jb
  run via their `?go=1&auto=1` query.
- On `window.load` the iframe is armed; at script parse it is blanked to `about:blank` so a
  WebProcess-crash page restore never auto-runs the chain. Before arming, `clearSlopkitState()`
  removes the slopkit one-shot latch and "stopped at …" markers from sessionStorage (shared
  `slopkit-poops:*` keys used by both chains) so every launch restarts the full chain.
- `app.js` mirrors each chain's screen/stage/early/summary into the log (errors, stage changes
  and summary verdicts) and receives the `?autoload` result via `postMessage`. For p2jb it
  additionally parses the exploit's pinned `#livestat` readout (upstream repaints it at 1 Hz)
  and renders a dedicated statistics panel (`#p2jbStats`) below the log with phase and overall
  progress bars, clocks, and live worker metrics. While visible, the panel replaces the slim
  progress bar and collapses once the payload is sent. All DOM updates are change-guarded and
  polling synchronizes with upstream's 1 Hz ticker so UI updates do not contend with exploit execution.

`payload.elf` is a virtual name: the PC host serves the installer ELF there, the homescreen app
serves the real unified-autoloader. All exploits autoload the same `payload.elf`. umtx2 (FW
1.00–5.50) boots its **own bundled elfldr** (`/app/<version>/umtx2/payloads/elfldr-ps5.elf`, kept
from the umtx2 submodule like stock umtx2); poops and p2jb (7.00–12.70) boot the **shared elfldr**
(`/app/<version>/shared/elfldr-ps5.elf`).

## Native installer (`src/`)

A PS5 payload running a `libmicrohttpd` server on port **18181**:

1. Serves the staged frontend: installer-page at `/`, the pointer at `/app/index.html`
   and the versioned autoloader at `/app/<version>/`.
2. Frontend files are embedded **compressed** (raw DEFLATE via `src/inflate.c`, the vendored
   puff) and inflated on demand.
3. The browser caches everything through `cache.appcache`, then hits `/install`. The ELF
   installs/updates the `WKAL00001` homescreen app and shuts down only after the cache is
   confirmed complete. If the user closes the browser mid-load, no `/install` is ever hit,
   so no shortcut is created/updated and the previously-installed version stays untouched (the
   installer process simply keeps running until a subsequent run kills it). The master URL
   carries `?v=<version>` so stale cached entries are avoided.
4. The app's `deeplinkUri` is the stable pointer `http://127.0.0.1:18181/app/index.html`.

### Cache layout and partial-cache protection

The staged autoloader lives under `/app/<full-version>/` (see the Makefile staging rule), so
every build's assets have version-unique URLs. This, plus two generated extras, protects the
cache against a user closing the browser mid-download:

- **Versioned app dir** (`/app/<version>/…`): an interrupted *update* can never clobber the
  files the currently-installed version points at — they live at their own URLs. An
  interrupted first cache never creates a shortcut at all, because the app is only installed
  after `/install` fires.
- **Pointer page** (`/app/index.html`, generated from `frontend/pointer/`): the stable
  deeplink target. It fetches the version's `__complete__` marker and only then redirects
  into `/app/<version>/index.html`; on a mismatch it shows "Cache incomplete" instead of
  loading a broken chain.
- **`__complete__` marker** (`/app/<version>/__complete__`, content = the full version): the
  **last** entry of the AppCache `CACHE:` section. If the marker is cached (with matching
  content), every file listed before it was downloaded — so the pointer can only ever point
  at a fully-cached directory.

Because the exploit iframe URLs, `payloads/`, `shared/`, slopkit's `../../` paths and the app
entry page's own `style.css`/`app.js`/`logo.svg`/`favicon.svg` references are all relative
(never `/app/...` absolute), `app.js`, the exploit patches and the app pages are untouched by
the versioned layout and resolve correctly under `/app/<version>/`, on the PC host and in the
dev server.

## PC host (`pc-host/host.py`)

- Binds DNS port 53 and HTTPS port 443 (both required). A self-signed certificate is generated
  on the fly with `openssl`.
- Redirects `manuals.playstation.net` to the PC and blocks other telemetry domains; the User's
  Guide URL is mapped to the served frontend.
- The frontend (+ filtered slopkit assets) is embedded in the script as a base64 zip and served
  from memory. `HOST_PAYLOAD` replaces the autoload payload with the installer ELF.

## Build system

- `make`: `all` (ELF), `host` (standalone host script), `dev` (local preview server),
  `slopkit-prepare`, `umtx2-prepare`, `relapse-prepare`, `payload-deps`, `version`,
  `icons`, `clean`.
- `tools/gen_file_registry.py` walks the staged `frontend/dist/`, compresses each file (raw
  DEFLATE) and emits the C registry + the AppCache manifest. It pins the version from the
  staging handoff (`dist/VERSION`), writes the `__complete__` marker, substitutes the tokens
  in the pointer page and the app's versioned `index.html`, lists the pointer and marker LAST
  in the manifest, and replaces the `[[EXPLOIT_MODE]]` token in `app.js` from the
  `FORCE_EXPLOIT` env (`auto | umtx2 | relapse | poops | p2jb`, default `auto`). Unused exploit payloads
  and assets are filtered out.
- `build_release.sh` builds the ELF in a Dockerized SDK and the host script; CI
  (`.github/workflows/release.yml`) produces the versioned artifacts and the Windows `.exe`.
  `FORCE_EXPLOIT` is forwarded into the Docker build explicitly.

## Slopkit integration

`slopkit` is a pinned, **pristine** submodule. The build copies it to the gitignored
`frontend/autoloader/slopkit/` and applies `patches/slopkit-autoload.patch` there
(`tools/apply_slopkit_patch.sh`, run automatically by the Makefile). Its bundled `payloads/`
dir is embedded as-is apart from the unused `.elf` files it ships — the registry/host filters
keep only `kexp*.bin` from it, so bumping the submodule never requires script changes.

The patch (in `slopkit/slopkit/poops.html`, `poops.js` and `p2jb.html`):

- `?autoload=<name>`: after the chain finishes and elfldr is up, sends the named payload from
  `../../payloads/`. Upstream's `exactQuery()` (which refuses non-canonical URLs) is relaxed in
  both pages to tolerate the extra `autoload` query key. The iframe URLs are the canonical
  production queries — poops (`go=1&auto=1&production=1&trigger=netcontrol&attempts=8&only=<full
  ladder>&log=debug&payload=1`) plus `autoload=payload.elf&v=final`, p2jb
  (`go=1&auto=1&production=1&log=debug&payload=1`) plus the same autoload suffix.
- A hidden `payload.elf` entry in each page's `PAYLOADS` list so `payloadIsListed()` accepts it.
- Posts `{type:"wkal", kind:"autoload", ok, bytes}` (or `{ok:false, why}`) to the parent page —
  poops from the end of its ladder, p2jb from its `showWin()` win handler after a 4 s wait for
  elfldr to bind port 9021.
- Loads the **shared elfldr** instead of the bundled copies: poops fetches
  `../../shared/elfldr-ps5.elf` in `poops.js`, and p2jb's `P2JB_ELF_URL` points at the same file.

To update slopkit: `git -C third_party/slopkit fetch && git -C third_party/slopkit checkout <commit>`,
re-run the script, and regenerate the patch if it no longer applies
(`git -C <scratch copy> diff --cached --full-index > patches/slopkit-autoload.patch`). Keep the
offsets cache-bust fallback in `tools/gen_file_registry.py` and the iframe URLs in
`app.js`/`gen_file_registry.py` in sync with upstream's `ROUTE_VERSION`.

## Umtx2 integration

`umtx2` is a pinned, **pristine** submodule. The build copies its `document/en/ps5` directory
(flattened to the copy root, so the exploit serves at `/app/umtx2/`) to the gitignored
`frontend/autoloader/umtx2/` and applies `patches/umtx2-autoload.patch` there
(`tools/apply_umtx2_patch.sh`, run automatically by the Makefile). The bundled payloads dir is
pruned down to `elfldr-ps5.elf` — umtx2 boots its **own** elfldr, exactly like stock umtx2.

The patch (in `umtx2/main.js`):

- Keeps `load_local_elf("elfldr-ps5.elf")` loading umtx2's own `payloads/elfldr-ps5.elf` (stock
  behavior; the shared elfldr is only used by slopkit).
- Adds an optional `base` parameter to `load_payload_into_elf_store_from_local_file` and
  `load_local_elf` so different base paths can be used without duplicating the fetch logic.
- Threads `payload_info.wkalBase` through the main loop's fetch call, so the payload is
  always fetched via the same code path as a regular button press.
- `?autoload=<name>`: after elfldr loads and `switchPage("payloads-view")` completes,
  waits 4 s (it must bind 9021), then fires a synthetic `MAINLOOP_EXECUTE_PAYLOAD_REQUEST`
  event with `{fileName, wkalBase: "../payloads/", toPort: 9021, wkalAutoload: true}`.
  The main loop processes it identically to a button press.
- The main loop's success and error handlers post `{type:"wkal", kind:"autoload", ok, bytes}`
  (or `{ok:false, why}`) to the parent page when `payload_info.wkalAutoload` is set.
- Neutralizes the `confirm()` dialogs around the elfldr probe so the chain runs unattended.

To update umtx2: `git -C third_party/umtx2 fetch && git -C third_party/umtx2 checkout <commit>`,
re-run the script, and regenerate `patches/umtx2-autoload.patch` if it no longer applies. Keep the
`?v=` cache-buster on `UMTX2_IFRAME_URL` in `app.js`/`gen_file_registry.py` in sync.

## Relapse integration

`relapse` is a pinned, **pristine** submodule (`third_party/relapse`, ntfargo's
Relapse-Exploit). The build copies it to the gitignored `frontend/autoloader/relapse/`
and applies `patches/relapse-autoload.patch` there (`tools/apply_relapse_patch.sh`, run
automatically by the Makefile). The copy drops `serve.py`/`README.md`/`LICENSE` (not
needed at runtime) and prunes the bundled `payloads/` dir down to the chain's own
`elfldr-ps5-1360.elf` and `kexp_*.bin` — the three R2-only ELFs
(`kstuff.elf`, `shadowmountplus.elf`, `etaHEN.elf`) are dropped because the autoloader's
`?autoload=` payload comes from the shared `/app/payloads/` dir instead.

The patch (in `relapse/src/main.js` and `relapse/src/kexp.js`):

- `?autoload=<name>` (default `payload.elf`): after the kernel stage boots the ELF loader
  on port 9021, `main()` autoloads that payload from the shared `../payloads/` dir and
  posts `{type:"wkal", kind:"autoload", ok, bytes}` (or `{ok:false, why}`) to the parent
  page. `connectToElfldr()` already retries until the loader is accepting, so no explicit
  wait is needed.
- **Strips the "press R2 to load kstuff/shadowmountplus/etaHEN" flow** (`watchR2` and the
  keydown handler) — the autoloader always arms the page with `?autoload=`, so the chain
  is autoload-only. `loadOptionalPayloads` (the R2 payload sender) is removed with it.
- Adds an exported `autoloadPayload(name, p, chain, log)` in `kexp.js` that reuses the
  existing `mapElf`/`connectToElfldr`/`sendElf` (a `base` param is added to
  `fetchBinary`/`mapElf` so the shared dir can be targeted).
- **Fixes the offset cache-bust**: upstream loads `offsets/<fw>.js?v=<Date.now()>`, a
  dynamic query that defeats AppCache offline serving. The patch pins it to
  `offsets/<fw>.js?v=final`, and `tools/gen_file_registry.py` enumerates every
  `relapse/offsets/*.js?v=final` entry in the manifest (parallel to the slopkit-offsets
  block).

Relapse boots its **own** elfldr (`relapse/payloads/elfldr-ps5-1360.elf`), matching umtx2
(which also boots its own elfldr) — the shared localhost-only elfldr is used by the slopkit
chains only. `runKexp`'s `DEFAULT_ELFLDR`/`DEFAULT_KEXP` paths are unchanged.

To update relapse: `git -C third_party/relapse fetch && git -C third_party/relapse checkout <commit>`,
re-run `tools/apply_relapse_patch.sh`, and regenerate `patches/relapse-autoload.patch` if it
no longer applies. Keep `RELAPSE_FIRMWARES` in `app.js` in sync with `relapse/src/firmware.js`'s
`supportedFirmware` list, and `RELAPSE_URL` in `app.js`/`gen_file_registry.py` in sync.

## Shared elfldr

Both slopkit chains boot the **shared** elfldr, served at `/app/<version>/shared/elfldr-ps5.elf`
(staged from `frontend/autoloader/shared/`). `tools/download_deps.sh` fetches it from the pinned
`itsPLK/ps5-elfldr` release (tag `ELFLDR_TAG`), sha256-verifies it, and caches the digest in a
`.sha256` sidecar so offline rebuilds work. umtx2 (FW 1.00–5.50) and relapse (FW 7.00–13.60)
boot their **own** elfldr from their respective submodules instead (umtx2 like stock umtx2;
relapse uses `relapse/payloads/elfldr-ps5-1360.elf`), matching each chain's stock behavior.

## Payload dependency

`tools/download_deps.sh` (the Makefile's `payload-deps` target) downloads
`frontend/autoloader/payloads/payload.elf` from the `ps5-unified-autoloader` submodule's pinned
GitHub release, sha256-verifies it, and caches the digest in a `.sha256` sidecar so offline
rebuilds work. Bump the submodule to pick up a newer release.

## Versioning

The base version lives in `include/wkali.h` (`WKAL_VERSION`). `tools/gen_version.py` produces
the full version — `<base>` for stable (`BUILD_TYPE=stable`) or `<base>-dev-<suffix>` for dev —
and regenerates `include/wkali_version.h`, `assets/param.json` and the version placeholders in
the pages. The full version also names the staged app directory (`/app/<version>/`), the
pointer page's redirect/marker targets and the `__complete__` content, so the whole cache
layout is version-keyed. It ends up in the installer ELF, the host banner and the artifact
names.

## Conventions

- The ELF serves the autoloader under `/app/<version>/`; the PC host maps `/app/` to its root.
- Never put `manifest="..."` on the autoloader page — caching is the installer page's job.
- Never edit `third_party/slopkit/`, `third_party/umtx2/` or `third_party/relapse/`, nor the
  generated `frontend/autoloader/slopkit/` / `frontend/autoloader/umtx2/` /
  `frontend/autoloader/relapse/` — edit the patch files instead.
- The pointer page (`frontend/pointer/`) and the manifest ordering are the partial-cache guard:
  keep `__complete__` the LAST cache entry and never reorder it before the pointer.
- After changing `host.py`, rebuild the host (`make host` / `build_release.sh`).
