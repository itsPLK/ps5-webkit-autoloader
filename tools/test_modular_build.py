#!/usr/bin/env python3
"""Verify the modular Wobkot build and its isolated Poops compatibility assets."""

import os
import subprocess
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.path.join(ROOT, "third_party", "ps5-webkit-remote-loader")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


with tempfile.TemporaryDirectory() as temporary:
    output = os.path.join(temporary, "page")
    os.makedirs(os.path.join(output, "payloads", "lua"))
    open(os.path.join(output, "payloads", "poops.js"), "wb").close()
    open(os.path.join(output, "payloads", "lua", "relapse.lua"), "wb").close()
    elfldr = os.path.join(temporary, "elfldr.elf")
    payload = os.path.join(temporary, "autoload.elf")
    for path in (elfldr, payload):
        with open(path, "wb") as stream:
            stream.write(b"\x7fELFtest")

    subprocess.run([
        sys.executable, os.path.join(ROOT, "tools", "build_modular_page.py"),
        "--output-dir", output,
        "--loader-dir", LOADER,
        "--version", "test",
        "--build-time", "test",
        "--elfldr-bin", elfldr,
        "--payload-bin", payload,
    ], cwd=ROOT, check=True)

    def present(relative):
        return os.path.isfile(os.path.join(output, relative))

    require(present("vendor/wobkot/src/userland.js"), "Wobkot userland was not staged")
    require(present("vendor/wobkot/src/kernel.js"), "deferred Wobkot kernel was not staged")
    require(not present("vendor/wobkot/host.py"), "upstream Wobkot host was staged")
    require(not present("vendor/wobkot/src/ps4/impl.js"), "unused PS4 runtime was staged")
    require(present("payloads/autoloader.js"), "selection orchestrator was not staged")
    require(present("payloads/relapse.js"), "Wobkot Relapse wrapper was not staged")
    require(present("payloads/poops.js"), "Poops payload was not staged")
    require(present("payloads/autoload.js"), "final ELF handoff was not staged")
    require(not present("payloads/lua/relapse.lua"), "stale Lua Relapse survived the clean build")
    require(present("offsets/7.61.js"), "Poops firmware offsets were not staged")
    require(present("src/main.js"), "Poops worker runtime was not staged")
    require(present("src/utils/rop_slave.js"), "Poops ROP worker was not staged")
    for retired in ("firmware.js", "rop.js", "webkit.js"):
        require(not present("src/" + retired), "retired runtime file was staged: " + retired)
    elfloaders = [name for name in os.listdir(os.path.join(output, "shared"))
                  if name.startswith("elfldr-ps5") and name.endswith(".elf")]
    require(elfloaders == ["elfldr-ps5.elf"], "unexpected ELF loader set: " + repr(elfloaders))

    with open(os.path.join(output, "index.html"), encoding="utf-8") as stream:
        html = stream.read()
    order = [
        html.find("src/wobkot_bootstrap.js"),
        html.find("vendor/wobkot/src/misc.js"),
        html.find("vendor/wobkot/src/ps5/impl.js"),
        html.find("vendor/wobkot/src/userland.js"),
        html.find("src/wobkot_adapter.js"),
        html.find('name: "autoloader.js"'),
    ]
    require(all(position >= 0 for position in order), "modular index is missing Wobkot or orchestrator")
    require(order == sorted(order), "Wobkot scripts or first payload are out of order")

print("Modular Wobkot + Poops staging passed")
