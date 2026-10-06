const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(initial, updater = { current_version: '0.1.2', available_version: null, message: 'Launcher is up to date.' }, userAgent = 'Windows NT 10.0') {
  const elements = new Map();
  for (const id of ['window-controls', 'window-minimize', 'window-close', 'window-drag', 'installed', 'latest', 'notes', 'primary', 'refresh', 'status', 'progress', 'launcher-version', 'launcher-update', 'launcher-update-status', 'launcher-update-confirm', 'launcher-confirm-text', 'launcher-install', 'launcher-later', 'launcher-progress']) {
    elements.set(id, {
      textContent: '', disabled: false, hidden: true, value: 0,
      classes: new Set(), handlers: {},
      classList: {
        toggle(name, value) { if (value) elements.get(id).classes.add(name); else elements.get(id).classes.delete(name); },
        add(name) { elements.get(id).classes.add(name); },
        remove(name) { elements.get(id).classes.delete(name); },
      },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      removeAttribute(name) { delete this[name]; },
    });
  }
  const calls = [];
  const windowCalls = [];
  const requests = [];
  let next = initial;
  let launcherNext = updater;
  let installResult;
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id), body: { classList: { add() {} } } },
    navigator: { userAgent },
    window: { __TAURI__: {
      window: { getCurrentWindow: () => ({
        minimize: async () => { windowCalls.push('minimize'); },
        close: async () => { windowCalls.push('close'); },
        startDragging: async () => { windowCalls.push('startDragging'); },
      }) },
      core: { invoke: async (command, args) => {
        calls.push(command); requests.push({ command, args });
        const result = command === 'launcher_update_status' ? launcherNext : command === 'install_launcher_update' ? installResult : next;
        if (result instanceof Error) throw result;
        return result;
      } },
      event: { listen: async () => {} },
    } },
    setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return { elements, calls, windowCalls, requests, context, setNext(value) { next = value; }, setUpdater(value) { launcherNext = value; }, setInstallResult(value) { installResult = value; } };
}

const installed = { version: '0.1.0', sha256: 'a', notes: 'Installed' };
const latest = { version: '0.2.0', sha256: 'b', notes: '<script>not HTML</script>' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('first installation is offered and notes use textContent', async () => {
  const h = harness({ installed: null, latest, check: 'online', running: false, message: 'Ready' });
  await flush();
  assert.equal(h.elements.get('primary').textContent, 'Install');
  assert.equal(h.elements.get('primary').disabled, false);
  assert.equal(h.elements.get('notes').textContent, latest.notes);
  h.elements.get('primary').handlers.click();
  await flush();
  assert.equal(h.calls.at(-1), 'install');
});

test('a known update requires Update even offline', async () => {
  const h = harness({ installed, latest, check: 'unavailable', running: false, message: 'Offline' });
  await flush();
  assert.equal(h.elements.get('primary').textContent, 'Update');
});

test('changed archive hash requires an update even with the same version', async () => {
  const h = harness({ installed, latest: { ...installed, sha256: 'different' }, check: 'online', running: false, message: 'Update' });
  await flush();
  assert.equal(h.elements.get('primary').textContent, 'Update');
});

test('offline installed build can play without a known update', async () => {
  const h = harness({ installed, latest: null, check: 'unavailable', running: false, message: 'Offline' });
  await flush();
  assert.equal(h.elements.get('primary').textContent, 'Play');
  assert.equal(h.elements.get('primary').disabled, false);
  h.elements.get('primary').handlers.click();
  await flush();
  assert.equal(h.calls.at(-1), 'launch');
});

test('invalid feed and running game disable the primary action', async () => {
  for (const extra of [{ check: 'error', running: false }, { check: 'online', running: true }]) {
    const h = harness({ installed, latest: installed, message: 'Blocked', ...extra });
    await flush();
    assert.equal(h.elements.get('primary').disabled, true);
  }
});

test('failed operation shows its error and permits checking again', async () => {
  const h = harness({ installed, latest, check: 'online', running: false, message: 'Ready' });
  await flush();
  h.setNext(new Error('Checksum mismatch'));
  h.elements.get('primary').handlers.click();
  await flush();
  assert.match(h.elements.get('status').textContent, /Checksum mismatch/);
  assert.equal(h.elements.get('refresh').disabled, false);
  assert.equal(h.elements.get('progress').hidden, true);
});

const updater = { current_version: '0.1.2', available_version: '0.1.3', message: 'Launcher update available.' };
const playable = { installed, latest: installed, check: 'online', running: false, message: 'Ready' };

test('Windows inline controls minimize and request a safe close', async () => {
  const h = harness(playable);
  await flush();
  assert.equal(h.elements.get('window-controls').hidden, false);
  await h.elements.get('window-minimize').handlers.click();
  await h.elements.get('window-close').handlers.click();
  assert.deepEqual(h.windowCalls, ['minimize', 'close']);
});

test('header drags only on a primary single click, never on double-click', async () => {
  const h = harness(playable);
  await flush();
  const drag = h.elements.get('window-drag').handlers.pointerdown;
  drag({ button: 0, detail: 1 });
  drag({ button: 0, detail: 2 });
  drag({ button: 2, detail: 1 });
  assert.deepEqual(h.windowCalls, ['startDragging']);
});

test('other platforms retain their native window controls', async () => {
  const h = harness(playable, undefined, 'Macintosh');
  await flush();
  assert.equal(h.elements.get('window-controls').hidden, true);
  assert.equal(h.elements.get('window-drag').handlers.pointerdown, undefined);
});

test('launcher update is optional and requires explicit confirmation', async () => {
  const h = harness(playable, updater);
  await flush();
  assert.equal(h.elements.get('primary').disabled, false);
  assert.equal(h.elements.get('launcher-update').hidden, false);
  assert.equal(h.calls.includes('install_launcher_update'), false);
  h.elements.get('launcher-update').handlers.click();
  assert.equal(h.elements.get('launcher-update-confirm').hidden, false);
  assert.equal(h.calls.includes('install_launcher_update'), false);
  h.elements.get('launcher-install').handlers.click();
  await flush();
  assert.equal(h.requests.at(-1).command, 'install_launcher_update');
  assert.equal(h.requests.at(-1).args.expectedVersion, '0.1.3');
});

test('later dismisses launcher update confirmation without installing', async () => {
  const h = harness(playable, updater);
  await flush();
  h.elements.get('launcher-update').handlers.click();
  h.elements.get('launcher-later').handlers.click();
  assert.equal(h.elements.get('launcher-update-confirm').hidden, true);
  assert.equal(h.calls.includes('install_launcher_update'), false);
});

test('launcher feed failure does not block playing or game updates', async () => {
  const h = harness(playable, new Error('Feed unavailable'));
  await flush();
  assert.equal(h.elements.get('primary').disabled, false);
  assert.equal(h.elements.get('launcher-update').hidden, true);
  assert.match(h.elements.get('launcher-update-status').textContent, /unaffected/);
});

test('running game blocks launcher installation', async () => {
  const h = harness({ ...playable, running: true }, updater);
  await flush();
  assert.equal(h.elements.get('launcher-update').disabled, true);
  h.elements.get('launcher-install').handlers.click();
  assert.equal(h.calls.includes('install_launcher_update'), false);
});

test('signature failure restores game controls and keeps update error separate', async () => {
  const h = harness(playable, updater);
  await flush();
  h.setInstallResult(new Error('Invalid update signature'));
  h.elements.get('launcher-update').handlers.click();
  h.elements.get('launcher-install').handlers.click();
  await flush();
  assert.equal(h.elements.get('primary').disabled, false);
  assert.match(h.elements.get('launcher-update-status').textContent, /Invalid update signature/);
  assert.equal(h.elements.get('status').textContent, 'Ready');
  assert.equal(h.elements.get('launcher-progress').hidden, true);
});
