#!/usr/bin/env python3
"""Build the modular PS5 WebKit Autoloader page directory.

Stages the modular frontend files into an output directory so they can be
served normally via HTTP or cached individually via AppCache:
  - index.html (lightweight entry page from frontend/autoloader/index.html)
  - style.css, app.js
  - src/ (runtime scripts from remote-loader)
  - vendor/wobkot/ (Wobkot firmware implementation and deferred kernel scripts)
  - offsets/ and the private ROP worker used only when Poops is selected
  - shared/ (shellcode and elfldr daemon)
  - payloads/ (autoloader orchestrator, Poops, Wobkot Relapse, autoload.js)
  - <target>.elf (payload binary)
"""

import argparse
import os
import shutil
import sys

from gen_version import get_version_info


RETIRED_RUNTIME_FILES = (
    "firmware.js", "rop.js", "webkit.js", "socket_test.js",
    "lua-vm.js", "utils/mem.js", "utils/syscalls.js",
)


def copy_tree(src, dst):
    os.makedirs(dst, exist_ok=True)
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            if f.startswith(".") or f.endswith(".DS_Store"):
                continue
            src_file = os.path.join(root, f)
            rel = os.path.relpath(src_file, src)
            dst_file = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(dst_file), exist_ok=True)
            shutil.copy2(src_file, dst_file)


def copy_file_tree(root, dst, relatives):
    for relative in relatives:
        source = os.path.join(root, relative)
        target = os.path.join(dst, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)


def main():
    parser = argparse.ArgumentParser(description="Build modular PS5 WebKit autoloader directory")
    parser.add_argument("--output-dir", required=True, help="Destination directory (e.g. build/autoloader)")
    parser.add_argument("--loader-dir", required=True, help="Path to ps5-webkit-remote-loader")
    parser.add_argument("--title", default=None, help="Page title")
    parser.add_argument("--version", default=None, help="Full version string")
    parser.add_argument("--build-time", default=None, help="Build time string")
    parser.add_argument("--elfldr-name", default="elfldr-ps5.elf", help="Virtual name for elfldr in shared/")
    parser.add_argument("--elfldr-bin", default=None, help="Path to elfldr ELF binary")
    parser.add_argument("--payload-name", default="autoload.elf", help="Virtual name for target payload ELF")
    parser.add_argument("--payload-bin", default=None, help="Path to target payload ELF binary")
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_dir = os.path.abspath(args.output_dir)
    loader_dir = os.path.abspath(args.loader_dir)

    wobkot_userland = os.path.join(loader_dir, "vendor", "wobkot", "src", "userland.js")
    if not os.path.isfile(wobkot_userland):
        raise SystemExit(
            "remote-loader's Wobkot submodule is not initialized; run: "
            "git submodule update --init --recursive"
        )

    version_info = get_version_info()
    version = args.version or version_info["full"]
    build_time = args.build_time or version_info["build_time"]

    # 1. Clean / create destination directories. Removing the whole prior tree
    # is essential when a runtime drops assets (for example the retired Lua layer),
    # otherwise AppCache would silently keep packaging stale files.
    if os.path.isdir(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(os.path.join(output_dir, "src"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "offsets"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "shared"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "payloads"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "vendor", "wobkot"), exist_ok=True)

    # 2. Copy modular engine files from remote-loader
    copy_tree(os.path.join(loader_dir, "src"), os.path.join(output_dir, "src"))
    copy_tree(os.path.join(loader_dir, "offsets"), os.path.join(output_dir, "offsets"))
    copy_tree(os.path.join(loader_dir, "shared"), os.path.join(output_dir, "shared"))
    copy_file_tree(
        os.path.join(loader_dir, "vendor", "wobkot"),
        os.path.join(output_dir, "vendor", "wobkot"),
        (
            "LICENSE.txt",
            "src/misc.js",
            "src/userland.js",
            "src/kernel.js",
            "src/ps5/impl.js",
            "src/ps5/relapse.js",
        ),
    )
    for relative in RETIRED_RUNTIME_FILES:
        retired = os.path.join(output_dir, "src", relative)
        if os.path.isfile(retired):
            os.unlink(retired)

    # 3. Copy shared binaries
    if args.elfldr_bin and os.path.exists(args.elfldr_bin):
        for name in os.listdir(os.path.join(output_dir, "shared")):
            if name.startswith("elfldr-ps5") and name.endswith(".elf"):
                os.unlink(os.path.join(output_dir, "shared", name))
        shutil.copy2(args.elfldr_bin, os.path.join(output_dir, "shared", args.elfldr_name))

    if args.payload_bin and os.path.exists(args.payload_bin):
        shutil.copy2(args.payload_bin, os.path.join(output_dir, args.payload_name))

    # 4. Copy payloads
    relapse_src = os.path.join(loader_dir, "payloads", "relapse.js")
    shutil.copy2(relapse_src, os.path.join(output_dir, "payloads", "relapse.js"))
    poops_src = os.path.join(loader_dir, "payloads", "poops.js")
    shutil.copy2(poops_src, os.path.join(output_dir, "payloads", "poops.js"))

    shutil.copy2(os.path.join(repo_root, "payloads", "autoload.js"), os.path.join(output_dir, "payloads", "autoload.js"))
    shutil.copy2(os.path.join(repo_root, "payloads", "autoloader.js"), os.path.join(output_dir, "payloads", "autoloader.js"))

    # 5. Copy frontend appearance
    shutil.copy2(os.path.join(repo_root, "frontend", "autoloader", "style.css"), os.path.join(output_dir, "style.css"))
    shutil.copy2(os.path.join(repo_root, "frontend", "autoloader", "app.js"), os.path.join(output_dir, "app.js"))

    # 6. Generate index.html from template
    template_path = os.path.join(repo_root, "frontend", "autoloader", "index.html")
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    html = html.replace("[[VERSION_PLACEHOLDER]]", version)
    html = html.replace("[[BUILD_TIME_PLACEHOLDER]]", build_time)
    html = html.replace("[[ELFLDR_FILENAME]]", args.elfldr_name)
    html = html.replace("[[PAYLOAD_ELF_FILENAME]]", args.payload_name)

    with open(os.path.join(output_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Staged modular autoloader into {output_dir}")
    print(f"  entry:       index.html ({len(html)} bytes)")
    print(f"  elfldr:      shared/{args.elfldr_name}")
    print(f"  payload ELF: {args.payload_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
