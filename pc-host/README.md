# PC setup host

The setup host is built by remote-loader's `tools/build_host.py`; this
repository does not maintain a separate DNS/HTTPS implementation. The generated
`webkit-autoloader-host_v<version>.py` embeds the Wobkot-based modular page carrying
the installer ELF and a TLS certificate. The selection orchestrator automatically
chooses Wobkot Relapse or Poops from firmware and network status.
It needs only Python's standard library.

Run the generated script, set the PS5's DNS to your PC's IP, then open Settings →
User's Guide. The page runs the exploit and installer; reboot after installation.
On systems requiring elevated privileges for ports 53/443, run the host with sudo.

For a local HTTP check without DNS or HTTPS:

```sh
python3 webkit-autoloader-host_v<version>.py --no-dns --no-https --http-port 8123
```

Use `--help` for upstream host options. `--extract <directory>` extracts the
embedded page. Build both versioned artifacts with `./build_release.sh`, or build
only the host from an existing installer with:

```sh
make host HOST_PAYLOAD=webkit-autoloader-installer_v<version>.elf
```
