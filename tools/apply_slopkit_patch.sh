#!/usr/bin/env bash
# Prepare the slopkit copy used by the frontend and apply our autoloader patch.
#
# slopkit lives as a pristine git submodule in third_party/slopkit (never
# modified). The frontend needs it under frontend/autoloader/slopkit, so this
# script:
#   1. copies third_party/slopkit -> frontend/autoloader/slopkit (fresh copy)
#   2. applies patches/slopkit-autoload.patch to the copy
#
# The copy is gitignored (frontend/autoloader/slopkit/), so the submodule is
# never dirtied. Run after every submodule update:
#
#   git submodule update --init --recursive
#   tools/apply_slopkit_patch.sh
#
# The Makefile runs this automatically before staging/serving (slopkit-prepare).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/third_party/slopkit"
DEST="$ROOT/frontend/autoloader/slopkit"
PATCH="$ROOT/patches/slopkit-autoload.patch"

if [ ! -e "$SOURCE/.git" ]; then
    echo "Error: slopkit submodule is not initialised."
    echo "Run: git submodule update --init --recursive"
    exit 1
fi

if [ ! -f "$PATCH" ]; then
    echo "Error: patch file not found: $PATCH"
    exit 1
fi

# 1. Fresh copy (drop .git, .github, anything not needed at runtime)
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SOURCE"/. "$DEST"/
rm -rf "$DEST/.git" "$DEST/.github" "$DEST/.gitignore" "$DEST/.gitmodules"

# 2. Turn the copy into a throwaway git repo so `git apply` can handle binary
#    diffs / patch chunks — plain git apply on a non-repo dir cannot.
#    Two commits: pristine slopkit, then our autoloader patch.
SRC_HASH=$(git -C "$SOURCE" rev-parse --short HEAD)
git -C "$DEST" init -q
git -C "$DEST" config user.name "wkal"
git -C "$DEST" config user.email "wkal@localhost"
git -C "$DEST" add -A
git -C "$DEST" commit -q -m "slopkit pristine (submodule $SRC_HASH)"

# 3. Apply the patch
cd "$DEST"
if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    git add -A
    git commit -q -m "Apply WKAL autoloader patch"
    echo "slopkit: copied to $DEST and autoloader patch applied."
elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "slopkit: autoloader patch is already applied."
else
    echo "Error: patch does not apply cleanly to $DEST."
    echo "slopkit has likely changed upstream — regenerate patches/slopkit-autoload.patch:"
    echo "  git -C $SOURCE diff > $PATCH"
    exit 1
fi

# 4. Sanity check: the patched pages must carry our integration markers.
#    Catches a silently truncated/empty patch. These markers only exist when
#    the patch applied (they are not in pristine slopkit).
if ! grep -q 'sendPayloadToElfldr(cfg.autoload, "../../payloads/"' slopkit/poops.html \
    || ! grep -q 'if (key === "autoload") return;' slopkit/poops.html \
    || ! grep -q 'name: "payload.elf"' slopkit/poops.html \
    || ! grep -q '"url=../../shared/" + name' slopkit/poops.js \
    || ! grep -q 'const AUTOLOAD = Q.get("autoload")' slopkit/p2jb.html \
    || ! grep -q 'sendPayloadToElfldr(AUTOLOAD, "../../payloads/")' slopkit/p2jb.html \
    || ! grep -q '"../../shared/elfldr-ps5.elf"' slopkit/p2jb.html; then
    echo "Error: slopkit patch verification FAILED — integration markers missing."
    echo "patches/slopkit-autoload.patch is incomplete or out of date."
    echo "Regenerate it from the pristine submodule:"
    echo "  git -C $SOURCE diff > $PATCH"
    exit 1
fi
echo "slopkit: patch verification OK (autoload block, exactQuery relaxation,"
echo "         hidden payload.elf tile, shared elfldr on poops + p2jb)."
