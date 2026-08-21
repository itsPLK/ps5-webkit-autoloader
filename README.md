<p align="center">
 <img src="./assets/icon.svg" width="128" />
</p>
<h1 align="center">PS5 WebKit Autoloader</h1>
&nbsp;
<p align="center">Automatically loads the WebKit exploit and your elf payloads.<br>Supports firmwares <b>1.00&ndash;5.50</b> and <b>7.00&ndash;12.00</b>.</p>

> [!NOTE]
> Uses the [umtx2](https://github.com/idlesauce/umtx2) (FW 1.00–5.50) and [slopkit](https://github.com/itsPLK/slopkit) (FW 7.00–12.00) WebKit exploits under the hood with minimal changes (via patch files in `patches/`), so stability should match the originals.

<p align="center">
    <b>Other Autoloaders:</b><br>
    <a href="https://github.com/itsPLK/ps5-y2jb-autoloader">Y2JB</a> |
    <a href="https://github.com/itsPLK/ps5-bdjb-autoloader">BD-JB</a> |
    <a href="https://github.com/itsPLK/ps5-lua-autoloader">Lua</a>
</p>

## Why WebKit Autoloader?

WebKit exploits are usually loaded by pointing your PS5's DNS at some server hosted by someone on the internet. That means you're putting your trust in whoever runs that server — and if it goes down, changes, or disappears, your setup breaks.

This autoloader does it differently:

- **Fully offline, no third-party DNS.** After a one-time install from your PC, everything is served straight from your PS5. There's nothing external to go down or change behind your back.
- **One-time setup, then a homescreen shortcut.** Once it's installed, you don't need a PC or the network at all — just launch "WebKit Autoloader" from the homescreen and you're done.
- **Payloads loaded the way you already know.** After the exploit chain runs, your payloads are sent just like in [Y2JB](https://github.com/itsPLK/ps5-y2jb-autoloader) / [BD-JB](https://github.com/itsPLK/ps5-bdjb-autoloader) / [Lua](https://github.com/itsPLK/ps5-lua-autoloader) autoloaders — via **Payload Manager**, or a custom `autoload.txt`.

## Setup Instructions

There are two ways to set up the autoloader, depending on whether you're already jailbroken.

### Already jailbroken? Just load the installer ELF

1. Download `webkit-autoloader-installer_vX.Y.Z.elf` from the [Releases](https://github.com/itsPLK/ps5-webkit-autoloader/releases) page.
2. Send it to your PS5 with `elfldr`, or launch it from Payload Manager.
3. The installer opens the browser once to cache the autoloader page, then creates the **WebKit Autoloader** app on the homescreen and exits.
4. **Reboot once**, then launch **WebKit Autoloader** from the homescreen.

### Not jailbroken yet

If you aren't jailbroken yet, you'll need to host the exploit locally on your PC for the initial setup:

1. Download `webkit-autoloader-host.py` (or the `.exe`) from the [Releases](https://github.com/itsPLK/ps5-webkit-autoloader/releases) and run it on a PC on your network.
2. On your PS5, set your network's DNS server to your PC's IP address.
3. Open the **User's Guide** from Settings to run the installer, which adds the **WebKit Autoloader** app to your homescreen.
4. **Reboot once**, then launch **WebKit Autoloader** from the homescreen.

## How to Use

There are two ways to configure payloads:

### 🟢 Option 1: Payload Manager

If no `autoload.txt` config is found, the autoloader will automatically launch **[Payload Manager](https://github.com/itsPLK/ps5-payload-manager)** — a fully-featured PS5 payload manager with a web UI. This lets you configure and send payloads directly from your browser, without needing to manually set up config files or transfer ELF files ahead of time.

Just run the autoloader — if there's nothing configured, Payload Manager starts automatically.

> **Note:** Payload Manager also has its own built-in autoload feature, which lets you configure payloads to load automatically on startup — all managed through its web UI. This is separate from the `autoload.txt` mechanism described below.

---

### ⚙️ Option 2: Manual Config (`autoload.txt`)

For a fixed, automated payload chain, you can configure payloads manually:

- Create a directory named `ps5_autoloader`.
- Inside this directory, place your `.elf` / `.bin` files, and an `autoload.txt` file.
  - In `autoload.txt`, list the files you want to load, one filename per line.
  - Filenames are case-sensitive — ensure each name exactly matches the file.
  - You can add lines like `!1000` to make the loader wait 1000 ms before sending the next payload.
- Put the `ps5_autoloader` directory in one of these locations (priority order - highest first):
  - Root of a USB drive
  - Internal drive: `/data/ps5_autoloader`

> **Note:** When an `autoload.txt` config is found, Payload Manager is **not** launched automatically. If you also want Payload Manager available, place `pldmgr.elf` in your `ps5_autoloader` directory and add it to `autoload.txt`.

## Additional Info

<Details>
<Summary><i>How to update the autoloader?</i></Summary>

The autoloader content is cached on the console, so updating is exactly the same as the initial install. Simply follow the **[Setup Instructions](#setup-instructions)** using the new release files. 

The latest installer payload will re-create the homescreen app and refresh the cached page for you. Your payloads and `autoload.txt` on USB / internal storage are never touched.
</Details>

<Details>
<Summary><i>How to use a custom ELF Loader?</i></Summary>

On firmwares 7.00–12.00 (slopkit), the autoloader uses a custom version of **elfldr** that only accepts connections from the PS5 itself (localhost). This improves security by preventing unauthorized devices on your network from sending payloads to your console. On firmwares 1.00–5.50 (umtx2), the stock elfldr is booted.

If you want to use a "normal" ELF Loader that allows sending payloads from any device, you can simply load it through **Payload Manager**.

Alternatively, if you are using a manual config file (`autoload.txt`):
1. Place your custom ELF Loader (e.g. `elfldr.elf`) in the `ps5_autoloader` directory.
2. Add `elfldr.elf` to your `autoload.txt`.
3. **Note**: If you are loading other payloads right after `elfldr.elf` in your `autoload.txt`, add a sleep command immediately after it (like `!4000` to sleep for 4 seconds) to give the new ELF Loader time to start up and listen before subsequent payloads are sent.

Example `autoload.txt`:
```text
# Load custom ELF Loader
elfldr.elf
# Give it 4 seconds to start up (only needed if sending more payloads)
!4000
# Send other payloads
etaHEN.elf
```
</Details>

---

## For developers

The technical internals and project architecture are documented in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Credits

* **[idlesauce](https://github.com/idlesauce)** & contributors — [umtx2](https://github.com/idlesauce/umtx2), the WebKit/kernel exploit chain used for firmware 1.00–5.50.
* **[jordyidk](https://github.com/jordyidk)** & contributors — [slopkit](https://github.com/itsPLK/slopkit), the WebKit/kernel exploit chain used for firmware 7.00–12.00.
* **[soniciso1](https://github.com/soniciso1)** — [pooP2JB](https://github.com/soniciso1/pooP2JB), firmware 7.00–8.60 support for slopkit.
* **[john-tornblom](https://github.com/john-tornblom)** — [ps5-payload-sdk](https://github.com/ps5-payload-dev/sdk/) and [elfldr](https://github.com/ps5-payload-dev/elfldr)
* **[Mark Adler](https://github.com/madler)** — [puff.c](https://github.com/madler/zlib/tree/master/contrib/puff) (used to decompress embedded frontend files)
* Everyone else contributing to the PS5 homebrew scene.

## Disclaimer

This tool is provided as-is for research and development purposes only. Use at your own risk. The developers are not responsible for any damage, data loss, or consequences resulting from the use of this software.

## License

This project is licensed under the GPL-3.0 License.

## Donate
- [donate to PLK](DONATE.md)
