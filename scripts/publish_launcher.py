"""Prepare or publish the signed launcher installer (never Unity game builds)."""
import argparse
import base64
from datetime import datetime, timezone
import http.client
import json
import shutil
import subprocess
import sys
from pathlib import Path
from publish import LAUNCHER, VERSION, publish_release, write_manifest


def check_signature_key(signature, public_key, expected_version=None):
    """Sanity-check Tauri's generated minisign artifact and trusted key ID.

    Tauri generates the actual signature during build and cryptographically
    verifies it during download. This check catches missing/mixed key files.
    """
    try:
        public_lines = base64.b64decode(public_key, validate=True).decode("utf-8").splitlines()
        signature_lines = base64.b64decode(signature, validate=True).decode("utf-8").splitlines()
        public = base64.b64decode(public_lines[1], validate=True)
        signed = base64.b64decode(signature_lines[1], validate=True)
        global_signature = base64.b64decode(signature_lines[3], validate=True)
        if len(public) != 42 or len(signed) != 74 or len(global_signature) != 64:
            raise ValueError("Invalid minisign artifact length.")
        if public[:2] != b"Ed" or signed[:2] not in (b"Ed", b"ED") or public[2:10] != signed[2:10]:
            raise ValueError("Signature belongs to a different updater signing key.")
        if not signature_lines[2].startswith("trusted comment: "):
            raise ValueError("Signature metadata is missing.")
        if expected_version is not None:
            fields = signature_lines[2].removeprefix("trusted comment: ").split("\t")
            versions = [field.removeprefix("version:") for field in fields if field.startswith("version:")]
            if versions != [expected_version]:
                raise ValueError("Signature does not carry the configured launcher version. Rebuild using the current Tauri CLI.")
    except (ValueError, IndexError, UnicodeError) as error:
        raise ValueError(f"Invalid updater signature: {error}") from error


def prepare_release(installer, config, repository, notes, output):
    version = config["version"]
    if not VERSION.fullmatch(version):
        raise ValueError("Launcher version must be a valid release version.")
    installer = installer.resolve(strict=True)
    if installer.name != f"The Signal Launcher_{version}_x64-setup.exe":
        raise ValueError("Installer filename does not match the configured launcher version.")
    if not 0 < installer.stat().st_size <= 100 * 1024 * 1024:
        raise ValueError("Launcher installer size is invalid.")
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Launcher installer is not a Windows executable.")
    signature_path = Path(str(installer) + ".sig")
    if not signature_path.is_file() or signature_path.stat().st_size > 16 * 1024:
        raise ValueError("Signed updater artifact is missing. Run npm run build with the original signing key.")
    signature = signature_path.read_text(encoding="utf-8").strip()
    updater = config["plugins"]["updater"]
    expected_endpoint = f"https://github.com/{repository}/releases/latest/download/latest.json"
    if updater["endpoints"] != [expected_endpoint]:
        raise ValueError("Launcher update endpoint does not match the configured launcher repository.")
    check_signature_key(signature, updater["pubkey"], version)
    if len(notes.encode("utf-8")) > 32 * 1024:
        raise ValueError("Release notes exceed 32 KB.")
    # GitHub normalizes spaces in asset names to dots. Stage those exact
    # names before uploading so the updater URL matches the public asset.
    output.mkdir(parents=True, exist_ok=True)
    public_installer = output / f"The.Signal.Launcher_{version}_x64-setup.exe"
    public_signature = Path(str(public_installer) + ".sig")
    shutil.copyfile(installer, public_installer)
    shutil.copyfile(signature_path, public_signature)
    manifest = {
        "version": version,
        "notes": notes,
        # Stable across upload retries of the same installer.
        "pub_date": datetime.fromtimestamp(installer.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": {"windows-x86_64": {
            "signature": signature,
            "url": f"https://github.com/{repository}/releases/download/v{version}/{public_installer.name}",
        }},
    }
    manifest_path = output / "latest.json"
    write_manifest(manifest_path, manifest)
    return version, (public_installer, public_signature, manifest_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, help="Signed NSIS installer; defaults to current build output")
    parser.add_argument("--notes", type=Path, help="UTF-8 launcher release notes")
    parser.add_argument("--output", type=Path, help="Local updater-manifest output directory")
    parser.add_argument("--publish", action="store_true", help="Upload installer, signature and latest.json to launcher repo")
    parser.add_argument("--target", help="Commit SHA or branch for a new release tag (CI uses the built commit)")
    args = parser.parse_args()
    config = json.loads((LAUNCHER / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    distribution = json.loads((LAUNCHER / "distribution.json").read_text(encoding="utf-8"))
    repository = distribution["launcher_repository"]
    installer = args.installer or LAUNCHER / "src-tauri/target/release/bundle/nsis" / f"The Signal Launcher_{config['version']}_x64-setup.exe"
    output = args.output or LAUNCHER / "releases" / f"launcher-{config['version']}"
    notes = args.notes.read_text(encoding="utf-8") if args.notes else "Launcher maintenance update."
    version, assets = prepare_release(installer, config, repository, notes, output)
    print(f"Prepared signed launcher {version}: {assets[-1]}", flush=True)
    if args.publish:
        print(f"Published: {publish_release(repository, version, notes, assets, f'The Signal Launcher {version}', target=args.target)}")
    else:
        print("Local preparation only. Add --publish to upload to the launcher repository.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, http.client.HTTPException, subprocess.CalledProcessError) as error:
        print(f"Launcher publishing failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.strip(), file=sys.stderr)
        sys.exit(1)
