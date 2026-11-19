// PS5 WebKit Autoloader: unified orchestrator.
//
// 1. Checks if an ELF loader daemon is already listening on loopback port 9021.
// 2. Checks if the process is already jailbroken (uid 0).
// 3. If exploitation is needed, selects Wobkot Relapse or Poops from firmware
//    and network status, matching the pre-Wobkot automatic policy.
// 4. Pre-fetches all needed assets before kernel exploit runs.
// 5. Executes the chosen exploit via api.executePayload().
// 6. Executes autoload.js to stage and stream the target ELF to elfldr on 9021.

const NR = {
  SOCKET: 0x61,
  CONNECT: 0x62,
  CLOSE: 6,
  GETUID: 24,
};

function failed(val) {
  return (val.low | 0) === -1;
}

async function isElfldrRunning(api) {
  let fd = -1;
  try {
    const addr = api.p.malloc(16, 1);
    for (let i = 0; i < 16; i++) api.p.write1(addr.add32(i), 0);
    // sockaddr_in: length 16, AF_INET (2), port 9021 (0x233d), 127.0.0.1
    [16, 2, 0x23, 0x3d, 127, 0, 0, 1].forEach((v, i) => api.p.write1(addr.add32(i), v));

    const socket = await api.chain.syscall(NR.SOCKET, 2, 1, 0);
    if (failed(socket)) return false;
    fd = socket.low | 0;

    const connected = await api.chain.syscall(NR.CONNECT, fd, addr, 16);
    return (connected.low | 0) === 0;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try { await api.chain.syscall(NR.CLOSE, fd); } catch {}
    }
  }
}

async function isJailbroken(api) {
  try {
    const uid = await api.chain.syscall(NR.GETUID);
    return (uid.low | 0) === 0;
  } catch {
    return false;
  }
}

function selectExploit(api) {
  let fw = 0;

  const params = typeof location !== "undefined" && location.search
    ? new URLSearchParams(location.search) : null;
  const fwArg = params ? params.get("fw") : null;

  let match = typeof navigator !== "undefined" && navigator.userAgent
    ? /PlayStation 5\/(\d+\.\d+)/.exec(navigator.userAgent) : null;
  if (!match && fwArg) match = ["PlayStation 5/" + fwArg, fwArg];

  if (match) {
    fw = parseFloat(match[1]);
  } else if (typeof api.fw === "string" && api.fw !== "unknown") {
    fw = parseFloat(api.fw);
  }

  const isOnline = typeof navigator !== "undefined" && !!navigator.onLine;

  if (fw < 7.00 || (fw > 12.00 && fw <= 13.60)) {
    return {
      file: "payloads/relapse.js",
      fallback: "relapse.js",
      args: [],
      reason: fw < 7.00
        ? "Poops profiles begin at FW 7.00"
        : "FW > 12.00 requires Relapse",
    };
  }
  if (isOnline) {
    return {
      file: "payloads/relapse.js",
      fallback: "relapse.js",
      args: [],
      reason: "network active",
    };
  }
  return {
    file: "payloads/poops.js",
    fallback: "poops.js",
    args: [],
    reason: "offline mode (FW 7.00-12.00)",
  };
}

async function fetchText(primary, fallback) {
  try {
    const res = await fetch(primary);
    if (res.ok) return await res.text();
  } catch (e) {}
  if (fallback) {
    const res2 = await fetch(fallback);
    if (res2.ok) return await res2.text();
  }
  throw new Error("Could not load " + primary);
}

return async function (api) {
  await api.log("[*] WebKit Autoloader initialized", "info");

  // Step 1: Check if ELF loader is already running
  const elfldrActive = await isElfldrRunning(api);
  if (elfldrActive) {
    await api.log("[+] ELF loader is already active on 127.0.0.1:9021. Skipping kernel exploit and autoload.", "success");
    return;
  }

  await api.log("[*] No active ELF loader on 9021.", "info");

  // Step 2: Check if already jailbroken
  const jb = await isJailbroken(api);
  if (jb) {
    await api.log("[+] Process is already jailbroken (uid 0). Skipping kernel exploit and autoload.", "success");
    return;
  }

  // Step 3: Determine which exploit to run
  const choice = selectExploit(api);
  await api.log(`[*] Auto-dispatch: selected ${choice.file} (${choice.reason})`, "info");

  // Step 4: Pre-fetch all needed resources BEFORE kernel exploit runs
  const exploitCode = await fetchText(choice.file, choice.fallback);
  const autoloadCode = await fetchText("payloads/autoload.js", "autoload.js");

  const elfName = (api && Array.isArray(api.args) && api.args[0]) || "autoload.elf";
  await api.log(`[*] Pre-fetching ${elfName}...`, "info");
  let elfBytes = null;
  try {
    const elfResp = await fetch(elfName);
    if (elfResp.ok) {
      elfBytes = await elfResp.arrayBuffer();
    }
  } catch (e) {}

  // Step 5: Run the selected exploit
  const exploitResult = await api.executePayload(exploitCode, choice.args || []);
  if (exploitResult && exploitResult.failed)
    throw new Error(choice.file + " failed; refusing to send the ELF payload");

  // Step 6: Transfer the autoloader ELF payload
  await api.log(`[*] Staging and sending ${elfName}...`, "info");
  await api.executePayload(autoloadCode, [elfName, elfBytes]);
};
