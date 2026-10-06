# The Signal Launcher

Windows-only Tauri 2 launcher. Vanilla HTML/CSS/JavaScript UI; Rust owns network,
verification, extraction and process launching. This is a **standalone repository**,
separate from the Unity game project. No Unity assets or source are included.

Local checkout: `D:\Dev\The Signal Launcher`.
Source and launcher releases: https://github.com/The-Signals/the-signal-launcher.
Game-build releases: https://github.com/The-Signals/the-signal-data.

Local packages and installer outputs were preserved during the move. The old Rust
cache is retained in ignored `src-tauri/target-before-move/` because its generated
permissions contain absolute paths to the old checkout; normal builds/tests use
the fresh `src-tauri/target/`. The backup cache is not source and is not uploaded.

## Develop and build

Prerequisites: Node.js/npm, PowerShell 7 (`pwsh`), Rust **1.90+** (MSVC target), Visual Studio C++ Build Tools
with the Windows SDK, and WebView2. Publishing needs Python **3.12+** and an
authenticated GitHub CLI (`gh auth login`). No publishing token ships in the app.

```powershell
cd "D:\Dev\The Signal Launcher"
npm ci
npm run dev
npm test
npm run test:ui
python -m unittest discover -s scripts -p "test_*.py"
npm run build
```

The NSIS installer is in `src-tauri/target/release/bundle/nsis/`. It installs for
the current user, creates shortcuts and downloads WebView2 only when missing.
Give testers that installer, not the Unity ZIP. Updater artifacts are signed, but
the installer does not have a Windows Authenticode certificate: Windows may still
show SmartScreen warnings. Windows code signing is a separate production step.

Repository configuration is `distribution.json`; rebuild the launcher after changing it.
The configured public game distribution repo is **The-Signals/the-signal-data**.
Only the explicit publishing script below uploads game assets there. The launcher
source and signed installers belong in **The-Signals/the-signal-launcher**. Never
push Unity source code into either distribution repository.

The data repository is public and initialized. The publishing script refuses
private or empty repositories; it never pushes source code, changes repository
visibility or initializes the remote automatically.

Launcher **0.1.1** switches from `ZiiMs/the-signal` to this data repository.
Existing installations from that older repository remain recognized, but all
new checks/downloads use the data repository. Testers must install the rebuilt
launcher manually; old launcher executables still check the old feed. Launcher
**0.1.2** adds signed self-updates; install this version manually once to bootstrap
the feature. Versions 0.1.0/0.1.1 cannot update themselves.

The supplied `D:\Dev\The Signal\Builds\SteamTest` build needs explicit Steam-test
packaging (see below). The launcher itself has no Steam dependency.

## Publish a locally built game

Build Unity for **Windows x86-64** into a separate build folder. Close the build
before packaging it, and don't modify it during packaging. Supply the actual
game executable filename; don't use UnityCrashHandler64.exe.

First test packaging without uploading:

```powershell
python scripts/publish.py --build "C:\Builds\The-Signal" --executable "The-Signal.exe" --version 0.1.0
```

To upload a package you already created (also use this to retry after a failed
GitHub upload, without recompressing the build):

```powershell
python scripts/publish.py --publish-existing "releases/0.1.0"
```

This verifies the existing ZIP's size/checksum and uses its manifest's version,
notes and Steam-test launch settings. No `--build`, `--version`, `--steam-test`
or extra `--publish` flag is needed. It never overwrites local package files.

To move a package made for the old repository to the new data repository:

```powershell
python scripts/publish.py --publish-existing "releases/0.1.1" --retarget
```

`--retarget` verifies the ZIP first, then atomically updates only the manifest's
download URL. It does not recompress the game or change its version/checksum.

To package a **new** build and publish it in one command:

```powershell
python scripts/publish.py --build "C:\Builds\The-Signal" --executable "The-Signal.exe" --version 0.1.0 --output "C:\Builds\Releases\0.1.0" --notes "C:\Builds\notes.txt" --publish
```

The script checks Unity build structure, rejects source folders, excludes Unity
backup/debug directories and `steam_appid.txt`, creates a ZIP and SHA-256 manifest,
uploads both to a **draft** GitHub release, then publishes it as latest. Existing
published release tags are never overwritten. Uploads show a terminal progress
bar with percentage, transferred MB, speed and ETA. Bytes are streamed directly
to GitHub with credentials obtained from your local `gh` login; no token is
stored in the package or launcher. Progress reaches 100% only after GitHub
confirms the complete asset. Non-interactive terminals/logs get periodic lines.

A failed upload leaves a draft. Retry the same `--publish-existing` command:
the script resumes the draft and skips assets only when their remote size and
SHA-256 match. It does not resume a partial file transfer; that file must be
uploaded again. An incomplete/mismatching draft asset must be removed manually
on GitHub before retrying; published assets are never replaced. Only completed
game releases should be marked latest in the **data repo**. Launcher releases
are marked latest in the separate **launcher repo**, never in the data repo.

## Signed launcher updates

Feed: `https://github.com/The-Signals/the-signal-launcher/releases/latest/download/latest.json`.
This repository must remain public for the current anonymous-download design.

- Check on startup and **Check again**, independently of the game release check.
- Show **Update launcher to …** when a newer version exists. **Play remains available**.
- Clicking the update button opens a confirmation. **Install and restart** starts
  the update; **Later** dismisses it. Do not install automatically in the background.
- Require the game to be closed, both before downloading and immediately before
  installation. Game install/launch and launcher installation share an operation lock.
- Tauri verifies the mandatory minisign signature and the signed version before
  installation. Tampered files or version metadata fail closed. Downgrades are disabled.
- On Windows the launcher exits to run the per-user installer, which restarts it.
  The installer may show its own progress window. Game data and saves are untouched.
- Failure to check the launcher feed does **not** block game updates or Play.

### Signing key: keep private and back up

The development key was generated outside the repository:

```text
~/.tauri/the-signal-launcher.key      PRIVATE — never publish or commit
~/.tauri/the-signal-launcher.key.pub  Public companion file
```

It is not password-protected; Windows file permissions restrict the private file
to this user, SYSTEM and administrators. **Back up both files securely.** Losing the
private key prevents updates for already-installed launchers. Do not replace it
with a newly generated key when building future versions. The public key is embedded
in `src-tauri/tauri.conf.json`; neither signing credentials nor GitHub tokens ship.

`npm run build` uses `scripts/build-launcher.ps1`, validates the public-key match,
and passes the original private-key **path** to Tauri for this build only. It restores
the previous signing environment afterward. To use a different backup location:

```powershell
pwsh -NoProfile -File scripts/build-launcher.ps1 -KeyPath "C:\Secure\the-signal-launcher.key"
```

If you later encrypt the original key, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
locally before building; do not put the password in source control or chat.

### Publish a launcher version

For each new version, bump `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` together, then build:

```powershell
npm run build
python scripts/publish_launcher.py
```

The second command only prepares the local updater manifest. Inspect the output,
then explicitly publish:

```powershell
python scripts/publish_launcher.py --publish
```

Optionally pass `--notes "launcher-notes.txt"`. The publishing tool uploads **three
public assets**: the NSIS installer, its `.sig`, and `latest.json`. It uses the same
upload progress/retry handling as game publishing and promotes the draft only after
all three upload. Rerun the same command after a failed upload; no fresh packaging
folder is required. Published version tags are immutable.

The publisher checks signature format, signing-key ID and declared version as a
sanity check; Tauri performs the cryptographic verification when downloading.
You can also validate the real artifact locally, including corruption rejection:

```powershell
$env:SIGNAL_TEST_INSTALLER = (Resolve-Path "src-tauri/target/release/bundle/nsis/The Signal Launcher_0.1.2_x64-setup.exe").Path
cargo test --manifest-path src-tauri/Cargo.toml validates_real_signed_launcher_artifact -- --ignored
```

To test the complete update flow, manually install 0.1.2, then build/publish a
newer launcher version. Confirm the prompt, **Later**, game-running block,
download/signature validation, installation and restart on a test Windows machine.

### GitHub Actions: automatic CI, manual releases

`.github/workflows/ci.yml` runs UI, Python publishing, and Rust tests on Windows
for every push and pull request. It does not need signing secrets or publish anything.

`.github/workflows/release.yml` runs only through **Actions → Release launcher →
Run workflow**. It reruns CI, builds and verifies the signed installer, then publishes
the installer, `.sig`, and `latest.json` using the existing publisher. No Unity builds
are uploaded. Releases are restricted to `main` in the launcher repository, and the
version tag targets the exact commit built, not a newer commit pushed during the run.

One-time GitHub setup:

1. Create a GitHub **Environment** named `release`. Restrict its deployment branch
   to `main`; optionally require a reviewer to approve publishing.
2. Add environment secret `TAURI_SIGNING_PRIVATE_KEY` containing the **contents**
   of your existing `~/.tauri/the-signal-launcher.key`, not its local path. Copy it
   directly into GitHub's secret field; never commit it or paste it into chat.
3. If the original key is encrypted, add environment secret
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Otherwise leave it unset.
4. Ensure repository/organization policy permits GitHub Actions write access to
   repository contents. The release job uses its short-lived `GITHUB_TOKEN`;
   no personal access token is needed.

For each release, commit a new matching version in `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and update both lockfiles
(`npm install --package-lock-only` and `cargo check --manifest-path src-tauri/Cargo.toml`).
Push to `main`, run the release workflow on `main`, and supply that version plus
release notes. The workflow refuses to overwrite published versions or reuse a tag
pointing at a different commit. **0.1.2 is already released; use a newer version.**
Failed uploads remain drafts; the existing publisher's asset checksum/retry rules
still apply. Rebuilding can produce different bytes, so a conflicting draft asset
may need manual removal before a retry. The original local publishing commands
remain available. Signing files are removed from the runner after each release.

### Steam-test builds (AppID 480)

Use `--steam-test` only for your Development Build. It requires the build-root
`steam_appid.txt` to contain `480`, deliberately includes that one override, and
sets manifest `launch_arguments` to `["--signal-steam-test"]`. The redundant
`LaunchSteamTest.cmd` is excluded; the launcher invokes the game directly.
Testers must have Steam running and signed in for Steam functionality. Launcher
offline-play permission does not guarantee Steam networking works offline.

```powershell
python scripts/publish.py --build "D:\Dev\The Signal\Builds\SteamTest" --executable "TheSignal.exe" --version 0.1.0 --steam-test
```

This is package-only. Use `--publish-existing "releases/0.1.0"` when ready to
publicly distribute it. Omit `--steam-test` for ordinary Steam-free builds;
their development AppID overrides are always excluded.

Validate the resulting real ZIP through the launcher's Rust extraction code:

```powershell
$env:SIGNAL_TEST_MANIFEST = (Resolve-Path "releases/0.1.0/manifest.json").Path
cargo test --manifest-path src-tauri/Cargo.toml validates_real_packaged_build -- --ignored
```

This verifies the checksum, extracts to a disposable temporary directory and
checks the executable and Steam-test AppID. It neither installs nor launches
the game and does not contact GitHub.

Build ZIPs are limited to 2 GB, unpacked builds to 8 GB and 100,000 entries. Under
500 MB is the intended playtest use. Notes are plain text (not rendered HTML).

## Manifest contract

The launcher reads `https://github.com/The-Signals/the-signal-data/releases/latest/download/manifest.json`.

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "url": "https://github.com/The-Signals/the-signal-data/releases/download/v0.1.0/The-Signal-0.1.0-windows-x64.zip",
  "size": 123456,
  "unpacked_size": 345678,
  "sha256": "<64 lowercase hexadecimal characters>",
  "executable": "The-Signal.exe",
  "launch_arguments": [],
  "notes": "What changed in this playtest."
}
```

## Update and offline rules

- Check on opening and immediately before Play. A changed version **or ZIP hash**
  requires an update. Launching the executable directly bypasses this policy.
- Connection failures, timeouts, GitHub 5xx and rate limiting allow offline play.
  Malformed manifests, TLS errors and other HTTP errors fail closed with an error.
- Persist the last successful manifest so a **known** required update cannot be
  bypassed by restarting offline. Never-installed machines need network access.
- Stream downloads to a temporary file, enforce declared size and SHA-256, then
  extract to a new directory. Reject traversal, Windows device/alternate-stream
  names, case-insensitive duplicates, symlinks and unpacked-size mismatches.
- Atomically replace the installed-build pointer only after successful extraction.
  Failed updates leave the active build untouched; staging is cleaned on ordinary
  failures. Force-killing the launcher can leave unused temporary files.
- One launcher instance and one operation at a time. Prevent closing the window
  during an operation. Detect running game processes under the managed versions
  directory, including games launched outside the launcher.

Game installations live below `%LOCALAPPDATA%\com.thesignal.playtest.launcher\game`.
Builds are retained separately under `versions/`; previous builds aren't removed
automatically in this MVP. Budget disk space accordingly. `active.json` selects
the installed build and `latest.json` caches the last successful update check.
Unity saves in its normal persistent-data directory are never touched. Any saves
written *inside the build directory* by game code will not migrate between versions.
Uninstalling the launcher does not provide a game-data cleanup UI.

## Clean-machine acceptance checklist

- Install as a standard user with and without WebView2; verify shortcuts/uninstall.
- Publish an actual Unity build, install it, confirm checksum and launch behavior.
- Publish a newer build; verify Play is blocked until it is installed.
- Disconnect during a download; verify the old build remains intact and retry works.
- Launch offline before/after a known update; verify the policy above.
- Start the game externally; verify updates and duplicate launches are blocked.
- Restart Windows/force-kill during download/extraction; verify the active pointer
  still selects a working build. Check low-disk-space and antivirus-lock errors.
- Confirm saves survive updates and no credentials/source/debug backups are shipped.
- Publish a newer signed **launcher** release; verify optional confirmation,
  game-running block, installation and restart without reinstalling the game.

Deferred: delta patches, channels, accounts and background services.
