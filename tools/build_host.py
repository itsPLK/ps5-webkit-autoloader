#!/usr/bin/env python3
"""Build the standalone webkit-autoloader-host.py PC host script.

Zips the frontend/autoloader directory (DEFLATE), base64-encodes the archive
and injects it into the [[EMBEDDED_ZIP]] placeholder in pc-host/host.py, so
the resulting single-file script can serve the frontend entirely from memory
without any external files.

Usage:
    build_host.py [--frontend DIR] [--input FILE] [--output FILE]
"""

import argparse
import base64
import io
import os
import subprocess
import sys
import tempfile
import zipfile

from gen_version import get_version_info

CHUNK = 76
MARKER = "# [[EMBEDDED_ZIP]]"
PLACEHOLDER = MARKER + "\nEMBEDDED_ZIP_B64 = \"\""
VERSION_MARKER = "# [[VERSION_PLACEHOLDER]]"
VERSION_PLACEHOLDER = VERSION_MARKER + '\nVERSION = "dev"'
BUILD_TIME_MARKER = "# [[BUILD_TIME_PLACEHOLDER]]"
BUILD_TIME_PLACEHOLDER = BUILD_TIME_MARKER + '\nBUILD_TIME = "dev"'
CERT_MARKER = "# [[SSL_CERT_PLACEHOLDER]]"
CERT_PLACEHOLDER = CERT_MARKER + '\nSSL_CERT_PEM = ""'
KEY_MARKER = "# [[SSL_KEY_PLACEHOLDER]]"
KEY_PLACEHOLDER = KEY_MARKER + '\nSSL_KEY_PEM = ""'
VERSION_TOKEN = b"[[VERSION_PLACEHOLDER]]"
BUILD_TIME_TOKEN = b"[[BUILD_TIME_PLACEHOLDER]]"

CERT_TARGET = "manuals.playstation.net"


def repo_root():
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# slopkit's bundled payload menu servers (ftpsrv, gdbsrv, kstuff, ...) are
# never used by the autoloader — only the kexp it boots is needed (slopkit
# boots the shared elfldr from /app/shared/, see tools/download_deps.sh).
# umtx2 keeps its OWN bundled elfldr (umtx2/payloads/elfldr-ps5.elf, like stock
# umtx2) and its other bundled payloads are pruned by tools/apply_umtx2_patch.sh.
# The copied slopkit/umtx2 are throwaway git repos (tools/apply_*_patch.sh), so
# .git must never be embedded. The payload digest sidecars (payloads/*.sha256)
# are build-time bookkeeping and must never be served.
def include_in_zip(rel):
    if "/.git/" in rel or rel.endswith("/.git"):
        return False
    if rel.startswith("slopkit/payloads/"):
        return rel.endswith("kexp_2026_05_25.bin")
    if rel == "slopkit/readme.png":
        return False
    if rel.endswith(".sha256"):
        return False
    return True


def build_zip(frontend_dir, overrides_dir, version, build_time, payload_path=None):
    """Zip the contents of frontend_dir and overrides_dir (merged) into memory."""
    archive = io.BytesIO()
    file_map = {}

    # 1. Base files
    for root, dirs, names in os.walk(frontend_dir):
        dirs.sort()
        for name in sorted(names):
            if name == ".DS_Store":
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, frontend_dir).replace(os.sep, "/")
            if not include_in_zip(rel):
                continue
            file_map[rel] = full

    # 2. Overrides
    if os.path.isdir(overrides_dir):
        for root, dirs, names in os.walk(overrides_dir):
            dirs.sort()
            for name in sorted(names):
                if name == ".DS_Store":
                    continue
                full = os.path.join(root, name)
                rel = os.path.relpath(full, overrides_dir).replace(os.sep, "/")
                file_map[rel] = full

    # 3. Host payload override: the PC host is the one-time setup flow, so it
    #    serves the installer ELF instead of the bundled unified-autoloader.
    #    The virtual path stays the same ("payload.elf") so the
    #    autoloader's ?autoload= request is unchanged — only the bytes differ.
    if payload_path:
        payload_path = os.path.abspath(payload_path)
        if not os.path.isfile(payload_path):
            sys.exit(f"Error: payload file not found: {payload_path}")
        file_map["payloads/payload.elf"] = payload_path
        print(f"  payload: {payload_path}")
        print("           -> payloads/payload.elf (installer ELF)")
    else:
        print("  payload: bundled payload.elf (default)")

    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in sorted(file_map.keys()):
            if rel == "index.html":
                # The autoloader carries version/build-time placeholders in its
                # title — the PC host serves it at the docroot, so replace them here.
                with open(file_map[rel], "rb") as f:
                    data = f.read()
                data = data.replace(VERSION_TOKEN, version.encode("utf-8"))
                data = data.replace(BUILD_TIME_TOKEN, build_time.encode("utf-8"))
                zf.writestr(rel, data)
            elif rel == "app.js":
                # Build-time exploit override (auto | umtx2 | poops | p2jb),
                # from the FORCE_EXPLOIT env — same token as the ELF build.
                with open(file_map[rel], "rb") as f:
                    data = f.read()
                mode = os.environ.get("FORCE_EXPLOIT", "auto")
                data = data.replace(b"[[EXPLOIT_MODE]]", mode.encode("utf-8"))
                zf.writestr(rel, data)
            else:
                zf.write(file_map[rel], arcname=rel)

    return archive.getvalue(), file_map


def embed_version(source, version, build_time):
    """Replace the VERSION/BUILD_TIME placeholder blocks with the real values."""
    if VERSION_PLACEHOLDER not in source:
        sys.exit(
            "Error: '{}' version placeholder not found in input script. "
            "Rebuild pc-host/host.py first.".format(VERSION_MARKER)
        )
    if BUILD_TIME_PLACEHOLDER not in source:
        sys.exit(
            "Error: '{}' build time placeholder not found in input script. "
            "Rebuild pc-host/host.py first.".format(BUILD_TIME_MARKER)
        )
    source = source.replace(VERSION_PLACEHOLDER, VERSION_MARKER + f'\nVERSION = "{version}"')
    return source.replace(BUILD_TIME_PLACEHOLDER, BUILD_TIME_MARKER + f'\nBUILD_TIME = "{build_time}"')


def embed_payload(source, payload_b64):
    """Replace the EMBEDDED_ZIP placeholder block in source with the payload."""
    if PLACEHOLDER not in source:
        sys.exit(
            "Error: '{}' placeholder not found in input script. "
            "Rebuild pc-host/host.py first.".format(PLACEHOLDER)
        )
    chunks = "\n".join(
        '    "%s"' % payload_b64[i : i + CHUNK]
        for i in range(0, len(payload_b64), CHUNK)
    )
    replacement = MARKER + "\nEMBEDDED_ZIP_B64 = (\n" + chunks + "\n)"
    return source.replace(PLACEHOLDER, replacement)


def generate_server_cert():
    """Generate a self-signed certificate for the spoofed target domain and
    return (cert_pem, key_pem)."""
    tmpdir = tempfile.mkdtemp(prefix="ps5-wkal-")
    cert_path = os.path.join(tmpdir, "cert.pem")
    key_path = os.path.join(tmpdir, "key.pem")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-nodes", "-days", "3650", "-sha256",
            "-keyout", key_path, "-out", cert_path,
            "-subj", "/CN=" + CERT_TARGET,
        ],
        check=True,
        capture_output=True,
    )
    with open(cert_path) as f:
        cert = f.read()
    with open(key_path) as f:
        key = f.read()
    return cert, key


def embed_server_cert(source, cert_pem, key_pem):
    """Replace the SSL cert/key placeholder blocks in source with the pair."""
    if CERT_PLACEHOLDER not in source:
        sys.exit(
            "Error: '{}' placeholder not found in input script. "
            "Rebuild pc-host/host.py first.".format(CERT_MARKER)
        )
    if KEY_PLACEHOLDER not in source:
        sys.exit(
            "Error: '{}' placeholder not found in input script. "
            "Rebuild pc-host/host.py first.".format(KEY_MARKER)
        )
    source = source.replace(CERT_PLACEHOLDER, CERT_MARKER + '\nSSL_CERT_PEM = """' + cert_pem + '"""')
    return source.replace(KEY_PLACEHOLDER, KEY_MARKER + '\nSSL_KEY_PEM = """' + key_pem + '"""')


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="build_host.py",
        description="Build webkit-autoloader-host.py with the frontend/autoloader and overrides embedded as a zipped payload.",
    )
    parser.add_argument("--frontend", default=os.path.join(repo_root(), "frontend", "autoloader"),
                        help="Frontend directory to embed (default: frontend/autoloader).")
    parser.add_argument("--overrides", default=os.path.join(repo_root(), "pc-host", "overrides"),
                        help="Overrides directory to embed (default: pc-host/overrides).")
    parser.add_argument("--input", default=os.path.join(repo_root(), "pc-host", "host.py"),
                        help="Source host script (default: pc-host/host.py).")
    parser.add_argument("--output", default=os.path.join(repo_root(), "webkit-autoloader-host.py"),
                        help="Output script (default: webkit-autoloader-host.py).")
    parser.add_argument("--payload", default=None,
                        help="ELF to serve as payloads/payload.elf in place of the "
                             "bundled unified-autoloader (default: bundled payload).")
    args = parser.parse_args(argv)

    frontend_dir = os.path.abspath(args.frontend)
    overrides_dir = os.path.abspath(args.overrides)
    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)

    if not os.path.isdir(frontend_dir):
        sys.exit(f"Error: frontend directory not found: {frontend_dir}")
    if output_path == input_path:
        sys.exit("Error: --output must differ from --input.")

    version_info = get_version_info()
    version = version_info["full"]
    build_time = version_info["build_time"]
    zip_data, file_map = build_zip(frontend_dir, overrides_dir, version, build_time,
                                   payload_path=args.payload)
    
    if not file_map:
        sys.exit(f"Error: no files to embed from {frontend_dir} and {overrides_dir}")

    raw_size = sum(os.path.getsize(path) for path in file_map.values())
    payload_b64 = base64.b64encode(zip_data).decode("ascii")

    with open(input_path, "r") as f:
        source = f.read()

    built = embed_payload(source, payload_b64)
    built = embed_version(built, version, build_time)
    cert_pem, key_pem = generate_server_cert()
    built = embed_server_cert(built, cert_pem, key_pem)

    # Sanity-check the injected payload decodes and the file compiles
    compile(built, output_path, "exec")

    with open(output_path, "w") as f:
        f.write(built)

    print(f"Embedded {len(file_map)} files (merged from {frontend_dir} and {overrides_dir})")
    print(f"  raw files:  {raw_size} bytes -> zip: {len(zip_data)} bytes -> base64: {len(payload_b64)} bytes")
    print(f"  version:    v{version} by PLK (built {build_time})")
    print(f"Wrote {output_path} ({len(built)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
