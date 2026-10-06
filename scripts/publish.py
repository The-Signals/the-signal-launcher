"""Package a local Unity Windows build and optionally publish a GitHub release."""
import argparse
import hashlib
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urlencode, urlsplit

LAUNCHER = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?")


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def write_manifest(path, manifest):
    """Atomically replace metadata; never leave a partially retargeted manifest."""
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(manifest, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class UploadProgress:
    def __init__(self, name, total, stream=None, clock=None):
        self.name = name
        self.total = total
        self.stream = stream if stream is not None else sys.stderr
        self.clock = clock if clock is not None else time.monotonic
        self.started = self.clock()
        self.last_render = float("-inf")
        self.last_bucket = -1
        self.interactive = self.stream.isatty()

    def update(self, sent, complete=False):
        now = self.clock()
        bucket = min(10, int(sent * 10 / max(1, self.total)))
        if not complete:
            if self.interactive and now - self.last_render < 0.15:
                return
            if not self.interactive and bucket == self.last_bucket:
                return
        elapsed = max(now - self.started, 0.001)
        speed = sent / elapsed
        eta = int(max(0, self.total - sent) / speed) if speed else None
        percent = 100.0 if complete else min(99.9, sent * 100 / max(1, self.total))
        filled = 24 if complete else min(23, int(percent * 24 / 100))
        bar = "#" * filled + "-" * (24 - filled)
        ending = "verified" if complete else "awaiting GitHub" if sent == self.total else f"ETA {eta}s" if eta is not None else "ETA --"
        line = f"{self.name} [{bar}] {percent:5.1f}% {sent / 1_000_000:.2f}/{self.total / 1_000_000:.2f} MB {speed / 1_000_000:.2f} MB/s {ending}"
        self.stream.write(("\r" if self.interactive else "") + line + ("\n" if complete or not self.interactive else ""))
        self.stream.flush()
        self.last_render = now
        self.last_bucket = bucket

    def failed(self):
        if self.interactive:
            self.stream.write("\n")
            self.stream.flush()


def upload_asset(upload_url, path, token):
    """Stream bytes directly to GitHub; authenticate using local gh credentials."""
    base = urlsplit(upload_url.split("{", 1)[0])
    if base.scheme != "https" or base.hostname != "uploads.github.com" or base.port not in (None, 443) or base.query or base.fragment or base.username:
        raise ValueError("GitHub returned an unexpected asset-upload URL.")
    total = path.stat().st_size
    progress = UploadProgress(path.name, total)
    connection = http.client.HTTPSConnection(base.hostname, timeout=120)
    try:
        request_path = base.path + "?" + urlencode({"name": path.name})
        connection.putrequest("POST", request_path)
        connection.putheader("Authorization", f"Bearer {token}")
        connection.putheader("Accept", "application/vnd.github+json")
        connection.putheader("X-GitHub-Api-Version", "2022-11-28")
        connection.putheader("User-Agent", "The-Signal-Publisher/0.1")
        content_types = {".zip": "application/zip", ".json": "application/json", ".sig": "text/plain"}
        connection.putheader("Content-Type", content_types.get(path.suffix.lower(), "application/octet-stream"))
        connection.putheader("Content-Length", str(total))
        connection.endheaders()
        progress.update(0)
        sent = 0
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(256 * 1024):
                if sent + len(chunk) > total:
                    raise ValueError("Asset changed during upload. Refusing to publish.")
                connection.send(chunk)
                sent += len(chunk)
                digest.update(chunk)
                progress.update(sent)
        if sent != total:
            raise ValueError("Asset changed during upload. Refusing to publish.")
        response = connection.getresponse()
        body = response.read(64 * 1024)
        if response.status != 201:
            # Do not print raw server responses or credentials.
            raise ValueError(f"GitHub rejected upload of {path.name} (HTTP {response.status}). The release remains a draft; check repository write access and retry.")
        asset = json.loads(body)
        if asset.get("state") != "uploaded" or asset.get("size") != total:
            raise ValueError(f"GitHub did not confirm the complete upload of {path.name}.")
        remote_digest = asset.get("digest")
        if remote_digest and remote_digest != "sha256:" + digest.hexdigest():
            raise ValueError(f"GitHub's checksum differs for {path.name}.")
        progress.update(total, complete=True)
        return asset
    except BaseException:
        progress.failed()
        raise
    finally:
        connection.close()


def safe_path(name):
    for part in name.split("/"):
        base = part.split(".")[0].upper()
        if (not part or part in (".", "..") or part.endswith((".", " "))
                or any(ord(c) < 32 or c in '<>:"\\|?*' for c in part)
                or base in {"CON", "PRN", "AUX", "NUL"}
                or re.fullmatch(r"(?:COM|LPT)[1-9]", base)):
            raise ValueError(f"Unsafe Windows path: {name}")


def package(build, executable, version, notes, repository, output, steam_test=False):
    build = build.resolve(strict=True)
    output = output.resolve()
    if output == build or build in output.parents:
        raise ValueError("Output must be outside the build folder.")
    if not VERSION.fullmatch(version):
        raise ValueError("Version must be major.minor.patch, optionally with a prerelease suffix.")
    safe_path(executable)
    if "/" in executable or not executable.lower().endswith(".exe"):
        raise ValueError("Supply the Unity executable filename at the build root.")
    if not (build / executable).is_file() or not (build / "UnityPlayer.dll").is_file():
        raise ValueError("Build must contain the game executable and UnityPlayer.dll.")
    if not (build / f"{Path(executable).stem}_Data").is_dir():
        raise ValueError("The Unity executable's matching _Data directory is missing.")
    if steam_test:
        app_id = build / "steam_appid.txt"
        if not app_id.is_file() or app_id.read_text(encoding="utf-8").strip() != "480":
            raise ValueError("--steam-test requires a root steam_appid.txt containing exactly 480.")
    if any((build / p).exists() for p in (".git", "Assets", "ProjectSettings")):
        raise ValueError("This looks like source, not a Unity build. Refusing to publish it.")
    if len(notes.encode("utf-8")) > 32 * 1024:
        raise ValueError("Release notes exceed 32 KB.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid GitHub owner/repository.")

    files = []
    names = set()
    unpacked_size = 0
    for path in sorted(build.rglob("*")):
        relative = path.relative_to(build)
        if path.is_symlink() or path.is_junction():
            raise ValueError(f"Build contains a symbolic link or junction: {relative}")
        if any("BackUpThisFolder_ButDontShipItWithYourGame" in p
               or "BurstDebugInformation_DoNotShip" in p for p in relative.parts):
            continue
        if not path.is_file():
            continue
        if path.name.lower() == "launchsteamtest.cmd":
            continue
        if path.name.lower() == "steam_appid.txt" and not (steam_test and relative.as_posix() == "steam_appid.txt"):
            continue
        name = relative.as_posix()
        safe_path(name)
        if name.lower() in names:
            raise ValueError(f"Case-insensitive duplicate build path: {name}")
        names.add(name.lower())
        unpacked_size += path.stat().st_size
        files.append((path, name))
    if len(files) > 100_000 or not 0 < unpacked_size <= 8 * 1024**3:
        raise ValueError("Build exceeds launcher file-count or unpacked-size limits.")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"The-Signal-{version}-windows-x64.zip"
    manifest_path = output / "manifest.json"
    if archive.exists() or manifest_path.exists():
        raise ValueError(f'Output already contains release assets. To upload them without repackaging, run: python scripts/publish.py --publish-existing "{output}". For a different build, use a new version/output directory.')
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
        for path, name in files:
            zipped.write(path, name)
    size = archive.stat().st_size
    if size > 2 * 1024**3:
        raise ValueError("ZIP exceeds the launcher's 2 GB download limit.")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    manifest = {
        "schema_version": 1,
        "version": version,
        "url": f"https://github.com/{repository}/releases/download/v{version}/{archive.name}",
        "size": size,
        "unpacked_size": unpacked_size,
        "sha256": digest,
        "executable": executable,
        "launch_arguments": ["--signal-steam-test"] if steam_test else [],
        "notes": notes,
    }
    write_manifest(manifest_path, manifest)
    return archive, manifest_path


def load_package(output, repository, retarget=False):
    """Verify an existing package without overwriting files or contacting GitHub."""
    output = output.resolve(strict=True)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if manifest.get("schema_version") != 1 or not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Existing manifest has an unsupported schema or invalid version.")
    archive = output / f"The-Signal-{version}-windows-x64.zip"
    expected_url = f"https://github.com/{repository}/releases/download/v{version}/{archive.name}"
    needs_retarget = manifest.get("url") != expected_url
    if needs_retarget and not retarget:
        raise ValueError("Existing manifest targets another repository. Add --retarget to update its download URL after verification, without rebuilding the ZIP.")
    size = archive.stat().st_size
    if not 0 < size <= 2 * 1024**3 or size != manifest.get("size"):
        raise ValueError("Existing ZIP size does not match its manifest.")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("Existing ZIP checksum does not match its manifest. Refusing to publish.")
    notes = manifest.get("notes", "")
    if not isinstance(notes, str) or len(notes.encode("utf-8")) > 32 * 1024:
        raise ValueError("Existing release notes are invalid.")
    if needs_retarget:
        manifest["url"] = expected_url
        write_manifest(manifest_path, manifest)
    return archive, manifest_path, version, notes


def publish(repository, version, notes, archive, manifest):
    return publish_release(repository, version, notes, (archive, manifest), f"The Signal {version}")


def publish_release(repository, version, notes, assets, title):
    details = json.loads(gh("repo", "view", repository, "--json", "isPrivate,isEmpty"))
    if details["isPrivate"]:
        raise ValueError("Distribution repository must be public. No credentials belong in the launcher.")
    if details.get("isEmpty"):
        raise ValueError("Distribution repository is empty. Initialize it with a distribution-only README before publishing releases; do not push Unity source.")
    tag = f"v{version}"
    # Published tags are immutable; a failed draft upload can be resumed safely.
    existing = subprocess.run(["gh", "release", "view", tag, "--repo", repository, "--json", "databaseId,isDraft"], capture_output=True, text=True)
    if existing.returncode == 0:
        summary = json.loads(existing.stdout)
        if not summary.get("isDraft"):
            raise ValueError(f"Release {tag} is already published. Use a new version.")
        print(f"Resuming draft release {tag}.", flush=True)
    elif "404" not in existing.stderr and "release not found" not in existing.stderr.lower():
        raise ValueError(f"Could not check existing release: {existing.stderr.strip()}")
    else:
        gh("release", "create", tag, "--repo", repository,
           "--draft", "--title", title, "--notes", notes or "Playtest build.")
        summary = json.loads(gh("release", "view", tag, "--repo", repository, "--json", "databaseId,isDraft"))
    release = json.loads(gh("api", f"repos/{repository}/releases/{summary['databaseId']}"))
    if not release.get("draft"):
        raise ValueError("Release is no longer a draft. No assets were uploaded.")
    token = gh("auth", "token", "--hostname", "github.com").strip()
    if not token:
        raise ValueError("GitHub authentication is missing. Run gh auth login.")
    for path in assets:
        matches = [asset for asset in release.get("assets", []) if asset["name"] == path.name]
        if matches:
            with path.open("rb") as stream:
                digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
            asset = matches[0]
            if len(matches) != 1 or asset.get("state") != "uploaded" or asset.get("size") != path.stat().st_size or asset.get("digest") != digest:
                raise ValueError(f"Draft already contains an incomplete or different {path.name}. Remove that asset from the draft on GitHub before retrying. No asset was overwritten.")
            print(f"Already uploaded and verified: {path.name}", flush=True)
        else:
            upload_asset(release["upload_url"], path, token)
    # Only promote a release after ALL assets have uploaded successfully. Playtest
    # suffixes deliberately stay normal releases so /releases/latest can find them.
    gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest")
    return f"https://github.com/{repository}/releases/tag/{tag}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build", type=Path, help="Unity Windows build folder (not project source)")
    mode.add_argument("--publish-existing", type=Path, metavar="FOLDER", help="Verify and publish an already packaged ZIP and manifest, without repackaging")
    parser.add_argument("--executable", help="Game .exe filename at the build root")
    parser.add_argument("--version", help="Unique version, e.g. 0.1.0")
    parser.add_argument("--notes", type=Path, help="UTF-8 release notes file")
    parser.add_argument("--output", type=Path, help="New local output folder")
    parser.add_argument("--publish", action="store_true", help="Actually upload and publish; default is package-only")
    parser.add_argument("--steam-test", action="store_true", help="Explicitly preserve root AppID 480 and launch with --signal-steam-test (Development Builds only)")
    parser.add_argument("--retarget", action="store_true", help="With --publish-existing, update the verified manifest to the currently configured repository")
    args = parser.parse_args()
    repository = json.loads((LAUNCHER / "distribution.json").read_text(encoding="utf-8"))["repository"]
    if args.publish_existing:
        if args.executable or args.version or args.notes or args.output or args.steam_test:
            parser.error("--publish-existing reads build settings from the existing manifest; omit packaging options.")
        archive, manifest, version, notes = load_package(args.publish_existing, repository, retarget=args.retarget)
        print(f"Verified existing package: {archive}", flush=True)
        print(f"Published: {publish(repository, version, notes, archive, manifest)}")
        return
    if not args.executable or not args.version:
        parser.error("--build requires --executable and --version.")
    if args.retarget:
        parser.error("--retarget is only supported with --publish-existing.")
    notes = args.notes.read_text(encoding="utf-8") if args.notes else ""
    output = args.output or LAUNCHER / "releases" / args.version
    archive, manifest = package(args.build, args.executable, args.version, notes, repository, output, steam_test=args.steam_test)
    print(f"Packaged: {archive}\nManifest: {manifest}")
    if args.publish:
        print(f"Published: {publish(repository, args.version, notes, archive, manifest)}")
    else:
        print("Local packaging only. Add --publish to upload a public game release.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, http.client.HTTPException, subprocess.CalledProcessError) as error:
        print(f"Publishing failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.strip(), file=sys.stderr)
        sys.exit(1)
