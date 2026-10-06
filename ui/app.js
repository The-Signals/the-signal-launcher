const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const el = (id) => document.getElementById(id);
let state;
let busy = false;
let launcherUpdate;
let checkingLauncher = false;
let openingFolder = false;

function setupWindowControls() {
  if (!/Windows/i.test(navigator.userAgent)) return;
  const launcherWindow = window.__TAURI__.window.getCurrentWindow();
  document.body.classList.add('custom-window');
  el('window-controls').hidden = false;
  const windowAction = async (action) => {
    try { await action(); } catch (error) {
      el('status').textContent = `Window action failed: ${error}`;
    }
  };
  el('window-minimize').addEventListener('click', () => windowAction(() => launcherWindow.minimize()));
  // close(), not destroy(), preserves the backend's protection during updates.
  el('window-close').addEventListener('click', () => windowAction(() => launcherWindow.close()));
  // Mouse events carry the click count; pointerdown.detail can be zero
  // in WebView2, which previously prevented the native drag from starting.
  el('window-drag').addEventListener('mousedown', (event) => {
    if (event.button === 0 && event.detail === 1 && !event.target.closest('.window-controls')) {
      event.preventDefault();
      windowAction(() => launcherWindow.startDragging());
    }
  });
}

setupWindowControls();

function launcherControls() {
  el('view-folder').disabled = busy || openingFolder || !state?.installed;
  el('launcher-update').hidden = !launcherUpdate?.available_version;
  el('launcher-update').disabled = busy || checkingLauncher || state?.running || !launcherUpdate?.available_version;
  el('launcher-install').disabled = busy || checkingLauncher || state?.running;
  el('launcher-later').disabled = busy;
}

async function checkLauncherUpdate() {
  if (checkingLauncher) return;
  checkingLauncher = true;
  launcherControls();
  try {
    launcherUpdate = await invoke('launcher_update_status');
    el('launcher-version').textContent = launcherUpdate.current_version;
    el('launcher-update-status').textContent = launcherUpdate.message;
    el('launcher-update').textContent = `Update launcher to ${launcherUpdate.available_version}`;
  } catch {
    launcherUpdate = undefined;
    el('launcher-update-status').textContent = 'Launcher update check unavailable. Game updates and play are unaffected.';
  } finally {
    checkingLauncher = false;
    launcherControls();
  }
}

function render(next) {
  state = next;
  el('installed').textContent = next.installed?.version ?? 'Not installed';
  el('latest').textContent = next.latest?.version ?? 'Unavailable';
  el('notes').textContent = next.latest?.notes || next.installed?.notes || 'No release notes yet.';
  const update = next.latest && (!next.installed || next.latest.sha256 !== next.installed.sha256 || next.latest.version !== next.installed.version);
  el('primary').textContent = next.running ? 'Game running' : update ? (next.installed ? 'Update' : 'Install') : next.installed ? 'Play' : 'No build available';
  el('primary').disabled = busy || next.running || next.check === 'error' || (!next.installed && !next.latest);
  el('refresh').disabled = busy;
  el('status').textContent = next.message;
  el('status').classList.toggle('error', next.check === 'error');
  launcherControls();
}

async function run(command) {
  if (busy) return;
  busy = true;
  el('primary').disabled = true;
  el('refresh').disabled = true;
  el('launcher-update-confirm').hidden = true;
  launcherControls();
  el('status').classList.remove('error');
  el('status').textContent = command === 'install' ? 'Preparing download…' : command === 'launch' ? 'Checking before launch…' : 'Checking for updates…';
  try {
    const next = await invoke(command);
    busy = false;
    render(next);
  } catch (error) {
    busy = false;
    // Refresh local status without silently re-enabling Play against a failed check.
    try { render(await invoke('local_status')); } catch { /* Keep the original error visible. */ }
    el('status').textContent = String(error);
    el('status').classList.add('error');
    el('refresh').disabled = false;
  } finally {
    el('progress').hidden = true;
    launcherControls();
  }
}

el('refresh').addEventListener('click', async () => {
  const gameCheck = run('check');
  await checkLauncherUpdate();
  await gameCheck;
});
el('primary').addEventListener('click', () => {
  const update = state.latest && (!state.installed || state.latest.sha256 !== state.installed.sha256 || state.latest.version !== state.installed.version);
  run(update ? 'install' : 'launch');
});

el('view-folder').addEventListener('click', async () => {
  if (busy || openingFolder || !state?.installed) return;
  openingFolder = true;
  launcherControls();
  try {
    await invoke('open_game_folder');
  } catch (error) {
    el('status').textContent = `Could not open game folder: ${error}`;
    el('status').classList.add('error');
  } finally {
    openingFolder = false;
    launcherControls();
  }
});

el('launcher-update').addEventListener('click', () => {
  if (busy || checkingLauncher || state?.running || !launcherUpdate?.available_version) return;
  el('launcher-confirm-text').textContent = `Install launcher ${launcherUpdate.available_version}? The launcher will close, install the signed update, and restart. Close the game first.`;
  el('launcher-update-confirm').hidden = false;
});
el('launcher-later').addEventListener('click', () => { el('launcher-update-confirm').hidden = true; });
el('launcher-install').addEventListener('click', async () => {
  if (busy || checkingLauncher || state?.running || el('launcher-update-confirm').hidden || !launcherUpdate?.available_version) return;
  busy = true;
  el('primary').disabled = true;
  el('refresh').disabled = true;
  launcherControls();
  el('launcher-update-status').textContent = 'Preparing the signed launcher update…';
  try {
    await invoke('install_launcher_update', { expectedVersion: launcherUpdate.available_version });
    // Windows exits this process and the installer restarts the updated launcher.
    el('launcher-update-status').textContent = 'Installing launcher update and restarting…';
  } catch (error) {
    busy = false;
    const message = String(error);
    try { render(await invoke('local_status')); } catch { /* Preserve the update error. */ }
    await checkLauncherUpdate();
    el('launcher-update-status').textContent = message;
    el('refresh').disabled = false;
    el('launcher-progress').hidden = true;
    el('launcher-update-confirm').hidden = true;
    launcherControls();
  }
});

async function start() {
  await listen('install-progress', ({ payload }) => {
    el('status').textContent = payload.message;
    el('progress').hidden = false;
    if (payload.percent == null) el('progress').removeAttribute('value');
    else el('progress').value = payload.percent;
  });
  await listen('launcher-update-progress', ({ payload }) => {
    el('launcher-update-status').textContent = payload.message;
    el('launcher-progress').hidden = false;
    if (payload.percent == null) el('launcher-progress').removeAttribute('value');
    else el('launcher-progress').value = payload.percent;
  });
  const gameCheck = run('check');
  await checkLauncherUpdate();
  await gameCheck;
  // Refresh the running-game indicator after it exits, without network polling.
  setInterval(async () => {
    if (!busy && state?.running) {
      try { render(await invoke('local_status')); } catch { /* Retry on the next tick. */ }
    }
  }, 3000);
}
start().catch((error) => { el('status').textContent = String(error); });
