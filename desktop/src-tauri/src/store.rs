// The block list, kept in a JSON file, and how lists from other devices merge
// into it (same rules as the phone's Sync.kt; see desktop/PROTOCOL.md).
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub sites: Vec<String>,
    #[serde(default)]
    pub days: Vec<u8>,
    #[serde(default = "midnight")]
    pub start: String,
    #[serde(default = "midnight")]
    pub end: String,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

fn midnight() -> String {
    "00:00".into()
}

#[derive(Serialize, Deserialize, Default)]
struct Data {
    device: String,
    key: String,
    blocks: Vec<Block>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn now_local() -> String {
    chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string()
}

const TOMBSTONE_MS: i64 = 30 * 86_400_000;

fn new_key() -> String {
    let abc = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut r = rand::thread_rng();
    let s: String = (0..20).map(|_| abc[r.gen_range(0..abc.len())] as char).collect();
    s.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

impl Store {
    pub fn open(path: PathBuf) -> Store {
        let mut data: Data = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if data.device.is_empty() {
            data.device = uuid::Uuid::new_v4().to_string();
        }
        if data.key.is_empty() {
            data.key = new_key();
        }
        let s = Store { path, data: Mutex::new(data) };
        s.save(&s.data.lock().unwrap());
        s
    }

    fn save(&self, d: &Data) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(d).unwrap()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    pub fn device(&self) -> String {
        self.data.lock().unwrap().device.clone()
    }

    pub fn key(&self) -> String {
        self.data.lock().unwrap().key.clone()
    }

    pub fn set_key(&self, key: &str) -> Result<String, String> {
        let clean: String = key.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if clean.len() < 16 {
            return Err("That key is too short".into());
        }
        let k = clean.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-");
        let mut d = self.data.lock().unwrap();
        d.key = k.clone();
        self.save(&d);
        Ok(k)
    }

    // Live blocks: not deleted, not finished one-offs.
    pub fn live(&self) -> Vec<Block> {
        let now = now_local();
        self.data
            .lock()
            .unwrap()
            .blocks
            .iter()
            .filter(|b| !b.deleted && b.until.as_ref().map_or(true, |u| *u > now))
            .cloned()
            .collect()
    }

    pub fn find(&self, uid: &str) -> Option<Block> {
        self.data.lock().unwrap().blocks.iter().find(|b| b.uid == uid && !b.deleted).cloned()
    }

    pub fn add(&self, mut b: Block) {
        let mut d = self.data.lock().unwrap();
        b.origin = d.device.clone();
        b.updated_at = now_ms();
        d.blocks.push(b);
        self.save(&d);
    }

    pub fn delete(&self, uid: &str) {
        let mut d = self.data.lock().unwrap();
        if let Some(b) = d.blocks.iter_mut().find(|b| b.uid == uid) {
            b.deleted = true;
            b.updated_at = now_ms();
        }
        self.save(&d);
    }

    // Everything, tombstones included, for other devices.
    pub fn export(&self) -> Vec<Block> {
        let mut d = self.data.lock().unwrap();
        let cutoff = now_ms() - TOMBSTONE_MS;
        let now = now_local();
        let before = d.blocks.len();
        d.blocks.retain(|b| !(b.deleted && b.updated_at < cutoff) && b.until.as_ref().map_or(true, |u| *u > now));
        if d.blocks.len() != before {
            self.save(&d);
        }
        d.blocks.clone()
    }

    // Merge a list from device `from`. Newest edit of each block wins (a
    // deletion wins a tie). Built-ins (the phone's coded blocks) are replaced
    // wholesale when they come from the device that defines them. Returns
    // whether anything changed.
    pub fn merge(&self, incoming: Vec<Block>, from: &str) -> bool {
        let mut d = self.data.lock().unwrap();
        let now = now_local();
        let mut changed = false;
        let from_origin: HashSet<String> = incoming.iter().filter(|b| b.built_in && b.origin == from).map(|b| b.uid.clone()).collect();
        let sender_has_builtins = !from_origin.is_empty();
        let before = d.blocks.len();
        d.blocks.retain(|b| !(b.built_in && b.origin == from && sender_has_builtins && !from_origin.contains(&b.uid)));
        changed |= d.blocks.len() != before;
        for b in incoming {
            if b.uid.is_empty() || b.until.as_ref().map_or(false, |u| *u <= now) {
                continue;
            }
            match d.blocks.iter_mut().find(|m| m.uid == b.uid) {
                Some(m) => {
                    if b.updated_at > m.updated_at || (b.updated_at == m.updated_at && b.deleted && !m.deleted) {
                        *m = b;
                        changed = true;
                    }
                }
                None => {
                    d.blocks.push(b);
                    changed = true;
                }
            }
        }
        if changed {
            self.save(&d);
        }
        changed
    }
}
