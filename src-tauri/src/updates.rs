use crate::{core::Progress, AppState};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct OperationGate(Arc<AtomicBool>);

pub struct OperationGuard(Arc<AtomicBool>);

impl OperationGate {
    pub fn acquire(&self) -> Result<OperationGuard, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another launcher operation is in progress.".to_string())?;
        Ok(OperationGuard(self.0.clone()))
    }

    pub fn is_busy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
pub struct LauncherUpdateStatus {
    current_version: String,
    available_version: Option<String>,
    notes: Option<String>,
    message: String,
}

fn validate_release(version: &str, expected: &str, url: &str) -> Result<(), String> {
    if version != expected {
        return Err(
            "The launcher release changed. Check again before confirming the new version.".into(),
        );
    }
    let distribution: serde_json::Value =
        serde_json::from_str(include_str!("../../distribution.json")).map_err(|e| e.to_string())?;
    let repository = distribution["launcher_repository"]
        .as_str()
        .ok_or("Launcher repository is not configured.")?;
    let prefix = format!("https://github.com/{repository}/releases/download/");
    if !url.starts_with(&prefix) || !url.ends_with(".exe") {
        return Err("Launcher update points outside the configured installer repository.".into());
    }
    Ok(())
}

async fn ensure_game_closed(app: &tauri::AppHandle) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let launcher = state
            .launcher
            .lock()
            .map_err(|_| "Launcher state is unavailable.")?;
        if launcher.game_running() {
            Err("Close The Signal before updating the launcher.".into())
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn launcher_update_status(app: tauri::AppHandle) -> Result<LauncherUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let result = app
        .updater_builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await;
    let update = match result {
        Ok(update) => update,
        Err(_) => {
            return Ok(LauncherUpdateStatus {
                current_version,
                available_version: None,
                notes: None,
                message: "Launcher update check unavailable. Game updates and play are unaffected."
                    .into(),
            })
        }
    };
    if let Some(update) = update {
        validate_release(
            &update.version,
            &update.version,
            update.download_url.as_str(),
        )?;
        Ok(LauncherUpdateStatus {
            current_version,
            available_version: Some(update.version),
            notes: update.body,
            message: "A launcher update is available. Install when convenient.".into(),
        })
    } else {
        Ok(LauncherUpdateStatus {
            current_version,
            available_version: None,
            notes: None,
            message: "Launcher is up to date.".into(),
        })
    }
}

#[tauri::command]
pub async fn install_launcher_update(
    app: tauri::AppHandle,
    expected_version: String,
) -> Result<(), String> {
    let _guard = app.state::<AppState>().gate.acquire()?;
    ensure_game_closed(&app).await?;
    let mut update = app
        .updater_builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No newer launcher version is available.")?;
    validate_release(
        &update.version,
        &expected_version,
        update.download_url.as_str(),
    )?;
    update.timeout = Some(Duration::from_secs(10 * 60));
    let mut downloaded = 0u64;
    let progress_app = app.clone();
    let finished_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| (downloaded as f64 * 100.0 / t as f64).min(99.0));
                let _ = progress_app.emit(
                    "launcher-update-progress",
                    Progress {
                        message: format!(
                            "Downloading launcher update… {:.2} MB",
                            downloaded as f64 / 1_000_000.0
                        ),
                        percent,
                    },
                );
            },
            move || {
                let _ = finished_app.emit(
                    "launcher-update-progress",
                    Progress {
                        message: "Download received. Verifying update signature…".into(),
                        percent: None,
                    },
                );
            },
        )
        .await
        .map_err(|e| format!("Launcher update failed; nothing was installed: {e}"))?;
    // Download verifies the mandatory signature. Check again in case the game
    // was started outside the launcher while this download was in progress.
    ensure_game_closed(&app).await?;
    let _ = app.emit(
        "launcher-update-progress",
        Progress {
            message: "Signature verified. The launcher will close to install and restart…".into(),
            percent: Some(100.0),
        },
    );
    update
        .restart_after_install(true)
        .install(bytes)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_gate_blocks_concurrent_actions_and_recovers_after_drop() {
        let gate = OperationGate::default();
        let guard = gate.acquire().unwrap();
        assert!(gate.is_busy());
        assert!(gate.acquire().is_err());
        drop(guard);
        assert!(!gate.is_busy());
        assert!(gate.acquire().is_ok());
    }

    #[test]
    fn update_requires_confirmed_version_and_trusted_installer_repository() {
        let url =
            "https://github.com/The-Signals/the-signal-launcher/releases/download/v0.1.3/setup.exe";
        assert!(validate_release("0.1.3", "0.1.3", url).is_ok());
        assert!(validate_release("0.1.4", "0.1.3", url).is_err());
        assert!(validate_release("0.1.3", "0.1.3", "https://example.com/setup.exe").is_err());
        assert!(validate_release(
            "0.1.3",
            "0.1.3",
            "https://github.com/The-Signals/the-signal-data/releases/download/v0.1.3/setup.exe"
        )
        .is_err());
    }

    #[test]
    #[ignore = "Set SIGNAL_TEST_INSTALLER to a built signed NSIS installer"]
    fn validates_real_signed_launcher_artifact_and_rejects_tampering() {
        use base64::Engine;
        let installer = std::env::var("SIGNAL_TEST_INSTALLER").expect("SIGNAL_TEST_INSTALLER");
        let mut bytes = std::fs::read(&installer).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let public_encoded = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let signature_encoded = std::fs::read_to_string(format!("{installer}.sig")).unwrap();
        let decode = |value: &str| {
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(value.trim())
                    .unwrap(),
            )
            .unwrap()
        };
        let public_key = minisign_verify::PublicKey::decode(&decode(public_encoded)).unwrap();
        let signature_text = decode(&signature_encoded);
        let signature = minisign_verify::Signature::decode(&signature_text).unwrap();
        public_key.verify(&bytes, &signature, true).unwrap();
        assert!(signature
            .trusted_comment()
            .split('\t')
            .any(|field| field == format!("version:{}", env!("CARGO_PKG_VERSION"))));
        bytes[0] ^= 1;
        assert!(public_key.verify(&bytes, &signature, true).is_err());
        bytes[0] ^= 1;
        let tampered_text = signature_text.replace(
            &format!("version:{}", env!("CARGO_PKG_VERSION")),
            "version:99.0.0",
        );
        let tampered_signature = minisign_verify::Signature::decode(&tampered_text).unwrap();
        assert!(public_key
            .verify(&bytes, &tampered_signature, true)
            .is_err());
    }
}
