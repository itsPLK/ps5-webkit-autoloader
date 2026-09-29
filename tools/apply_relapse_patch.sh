#!/usr/bin/env bash
# Prepare the Relapse-Exploit copy used by the frontend and apply our
# autoloader patch.
#
# Relapse lives as a pristine git submodule in third_party/relapse (never
# modified). The frontend needs the exploit under frontend/autoloader/relapse,
# so this script:
#   1. copies third_party/relapse -> frontend/autoloader/relapse (fresh copy,
#      dropping serve.py / README.md / LICENSE which are not needed at runtime)
#   2. prunes the bundled payloads dir down to the chain's own elfldr
#      (elfldr-ps5-1360.elf) and kexp (kexp_*.bin). The three R2-only ELFs
#      (kstuff.elf, shadowmountplus.elf, etaHEN.elf) are dropped — the
#      autoloader's ?autoload= payload comes from the shared /app/payloads/
#      dir instead, and the R2 "press to load" flow is not used.
#   3. applies patches/relapse-autoload.patch to the copy
#
# The copy is gitignored (frontend/autoloader/relapse/), so the submodule is
# never dirtied. Run after every submodule update:
#
#   git submodule update --init --recursive
#   tools/apply_relapse_patch.sh
#
# The Makefile runs this automatically before staging/serving (relapse-prepare).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/third_party/relapse"
DEST="$ROOT/frontend/autoloader/relapse"
PATCH="$ROOT/patches/relapse-autoload.patch"

if [ ! -e "$SOURCE/.git" ]; then
    echo "Error: relapse submodule is not initialised."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

if [ ! -f "$PATCH" ]; then
    echo "Error: patch file not found: $PATCH"
    exit 1
fi

# 1. Fresh copy of the exploit root, dropping non-runtime files. Prune the
#    bundled payloads dir down to the chain's own elfldr + kexp (the autoload
#    payload comes from the shared /app/payloads/ dir; the R2-only ELFs are
#    unused).
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SOURCE"/. "$DEST"/
rm -rf "$DEST/.git" "$DEST/.github" "$DEST/.gitignore" "$DEST/serve.py" \
       "$DEST/README.md" "$DEST/LICENSE"
mkdir -p "$DEST/payloads"
rm -f "$DEST/payloads/kstuff.elf" "$DEST/payloads/shadowmountplus.elf" \
      "$DEST/payloads/etaHEN.elf"

# 2. Turn the copy into a throwaway git repo so `git apply` can handle the
#    patch. Two commits: pristine relapse, then our autoloader patch.
SRC_HASH=$(git -C "$SOURCE" rev-parse --short HEAD)
git -C "$DEST" init -q
git -C "$DEST" config user.name "wkal"
git -C "$DEST" config user.email "wkal@localhost"
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "relapse pristine (submodule $SRC_HASH)"

# 3. Apply the patch
cd "$DEST"
if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    git add -A
    git commit -q -m "Apply WKAL autoloader patch"
    echo "relapse: copied to $DEST and autoloader patch applied."
elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "relapse: autoloader patch is already applied."
else
    echo "Error: patch does not apply cleanly to $DEST."
    echo "relapse has likely changed upstream — regenerate patches/relapse-autoload.patch:"
    echo "  (see the regeneration notes in ARCHITECTURE.md)"
    exit 1
fi

# 4. Sanity check: the patched source must carry our integration markers, the
#    R2 handler must be gone, the offset cache-bust must be fixed to ?v=final,
#    and payloads/ must contain only the chain's own elfldr + kexp. Catches a
#    silently truncated patch.
if ! grep -q 'AUTOLOAD_NAME' src/main.js \
    || ! grep -q 'autoloadPayload' src/main.js \
    || ! grep -q 'window.parent.postMessage' src/main.js \
    || ! grep -q 'v=final' src/main.js \
    || grep -q 'watchR2' src/main.js \
    || ! grep -q 'export async function autoloadPayload' src/kexp.js \
    || ! grep -q '"../payloads/"' src/kexp.js \
    || grep -q 'loadOptionalPayloads' src/kexp.js \
    || [ -f payloads/kstuff.elf ] \
    || [ -f payloads/shadowmountplus.elf ] \
    || [ -f payloads/etaHEN.elf ] \
    || ! [ -f payloads/elfldr-ps5-1360.elf ]; then
    echo "Error: relapse patch verification FAILED — integration markers missing."
    echo "patches/relapse-autoload.patch is incomplete or out of date."
    echo "Regenerate it from the pristine submodule and re-run."
    exit 1
fi
echo "relapse: patch verification OK (autoload + wkal postMessage, R2 removed,"
echo "         fixed ?v=final offset cache-bust, own elfldr + kexp kept)."
