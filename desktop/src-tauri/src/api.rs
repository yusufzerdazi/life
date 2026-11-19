// The routes the shared React UI calls (web/src/api.js → invoke("api")),
// shaped like the phone's LocalApi so web/src/Blocks.jsx works unchanged.
use crate::policy::{self, active_until, is_always};
use crate::store::Block;
use crate::{apps, App};
use chrono::NaiveDateTime;
use serde_json::{json, Value};

pub struct Res {
    pub status: u16,
    pub text: String,
}

fn ok(v: Value) -> Res {
    Res { status: 200, text: v.to_string() }
}
fn err(status: u16, msg: &str) -> Res {
    Res { status, text: json!({ "error": msg }).to_string() }
}

pub fn route(app: &App, method: &str, path: &str, body: &str) -> Res {
    let parts: Vec<&str> = path.trim_start_matches("/api/").split('?').next().unwrap_or("").split('/').collect();
    let b: Value = serde_json::from_str(body).unwrap_or(json!({}));
    match (method, parts.as_slice()) {
        ("GET", ["blocks"]) => ok(list(app)),
        ("POST", ["blocks"]) => add(app, &b),
        ("DELETE", ["blocks", uid]) => delete(app, uid),
        ("GET", ["apps"]) => ok(json!({ "apps": apps::installed() })),
        ("GET", ["sync"]) => ok(app.sync.status()),
        ("POST", ["sync", "key"]) => match app.store.set_key(b["key"].as_str().unwrap_or("")) {
            Ok(_) => {
                app.sync.key_changed();
                ok(app.sync.status())
            }
            Err(e) => err(400, &e),
        },
        // Not on desktop: the UI hides what it can't use.
        _ => err(404, "Not here"),
    }
}

fn now() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

fn fmt(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn list(app: &App) -> Value {
    let now = now();
    let mut out: Vec<Value> = app
        .store
        .live()
        .into_iter()
        .map(|b| {
            let note = b.category.as_ref().map(|c| format!("{c} sites ({} on the list)", policy::list_size(c)));
            json!({
                "id": b.uid,
                "name": b.name,
                "apps": b.apps.iter().map(|a| json!({ "pkg": a, "label": b.labels.get(a).cloned().unwrap_or_else(|| apps::label(a)) })).collect::<Vec<_>>(),
                "sites": b.sites,
                "note": note,
                "days": b.days,
                "start": b.start,
                "end": b.end,
                "builtIn": b.built_in,
                "always": is_always(&b) && b.until.is_none(),
                "oneOff": b.until.is_some(),
                "activeUntil": active_until(&b, now).map(fmt),
            })
        })
        .collect();
    // Built-ins and categories first, as on the phone.
    out.sort_by_key(|v| !v["builtIn"].as_bool().unwrap_or(false));
    json!({ "blocks": out })
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn valid_time(s: &str) -> bool {
    chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok()
}

fn add(app: &App, b: &Value) -> Res {
    let name = b["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Block").to_string();
    let apps_: Vec<String> = strings(&b["apps"]);
    let mut sites: Vec<String> = strings(&b["sites"]).iter().filter_map(|s| policy::host_of(s)).collect();
    sites.dedup();
    let mut days: Vec<u8> = b["days"].as_array().map(|a| a.iter().filter_map(|d| d.as_u64()).filter(|d| (1..=7).contains(d)).map(|d| d as u8).collect()).unwrap_or_default();
    days.sort();
    days.dedup();
    let (start, end) = (b["start"].as_str().unwrap_or(""), b["end"].as_str().unwrap_or(""));
    if apps_.is_empty() && sites.is_empty() {
        return err(400, "Pick at least one app or website");
    }
    if days.is_empty() {
        return err(400, "Pick at least one day");
    }
    if !valid_time(start) || !valid_time(end) {
        return err(400, "Times must be HH:MM");
    }
    let labels = apps_.iter().map(|a| (a.clone(), apps::label(a))).collect();
    app.store.add(Block {
        uid: uuid::Uuid::new_v4().to_string(),
        name,
        apps: apps_,
        labels,
        sites,
        days,
        start: start.into(),
        end: end.into(),
        until: None,
        category: None,
        built_in: false,
        origin: String::new(),
        updated_at: 0,
        deleted: false,
    });
    app.changed();
    Res { status: 201, text: "{}".into() }
}

fn delete(app: &App, uid: &str) -> Res {
    let Some(b) = app.store.find(uid) else { return err(404, "Block not found") };
    if b.built_in {
        return err(403, "Built-in blocks can only be changed in the phone app's code");
    }
    if let Some(u) = active_until(&b, now()) {
        return err(409, &format!("“{}” is on until {} — you can remove it after that", b.name, u.format("%H:%M")));
    }
    app.store.delete(uid);
    app.changed();
    Res { status: 204, text: String::new() }
}
