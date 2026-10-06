use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_UNPACKED: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub version: String,
    pub url: String,
    pub size: u64,
    pub unpacked_size: u64,
    pub sha256: String,
    pub executable: String,
    #[serde(default)]
    pub launch_arguments: Vec<String>,
    pub notes: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation {
    manifest: Manifest,
    directory: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Online,
    Unavailable,
    Error,
}

#[derive(Serialize)]
pub struct Status {
    installed: Option<Manifest>,
    latest: Option<Manifest>,
    check: CheckState,
    running: bool,
    message: String,
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub message: String,
    pub percent: Option<f64>,
}

pub struct Launcher {
    root: PathBuf,
    repository: String,
    previous_repositories: Vec<String>,
    latest: Option<Manifest>,
    check: CheckState,
    message: String,
}

fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// Windows rejects more paths than ZIP's traversal check does. Reject ambiguous
// paths even in tests on other platforms, rather than relying on extraction OS.
fn safe_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return Err(format!("Unsafe archive path: {value}"));
    }
    for part in value.split('/') {
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                base.strip_prefix(prefix)
                    .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
            });
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
            || device
        {
            return Err(format!("Unsafe archive path: {value}"));
        }
    }
    Ok(PathBuf::from(value))
}

fn valid_repository(repository: &str) -> bool {
    let parts: Vec<_> = repository.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
}

impl Manifest {
    fn validate(&self, repository: &str) -> Result<()> {
        let prefix = format!("https://github.com/{repository}/releases/download/");
        let tail = self.url.strip_prefix(&prefix).unwrap_or("");
        let parts: Vec<_> = tail.split('/').collect();
        if self.schema_version != 1
            || self.version.is_empty()
            || self.version.len() > 80
            || !self
                .version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c))
            || self.size == 0
            || self.size > 2 * 1024 * 1024 * 1024
            || self.unpacked_size == 0
            || self.unpacked_size > MAX_UNPACKED
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || parts.len() != 2
            || parts.iter().any(|p| {
                p.is_empty()
                    || !p
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
            })
            || !self.url.ends_with(".zip")
            || self.notes.len() > 32 * 1024
            || self.launch_arguments.len() > 32
            || self
                .launch_arguments
                .iter()
                .any(|arg| arg.len() > 512 || arg.contains('\0'))
        {
            return Err(
                "Release manifest is invalid or points outside the configured repository.".into(),
            );
        }
        safe_path(&self.executable)?;
        if !self.executable.to_ascii_lowercase().ends_with(".exe") {
            return Err("Release executable must be a Windows .exe.".into());
        }
        Ok(())
    }

    fn matches(&self, other: &Self) -> bool {
        self.version == other.version && self.sha256 == other.sha256
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    // tempfile uses replace semantics on Windows; the previous pointer remains
    // valid until this atomic commit. Flush before publishing it.
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing parent")?)
        .map_err(io_error)?;
    serde_json::to_writer_pretty(file.as_file_mut(), value).map_err(io_error)?;
    file.as_file_mut().write_all(b"\n").map_err(io_error)?;
    file.as_file_mut().sync_all().map_err(io_error)?;
    file.persist(path).map_err(io_error)?;
    Ok(())
}

impl Launcher {
    pub fn new(
        root: PathBuf,
        repository: String,
        previous_repositories: Vec<String>,
    ) -> Result<Self> {
        if !valid_repository(&repository)
            || previous_repositories.iter().any(|r| !valid_repository(r))
        {
            return Err("Invalid distribution repository.".into());
        }
        fs::create_dir_all(root.join("versions")).map_err(io_error)?;
        let cache = root.join("latest.json");
        let latest = fs::read(&cache)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .filter(|m| m.validate(&repository).is_ok());
        Ok(Self {
            root,
            repository,
            previous_repositories,
            latest,
            check: CheckState::Unavailable,
            message: "Not checked yet.".into(),
        })
    }

    fn installation(&self) -> Result<Option<Installation>> {
        let path = self.root.join("active.json");
        if !path.exists() {
            return Ok(None);
        }
        let installed: Installation =
            serde_json::from_slice(&fs::read(path).map_err(io_error)?).map_err(io_error)?;
        // Migration applies only to already-installed builds, never new downloads.
        if installed.manifest.validate(&self.repository).is_err()
            && !self
                .previous_repositories
                .iter()
                .any(|r| installed.manifest.validate(r).is_ok())
        {
            return Err(
                "Installed build metadata is invalid or belongs to an unrecognized repository."
                    .into(),
            );
        }
        let directory = safe_path(&installed.directory)?;
        if directory.components().count() != 1 || !installed.directory.starts_with("build-") {
            return Err("Invalid installed-build directory.".into());
        }
        if !self
            .root
            .join("versions")
            .join(directory)
            .join(&installed.manifest.executable)
            .is_file()
        {
            return Err("Installed game executable is missing. Restore it or remove active.json to reinstall.".into());
        }
        Ok(Some(installed))
    }

    pub(crate) fn game_running(&self) -> bool {
        let versions = self.root.join("versions");
        let versions = versions.canonicalize().unwrap_or(versions);
        let system = sysinfo::System::new_all();
        system.processes().values().any(|process| {
            process.exe().is_some_and(|path| {
                path.canonicalize()
                    .unwrap_or_else(|_| path.to_path_buf())
                    .starts_with(&versions)
            })
        })
    }

    pub fn status(&self) -> Result<Status> {
        Ok(Status {
            installed: self.installation()?.map(|i| i.manifest),
            latest: self.latest.clone(),
            check: self.check,
            running: self.game_running(),
            message: self.message.clone(),
        })
    }

    pub fn refresh(&mut self) -> Result<Status> {
        let client = Client::builder()
            .user_agent("The-Signal-Launcher/0.1")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(io_error)?;
        let url = format!(
            "https://github.com/{}/releases/latest/download/manifest.json",
            self.repository
        );
        match client.get(url).header("Cache-Control", "no-cache").send() {
            Err(error) if error.is_connect() || error.is_timeout() => {
                self.check = CheckState::Unavailable;
                self.message = "Cannot reach GitHub. An installed build can be played offline unless a required update is already known.".into();
            }
            Err(error) => {
                self.check = CheckState::Error;
                self.message = format!("Update check failed: {error}");
            }
            Ok(response)
                if response.status().is_server_error() || response.status().as_u16() == 429 =>
            {
                self.check = CheckState::Unavailable;
                self.message = "GitHub is temporarily unavailable. Offline play is available for an up-to-date installed build.".into();
            }
            Ok(response) => {
                let result = (|| -> Result<Manifest> {
                    if !response.status().is_success() {
                        return Err(format!("GitHub returned {}. Publish a game release with manifest.json before using the launcher.", response.status()));
                    }
                    let mut bytes = Vec::new();
                    response
                        .take(MAX_MANIFEST + 1)
                        .read_to_end(&mut bytes)
                        .map_err(io_error)?;
                    if bytes.len() as u64 > MAX_MANIFEST {
                        return Err("Release manifest is too large.".into());
                    }
                    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(io_error)?;
                    manifest.validate(&self.repository)?;
                    write_json(&self.root.join("latest.json"), &manifest)?;
                    Ok(manifest)
                })();
                match result {
                    Ok(manifest) => {
                        self.latest = Some(manifest);
                        self.check = CheckState::Online;
                        self.message = match self.installation()? {
                            None => "Ready to install The Signal.".into(),
                            Some(i)
                                if self.latest.as_ref().is_some_and(|m| m.matches(&i.manifest)) =>
                            {
                                "You are tuned to the latest build.".into()
                            }
                            _ => "A new build is available. Update before playing.".into(),
                        };
                    }
                    Err(error) => {
                        self.check = CheckState::Error;
                        self.message = error;
                    }
                }
            }
        }
        self.status()
    }

    pub fn install(&mut self, emit: impl Fn(Progress)) -> Result<Status> {
        if self.game_running() {
            return Err("Close The Signal before installing an update.".into());
        }
        self.refresh()?;
        if !matches!(self.check, CheckState::Online) {
            return Err(self.message.clone());
        }
        let manifest = self.latest.clone().ok_or("No published build available.")?;
        if self
            .installation()?
            .is_some_and(|i| i.manifest.matches(&manifest))
        {
            return self.status();
        }
        let disks = sysinfo::Disks::new_with_refreshed_list();
        if let Some(disk) = disks
            .iter()
            .filter(|d| self.root.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
        {
            if disk.available_space() < manifest.size + manifest.unpacked_size + 64 * 1024 * 1024 {
                return Err(
                    "Not enough free disk space for download and staged installation.".into(),
                );
            }
        }
        let client = Client::builder()
            .user_agent("The-Signal-Launcher/0.1")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(io_error)?;
        let mut response = client
            .get(&manifest.url)
            .send()
            .map_err(io_error)?
            .error_for_status()
            .map_err(io_error)?;
        if response
            .content_length()
            .is_some_and(|length| length != manifest.size)
        {
            return Err("Download size does not match the release manifest.".into());
        }
        let mut archive = tempfile::NamedTempFile::new_in(&self.root).map_err(io_error)?;
        let mut hash = Sha256::new();
        let mut received = 0u64;
        let mut buffer = [0u8; 128 * 1024];
        let mut last_percent = -1i32;
        loop {
            let count = response.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            received += count as u64;
            if received > manifest.size {
                return Err("Download exceeds its declared size.".into());
            }
            archive.write_all(&buffer[..count]).map_err(io_error)?;
            hash.update(&buffer[..count]);
            let percent = (received * 100 / manifest.size) as i32;
            if percent != last_percent {
                emit(Progress {
                    message: format!(
                        "Downloading… {} / {} MB",
                        received / 1_000_000,
                        manifest.size / 1_000_000
                    ),
                    percent: Some(percent as f64),
                });
                last_percent = percent;
            }
        }
        if received != manifest.size || format!("{:x}", hash.finalize()) != manifest.sha256 {
            return Err(
                "Download verification failed. The installed build was not changed; please retry."
                    .into(),
            );
        }
        archive.flush().map_err(io_error)?;
        emit(Progress {
            message: "Verified download. Installing…".into(),
            percent: None,
        });
        let stage = tempfile::Builder::new()
            .prefix("build-")
            .tempdir_in(self.root.join("versions"))
            .map_err(io_error)?;
        extract(archive.path(), stage.path(), &manifest)?;
        if self.game_running() {
            return Err("The game was started during installation. Close it and retry.".into());
        }
        // The staged directory is immutable once published. No current files are
        // overwritten; an interrupted update cannot invalidate active.json.
        let directory = stage
            .path()
            .file_name()
            .ok_or("Missing build directory")?
            .to_string_lossy()
            .into_owned();
        let installed = Installation {
            manifest,
            directory,
        };
        let retained_path = stage.keep();
        if let Err(error) = write_json(&self.root.join("active.json"), &installed) {
            // Only remove the staging directory this invocation created.
            let _ = fs::remove_dir_all(retained_path);
            return Err(error);
        }
        self.message = "Installed successfully. Ready to play.".into();
        self.status()
    }

    pub fn launch(&mut self) -> Result<Status> {
        if self.game_running() {
            return Err("The Signal is already running.".into());
        }
        self.refresh()?;
        if matches!(self.check, CheckState::Error) {
            return Err(self.message.clone());
        }
        let installed = self.installation()?.ok_or("Install The Signal first.")?;
        if self
            .latest
            .as_ref()
            .is_some_and(|m| !m.matches(&installed.manifest))
        {
            return Err("An update is required before playing.".into());
        }
        let directory = self.root.join("versions").join(&installed.directory);
        Command::new(directory.join(&installed.manifest.executable))
            .args(&installed.manifest.launch_arguments)
            .current_dir(directory)
            .spawn()
            .map_err(|e| format!("Could not launch The Signal: {e}"))?;
        self.message = "The Signal is running. Close the game before updating.".into();
        let mut status = self.status()?;
        status.running = true;
        Ok(status)
    }
}

fn extract(archive_path: &Path, destination: &Path, manifest: &Manifest) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(fs::File::open(archive_path).map_err(io_error)?).map_err(io_error)?;
    if zip.len() > 100_000 {
        return Err("Archive contains too many files.".into());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(io_error)?;
        let name = entry.name().trim_end_matches('/');
        let relative = safe_path(name)?;
        if entry.enclosed_name().is_none()
            || !names.insert(name.to_ascii_lowercase())
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Archive contains duplicate, escaping, or symbolic-link entries.".into());
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(io_error)?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .ok_or("Archive size overflow")?;
        if total > manifest.unpacked_size {
            return Err("Archive exceeds its declared unpacked size.".into());
        }
        fs::create_dir_all(output.parent().ok_or("Missing parent")?).map_err(io_error)?;
        let declared = entry.size();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(io_error)?;
        let copied =
            std::io::copy(&mut (&mut entry).take(declared + 1), &mut file).map_err(io_error)?;
        if copied != declared {
            return Err("Archive entry size mismatch.".into());
        }
        file.sync_all().map_err(io_error)?;
    }
    if total != manifest.unpacked_size || !destination.join(&manifest.executable).is_file() {
        return Err("Archive is incomplete or does not contain the game executable.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 1,
            version: "0.1.0".into(),
            url: "https://github.com/ZiiMs/the-signal/releases/download/v0.1.0/game.zip".into(),
            size: 20,
            unpacked_size: 3,
            sha256: "a".repeat(64),
            executable: "The-Signal.exe".into(),
            launch_arguments: vec![],
            notes: "Test".into(),
        }
    }

    #[test]
    fn rejects_unsafe_windows_paths() {
        for path in [
            "../game.exe",
            "/game.exe",
            "C:/game.exe",
            "a\\b",
            "NUL.txt",
            "a/COM1",
            "a/file:stream",
            "a/../b",
            "a./b",
            "a /b",
            "a//b",
        ] {
            assert!(safe_path(path).is_err(), "{path}");
        }
        assert!(safe_path("The-Signal_Data/Managed/game.dll").is_ok());
    }

    #[test]
    fn validates_manifest_and_repository_boundary() {
        let mut m = manifest();
        assert!(m.validate("ZiiMs/the-signal").is_ok());
        assert!(m.validate("other/repo").is_err());
        m.executable = "../bad.exe".into();
        assert!(m.validate("ZiiMs/the-signal").is_err());
        assert!(!valid_repository("../repo"));
    }

    #[test]
    fn validates_launch_arguments_and_changed_hashes() {
        let original = manifest();
        let mut next = original.clone();
        next.launch_arguments = vec!["--signal-steam-test".into()];
        assert!(next.validate("ZiiMs/the-signal").is_ok());
        assert!(next.matches(&original));
        next.sha256 = "b".repeat(64);
        assert!(!next.matches(&original));
        next.launch_arguments = vec!["bad\0argument".into()];
        assert!(next.validate("ZiiMs/the-signal").is_err());
    }

    #[test]
    #[ignore = "Set SIGNAL_TEST_MANIFEST to a locally packaged manifest.json"]
    fn validates_real_packaged_build() {
        let path =
            PathBuf::from(std::env::var("SIGNAL_TEST_MANIFEST").expect("SIGNAL_TEST_MANIFEST"));
        let manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../distribution.json")).unwrap();
        manifest
            .validate(config["repository"].as_str().unwrap())
            .unwrap();
        let archive_path = path
            .parent()
            .unwrap()
            .join(manifest.url.rsplit('/').next().unwrap());
        let mut file = fs::File::open(&archive_path).unwrap();
        assert_eq!(file.metadata().unwrap().len(), manifest.size);
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 128 * 1024];
        loop {
            let count = file.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        assert_eq!(format!("{:x}", digest.finalize()), manifest.sha256);
        let stage = tempfile::tempdir().unwrap();
        extract(&archive_path, stage.path(), &manifest).unwrap();
        assert!(stage.path().join(&manifest.executable).is_file());
        if manifest
            .launch_arguments
            .iter()
            .any(|a| a == "--signal-steam-test")
        {
            assert_eq!(
                fs::read_to_string(stage.path().join("steam_appid.txt"))
                    .unwrap()
                    .trim(),
                "480"
            );
        }
    }

    #[test]
    fn pointer_replacement_and_offline_cache_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        write_json(&root.path().join("latest.json"), &manifest()).unwrap();
        let mut next = manifest();
        next.version = "0.2.0".into();
        write_json(&root.path().join("latest.json"), &next).unwrap();
        let launcher =
            Launcher::new(root.path().into(), "ZiiMs/the-signal".into(), vec![]).unwrap();
        assert_eq!(launcher.latest.unwrap().version, "0.2.0");
    }

    #[test]
    fn repository_migration_preserves_installed_build_but_not_old_feed_cache() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("versions/build-old");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("The-Signal.exe"), b"exe").unwrap();
        let installed = Installation {
            manifest: manifest(),
            directory: "build-old".into(),
        };
        write_json(&root.path().join("active.json"), &installed).unwrap();
        write_json(&root.path().join("latest.json"), &manifest()).unwrap();
        let launcher = Launcher::new(
            root.path().into(),
            "The-Signals/the-signal-data".into(),
            vec!["ZiiMs/the-signal".into()],
        )
        .unwrap();
        assert!(launcher.latest.is_none());
        assert_eq!(
            launcher.installation().unwrap().unwrap().manifest.version,
            "0.1.0"
        );
        assert!(manifest().validate("The-Signals/the-signal-data").is_err());
        let strict = Launcher::new(
            root.path().into(),
            "The-Signals/the-signal-data".into(),
            vec![],
        )
        .unwrap();
        assert!(strict.installation().is_err());
    }

    fn archive(root: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = root.join("test.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn extracts_only_complete_safe_archives() {
        let root = tempfile::tempdir().unwrap();
        let path = archive(root.path(), &[("The-Signal.exe", b"exe")]);
        let stage = root.path().join("stage");
        fs::create_dir(&stage).unwrap();
        assert!(extract(&path, &stage, &manifest()).is_ok());
        assert_eq!(fs::read(stage.join("The-Signal.exe")).unwrap(), b"exe");
    }

    #[test]
    fn rejects_traversal_duplicates_and_size_mismatches() {
        for entries in [
            vec![("../bad.exe", b"exe".as_slice())],
            vec![
                ("The-Signal.exe", b"exe".as_slice()),
                ("the-signal.exe", b"exe".as_slice()),
            ],
            vec![("The-Signal.exe", b"too much".as_slice())],
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = archive(root.path(), &entries);
            let stage = root.path().join("stage");
            fs::create_dir(&stage).unwrap();
            assert!(extract(&path, &stage, &manifest()).is_err());
            assert!(!root.path().join("bad.exe").exists());
        }
    }
}
