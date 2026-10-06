const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(initial, updater = { current_version: '0.1.2', available_version: null, message: 'Launcher is up to date.' }, userAgent = 'Windows NT 10.0') {
  const elements = new Map();
  elements.set('open-changelog', { disabled: false, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
  for (const id of ['launcher-update-section', 'launcher-update-badge']) {
    elements.set(id, { hidden: true, classes: new Set(), classList: { toggle(name, value) { if (value) elements.get(id).classes.add(name); else elements.get(id).classes.delete(name); } } });
  }
  for (const id of ['game-settings', 'settings-dialog', 'settings-close', 'settings-status', 'install-directory', 'change-directory', 'uninstall-game', 'uninstall-confirm', 'confirm-uninstall', 'cancel-uninstall', 'window-controls', 'window-minimize', 'window-close', 'window-drag', 'installed', 'latest', 'notes', 'primary', 'refresh', 'status', 'progress', 'launcher-version', 'launcher-update', 'launcher-update-status', 'launcher-update-confirm', 'launcher-confirm-text', 'launcher-install', 'launcher-later', 'launcher-progress']) {
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
      focus() { context.document.activeElement = this; },
    });
  }
  elements.set('view-folder', { disabled: true, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
  const calls = [];
  const windowCalls = [];
  const requests = [];
  const listeners = new Map();
  let next = initial;
  let launcherNext = updater;
  let installResult;
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id), handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; }, body: { classList: { add() {} } } },
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
      event: { listen: async (name, handler) => { listeners.set(name, handler); } },
    } },
    setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return { elements, calls, windowCalls, requests, listeners, context, setNext(value) { next = value; }, setUpdater(value) { launcherNext = value; }, setInstallResult(value) { installResult = value; } };
}

const installed = { version: '0.1.0', sha256: 'a', notes: 'Installed' };
const latest = { version: '0.2.0', sha256: 'b', notes: '<script>not HTML</script>' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Cartographer markup retains every app control exactly once and uses local artwork', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'No duplicate DOM IDs');
  for (const [, id] of app.matchAll(/el\('([^']+)'\)/g)) assert.equal(ids.filter(value => value === id).length, 1, `Missing control: ${id}`);
  assert.match(html, /class="map-cards"/);
  assert.match(html, /id="notes" tabindex="0"/);
  assert.match(html, /src="transmission\.svg"/);
  assert.ok(fs.existsSync(path.join(__dirname, '../ui/transmission.svg')));
  assert.doesNotMatch(html, /preview-bridge|mockups\.js/);
});

test('game and launcher progress retain determinate and indeterminate states', async () => {
  const h = harness({ installed, latest: installed, check: 'online', running: false, message: 'Ready' });
  await flush();
  for (const [event, progressId, statusId] of [['install-progress', 'progress', 'status'], ['launcher-update-progress', 'launcher-progress', 'launcher-update-status']]) {
    const handler = h.listeners.get(event);
    handler({ payload: { message: 'Verifying…', percent: null } });
    assert.equal(h.elements.get(progressId).hidden, false);
    assert.equal('value' in h.elements.get(progressId), false);
    assert.equal(h.elements.get(statusId).textContent, 'Verifying…');
    handler({ payload: { message: 'Downloading 64%', percent: 64 } });
    assert.equal(h.elements.get(progressId).value, 64);
    assert.equal(h.elements.get(statusId).textContent, 'Downloading 64%');
  }
});

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

test('Play and download actions use distinct color classes that reset with state changes', async () => {
  const h = harness(playable);
  await flush();
  const primary = h.elements.get('primary');
  assert.equal(primary.classes.has('action-play'), true);
  assert.equal(primary.classes.has('action-update'), false);
  h.setNext({ ...playable, latest });
  await h.elements.get('refresh').handlers.click();
  assert.equal(primary.textContent, 'Update');
  assert.equal(primary.classes.has('action-play'), false);
  assert.equal(primary.classes.has('action-update'), true);
  h.setNext({ ...playable, installed: null, latest });
  await h.elements.get('refresh').handlers.click();
  assert.equal(primary.textContent, 'Install');
  assert.equal(primary.classes.has('action-update'), true);
  h.setNext({ ...playable, latest: null, check: 'unavailable' });
  await h.elements.get('refresh').handlers.click();
  assert.equal(primary.classes.has('action-play'), true);
  assert.equal(primary.classes.has('action-update'), false);
  h.setNext({ ...playable, running: true });
  await h.elements.get('refresh').handlers.click();
  assert.equal(primary.classes.has('action-play'), false);
  assert.equal(primary.classes.has('action-update'), false);
});

test('release notes arrow opens the GitHub changelog without launching or installing', async () => {
  const h = harness(playable);
  await flush();
  await h.elements.get('open-changelog').handlers.click();
  assert.equal(h.calls.at(-1), 'open_release_changelog');
  assert.equal(h.elements.get('open-changelog').disabled, false);
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.calls.includes('launch'), false);
});

test('changelog browser errors are visible without blocking Play', async () => {
  const h = harness(playable);
  await flush();
  h.setNext(new Error('Browser unavailable'));
  await h.elements.get('open-changelog').handlers.click();
  assert.match(h.elements.get('status').textContent, /Could not open release changelog:.*Browser unavailable/);
  assert.equal(h.elements.get('primary').disabled, false);
  assert.equal(h.elements.get('open-changelog').disabled, false);
});

test('launcher updates display a prominent badge only while an update is available', async () => {
  const h = harness(playable, updater);
  await flush();
  assert.equal(h.elements.get('launcher-update-badge').hidden, false);
  assert.equal(h.elements.get('launcher-update-section').classes.has('update-available'), true);
  assert.equal(h.elements.get('launcher-update').textContent, 'Update launcher to 0.1.3');
  assert.equal(h.elements.get('primary').disabled, false);
  assert.equal(h.calls.includes('install_launcher_update'), false);
  h.setUpdater({ current_version: '0.1.3', available_version: null, message: 'Launcher is up to date.' });
  await vm.runInContext('checkLauncherUpdate()', h.context);
  assert.equal(h.elements.get('launcher-update-badge').hidden, true);
  assert.equal(h.elements.get('launcher-update-section').classes.has('update-available'), false);
  assert.equal(h.elements.get('launcher-update').hidden, true);
});

test('a failed launcher recheck clears the update highlight without blocking play', async () => {
  const h = harness(playable, updater);
  await flush();
  h.setUpdater(new Error('Feed unavailable'));
  await vm.runInContext('checkLauncherUpdate()', h.context);
  assert.equal(h.elements.get('launcher-update-badge').hidden, true);
  assert.equal(h.elements.get('launcher-update-section').classes.has('update-available'), false);
  assert.equal(h.elements.get('primary').disabled, false);
});

test('cogwheel opens settings with the current directory and Escape restores focus', async () => {
  const h = harness({ ...playable, install_directory: 'D:\\Games\\The Signal' });
  await flush();
  h.elements.get('game-settings').handlers.click();
  assert.equal(h.elements.get('settings-dialog').hidden, false);
  assert.equal(h.elements.get('install-directory').textContent, 'D:\\Games\\The Signal');
  assert.equal(h.context.document.activeElement, h.elements.get('settings-close'));
  h.context.document.handlers.keydown({ key: 'Escape' });
  assert.equal(h.elements.get('settings-dialog').hidden, true);
  assert.equal(h.context.document.activeElement, h.elements.get('game-settings'));
});

test('uninstall requires confirmation and cancellation does not uninstall', async () => {
  const h = harness(playable);
  await flush();
  h.elements.get('game-settings').handlers.click();
  await h.elements.get('confirm-uninstall').handlers.click();
  assert.equal(h.calls.includes('uninstall'), false);
  h.elements.get('uninstall-game').handlers.click();
  assert.equal(h.elements.get('uninstall-confirm').hidden, false);
  h.elements.get('cancel-uninstall').handlers.click();
  assert.equal(h.calls.includes('uninstall'), false);
  h.elements.get('uninstall-game').handlers.click();
  h.setNext({ ...playable, installed: null, message: 'Uninstalled' });
  const action = h.elements.get('confirm-uninstall').handlers.click();
  assert.equal(h.elements.get('game-settings').disabled, true);
  assert.equal(h.elements.get('settings-close').disabled, true);
  await action;
  assert.equal(h.calls.at(-1), 'uninstall');
  assert.equal(h.elements.get('primary').textContent, 'Install');
  assert.equal(h.elements.get('uninstall-game').disabled, true);
  assert.equal(h.elements.get('uninstall-confirm').hidden, true);
});

test('directory changes work before installation and errors remain visible', async () => {
  const h = harness({ ...playable, installed: null });
  await flush();
  assert.equal(h.elements.get('change-directory').disabled, false);
  h.setNext(new Error('Destination must be empty'));
  await h.elements.get('change-directory').handlers.click();
  assert.ok(h.calls.includes('change_install_directory'));
  assert.match(h.elements.get('settings-status').textContent, /Destination must be empty/);
  assert.equal(h.elements.get('change-directory').disabled, false);
});

test('running games block moving and uninstalling but settings can still be viewed', async () => {
  const h = harness({ ...playable, running: true });
  await flush();
  h.elements.get('game-settings').handlers.click();
  assert.equal(h.elements.get('settings-dialog').hidden, false);
  assert.equal(h.elements.get('change-directory').disabled, true);
  assert.equal(h.elements.get('uninstall-game').disabled, true);
  await h.elements.get('change-directory').handlers.click();
  h.elements.get('uninstall-game').handlers.click();
  await h.elements.get('confirm-uninstall').handlers.click();
  assert.equal(h.calls.includes('change_install_directory'), false);
  assert.equal(h.calls.includes('uninstall'), false);
});

test('settings traps keyboard focus', async () => {
  const h = harness(playable);
  await flush();
  h.elements.get('game-settings').handlers.click();
  let prevented = 0;
  h.context.document.handlers.keydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(h.context.document.activeElement, h.elements.get('uninstall-game'));
  h.context.document.handlers.keydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(h.context.document.activeElement, h.elements.get('settings-close'));
  assert.equal(prevented, 2);
});

test('game folder opens for installed builds, including offline and running games', async () => {
  for (const extra of [{}, { check: 'unavailable' }, { running: true }]) {
    const h = harness({ ...playable, ...extra });
    await flush();
    assert.equal(h.elements.get('view-folder').disabled, false);
    await h.elements.get('view-folder').handlers.click();
    assert.equal(h.calls.at(-1), 'open_game_folder');
    assert.equal(h.elements.get('status').textContent, 'Ready');
  }
});

test('game folder is unavailable before installation and during operations', async () => {
  const h = harness({ ...playable, installed: null });
  await flush();
  assert.equal(h.elements.get('view-folder').disabled, true);
  await h.elements.get('view-folder').handlers.click();
  assert.equal(h.calls.includes('open_game_folder'), false);
  h.setNext(playable);
  h.elements.get('refresh').handlers.click();
  assert.equal(h.elements.get('view-folder').disabled, true);
  await h.elements.get('view-folder').handlers.click();
  assert.equal(h.calls.includes('open_game_folder'), false);
  await flush();
  assert.equal(h.elements.get('view-folder').disabled, false);
});

test('folder errors are visible without blocking play', async () => {
  const h = harness(playable);
  await flush();
  h.setNext(new Error('File Explorer unavailable'));
  await h.elements.get('view-folder').handlers.click();
  assert.match(h.elements.get('status').textContent, /Could not open game folder:.*File Explorer unavailable/);
  assert.equal(h.elements.get('view-folder').disabled, false);
  assert.equal(h.elements.get('primary').disabled, false);
});

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
  const drag = h.elements.get('window-drag').handlers.mousedown;
  const target = { closest: () => null };
  let prevented = 0;
  drag({ button: 0, detail: 1, target, preventDefault() { prevented++; } });
  drag({ button: 0, detail: 2, target });
  drag({ button: 2, detail: 1, target });
  assert.deepEqual(h.windowCalls, ['startDragging']);
  assert.equal(prevented, 1);
  assert.equal(h.elements.get('window-drag').handlers.pointerdown, undefined);
});

test('window controls and their icons do not start a header drag', async () => {
  const h = harness(playable);
  await flush();
  const drag = h.elements.get('window-drag').handlers.mousedown;
  drag({ button: 0, detail: 1, target: { closest: () => h.elements.get('window-controls') } });
  assert.deepEqual(h.windowCalls, []);
  await h.elements.get('window-minimize').handlers.click();
  await h.elements.get('window-close').handlers.click();
  assert.deepEqual(h.windowCalls, ['minimize', 'close']);
});

test('other platforms retain their native window controls', async () => {
  const h = harness(playable, undefined, 'Macintosh');
  await flush();
  assert.equal(h.elements.get('window-controls').hidden, true);
  assert.equal(h.elements.get('window-drag').handlers.mousedown, undefined);
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
