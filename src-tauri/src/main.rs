#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod updates;
use core::{Launcher, Status};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

struct AppState {
    launcher: Mutex<Launcher>,
    gate: updates::OperationGate,
}

async fn operation(app: tauri::AppHandle, action: &'static str) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.gate.acquire()?;
        let mut launcher = state
            .launcher
            .try_lock()
            .map_err(|_| "Another launcher operation is in progress.")?;
        match action {
            "check" => launcher.refresh(),
            "install" => launcher.install(|progress| {
                let _ = app.emit("install-progress", progress);
            }),
            "launch" => launcher.launch(),
            _ => launcher.status(),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check(app: tauri::AppHandle) -> Result<Status, String> {
    operation(app, "check").await
}
#[tauri::command]
async fn install(app: tauri::AppHandle) -> Result<Status, String> {
    operation(app, "install").await
}
#[tauri::command]
async fn launch(app: tauri::AppHandle) -> Result<Status, String> {
    operation(app, "launch").await
}
#[tauri::command]
async fn local_status(app: tauri::AppHandle) -> Result<Status, String> {
    operation(app, "status").await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            #[derive(serde::Deserialize)]
            struct Distribution {
                repository: String,
                #[serde(default)]
                previous_repositories: Vec<String>,
            }
            let config: Distribution =
                serde_json::from_str(include_str!("../../distribution.json"))?;
            // Game data belongs to this user, outside the launcher installation.
            let root = app.path().app_local_data_dir()?.join("game");
            let launcher = Launcher::new(root, config.repository, config.previous_repositories)
                .map_err(std::io::Error::other)?;
            app.manage(AppState {
                launcher: Mutex::new(launcher),
                gate: updates::OperationGate::default(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<AppState>().gate.is_busy() {
                    // Let the transactional update finish rather than killing its worker.
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            check,
            install,
            launch,
            local_status,
            updates::launcher_update_status,
            updates::install_launcher_update
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run The Signal Launcher");
}
