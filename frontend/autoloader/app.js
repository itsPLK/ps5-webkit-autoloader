// Presentation only: runs through the standalone builder's awaited --js hook.
// Keep the actual console, payloads and exploit in this document.
(function () {
  'use strict';
  var output = document.getElementById('console');
  if (!output || document.getElementById('loader')) return;

  function element(tag, id, parent, text) {
    var node = document.createElement(tag);
    node.id = id;
    if (text) node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  var loader = element('main', 'loader', document.body);
  var wrapper = element('div', 'logWrapper', loader);
  wrapper.appendChild(output);
  var progress = element('div', 'progressContainer', loader);
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  var bar = element('div', 'progressBar', progress);
  var label = element('div', 'progressLabel', progress);
  var config = window.WKAL_PAGE || {};
  if (config.version) {
    document.title = 'WebKit Autoloader v' + config.version + ' by PLK' +
      (config.buildTime ? ' (built ' + config.buildTime + ')' : '');
  }
  var footer = element('div', 'footer', document.body);
  element('div', 'buildInfo', footer, 'WebKit Autoloader' +
    (config.version ? ' v' + config.version : '') + ' by PLK' +
    (config.buildTime ? ' (built ' + config.buildTime + ')' : ''));
  var source = element('div', 'sourceInfo', footer, 'This project is free and open source: ');
  var link = element('a', 'sourceLink', source, 'github.com/itsPLK/ps5-webkit-autoloader');
  link.href = 'https://github.com/itsPLK/ps5-webkit-autoloader';

  var percent = 0;
  var finished = false;
  var sent = false;
  function update(next, message, state) {
    percent = Math.max(percent, next);
    bar.style.width = percent + '%';
    label.textContent = message;
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-valuetext', message);
    progress.setAttribute('data-state', state || 'running');
  }
  update(0, 'Starting WebKit exploit...');

  function readLine(line) {
    var text = line.textContent || '';
    var error = /(?:^|\s)log-(?:error|minus)(?:\s|$)/.test(line.className);
    var summary = /queue finished: \d+\/\d+ completed, (\d+) failed/.exec(text);
    if (summary) {
      finished = true;
      if (Number(summary[1]) !== 0) update(percent, 'Autoload failed. See the log above.', 'error');
      else update(100, sent ? 'Autoload finished.' : 'Payloads finished.', 'done');
      return;
    }
    if (/queue stopped:/.test(text)) {
      finished = true;
      if (error) update(percent, 'Stopped. See the log above.', 'error');
      else if (/ELF loader is already accepting connections/.test(text))
        update(100, 'ELF loader already running. Nothing to do.', 'done');
      else update(percent, 'Stopped. See the log above.', 'stopped');
      return;
    }
    if (error) {
      update(percent, 'An error occurred. See the log above.', 'error');
      return;
    }
    if (finished) return;
    if (/Autoload: sent \d+ bytes/.test(text)) {
      sent = true;
      update(98, 'Finishing autoload...');
    } else if (/Staging and sending|Autoload: staging/i.test(text)) update(95, 'Loading autoload payload...');
    else if (/Wobkot Relapse completed|Created bin thread|kernel exploit complete, we are root/i.test(text)) update(90, 'ELF loader ready...');
    else if (/Achieved jailbreak|ps9_stage4.*PASS/i.test(text)) update(80, 'Privileges ready...');
    else if (/Achieved (?:unrestricted kernel RW|kernel ARW)|ps8_stage3.*PASS/i.test(text)) update(65, 'Kernel read/write ready...');
    else if (/Wobkot Relapse|===RELAPSE===|kernel exploit starting|selected .*poops/i.test(text)) update(40, 'Starting kernel exploit...');
    else if (/Wobkot userland ready|Achieved ROP/i.test(text)) update(30, 'WebKit ready...');
    else if (/Achieved ARW/i.test(text)) update(20, 'Preparing WebKit...');
    else if (/Starting Wobkot userland/i.test(text)) update(10, 'Starting WebKit exploit...');
    else {
      var stage = /\bSTAGE\s*([0-5])\b/i.exec(text);
      if (stage) update(40 + Number(stage[1]) * 10, 'Running kernel exploit...');
    }
  }

  // Observe the native log instead of replacing writeLog or the module APIs.
  // Process only changed lines, including in-place stage updates.
  var observer = new MutationObserver(function (records) {
    var changed = [];
    function remember(node) {
      if (node.nodeType !== 1) node = node.parentNode;
      while (node && node.parentNode !== output) node = node.parentNode;
      if (node && changed.indexOf(node) < 0) changed.push(node);
    }
    records.forEach(function (record) {
      if (record.target === output) {
        for (var i = 0; i < record.addedNodes.length; i++) remember(record.addedNodes[i]);
      } else remember(record.target);
    });
    changed.forEach(readLine);
    while (output.children.length > 80) output.removeChild(output.firstElementChild);
    wrapper.scrollTop = wrapper.scrollHeight;
  });
  observer.observe(output, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
}());
