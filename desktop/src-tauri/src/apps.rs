// Desktop apps, by the id blocks store for them: the bundle id on a Mac
// (com.tinyspeck.slackmacgap), the .exe name on Windows (slack.exe).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

static LABELS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn label(id: &str) -> String {
    if let Some(l) = LABELS.lock().unwrap().as_ref().and_then(|m| m.get(id)) {
        return l.clone();
    }
    id.to_string()
}

fn remember(list: &[(String, String)]) {
    let mut g = LABELS.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    for (id, name) in list {
        m.insert(id.clone(), name.clone());
    }
}

pub fn installed() -> Vec<Value> {
    let mut list = scan();
    list.sort_by_key(|(_, n)| n.to_lowercase());
    list.dedup_by(|a, b| a.0 == b.0);
    remember(&list);
    list.into_iter().map(|(id, name)| json!({ "pkg": id, "label": name })).collect()
}

// The app id of a running process, from its executable path.
pub fn id_for(process_path: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = process_path.ancestors().find(|p| p.extension().map_or(false, |e| e == "app"))?;
        return mac_bundle(bundle).map(|(id, _)| id);
    }
    #[cfg(not(target_os = "macos"))]
    {
        return process_path.file_name().map(|n| n.to_string_lossy().to_lowercase());
    }
}

#[cfg(target_os = "macos")]
fn mac_bundle(app: &Path) -> Option<(String, String)> {
    let info = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    let d = info.as_dictionary()?;
    let id = d.get("CFBundleIdentifier")?.as_string()?.to_string();
    let name = d
        .get("CFBundleDisplayName")
        .or_else(|| d.get("CFBundleName"))
        .and_then(|v| v.as_string())
        .map(String::from)
        .unwrap_or_else(|| app.file_stem().unwrap_or_default().to_string_lossy().to_string());
    Some((id, name))
}

#[cfg(target_os = "macos")]
fn scan() -> Vec<(String, String)> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = ["/Applications".to_string(), "/Applications/Utilities".into(), "/System/Applications".into(), format!("{home}/Applications")];
    dirs.iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |e| e == "app"))
        .filter_map(|p| mac_bundle(&p))
        .filter(|(id, _)| id != "com.zerdazi.life.desktop")
        .collect()
}

// Windows: programs running now (from Program Files / AppData), which covers
// what you'd want to block without parsing Start Menu shortcuts.
#[cfg(not(target_os = "macos"))]
fn scan() -> Vec<(String, String)> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .filter_map(|p| p.exe().map(|e| e.to_path_buf()))
        .filter(|e| {
            let s = e.to_string_lossy().to_lowercase();
            (s.contains("program files") || s.contains("appdata")) && !s.contains("\\windows\\")
        })
        .filter_map(|e| {
            let id = e.file_name()?.to_string_lossy().to_lowercase();
            let name = e.file_stem()?.to_string_lossy().to_string();
            (id != "life.exe").then_some((id, name))
        })
        .collect()
}
