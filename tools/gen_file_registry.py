#!/usr/bin/env python3
"""
Generate a C file registry + cache.appcache manifest from a dist directory.

Scans <dist_dir> recursively and produces:
  - <header_out>  : file_registry.h  (FileEntry struct + extern table)
  - <source_out>  : file_registry.c  (byte arrays + lookup function)
  - <dist_dir>/cache.appcache        (AppCache manifest listing all files)

Usage: gen_file_registry.py <dist_dir> <header_out> <source_out>
"""

import os
import posixpath
import re
import sys
import zlib

from gen_version import get_version_info

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".appcache": "text/cache-manifest",
    ".txt": "text/plain",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
}


def detect_content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return CONTENT_TYPES.get(ext, "application/octet-stream")


# slopkit ships its own payload menu servers (ftpsrv, gdbsrv, kstuff, ...) that
# our autoloader never uses — the chains only need the elfldr they boot and
# the kexp shellcode that loads it. poops boots the shared elfldr (served from
# /app/<version>/shared/elfldr-ps5.elf, see tools/download_deps.sh) and p2jb
# is patched onto it too, so only the kexp is kept (both chains use it).
# umtx2 boots its OWN bundled elfldr (kept by
# tools/apply_umtx2_patch.sh at umtx2/payloads/elfldr-ps5.elf, like stock
# umtx2); the rest of its payloads are pruned, and the autoload payload comes
# from /app/<version>/payloads/. readme.png is a slopkit repo asset, also
# unused. The copied slopkit is a throwaway git repo
# (tools/apply_slopkit_patch.sh), so .git must never be embedded. The payload
# digest sidecars (payloads/*.sha256) are build-time bookkeeping and must never
# be served. /VERSION is the staging version handoff (see Makefile) — build-time
# bookkeeping too.
def include_in_registry(path):
    if "/.git/" in path or path.endswith("/.git"):
        return False
    if path == "/VERSION":
        return False
    if "/slopkit/payloads/" in path:
        return path.endswith("kexp_2026_05_25.bin")
    if "/slopkit/readme.png" in path:
        return False
    if path.endswith(".sha256"):
        return False
    return True


VERSION_PLACEHOLDER = b"[[VERSION_PLACEHOLDER]]"
BUILD_TIME_PLACEHOLDER = b"[[BUILD_TIME_PLACEHOLDER]]"
EXPLOIT_MODE_PLACEHOLDER = b"[[EXPLOIT_MODE]]"
APP_DIR_PLACEHOLDER = b"[[APP_DIR_PLACEHOLDER]]"

# The build-time exploit override in app.js (auto | umtx2 | poops | p2jb).
# Defaults to "auto" (firmware routing) unless FORCE_EXPLOIT is set.
DEFAULT_EXPLOIT_MODE = "auto"
EXPLOIT_MODES = ("auto", "umtx2", "poops", "p2jb")


def get_version_info_with_handoff(dist_dir):
    """Return version_info for the build, preferring the VERSION handoff file
    written by the Makefile staging rule over a freshly computed value.

    The staged app directory lives at /app/<full-version>/, so the version used
    for the directory and the one used to generate the pointer/marker content
    must be identical. Recomputed timestamps (dirty-tree dev builds) could
    straddle a second boundary, so the recipe pins it in dist/VERSION."""
    info = get_version_info()
    try:
        with open(os.path.join(dist_dir, "VERSION"), "r", encoding="utf-8") as f:
            pinned = f.read().strip()
        if pinned:
            info = dict(info)
            info["full"] = pinned
    except OSError:
        pass
    return info


def apply_version_placeholder(path, data, version, build_time, versioned_paths):
    """Replace [[VERSION_PLACEHOLDER]]/[[BUILD_TIME_PLACEHOLDER]] in versioned HTML files."""
    if path in versioned_paths:
        data = data.replace(VERSION_PLACEHOLDER, version.encode("utf-8"))
        data = data.replace(BUILD_TIME_PLACEHOLDER, build_time.encode("utf-8"))
    return data


def apply_pointer_placeholder(path, data, version):
    """Replace the tokens in the stable /app/index.html pointer page. It needs
    the versioned app directory name (for the redirect + marker fetch) and the
    expected marker content, both of which are the full version string."""
    if path == "/app/index.html":
        data = data.replace(APP_DIR_PLACEHOLDER, version.encode("utf-8"))
        data = data.replace(VERSION_PLACEHOLDER, version.encode("utf-8"))
    return data


def apply_exploit_mode_placeholder(path, data, app_dir):
    """Replace the [[EXPLOIT_MODE]] token in app.js from the FORCE_EXPLOIT env."""
    if path == app_dir + "/app.js":
        mode = os.environ.get("FORCE_EXPLOIT", DEFAULT_EXPLOIT_MODE)
        if mode not in EXPLOIT_MODES:
            print(f"Warning: unknown FORCE_EXPLOIT '{mode}' - using 'auto'.", file=sys.stderr)
            mode = "auto"
        data = data.replace(EXPLOIT_MODE_PLACEHOLDER, mode.encode("utf-8"))
    return data


def emit_c_array(out, name, data):
    out.write(f"static const unsigned char {name}[] = {{\n")
    for i in range(0, len(data), 12):
        chunk = ", ".join(f"0x{b:02x}" for b in data[i : i + 12])
        out.write(f"    {chunk},\n")
    out.write("};\n")


# Compress embedded files with raw DEFLATE (no zlib header), matching the
# vendored puff.c inflater in src/inflate.c. This roughly halves the registry
# and keeps the installer ELF small. Files that would not shrink are stored
# uncompressed instead.
def compress_entry(data):
    if len(data) < 64:
        return data, False
    co = zlib.compressobj(level=9, wbits=-15)
    comp = co.compress(data) + co.flush()
    if len(comp) >= len(data):
        return data, False
    return comp, True


# The autoloader iframe loads poops.html with this exact query string. AppCache
# matches URLs exactly (query included), so the manifest must list the full URL
# or the console serves a fallback document instead of the exploit page. The
# app now lives under /app/<version>/, so the URL is prefixed with that. Keep
# in sync with POOPS_URL in frontend/autoloader/app.js (which resolves to the
# same absolute path from the versioned app dir). The trailing v= matches
# slopkit's ROUTE_VERSION cache-bust (see the patch regeneration notes in
# ARCHITECTURE.md).
def poops_iframe_url(app_dir):
    return (
        app_dir + "/slopkit/slopkit/poops.html"
        "?go=1&auto=1&production=1&trigger=netcontrol&attempts=8"
        "&only=ps0_preflight,ps1_prepare,ps3_stage0,ps4_validate"
        ",ps5_stage1,ps6_stage2,ps8_stage3,ps9_stage4,ps10_stage5"
        "&log=debug&payload=1&autoload=payload.elf&v=final"
    )


# Same for p2jb (FW 12.02-12.70): upstream's canonical production query plus
# our autoload key (relaxed in patches/slopkit-autoload.patch). Keep in sync
# with P2JB_URL in frontend/autoloader/app.js.
def p2jb_iframe_url(app_dir):
    return (
        app_dir + "/slopkit/slopkit/p2jb.html"
        "?go=1&auto=1&production=1&log=debug"
        "&payload=1&autoload=payload.elf&v=final"
    )


# umtx2 auto-runs its chain on load via the 'on_load_autorun' sessionStorage
# key set by app.js; the URL carries the autoload payload name + a cache-bust
# that must be bumped together with the umtx2 patch (patches/umtx2-autoload.patch).
# Keep in sync with UMTX2_URL in frontend/autoloader/app.js.
def umtx2_iframe_url(app_dir):
    return app_dir + "/umtx2/index.html?autoload=payload.elf&v=1"

# slopkit references its own scripts with cache-busting query strings
# (e.g. "./core.js?v=final", "main.js?v=final", "../offsets/9.00.js?v=final").
# AppCache matches URLs exactly, so the manifest must list those query
# variants too or the console falls back and the module imports fail.
CACHEBUST_RE = re.compile(r'([A-Za-z0-9_./-]+\.(?:js|css|html|png|jpg|gif))\?v=[A-Za-z0-9]+')


def collect_cachebust_urls(files):
    """Scan staged HTML/JS for query-string script imports (slopkit's ?v=
    cache-busters) and return their absolute URLs, resolved relative to the
    referencing file. Offsets are loaded dynamically as ../offsets/<fw>.js?v=final
    in main.js, so every offsets file gets the ?v=final variant as well."""
    urls = set()
    for path, full in files:
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                data = f.read()
        except OSError:
            continue
        base = posixpath.dirname(path)
        for match in CACHEBUST_RE.finditer(data):
            ref, query = match.group(1), match.group(0)[len(match.group(1)):]
            resolved = posixpath.normpath(posixpath.join(base, ref))
            if resolved.startswith("/") and "/slopkit/" in resolved:
                urls.add(resolved + query)
    for path, _ in files:
        if "/slopkit/offsets/" in path and path.endswith(".js"):
            urls.add(path + "?v=final")
    return sorted(urls)


def build_manifest(files, version, build_time, app_dir, pointer_path, marker_path):
    """Build the AppCache manifest. Ordering matters for partial-cache safety:
    every versioned file is listed first, then the exploit iframe URLs and the
    slopkit cache-bust variants, then the pointer page, then the __complete__
    marker LAST. The marker being the final entry means a successfully cached
    marker implies the whole versioned directory was downloaded — and the
    pointer (frontend/pointer/index.html) verifies the marker's content before
    redirecting into it."""
    lines = [
        "CACHE MANIFEST",
        f"# WebKit Autoloader v{version} by PLK (built {build_time}) - "
        "auto-generated by tools/gen_file_registry.py, do not edit.",
        "",
        "CACHE:",
    ]
    cache_entries = [path for path, _ in files if path not in (pointer_path, marker_path)]
    cache_entries.sort()
    lines += cache_entries
    lines.append(poops_iframe_url(app_dir))
    lines.append(p2jb_iframe_url(app_dir))
    lines.append(umtx2_iframe_url(app_dir))
    lines += collect_cachebust_urls(files)
    lines.append(pointer_path)
    lines.append(marker_path)
    lines += [
        "",
        "NETWORK:",
        "/install",
        "/version",
        "/logs",
        "",
        "FALLBACK:",
        "/ /index.html",
    ]

    # Fall back to <dir>/index.html for each subdirectory that has one
    # (e.g. "/app/ /app/index.html" from the pointer, and
    # "/app/<version>/ /app/<version>/index.html"), so cached apps work offline.
    paths = {path for path, _ in files}
    for path in sorted(paths):
        if path == "/index.html" or not path.endswith("/index.html"):
            continue
        directory = os.path.dirname(path)
        if directory != "/":
            lines.append(f"{directory}/ {path}")

    lines += [""]
    return "\n".join(lines)


def main():
    if len(sys.argv) != 4:
        print("Usage: gen_file_registry.py <dist_dir> <header_out> <source_out>")
        sys.exit(1)

    dist_dir, header_out, source_out = sys.argv[1:4]

    if not os.path.isdir(dist_dir):
        print(f"Error: {dist_dir} not found or not a directory.")
        sys.exit(1)

    version_info = get_version_info_with_handoff(dist_dir)
    version = version_info["full"]
    app_dir = "/app/" + version
    pointer_path = "/app/index.html"
    marker_path = app_dir + "/__complete__"

    # The __complete__ completeness marker lives in the versioned app dir and is
    # listed LAST in the AppCache manifest. Its content is the full version; the
    # pointer page verifies it before redirecting into the directory.
    marker_full = os.path.join(dist_dir, marker_path.lstrip("/"))
    os.makedirs(os.path.dirname(marker_full), exist_ok=True)
    with open(marker_full, "w", encoding="utf-8") as f:
        f.write(version)

    # Files that carry the version/badge and get the placeholders replaced:
    # installer page at the dist root, and the versioned autoloader app index.
    versioned_paths = ("/index.html", app_dir + "/index.html")

    files = []
    for root, dirs, names in os.walk(dist_dir):
        dirs.sort()
        for name in sorted(names):
            if name == "cache.appcache":
                continue  # regenerated below
            full = os.path.join(root, name)
            rel = os.path.relpath(full, dist_dir).replace(os.sep, "/")
            if not include_in_registry(f"/{rel}"):
                continue
            files.append((f"/{rel}", full))
    files.sort(key=lambda f: f[0])

    # Write cache.appcache into the dist dir and include it in the registry
    manifest_path = os.path.join(dist_dir, "cache.appcache")
    with open(manifest_path, "w") as f:
        f.write(build_manifest(files, version, version_info["build_time"],
                               app_dir, pointer_path, marker_path))

    files.append((f"/cache.appcache", manifest_path))
    files.sort(key=lambda f: f[0])

    # Header
    with open(header_out, "w") as out:
        out.write("/* Auto-generated by tools/gen_file_registry.py - do not edit. */\n")
        out.write("\n")
        out.write("#ifndef FILE_REGISTRY_H\n")
        out.write("#define FILE_REGISTRY_H\n")
        out.write("\n")
        mode = os.environ.get("FORCE_EXPLOIT", DEFAULT_EXPLOIT_MODE)
        if mode not in EXPLOIT_MODES:
            mode = "auto"
        out.write(f'#define WKALI_FORCE_EXPLOIT "{mode}"\n')
        out.write("\n")
        out.write("typedef struct {\n")
        out.write("    const char *path;\n")
        out.write("    const unsigned char *data;\n")
        out.write("    unsigned int size;\n")
        out.write("    unsigned int orig_size;\n")
        out.write("    unsigned char compressed;\n")
        out.write("    const char *content_type;\n")
        out.write("} FileEntry;\n")
        out.write("\n")
        out.write("extern const FileEntry file_registry[];\n")
        out.write("extern const unsigned int file_registry_count;\n")
        out.write("\n")
        out.write("/* Returns a pointer to the entry matching path (e.g. \"/index.html\"), or NULL. */\n")
        out.write("const FileEntry *file_registry_find(const char *path);\n")
        out.write("\n")
        out.write("#endif /* FILE_REGISTRY_H */\n")

    # Source
    with open(source_out, "w") as out:
        out.write("/* Auto-generated by tools/gen_file_registry.py - do not edit. */\n")
        out.write("\n")
        out.write('#include <string.h>\n')
        out.write("\n")
        out.write('#include "file_registry.h"\n')
        out.write("\n")

        entries = []
        for i, (path, full) in enumerate(files):
            with open(full, "rb") as f:
                data = f.read()
            data = apply_version_placeholder(path, data, version,
                                             version_info["build_time"], versioned_paths)
            data = apply_pointer_placeholder(path, data, version)
            data = apply_exploit_mode_placeholder(path, data, app_dir)
            stored, compressed = compress_entry(data)
            emit_c_array(out, f"file_{i}", stored)
            out.write("\n")
            entries.append((path, compressed, len(data), len(stored)))

        out.write("const FileEntry file_registry[] = {\n")
        for i, (path, _) in enumerate(files):
            content_type = detect_content_type(path)
            _, compressed, orig_size, stored_size = entries[i]
            out.write(
                f'    {{ "{path}", file_{i}, {stored_size}, {orig_size}, '
                f'{1 if compressed else 0}, "{content_type}" }},\n'
            )
        out.write("};\n")
        out.write("\n")
        out.write("const unsigned int file_registry_count =\n")
        out.write("    sizeof(file_registry) / sizeof(file_registry[0]);\n")
        out.write("\n")
        out.write("const FileEntry *file_registry_find(const char *path) {\n")
        out.write("    if (!path)\n")
        out.write("        return NULL;\n")
        out.write("\n")
        out.write("    for (unsigned int i = 0; i < file_registry_count; i++) {\n")
        out.write('        if (strcmp(file_registry[i].path, path) == 0)\n')
        out.write("            return &file_registry[i];\n")
        out.write("    }\n")
        out.write("\n")
        out.write("    return NULL;\n")
        out.write("}\n")

    print(f"Generated {header_out} and {source_out} ({len(files)} files, {manifest_path})")


if __name__ == "__main__":
    main()
