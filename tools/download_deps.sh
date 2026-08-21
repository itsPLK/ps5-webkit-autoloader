#!/usr/bin/env bash
# Download the shared ps5-elfldr ELF and the ps5-unified-autoloader payload
# ELF from their GitHub releases, pinned to the third_party/ submodules.
#
#   third_party/ps5-elfldr             -> frontend/autoloader/shared/elfldr-ps5.elf
#   third_party/ps5-unified-autoloader -> frontend/autoloader/payloads/payload.elf
#
# The shared elfldr is used by the slopkit chain (7.00-12.00); umtx2
# (1.00-5.50) boots its own elfldr from the umtx2 submodule, like stock umtx2.
# The unified-autoloader payload is the "bundled" ELF embedded in the installer:
# after install, the homescreen app runs the exploit chain and autoloads it from
# the local AppCache.
#
# Neither is rebuilt here — both ship as prebuilt release assets (same approach
# as ps5-y2jb-autoloader's scripts/download_deps.sh), pinned to the submodule
# commits so builds are reproducible: bump the submodule to bump the payload.
#
# The elfldr tag is pinned explicitly (not via git describe) because ps5-elfldr
# tags multiple builds against one commit and describe picks an older tag; keep
# ELFLDR_TAG in sync when bumping third_party/ps5-elfldr.
#
# Idempotent: skips assets that already exist and match their cached sha256.
# The Makefile runs this automatically (payload-deps) before staging the
# frontend and building the PC host.
#
# Uses only python3 (a build dependency already) — no curl required, so it
# also runs inside the Docker SDK image.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Shared elfldr (same ELF across all exploit chains)
ELFLDR_SUBMODULE="$ROOT/third_party/ps5-elfldr"
ELFLDR_REPO="itsPLK/ps5-elfldr"
ELFLDR_TAG="v0.24-148b71c"
ELFLDR_DEST="$ROOT/frontend/autoloader/shared/elfldr-ps5.elf"

# Bundled autoload payload
PAYLOAD_SUBMODULE="$ROOT/third_party/ps5-unified-autoloader"
PAYLOAD_REPO="itsPLK/ps5-unified-autoloader"
PAYLOAD_DEST="$ROOT/frontend/autoloader/payloads/payload.elf"

# Fetch the pinned release, verify the payload, and download it if needed.
# Exit codes: 0 = asset ready, 3 = already present and verified.
download_release() {
    local repo="$1" tag="$2" dest="$3"
    python3 - "$repo" "$tag" "$dest" <<'PY'
import hashlib
import json
import os
import sys
import time
import urllib.request

repo, tag, dest = sys.argv[1], sys.argv[2], sys.argv[3]
sidecar = dest + ".sha256"  # "<tag> <sha256>" cached after a successful verify

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

# Offline fast path: asset + sidecar from a previous successful run.
if os.path.isfile(dest) and os.path.isfile(sidecar):
    with open(sidecar) as f:
        try:
            st_tag, st_hash = f.read().split()
        except ValueError:
            st_tag, st_hash = "", ""
    if st_tag == tag and sha256_of(dest) == st_hash:
        print(f"{os.path.basename(dest)} already present and verified ({tag}).")
        sys.exit(0)
    print("Existing asset does not match the pinned release - re-checking...")

def fetch(url, attempts=5):
    """Fetch a URL, tolerating GitHub's flaky release CDN.

    Two things break urllib against github.com release downloads:
      - http.client adds `Accept-Encoding: identity` when unset, and the asset
        CDN (release-assets.githubusercontent.com) deterministically drops those
        connections. We send `gzip` and decompress by hand.
      - The CDN also intermittently closes connections before responding, so we
        retry with a short backoff.
    """
    import gzip

    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={
            "User-Agent": "ps5-webkit-autoloader-build",
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                    data = gzip.decompress(data)
                return data
        except Exception as exc:
            last = exc
            time.sleep(1 + i)
    raise last

try:
    release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/tags/{tag}"))
except Exception as exc:
    print(f"Error: could not fetch release {tag} ({exc}).", file=sys.stderr)
    sys.exit(1)

asset = None
for a in release.get("assets", []):
    if a.get("name", "").endswith(".elf"):
        asset = a
        break
if asset is None:
    print(f"Error: release {tag} has no .elf asset.", file=sys.stderr)
    sys.exit(1)

digest = asset.get("digest", "")
digest = digest.split(":", 1)[-1] if ":" in digest else digest

# Already downloaded and matching the pinned release? Just cache the digest.
if os.path.isfile(dest) and digest and sha256_of(dest) == digest:
    with open(sidecar, "w") as f:
        f.write(f"{tag} {digest}\n")
    print(f"{os.path.basename(dest)} already present and verified ({tag}).")
    sys.exit(0)

url = asset["browser_download_url"]
print(f"Fetching release metadata for {repo}@{tag}...")
print(f"Downloading {url} ...")
os.makedirs(os.path.dirname(dest), exist_ok=True)
tmp = dest + ".tmp"
try:
    data = fetch(url)
except Exception as exc:
    print(f"Error: download failed ({exc}).", file=sys.stderr)
    sys.exit(1)
with open(tmp, "wb") as f:
    f.write(data)

if digest:
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        os.remove(tmp)
        print(f"Error: sha256 mismatch (got {actual}, expected {digest}).", file=sys.stderr)
        sys.exit(1)
    print(f"sha256 verified: {actual}")

os.replace(tmp, dest)
with open(sidecar, "w") as f:
    f.write(f"{tag} {digest}\n")
print(f"{os.path.basename(dest)} ready ({tag}): {dest}")
PY
}

if [ ! -e "$ELFLDR_SUBMODULE/.git" ]; then
    echo "Error: ps5-elfldr submodule is not initialised."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

if [ ! -e "$PAYLOAD_SUBMODULE/.git" ]; then
    echo "Error: ps5-unified-autoloader submodule is not initialised."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

PAYLOAD_TAG=$(git -C "$PAYLOAD_SUBMODULE" describe --tags --always)

download_release "$ELFLDR_REPO" "$ELFLDR_TAG" "$ELFLDR_DEST"
download_release "$PAYLOAD_REPO" "$PAYLOAD_TAG" "$PAYLOAD_DEST"
