// life for Mac and Windows: the same blocks as the phone, shared over the
// home network. Runs in the background (tray icon), starts at login.
//   - store.rs   the block list (JSON file) and merging
//   - sync.rs    finding and swapping with the phone / other computers
//   - policy.rs  what's on now: schedules and the category lists
//   - watch.rs   hides blocked apps and shows "Not now."
//   - local.rs   http://127.0.0.1:47711 for the browser extension
//   - api.rs     the routes the shared React UI uses
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod apps;
mod local;
mod policy;
mod store;
mod sync;
mod watch;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

pub struct App {
    pub store: Arc<store::Store>,
    pub sync: Arc<sync::Sync>,
}

impl App {
    // A local change: tell the other devices.
    pub fn changed(&self) {
        self.sync.soon();
    }
}

#[derive(serde::Serialize)]
struct Reply {
    status: u16,
    text: String,
}

#[tauri::command]
fn api(state: tauri::State<'_, Arc<App>>, method: String, path: String, body: String) -> Reply {
    let r = api::route(&state, &method, &path, &body);
    Reply { status: r.status, text: r.text }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .invoke_handler(tauri::generate_handler![api])
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let data = handle.path().app_data_dir()?;
            let store = Arc::new(store::Store::open(data.join("blocks.json")));
            if let Ok(lists) = handle.path().resource_dir().map(|d| d.join("lists")) {
                std::thread::spawn(move || policy::load_lists(&lists));
            }
            let sync = sync::Sync::new(store.clone(), || {});
            let app = Arc::new(App { store, sync: sync.clone() });
            tauri_app.manage(app.clone());
            sync.start();
            local::start(app.clone());
            watch::start(app.clone(), handle.clone());

            // Start at login, in the background.
            let _ = handle.autolaunch().enable();
            if !std::env::args().any(|a| a == "--background") {
                show_main(&handle);
            }

            let open = MenuItem::with_id(tauri_app, "open", "Open life", true, None::<&str>)?;
            let menu = Menu::with_items(tauri_app, &[&open])?;
            TrayIconBuilder::new()
                .icon(tauri_app.default_window_icon().cloned().unwrap())
                .tooltip("life")
                .menu(&menu)
                .on_menu_event(|app, e| {
                    if e.id.as_ref() == "open" {
                        show_main(app);
                    }
                })
                .build(tauri_app)?;
            Ok(())
        })
        // Closing a window just hides it: life keeps running in the tray.
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                let _ = w.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't start life")
        .run(|app, e| {
            // Clicking the Dock icon on a Mac.
            if let tauri::RunEvent::Reopen { .. } = e {
                show_main(app);
            }
        });
}
