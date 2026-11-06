# Changelog

All notable changes to this project will be documented in this file.

## [v0.7.0] - 2026-11-06

Most of this release is changes in [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), the shared base this project builds on. Main changes:

* **Switched Relapse to [notmaj0r](https://github.com/notmaj0r)'s [Lua implementation](https://github.com/notmaj0r/remote_lua_loader)**: Adapted to run through the remote loader's new Lua runtime (LuaK1t)
* **Fixed freezes/hangs during loading**: Resolved several causes of the loader hanging or freezing mid-load in the shared exploit runner.
* **Modular AppCache loading**: Replaced the monolithic single-file HTML bundle (with payloads inlined as base64) with a modular architecture staged into AppCache, cutting build artifact sizes substantially (`host.py` ~11.9MB → ~3.7MB, installer `.elf` ~3.9MB → ~2.1MB).
* **Automatic exploit selection**: Automatically selects the best exploit based on firmware version and network status:
  - **FW > 12.00 and FW <= 13.60**: Relapse (Poops does not support > 12.00)
  - **FW == 9.05**: Poops (Relapse does not support 9.05)
  - **Active network connection**: Relapse
  - **Offline (FW <= 12.00)**: Poops (works without active network connection)

### Dependencies
* Updated [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) to v0.2.0
* Updated [ps5-unified-autoloader](https://github.com/itsPLK/ps5-unified-autoloader) to v0.1.7

## [v0.6.2] - 2026-10-28

- Updated [ps5-unified-autoloader](https://github.com/itsPLK/ps5-unified-autoloader) to v0.1.6
  - includes bundled [Payload Manager](https://github.com/itsPLK/ps5-payload-manager) v0.6.3
- Updated [ps5-elfldr](https://github.com/itsPLK/ps5-elfldr) to v0.27
- Updated [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) to v0.1.2
  - Added Relapse support for FW 11.40 (credit: [@tidewell](https://github.com/tidewell), [@notmaj0r](https://github.com/notmaj0r))
## [v0.6.1] - 2026-10-08

* **9.05, 11.40 & 11.60**: Added missing offsets to fix Poops support.
  *(Note: Relapse remains unsupported on 9.05 and 11.40)*

## [v0.6.0] - 2026-10-07

### Unified Architecture & Upstream Remote Loader Base
* **Single Shared Base**: WebKit Autoloader is now built on top of [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), unifying the userland exploit runner, ROP primitives, and payload pipeline across both Poops and Relapse.
* **Developer Iteration & Contributions**: Developers looking to experiment with, test, or improve Poops or Relapse can now do so easily in [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) by loading payloads over the network (port 9027). Any improvements made in that repo can be contributed upstream to directly benefit both projects.

### Dropped umtx2 (FW <= 5.50)
* **Dropped Legacy umtx2 Support**: Support for firmwares 1.00–5.50 via umtx2 has been dropped in this release. That path was not receiving updates and was blocking development and architectural changes.
* **Future Lower Firmware Support**: Support for lower firmwares may be added back in the future if it is added to [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader). Contributions to bring lower firmware support to the new unified base are welcome!

### Exploit & Stability Improvements
* **Relapse Stability**: Stability and reliability improvements for the Relapse chain.

---
For changelogs of previous releases, see [GitHub Releases](https://github.com/itsPLK/ps5-webkit-autoloader/releases).

