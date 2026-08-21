# PS5 WebKit Autoloader: Architecture

A persistent entry point for PS5 payloads that runs a WebKit/kernel exploit chain
and autoloads your payloads fully offline. Two exploit chains are bundled and
selected by firmware:

- **umtx2** (FW **1.00–5.50**) — idlesauce's umtx2 exploit.
- **slopkit** (FW **7.00–12.00**) — the slopkit exploit chain.

Both converge on the same result: a `WKAL00001` homescreen app that runs the
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
| `patches/` | The slopkit and umtx2 autoloader patch files |
| `tools/` | Build, version, icon, registry scripts, and dependency downloader |
| `assets/` | Icon source and PS5 app metadata templates |
| `third_party/` | `slopkit`, `umtx2`, `ps5-elfldr` and `ps5-unified-autoloader` submodules (pinned) |

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
  same-origin iframe. On load, `app.js` picks the chain from the firmware in the
  user-agent (`PlayStation 5/x.xx`): **umtx2** (`umtx2/index.html?autoload=payload.elf`)
  for 1.00–5.50, **slopkit** (`slopkit/slopkit/poops.html?go=1&auto=1&...`) for 7.00–12.00.
  Firmware outside both ranges shows a clean error and never arms the iframe.
- A `FORCE_EXPLOIT` build-time override (or a `?force=` query) bypasses the table so a
  specific chain can be exercised on any firmware for testing; the exploit's own
  firmware guard still applies.
- umtx2 auto-runs its chain via the `on_load_autorun` sessionStorage key (set by
  `app.js` before arming); slopkit runs via its `?go=1&auto=1` query.
- On `window.load` the iframe is armed; at script parse it is blanked to `about:blank` so a
  WebProcess-crash page restore never auto-runs the chain. Before arming, `clearSlopkitState()`
  removes slopkit's one-shot latch and "stopped at …" markers from sessionStorage so every
  launch restarts the full ladder.
- `app.js` mirrors the chain's screen/stage/early/summary into the log (errors, stage changes
  and summary verdicts) and receives the `?autoload` result via `postMessage`.

`payload.elf` is a virtual name: the PC host serves the installer ELF there, the homescreen app
serves the real unified-autoloader. Both exploits autoload the same `payload.elf`. umtx2 (FW
1.00–5.50) boots its **own bundled elfldr** (`/app/<version>/umtx2/payloads/elfldr-ps5.elf`, kept
from the umtx2 submodule like stock umtx2); slopkit (7.00–12.00) boots the **shared elfldr**
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
  `slopkit-prepare`, `umtx2-prepare`, `payload-deps`, `version`, `icons`, `clean`.
- `tools/gen_file_registry.py` walks the staged `frontend/dist/`, compresses each file (raw
  DEFLATE) and emits the C registry + the AppCache manifest. It pins the version from the
  staging handoff (`dist/VERSION`), writes the `__complete__` marker, substitutes the tokens
  in the pointer page and the app's versioned `index.html`, lists the pointer and marker LAST
  in the manifest, and replaces the `[[EXPLOIT_MODE]]` token in `app.js` from the
  `FORCE_EXPLOIT` env (default `auto`). Unused exploit payloads and assets are filtered out.
- `build_release.sh` builds the ELF in a Dockerized SDK and the host script; CI
  (`.github/workflows/release.yml`) produces the versioned artifacts and the Windows `.exe`.
  `FORCE_EXPLOIT` is forwarded into the Docker build explicitly.

## Slopkit integration

`slopkit` is a pinned, **pristine** submodule. The build copies it to the gitignored
`frontend/autoloader/slopkit/` and applies `patches/slopkit-autoload.patch` there
(`tools/apply_slopkit_patch.sh`, run automatically by the Makefile).

The patch (in `slopkit/slopkit/poops.html` and `slopkit/slopkit/poops.js`):

- `?autoload=<name>`: after the chain finishes and elfldr is up, sends the named payload from
  `../../payloads/`. Upstream's `exactQuery()` (which refuses non-canonical URLs) is relaxed to
  tolerate the extra `autoload` query key, and the iframe URL is the canonical production query
  (`go=1&auto=1&production=1&trigger=netcontrol&attempts=8&only=<full ladder>&log=debug&payload=1`)
  plus `autoload=payload.elf&v=final`.
- A hidden `payload.elf` entry in slopkit's `PAYLOADS` list so `payloadIsListed()` accepts it.
- Posts `{type:"wkal", kind:"autoload", ok, bytes}` to the parent page.
- Loads the **shared elfldr** from `../../shared/elfldr-ps5.elf` instead of its bundled copy
  (the kexp shellcode stays slopkit's own — it is firmware-specific).

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

## Shared elfldr

slopkit boots the **shared** elfldr, served at `/app/<version>/shared/elfldr-ps5.elf` (staged
from `frontend/autoloader/shared/`). `tools/download_deps.sh` fetches it from the pinned
`itsPLK/ps5-elfldr` release (tag `ELFLDR_TAG`), sha256-verifies it, and caches the digest in a
`.sha256` sidecar so offline rebuilds work. umtx2 (FW 1.00–5.50) boots its **own** elfldr from
the umtx2 submodule instead, matching stock umtx2 behavior. Future shared chain binaries
(e.g. a kexp) can live in the versioned `/app/<version>/shared/` dir too.

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
- Never edit `third_party/slopkit/` or `third_party/umtx2/`, nor the generated
  `frontend/autoloader/slopkit/` / `frontend/autoloader/umtx2/` — edit the patch files instead.
- The pointer page (`frontend/pointer/`) and the manifest ordering are the partial-cache guard:
  keep `__complete__` the LAST cache entry and never reorder it before the pointer.
- After changing `host.py`, rebuild the host (`make host` / `build_release.sh`).
