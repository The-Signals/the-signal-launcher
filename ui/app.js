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

el('open-changelog').addEventListener('click', async () => {
  el('open-changelog').disabled = true;
  try {
    await invoke('open_release_changelog');
  } catch (error) {
    el('status').textContent = `Could not open release changelog: ${error}`;
    el('status').classList.add('error');
  } finally {
    el('open-changelog').disabled = false;
  }
});

function launcherControls() {
  const updateAvailable = Boolean(launcherUpdate?.available_version);
  el('launcher-update-section').classList.toggle('update-available', updateAvailable);
  el('launcher-update-badge').hidden = !updateAvailable;
  el('game-settings').disabled = busy || !state;
  el('change-directory').disabled = busy || !state || state.running;
  el('uninstall-game').disabled = busy || !state?.installed || state.running;
  el('confirm-uninstall').disabled = busy || !state?.installed || state.running;
  el('cancel-uninstall').disabled = busy;
  el('settings-close').disabled = busy;
  el('view-folder').disabled = busy || openingFolder || !state?.installed;
  el('launcher-update').hidden = !updateAvailable;
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
  el('install-directory').textContent = next.install_directory ?? 'Default game directory';
  if (next.running && !el('settings-dialog').hidden) el('settings-status').textContent = 'Close The Signal before moving or uninstalling it.';
  el('installed').textContent = next.installed?.version ?? 'Not installed';
  el('latest').textContent = next.latest?.version ?? 'Unavailable';
  el('notes').textContent = next.latest?.notes || next.installed?.notes || 'No release notes yet.';
  const update = next.latest && (!next.installed || next.latest.sha256 !== next.installed.sha256 || next.latest.version !== next.installed.version);
  el('primary').classList.toggle('action-play', Boolean(next.installed && !update && !next.running));
  el('primary').classList.toggle('action-update', Boolean(update && !next.running));
  el('primary').textContent = next.running ? 'Game running' : update ? (next.installed ? 'Update' : 'Install') : next.installed ? 'Play' : 'No build available';
  el('primary').disabled = busy || next.running || next.check === 'error' || (!next.installed && !next.latest);
  el('refresh').disabled = busy;
  el('status').textContent = next.message;
  el('status').classList.toggle('error', next.check === 'error');
  launcherControls();
}

async function run(command, args) {
  if (busy) return;
  busy = true;
  el('primary').disabled = true;
  el('refresh').disabled = true;
  el('launcher-update-confirm').hidden = true;
  launcherControls();
  el('status').classList.remove('error');
  const message = command === 'change_install_directory' ? 'Choose a location. Moving the game may take a moment…' : command === 'uninstall' ? 'Uninstalling game…' : command === 'install' ? 'Preparing download…' : command === 'launch' ? 'Checking before launch…' : 'Checking for updates…';
  el('status').textContent = message;
  el('settings-status').textContent = message;
  try {
    const next = await invoke(command, args);
    busy = false;
    render(next);
    el('settings-status').textContent = next.message;
  } catch (error) {
    busy = false;
    // Refresh local status without silently re-enabling Play against a failed check.
    try { render(await invoke('local_status')); } catch { /* Keep the original error visible. */ }
    el('status').textContent = String(error);
    el('settings-status').textContent = String(error);
    el('status').classList.add('error');
    el('refresh').disabled = false;
  } finally {
    el('progress').hidden = true;
    launcherControls();
  }
}

function closeSettings() {
  if (busy) return;
  el('settings-dialog').hidden = true;
  el('uninstall-confirm').hidden = true;
  el('game-settings').focus();
}
el('game-settings').addEventListener('click', () => {
  if (busy || !state) return;
  el('settings-dialog').hidden = false;
  el('uninstall-confirm').hidden = true;
  el('settings-status').textContent = state.running ? 'Close The Signal before moving or uninstalling it.' : '';
  el('settings-close').focus();
});
el('settings-close').addEventListener('click', closeSettings);
el('settings-dialog').addEventListener('click', (event) => { if (event.target === el('settings-dialog')) closeSettings(); });
document.addEventListener('keydown', (event) => {
  if (el('settings-dialog').hidden) return;
  if (event.key === 'Escape') closeSettings();
  if (event.key === 'Tab') {
    const controls = ['settings-close', 'change-directory', 'uninstall-game', ...(!el('uninstall-confirm').hidden ? ['confirm-uninstall', 'cancel-uninstall'] : [])].map(el).filter((button) => !button.disabled);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
el('change-directory').addEventListener('click', () => {
  if (busy || !state || state.running) return;
  el('uninstall-confirm').hidden = true;
  return run('change_install_directory');
});
el('uninstall-game').addEventListener('click', () => {
  if (busy || !state?.installed || state.running) return;
  el('uninstall-confirm').hidden = false;
  el('cancel-uninstall').focus();
});
el('cancel-uninstall').addEventListener('click', () => { if (!busy) { el('uninstall-confirm').hidden = true; el('uninstall-game').focus(); } });
el('confirm-uninstall').addEventListener('click', async () => {
  if (busy || !state?.installed || state.running || el('uninstall-confirm').hidden) return;
  await run('uninstall');
  el('uninstall-confirm').hidden = true;
});

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
