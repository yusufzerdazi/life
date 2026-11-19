// What's blocked right now: the schedule (as on the phone's Schedule.kt) and
// the category lists bundled from android/app/src/main/assets/lists.
use crate::store::{Block, Store};
use chrono::{Datelike, Duration, NaiveDateTime, NaiveTime};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

pub const FOREVER: &str = "9999-01-01T00:00:00";

fn time(s: &str) -> NaiveTime {
    NaiveTime::parse_from_str(s, "%H:%M").unwrap_or(NaiveTime::MIN)
}

pub fn is_always(b: &Block) -> bool {
    b.days.len() == 7 && b.start == b.end
}

// End of the window of `b` that contains `now`, or None.
pub fn active_until(b: &Block, now: NaiveDateTime) -> Option<NaiveDateTime> {
    if let Some(u) = &b.until {
        let u = NaiveDateTime::parse_from_str(u, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| NaiveDateTime::parse_from_str(u, "%Y-%m-%dT%H:%M"))
            .ok()?;
        return (now < u).then_some(u);
    }
    if is_always(b) {
        return NaiveDateTime::parse_from_str(FOREVER, "%Y-%m-%dT%H:%M:%S").ok();
    }
    let (start, end) = (time(&b.start), time(&b.end));
    let today = now.date();
    // A window that started yesterday may still be running past midnight.
    [today - Duration::days(1), today]
        .into_iter()
        .filter(|d| b.days.contains(&(d.weekday().number_from_monday() as u8)))
        .map(|d| {
            let s = d.and_time(start);
            let e = if end > start { d.and_time(end) } else { (d + Duration::days(1)).and_time(end) };
            (s, e)
        })
        .filter(|(s, e)| now >= *s && now < *e)
        .map(|(_, e)| e)
        .max()
}

pub fn host_of(url: &str) -> Option<String> {
    let s = url.trim().to_lowercase();
    let s = s.split("://").last()?;
    let h = s.split(['/', '?', '#']).next()?.split(':').next()?;
    let h = h.strip_prefix("www.").unwrap_or(h);
    (h.contains('.') && !h.contains(' ')).then(|| h.to_string())
}

pub fn matches(host: &str, domains: &[String]) -> bool {
    domains.iter().any(|d| host == d || host.ends_with(&format!(".{d}")))
}

// --- category lists ---

static LISTS: OnceLock<HashMap<String, HashSet<String>>> = OnceLock::new();

pub fn load_lists(dir: &Path) {
    let mut m = HashMap::new();
    for name in ["adult", "news"] {
        let set = std::fs::read_to_string(dir.join(format!("{name}.txt")))
            .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect())
            .unwrap_or_default();
        m.insert(name.to_string(), set);
    }
    let _ = LISTS.set(m);
}

pub fn list_size(name: &str) -> usize {
    LISTS.get().and_then(|l| l.get(name)).map_or(0, |s| s.len())
}

fn in_category(host: &str, category: &str) -> bool {
    let Some(set) = LISTS.get().and_then(|l| l.get(category)) else { return false };
    let parts: Vec<&str> = host.split('.').collect();
    (0..parts.len().saturating_sub(1)).any(|i| set.contains(&parts[i..].join(".")))
}

pub struct Hit {
    pub name: String,
    pub until: NaiveDateTime,
    pub category: Option<String>,
}

fn latest(hits: impl Iterator<Item = Hit>) -> Option<Hit> {
    hits.max_by_key(|h| h.until)
}

pub fn for_app(store: &Store, app: &str, now: NaiveDateTime) -> Option<Hit> {
    let app = app.to_lowercase();
    latest(store.live().into_iter().filter(|b| b.category.is_none() && b.apps.iter().any(|a| a.to_lowercase() == app)).filter_map(|b| {
        active_until(&b, now).map(|until| Hit { name: b.name.clone(), until, category: None })
    }))
}

pub fn for_url(store: &Store, url: &str, now: NaiveDateTime) -> Option<Hit> {
    let host = host_of(url)?;
    latest(store.live().into_iter().filter_map(|b| {
        let hit = match &b.category {
            Some(c) => in_category(&host, c),
            None => matches(&host, &b.sites),
        };
        if !hit {
            return None;
        }
        active_until(&b, now).map(|until| Hit { name: b.name.clone(), until, category: b.category.clone() })
    }))
}
