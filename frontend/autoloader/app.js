(function () {
  'use strict';

  var splashEl = document.getElementById('splash');
  var loaderEl = document.getElementById('loader');
  var logContainer = document.getElementById('logContainer');
  var progressBar = document.getElementById('progressBar');
  var progressLabel = document.getElementById('progressLabel');
  var exploitEl = document.getElementById('exploit');

  /* After a WebProcess crash the PS5 browser restores this page together with
     the iframe at its last URL — the armed exploit URL, which would auto-run
     the chain again. Blank it as early as possible (the iframe element is
     already in the DOM at script parse) so the chain only runs after the
     splash screen. */
  try {
    exploitEl.src = 'about:blank';
  } catch (e) { }

  var MAX_LOG_LINES = 80;
  var finished = false;
  var chainStarted = false;
  var mirroredLines = 0;
  var lastStageText = '';
  var lastStageCls = '';
  var lastSummaryText = '';
  var earlyLinesLogged = 0;
  var lastFrameUrl = '';
  var repairCount = 0;

  /* The slopkit chains (poops 7.00-12.00, p2jb 12.02-12.70) keep a one-shot
     latch and their "stopped at …" marker in sessionStorage under shared
     "slopkit-poops:*" keys. On the PS5 browser the shortcut session can
     outlive a console reboot, so a previous interrupted run would otherwise
     block every retry with "the last run stopped at X but the latch is clear".
     Clear them right before arming so the full chain always restarts from
     the top (never a mid-chain resume). The iframe is same-origin, so this
     is exactly the storage both exploit pages read. */
  function clearSlopkitState() {
    try {
      sessionStorage.removeItem('slopkit-poops:next');
      sessionStorage.removeItem('slopkit-poops:latch');
    } catch (e) { }
  }

  /* Build-time exploit override: "auto" (firmware table), "umtx2", "poops"
     (7.00-12.00) or "p2jb" (12.02-12.70). Replaced by
     tools/gen_file_registry.py / build_host.py / dev_server.py from the
     FORCE_EXPLOIT env (default "auto"); left as the raw placeholder when
     served straight from source -> auto. A ?force= query on this page
     overrides it at runtime (handy for make dev). */
  var EXPLOIT_MODE = '[[EXPLOIT_MODE]]';
  if (EXPLOIT_MODE.indexOf('[[') === 0) EXPLOIT_MODE = 'auto';

  /* Firmwares supported by each exploit, keyed on the exact UA firmware
     string (/PlayStation 5/x.xx/). Keep in sync with the exploits' own lists:
     umtx2/document/en/ps5/main.js and slopkit/slopkit/main.js. */
  var UMTX2_FIRMWARES = ["1.00", "1.01", "1.02", "1.05", "1.10", "1.11", "1.12", "1.13", "1.14", "2.00", "2.20", "2.25", "2.26", "2.30", "2.50", "2.70", "3.00", "3.10", "3.20", "3.21", "4.00", "4.02", "4.03", "4.50", "4.51", "5.00", "5.02", "5.10", "5.50"];
  var POOPS_FIRMWARES = ["7.00", "7.01", "7.20", "7.40", "7.60", "7.61", "8.00", "8.20", "8.40", "8.60", "9.00", "9.05", "9.20", "9.40", "9.60", "10.00", "10.01", "10.20", "10.40", "10.60", "11.00", "11.20", "11.40", "11.60", "12.00"];
  var P2JB_FIRMWARES = ["12.02", "12.20", "12.40", "12.60", "12.70"];

  var UMTX2_URL =
    'umtx2/index.html?autoload=payload.elf&v=1';

  /* Keep in sync with EXPLOIT_IFRAME_URL in tools/gen_file_registry.py — the
     AppCache manifest lists these exact URLs so the console can serve them
     offline (AppCache matches URLs including the query string). */
  var POOPS_URL =
    'slopkit/slopkit/poops.html?go=1&auto=1&production=1&trigger=netcontrol&attempts=8&only=ps0_preflight,ps1_prepare,ps3_stage0,ps4_validate,ps5_stage1,ps6_stage2,ps8_stage3,ps9_stage4,ps10_stage5&log=debug&payload=1&autoload=payload.elf&v=final';
  var P2JB_URL =
    'slopkit/slopkit/p2jb.html?go=1&auto=1&production=1&log=debug&payload=1&autoload=payload.elf&v=final';

  var EXPLOIT_URL = '';
  var exploitMode = null;

  function uiLog(message, type) {
    type = type || 'info';
    var entry = document.createElement('div');
    entry.className = 'line ' + type;
    entry.textContent = message;
    logContainer.appendChild(entry);
    while (logContainer.childElementCount > MAX_LOG_LINES) {
      logContainer.removeChild(logContainer.firstChild);
    }
    logContainer.parentNode.scrollTop = logContainer.parentNode.scrollHeight;
    return entry;
  }

  function updateProgress(percent, message) {
    progressBar.style.transform = 'scaleX(' + percent / 100 + ')';
    if (message) {
      progressLabel.textContent = message;
      uiLog(message, 'info');
    }
  }

  window.uiLog = uiLog;
  window.updateProgress = updateProgress;

  function detectFirmware() {
    var m = /PlayStation 5\/(\d+\.\d+)/.exec(navigator.userAgent);
    if (!m) return null;
    return { str: m[1], num: parseFloat(m[1]) };
  }

  /* Choose which exploit to arm. Forced modes (build-time EXPLOIT_MODE or a
     ?force= query on this page) bypass the firmware table so a specific chain
     can be exercised on any firmware — the exploit page's own firmware guard
     still applies. Returns 'umtx2' | 'poops' | 'p2jb' | null. */
  function pickExploit() {
    var fw = detectFirmware();
    var forced = null;
    try {
      var q = new URLSearchParams(window.location.search).get('force');
      if (q === 'umtx2' || q === 'poops' || q === 'p2jb') forced = q;
    } catch (e) { }
    if (forced) {
      uiLog('[force] using ' + forced + ' on firmware ' + (fw ? fw.str : 'unknown'), 'warning');
      return forced;
    }
    if (EXPLOIT_MODE === 'umtx2' || EXPLOIT_MODE === 'poops'
      || EXPLOIT_MODE === 'p2jb') {
      uiLog('[force] using ' + EXPLOIT_MODE + ' on firmware ' + (fw ? fw.str : 'unknown'), 'warning');
      return EXPLOIT_MODE;
    }
    if (!fw) {
      uiLog('[ERROR] Not a PlayStation 5 browser.', 'error');
      return null;
    }
    if (UMTX2_FIRMWARES.indexOf(fw.str) !== -1) return 'umtx2';
    if (POOPS_FIRMWARES.indexOf(fw.str) !== -1) return 'poops';
    if (P2JB_FIRMWARES.indexOf(fw.str) !== -1) return 'p2jb';
    uiLog('[ERROR] Unsupported firmware ' + fw.str +
      ' (supported: 1.00-5.50 via umtx2, 7.00-12.00 via poops,'
      + ' 12.02-12.70 via p2jb).', 'error');
    return null;
  }

  function revealExploit() {
    splashEl.classList.add('hide');
    setTimeout(function () {
      splashEl.hidden = true;
      loaderEl.hidden = false;
    }, 480);
  }

  function onAutoloadResult(data) {
    if (finished) return;
    finished = true;
    if (data.ok) {
      uiLog('Payload loaded (' + data.bytes + ' bytes sent to elfldr).', 'success');
      updateProgress(100, 'Autoload finished.');

      /* Payload is running as its own process now — unload the iframe to
         free the memory it held and avoid a browser OOM dialog.
         NOTE: only safe for umtx2; poops and p2jb require their document to
         remain open (poops holds parked racers and fds, p2jb holds its ROP
         workers and spawned threads). */
      if (exploitMode === 'umtx2') {
        try { exploitEl.src = 'about:blank'; } catch (e) { }
      }
    } else {
      uiLog('[ERROR] Autoload failed: ' + (data.why || 'unknown error'), 'error');
      updateProgress(0, 'Autoload failed.');
    }
    setTimeout(function () {
      if (data.ok) {
        uiLog('Payload running on the console.', 'success');
      }
    }, 1500);
  }

  /* Mirror slopkit's live screen log (#scr) and stage text (#stage) from the
     same-origin exploit iframe into our own log view, so the UI shows what
     the chain is doing (and errors) instead of a generic progress message. */
  function mirrorSlopkit() {
    var doc;
    try {
      doc = exploitEl.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc) return;

    /* Detect iframe navigation/reload: reset the mirror so a fresh document
       (or a crash restore) streams its log from the top. */
    var frameUrl = '';
    try {
      frameUrl = exploitEl.contentWindow.location.href;
    } catch (e) { }
    if (frameUrl !== lastFrameUrl) {
      lastFrameUrl = frameUrl;
      mirroredLines = 0;
      lastStageText = '';
      lastStageCls = '';
      lastSummaryText = '';
      earlyLinesLogged = 0;
    }
    /* The iframe is intentionally empty until the chain is armed — nothing
       to mirror yet. */
    if (!chainStarted) return;

    var scr = doc.getElementById('scr');
    if (!scr) {
      /* #scr is static HTML in poops.html — while it parses, #cat (earlier in
         the DOM) and <title> are already present, so a poll can briefly see
         "slopkit page without its screen". Same for the blank pre-navigation
         document. Never warn or re-arm during these windows: re-arming
         reloads the exploit a second time (and the log doubles). */
      var isArmedUrl = frameUrl.length > EXPLOIT_URL.length &&
        frameUrl.slice(-EXPLOIT_URL.length) === EXPLOIT_URL;
      if (frameUrl === 'about:blank' || doc.readyState !== 'complete'
        || isArmedUrl) {
        return;
      }
      /* Only reached when the iframe settled on a *different* page: slopkit's
         landing page (RUN button), a not-armed poops.html, or a 404. */
      var arm = doc.getElementById('arm');
      var cat = doc.getElementById('cat');
      var start = doc.getElementById('start');
      var title = doc.title || '';
      if (mirrorSlopkit.warned !== frameUrl) {
        mirrorSlopkit.warned = frameUrl;
        if (start) {
          uiLog('[iframe] slopkit landing page loaded (RUN button) — chain not started.', 'warning');
        } else if (arm && !arm.hidden) {
          uiLog('[iframe] slopkit page is NOT armed (?go=1 missing) — nothing will run.', 'warning');
        } else if (cat && title.indexOf('slopkit') !== -1) {
          uiLog('[iframe] slopkit page loaded without its screen (title="' + title + '").', 'warning');
        } else {
          uiLog('[iframe] page has no slopkit screen: title="' + title + '"', 'warning');
        }
      }
      /* Re-arm only for a wrong *slopkit* page (landing page or not-armed
         poops.html) — never for the armed URL itself. */
      var isSlopkitPage = !!start || (arm && !arm.hidden);
      if (chainStarted && isSlopkitPage && repairCount < 5) {
        repairCount++;
        uiLog('[iframe] re-arming (attempt ' + repairCount + '): ' + EXPLOIT_URL, 'info');
        try {
          exploitEl.src = EXPLOIT_URL;
        } catch (e) {
          uiLog('[iframe] re-arm failed: ' + (e && e.message ? e.message : e), 'error');
        }
      } else if (chainStarted && isSlopkitPage) {
        uiLog('[iframe] giving up after ' + repairCount + ' re-arm attempts.', 'error');
      }
      return;
    }

    var lines = scr.textContent.split('\n');
    /* If the screen shrank (slopkit caps its log at SCREEN_LINES and drops
       the oldest lines, or a fresh document replaced it), re-anchor the
       counter WITHOUT re-logging — the remaining lines were already streamed,
       and re-streaming them would double the log. A fresh document starts
       empty, so its new lines stream normally from here on. */
    if (lines.length < mirroredLines) {
      mirroredLines = lines.length;
    }
    for (; mirroredLines < lines.length; mirroredLines++) {
      var line = lines[mirroredLines].trim();
      if (!line) continue;
      /* Curated release log: surface the per-row progress ("> "), the
         milestone marks (STAGE / POOPS / LATCH / OFFSETS / ...), and
         anything that looks like a failure — never the full raw stream
         (that floods the UI and hides the actual result). */
      if (/^>/.test(line) || /^\[\+\]/.test(line)
        || /^(STAGE[0-5]|ALLPROC-CHECK|ALIASES-REPAIRED|POOPS-COMPLETE|POOPS-VERDICT|LATCH-HELD|LATCH-READ|OFFSETS-READY|WEBKIT-BASE|MODULE-BASES|SOCKETS|SPAWN|WAKEGATE)/.test(line)) {
        uiLog('[log] ' + line, 'info');
      } else if (/FAIL|ERROR|REFUSED|REBOOT|failed|panic|exception/i.test(line)
        || /^\[-\]/.test(line)) {
        uiLog('[log] ' + line, 'error');
      }
    }

    var stage = doc.getElementById('stage');
    if (stage && stage.textContent !== lastStageText) {
      lastStageText = stage.textContent;
      lastStageCls = stage.className || '';
      progressLabel.textContent = lastStageText;
      if (lastStageCls.indexOf('bad') !== -1) {
        uiLog('[stage] ' + lastStageText, 'error');
      } else if (lastStageCls.indexOf('ok') !== -1) {
        uiLog('[stage] ' + lastStageText, 'success');
      } else {
        uiLog('[stage] ' + lastStageText, 'info');
      }
    }

    /* Mirror the summary block (verdict/reboot details) when it changes. */
    var summary = doc.getElementById('summary');
    if (summary && summary.textContent && summary.textContent !== lastSummaryText) {
      var summaryLines = summary.textContent.split('\n');
      for (var i = 0; i < summaryLines.length; i++) {
        var sline = summaryLines[i].trim();
        if (sline && /FAIL|ERROR|REFUSED|REBOOT|failed|panic/i.test(sline)) {
          uiLog('[summary] ' + sline, 'error');
        }
      }
      lastSummaryText = summary.textContent;
    }

    /* Mirror the #early log (errors/notices written before the module chain
       runs — the earliest thing slopkit produces). slopkit only ever appends
       to #early, so log just the new tail — re-logging the whole buffer on
       every change doubled every early line. */
    var early = doc.getElementById('early');
    if (early && early.textContent) {
      var earlyLines = early.textContent.split('\n');
      if (earlyLines.length < earlyLinesLogged) {
        earlyLinesLogged = 0;
      }
      for (; earlyLinesLogged < earlyLines.length; earlyLinesLogged++) {
        var eline = earlyLines[earlyLinesLogged].trim();
        if (eline) {
          uiLog('[early] ' + eline, /ERROR|FAIL/i.test(eline) ? 'error' : 'info');
        }
      }
    }
  }

  /* Mirror umtx2's live #console log (#console > div, classed LOG-*) from the
     same-origin exploit iframe into our own log view, mapping its severity
     classes onto ours. umtx2 updates its last console line in place for
     progress logs (FLAG_TEMP, e.g. "Race attempt N-M"), so we update our
     matching last line in place too. */
  var umtx2MirroredLines = 0;
  var umtx2LastEntry = null;
  var umtx2LastText = '';
  function mirrorUmtx2() {
    var doc;
    try {
      doc = exploitEl.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc || !chainStarted) return;
    var lines = doc.querySelectorAll('#console > div');
    if (lines.length < umtx2MirroredLines) {
      /* Iframe reloaded (#console recreated) — restart from a fresh document. */
      umtx2MirroredLines = lines.length;
      umtx2LastEntry = null;
      umtx2LastText = '';
    }
    for (; umtx2MirroredLines < lines.length; umtx2MirroredLines++) {
      var el = lines[umtx2MirroredLines];
      var text = (el.textContent || '').trim();
      if (!text) continue;
      var cls = el.className || '';
      var entry;
      if (/LOG-ERROR/.test(cls)) {
        entry = uiLog('[umtx2] ' + text, 'error');
      } else if (/LOG-WARN/.test(cls)) {
        entry = uiLog('[umtx2] ' + text, 'warning');
      } else if (/LOG-SUCCESS/.test(cls)) {
        entry = uiLog('[umtx2] ' + text, 'success');
      } else {
        entry = uiLog('[umtx2] ' + text, 'info');
      }
      umtx2LastEntry = entry;
      umtx2LastText = text;
    }
    /* Live-update the last mirrored line when umtx2 rewrites it in place. */
    if (lines.length > 0 && umtx2LastEntry
      && umtx2LastEntry === logContainer.lastChild) {
      var last = lines[lines.length - 1];
      var lastText = (last.textContent || '').trim();
      if (lastText && lastText !== umtx2LastText) {
        umtx2LastEntry.textContent = '[umtx2] ' + lastText;
        umtx2LastText = lastText;
      }
    }
  }

  /* Mirror p2jb's ~1 h run from the same-origin exploit iframe into our UI.
     p2jb renders a pinned progress readout (#livestat, repainted by
     upstream's 1 Hz ticker) with a per-phase bar and an OVERALL line:
       "P2JB   total 00:12:03   leak 00:09:41\n<phase text>\n"
       "[####....] 43.10%   0.31%/min   ETA 00:38:12 ...\n"
       "OVERALL [####....] 37.4%   step 3/7 (leak)   ~00:41:12 left ..."
     Parse it on every poll to drive our own progress bar/label live across
     the whole run WITHOUT flooding the log — only phase changes are logged.
     Screen/stage/summary/early mirroring works like the poops one, with a
     p2jb-specific curated mark filter (upstream's log=debug screen would
     otherwise flood us over the hour). */
  var p2jbMirroredLines = 0;
  var p2jbLastStageText = '';
  var p2jbLastStageCls = '';
  var p2jbLastSummaryText = '';
  var p2jbEarlyLinesLogged = 0;
  var p2jbLastPhaseStep = '';
  var p2jbComplete = false;
  function mirrorP2jb() {
    var doc;
    try {
      doc = exploitEl.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc) return;

    /* Detect iframe navigation/reload: reset the mirrors so a fresh document
       (or a crash restore) streams its log from the top. */
    var frameUrl = '';
    try {
      frameUrl = exploitEl.contentWindow.location.href;
    } catch (e) { }
    if (frameUrl !== lastFrameUrl) {
      lastFrameUrl = frameUrl;
      p2jbMirroredLines = 0;
      p2jbLastStageText = '';
      p2jbLastStageCls = '';
      p2jbLastSummaryText = '';
      p2jbEarlyLinesLogged = 0;
      p2jbLastPhaseStep = '';
      p2jbComplete = false;
    }
    /* The iframe is intentionally empty until the chain is armed — nothing
       to mirror yet. */
    if (!chainStarted) return;

    var scr = doc.getElementById('scr');
    if (!scr) {
      /* #scr is static HTML in p2jb.html — while it parses, earlier elements
         and <title> are already present, so a poll can briefly see "p2jb
         page without its screen". Same for the blank pre-navigation
         document. Never warn or re-arm during these windows: re-arming
         reloads the exploit a second time (and the log doubles). */
      var isArmedUrl = frameUrl.length > EXPLOIT_URL.length &&
        frameUrl.slice(-EXPLOIT_URL.length) === EXPLOIT_URL;
      if (frameUrl === 'about:blank' || doc.readyState !== 'complete'
        || isArmedUrl) {
        return;
      }
      /* Only reached when the iframe settled on a *different* page: slopkit's
         landing page, a not-armed p2jb.html, or a 404. */
      var arm = doc.getElementById('arm');
      var runP2jb = doc.getElementById('run-p2jb');
      var title = doc.title || '';
      if (mirrorP2jb.warned !== frameUrl) {
        mirrorP2jb.warned = frameUrl;
        if (runP2jb) {
          uiLog('[iframe] slopkit landing page loaded — chain not started.', 'warning');
        } else if (arm && !arm.hidden) {
          uiLog('[iframe] p2jb page is NOT armed (?go=1 missing) — nothing will run.', 'warning');
        } else if (title.indexOf('slopkit') !== -1) {
          uiLog('[iframe] p2jb page loaded without its screen (title="' + title + '").', 'warning');
        } else {
          uiLog('[iframe] page has no p2jb screen: title="' + title + '"', 'warning');
        }
      }
      /* Re-arm only for a wrong *slopkit* page (landing page or not-armed
         p2jb.html) — never for the armed URL itself. */
      var isSlopkitPage = !!runP2jb || (arm && !arm.hidden);
      if (chainStarted && isSlopkitPage && repairCount < 5) {
        repairCount++;
        uiLog('[iframe] re-arming (attempt ' + repairCount + '): ' + EXPLOIT_URL, 'info');
        try {
          exploitEl.src = EXPLOIT_URL;
        } catch (e) {
          uiLog('[iframe] re-arm failed: ' + (e && e.message ? e.message : e), 'error');
        }
      } else if (chainStarted && isSlopkitPage) {
        uiLog('[iframe] giving up after ' + repairCount + ' re-arm attempts.', 'error');
      }
      return;
    }

    /* Live progress: parse the OVERALL line of #livestat into our bar/label.
       The element only exists once the first real phase starts; before that
       the stage text carries the status. Upstream's 1 Hz ticker keeps
       repainting #livestat even after the win, so stop once the chain is
       complete and let the stage/autoload messages own the label again. */
    var live = doc.getElementById('livestat');
    if (live && live.textContent && !p2jbComplete) {
      var mOverall = /OVERALL \[[#.]*\]\s+(\d+(?:\.\d+)?)%\s+step (\d+)\/(\d+)\s+\(([a-z]+)\)/.exec(live.textContent);
      var mLeft = /~(\d{2}:\d{2}:\d{2}) left/.exec(live.textContent);
      if (mOverall) {
        progressBar.style.transform = 'scaleX(' +
          Math.min(100, parseFloat(mOverall[1])) / 100 + ')';
        progressLabel.textContent = 'p2jb ' + mOverall[4] + ' — overall '
          + mOverall[1] + '%' + (mLeft ? ' · ~' + mLeft[1] + ' left' : '');
        var phaseStep = mOverall[2] + '/' + mOverall[3] + ' ' + mOverall[4];
        if (phaseStep !== p2jbLastPhaseStep) {
          p2jbLastPhaseStep = phaseStep;
          uiLog('[p2jb] phase ' + mOverall[4] + ' (step ' + mOverall[2]
            + '/' + mOverall[3] + ') — overall ' + mOverall[1] + '%'
            + (mLeft ? ', ~' + mLeft[1] + ' left' : ''), 'info');
        }
      }
    }

    var lines = scr.textContent.split('\n');
    /* If the screen shrank (p2jb caps its log at 12 lines and drops the
       oldest ones, or a fresh document replaced it), re-anchor the counter
       WITHOUT re-logging — the remaining lines were already streamed. */
    if (lines.length < p2jbMirroredLines) {
      p2jbMirroredLines = lines.length;
    }
    for (; p2jbMirroredLines < lines.length; p2jbMirroredLines++) {
      var line = lines[p2jbMirroredLines].trim();
      if (!line) continue;
      /* Curated release log: milestone marks and failures only. The verbose
         debug stream (LEAK-/SPRAY-/TRIPLET/PROGRESS every 15 s, ...) stays
         off our log — the livestat bar above carries the live progress. */
      if (/^(POOPS-BOOT|OFFSETS-READY|TRIGGER-ARMED|TRIGGER-FIRED|LATCH-SET|LATCH-ESCALATE|LATCH-CLEAR|LATCH-HELD|LATCH-RELEASED|POOPS-LATCHED|POOPS-STALLED|BOOT-STALLED|CHAIN-DEAD|STAGE5-DONE|POOPS-COMPLETE|POOPS-FAILED|ELFLDR-MENU-VISIBLE|ELFLDR-UP|ELF-SENT|ELF-SEND-FAILED|ELF-SENDER-BLOCKED|KEXP-JOIN|KEXP-JOIN-PRE|KEXP-SPAWN|KEXP-ELF|AUTOLOAD-OK|AUTOLOAD-FAILED)/.test(line)) {
        uiLog('[log] ' + line, 'info');
      } else if (/FAIL|ERROR|REFUSED|REBOOT|failed|panic|exception/i.test(line)
        || /^\[-\]/.test(line)) {
        uiLog('[log] ' + line, 'error');
      }
    }

    var stage = doc.getElementById('stage');
    if (stage && stage.textContent !== p2jbLastStageText) {
      p2jbLastStageText = stage.textContent;
      p2jbLastStageCls = stage.className || '';
      /* The livestat label wins while the run is in progress; before it
         exists (early boot) and after completion (win/autoload messages)
         mirror the stage text instead. */
      if (!live || p2jbComplete) progressLabel.textContent = p2jbLastStageText;
      /* showWin() fires on every win path (KEXP-JOIN detection and the
         already-jailbroken shortcut) — latch completion here so the
         autoload flow owns the UI from this point on. */
      if (!p2jbComplete && p2jbLastStageText.indexOf('ELF LOADER READY') !== -1) {
        p2jbComplete = true;
        progressBar.style.transform = 'scaleX(1)';
        uiLog('[p2jb] exploit complete — elfldr ready.', 'success');
      }
      if (p2jbLastStageCls.indexOf('bad') !== -1) {
        uiLog('[stage] ' + p2jbLastStageText, 'error');
      } else if (p2jbLastStageCls.indexOf('ok') !== -1) {
        uiLog('[stage] ' + p2jbLastStageText, 'success');
      } else {
        uiLog('[stage] ' + p2jbLastStageText, 'info');
      }
    }

    /* Mirror the summary block (verdict details) when it changes. */
    var summary = doc.getElementById('summary');
    if (summary && summary.textContent && summary.textContent !== p2jbLastSummaryText) {
      var summaryLines = summary.textContent.split('\n');
      for (var i = 0; i < summaryLines.length; i++) {
        var sline = summaryLines[i].trim();
        if (sline && /FAIL|ERROR|REFUSED|REBOOT|failed|panic/i.test(sline)) {
          uiLog('[summary] ' + sline, 'error');
        }
      }
      p2jbLastSummaryText = summary.textContent;
    }

    /* Mirror the #early log (errors/notices written before the module chain
       runs). p2jb only ever appends to #early, so log just the new tail. */
    var early = doc.getElementById('early');
    if (early && early.textContent) {
      var earlyLines = early.textContent.split('\n');
      if (earlyLines.length < p2jbEarlyLinesLogged) {
        p2jbEarlyLinesLogged = 0;
      }
      for (; p2jbEarlyLinesLogged < earlyLines.length; p2jbEarlyLinesLogged++) {
        var eline = earlyLines[p2jbEarlyLinesLogged].trim();
        if (eline) {
          uiLog('[early] ' + eline, /ERROR|FAIL/i.test(eline) ? 'error' : 'info');
        }
      }
    }
  }

  function mirrorExploit() {
    if (exploitMode === 'umtx2') {
      mirrorUmtx2();
      return;
    }
    if (exploitMode === 'p2jb') {
      mirrorP2jb();
      return;
    }
    mirrorSlopkit();
  }

  function start() {
    uiLog('WebKit Autoloader by PLK', 'success');
    updateProgress(0, 'Waiting to start...');

    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.type !== 'wkal') return;
      if (data.kind === 'autoload') {
        onAutoloadResult(data);
      }
    });

    /* No iframe 'load' listener: its mirroredLines reset re-streamed the
       whole screen mid-run (doubling the log), and the other state resets
       are already handled by the URL-diff branch in mirrorSlopkit() plus
       the shrink re-anchor (fresh documents start with an empty screen,
       so their lines stream normally). */
    setInterval(mirrorExploit, 500);

    var picked = pickExploit();
    if (!picked) {
      updateProgress(0, 'Unsupported firmware.');
      return;
    }
    exploitMode = picked;
    EXPLOIT_URL = picked === 'umtx2' ? UMTX2_URL
      : picked === 'p2jb' ? P2JB_URL
        : POOPS_URL;

    /* umtx2 auto-runs its chain on load when sessionStorage 'on_load_autorun'
       is set (it clears it itself once main() starts); clear it on the
       poops/p2jb paths so a stale key never re-triggers it. */
    try {
      if (picked === 'umtx2') {
        sessionStorage.setItem('on_load_autorun', 'kernel');
        sessionStorage.setItem('wkal_autoload', 'payload.elf');
      } else {
        sessionStorage.removeItem('on_load_autorun');
        sessionStorage.removeItem('wkal_autoload');
      }
    } catch (e) { }

    chainStarted = true;
    if (picked === 'poops' || picked === 'p2jb') {
      clearSlopkitState();
    }
    try {
      exploitEl.src = EXPLOIT_URL;
    } catch (e) { }

    setTimeout(revealExploit, 1500);
  }

  window.addEventListener('load', start);
})();
