// Covers blocked apps: every second, look at the frontmost app; if a block is
// on for it, hide it (Mac) / minimise it (Windows) and show "Not now.".
use crate::{apps, policy, App};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn start(app: Arc<App>, handle: AppHandle) {
    std::thread::spawn(move || {
        let mut ids: HashMap<std::path::PathBuf, Option<String>> = HashMap::new();
        let mut last: Option<(String, Instant)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let Ok(w) = active_win_pos_rs::get_active_window() else { continue };
            if w.process_id == std::process::id() as u64 {
                continue;
            }
            let id = ids.entry(w.process_path.clone()).or_insert_with(|| apps::id_for(&w.process_path)).clone();
            let Some(id) = id else { continue };
            let now = chrono::Local::now().naive_local();
            let Some(hit) = policy::for_app(&app.store, &id, now) else { continue };
            // Don't hammer the same app while it's being hidden.
            if last.as_ref().map_or(false, |(l, t)| *l == id && t.elapsed() < Duration::from_secs(2)) {
                continue;
            }
            last = Some((id.clone(), Instant::now()));
            hide(w.process_id);
            let what = if w.app_name.is_empty() { apps::label(&id) } else { w.app_name.clone() };
            show_blocked(&handle, &what, &hit.name, &hit.until.format("%Y-%m-%dT%H:%M:%S").to_string());
        }
    });
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn show_blocked(handle: &AppHandle, what: &str, name: &str, until: &str) {
    let hash = format!("blocked?what={}&name={}&until={}", enc(what), enc(name), enc(until));
    let h = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window("blocked") {
            let _ = w.eval(&format!("location.hash = {:?}", hash));
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let _ = WebviewWindowBuilder::new(&h, "blocked", WebviewUrl::App(format!("desktop.html#{hash}").into()))
            .title("Not now.")
            .inner_size(640.0, 460.0)
            .center()
            .always_on_top(true)
            .resizable(false)
            .focused(true)
            .build();
    });
}

#[cfg(target_os = "macos")]
fn hide(pid: u64) {
    use objc2_app_kit::NSRunningApplication;
    #[allow(unused_unsafe)]
    unsafe {
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32) {
            app.hide();
        }
    }
}

#[cfg(windows)]
fn hide(_pid: u64) {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, ShowWindow, SW_MINIMIZE};
    unsafe {
        let w = GetForegroundWindow();
        let _ = ShowWindow(w, SW_MINIMIZE);
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn hide(_pid: u64) {}
