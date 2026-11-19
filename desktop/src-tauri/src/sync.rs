// Sharing blocks with the phone and other computers on the home network.
// Same protocol as the phone's Sync.kt (desktop/PROTOCOL.md): mDNS service
// _lifesync._tcp, POST /sync/v1/exchange with the whole list, signed with
// HMAC-SHA256 over "time\nmethod\npath\nbody" using the shared key.
use crate::store::{now_ms, Block, Store};
use hmac::{Hmac, Mac};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const PORT: u16 = 47712;
const SERVICE: &str = "_lifesync._tcp.local.";
const PATH: &str = "/sync/v1/exchange";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    #[serde(skip)]
    device: String,
    pub name: String,
    #[serde(skip)]
    addr: String,
    pub last_sync: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Exchange {
    device: String,
    name: String,
    blocks: Vec<Block>,
}

pub struct Sync {
    store: Arc<Store>,
    peers: Mutex<HashMap<String, Peer>>,
    kick: Mutex<Option<Sender<()>>>,
    on_change: Box<dyn Fn() + Send + std::marker::Sync>,
}

static NAME: OnceLock<String> = OnceLock::new();
pub fn device_name() -> String {
    NAME.get_or_init(|| {
        let h = gethostname::gethostname().to_string_lossy().to_string();
        h.trim_end_matches(".local").to_string()
    })
    .clone()
}

fn sign(key: &str, time: &str, method: &str, path: &str, body: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    m.update(format!("{time}\n{method}\n{path}\n{body}").as_bytes());
    hex::encode(m.finalize().into_bytes())
}

impl Sync {
    pub fn new(store: Arc<Store>, on_change: impl Fn() + Send + std::marker::Sync + 'static) -> Arc<Sync> {
        Arc::new(Sync { store, peers: Mutex::new(HashMap::new()), kick: Mutex::new(None), on_change: Box::new(on_change) })
    }

    pub fn start(self: &Arc<Sync>) {
        let (tx, rx) = channel();
        *self.kick.lock().unwrap() = Some(tx);
        let s = self.clone();
        std::thread::spawn(move || s.serve());
        let s = self.clone();
        std::thread::spawn(move || s.mdns());
        let s = self.clone();
        std::thread::spawn(move || s.run(rx));
    }

    // A local change: swap with everyone now.
    pub fn soon(&self) {
        if let Some(tx) = self.kick.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    pub fn status(&self) -> serde_json::Value {
        let mut peers: Vec<Peer> = self.peers.lock().unwrap().values().cloned().collect();
        peers.sort_by(|a, b| a.name.cmp(&b.name));
        serde_json::json!({ "device": self.store.device(), "name": device_name(), "key": self.store.key(), "peers": peers })
    }

    pub fn key_changed(&self) {
        for p in self.peers.lock().unwrap().values_mut() {
            p.error = None;
        }
        self.soon();
    }

    fn body(&self) -> String {
        serde_json::to_string(&Exchange { device: self.store.device(), name: device_name(), blocks: self.store.export() }).unwrap()
    }

    fn merge(&self, blocks: Vec<Block>, from: &str) {
        if self.store.merge(blocks, from) {
            (self.on_change)();
        }
    }

    // Every minute, and whenever kicked (debounced a little).
    fn run(&self, rx: Receiver<()>) {
        std::thread::sleep(Duration::from_secs(3));
        loop {
            let peers: Vec<Peer> = self.peers.lock().unwrap().values().cloned().collect();
            for p in peers {
                let result = self.exchange(&p);
                let mut all = self.peers.lock().unwrap();
                if let Some(q) = all.get_mut(&p.device) {
                    match result {
                        Ok(name) => {
                            q.name = name;
                            q.last_sync = Some(now_ms());
                            q.error = None;
                        }
                        Err(e) => q.error = Some(e),
                    }
                }
            }
            if rx.recv_timeout(Duration::from_secs(60)).is_ok() {
                std::thread::sleep(Duration::from_millis(1500));
                while rx.try_recv().is_ok() {}
            }
        }
    }

    fn exchange(&self, p: &Peer) -> Result<String, String> {
        let body = self.body();
        let time = now_ms().to_string();
        let sig = sign(&self.store.key(), &time, "POST", PATH, &body);
        let res = ureq::post(&format!("http://{}{PATH}", p.addr))
            .timeout(Duration::from_secs(8))
            .set("Content-Type", "application/json")
            .set("X-Life-Time", &time)
            .set("X-Life-Sig", &sig)
            .send_string(&body);
        match res {
            Ok(r) => {
                let text = r.into_string().map_err(|e| e.to_string())?;
                let ex: Exchange = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                self.merge(ex.blocks, &ex.device);
                Ok(ex.name)
            }
            Err(ureq::Error::Status(401, _)) => Err("Different sync key".into()),
            Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
            Err(_) => Err("Couldn’t reach it".into()),
        }
    }

    fn serve(&self) {
        let server = match tiny_http::Server::http(("0.0.0.0", PORT)) {
            Ok(s) => s,
            Err(e) => return eprintln!("sync: can't listen on {PORT}: {e}"),
        };
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().take(5_000_000).read_to_string(&mut body);
            let header = |name: &'static str| req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string());
            let reply = |status: u16, text: String| {
                tiny_http::Response::from_string(text)
                    .with_status_code(status)
                    .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
            };
            if req.method() != &tiny_http::Method::Post || req.url() != PATH {
                let _ = req.respond(reply(404, r#"{"error":"not found"}"#.into()));
                continue;
            }
            let ok = match (header("X-Life-Time"), header("X-Life-Sig")) {
                (Some(t), Some(sig)) => {
                    let fresh = t.parse::<i64>().map_or(false, |t| (now_ms() - t).abs() < 5 * 60_000);
                    fresh && sign(&self.store.key(), &t, "POST", PATH, &body) == sig
                }
                _ => false,
            };
            if !ok {
                let _ = req.respond(reply(401, r#"{"error":"bad signature"}"#.into()));
                continue;
            }
            let Ok(ex) = serde_json::from_str::<Exchange>(&body) else {
                let _ = req.respond(reply(400, r#"{"error":"bad body"}"#.into()));
                continue;
            };
            // Whoever called us is a peer too, in case mDNS hasn't found them.
            if ex.device != self.store.device() {
                if let Some(ip) = req.remote_addr().map(|a| a.ip()) {
                    let mut all = self.peers.lock().unwrap();
                    let p = all.entry(ex.device.clone()).or_insert_with(|| Peer {
                        device: ex.device.clone(),
                        name: ex.name.clone(),
                        addr: sock(ip, PORT),
                        last_sync: None,
                        error: None,
                    });
                    p.name = ex.name.clone();
                    p.last_sync = Some(now_ms());
                    p.error = None;
                }
            }
            self.merge(ex.blocks, &ex.device);
            let _ = req.respond(reply(200, self.body()));
        }
    }

    fn mdns(&self) {
        let Ok(daemon) = ServiceDaemon::new() else { return eprintln!("sync: no mDNS") };
        let me = self.store.device();
        let instance = format!("life-{}", &me[..8]);
        let host = format!("{instance}.local.");
        let name = device_name();
        let props = [("device", me.as_str()), ("name", name.as_str())];
        if let Ok(info) = ServiceInfo::new(SERVICE, &instance, &host, "", PORT, &props[..]) {
            let _ = daemon.register(info.enable_addr_auto());
        }
        let Ok(events) = daemon.browse(SERVICE) else { return };
        while let Ok(ev) = events.recv() {
            if let ServiceEvent::ServiceResolved(info) = ev {
                let Some(dev) = info.get_property_val_str("device").map(String::from) else { continue };
                if dev == me {
                    continue;
                }
                // Prefer IPv4.
                let mut addrs: Vec<std::net::IpAddr> = info.get_addresses().iter().copied().collect();
                addrs.sort_by_key(|a| !a.is_ipv4());
                let Some(ip) = addrs.first() else { continue };
                let name = info.get_property_val_str("name").unwrap_or("?").to_string();
                let mut all = self.peers.lock().unwrap();
                let p = all.entry(dev.clone()).or_insert_with(|| Peer { device: dev.clone(), name: name.clone(), addr: String::new(), last_sync: None, error: None });
                p.addr = sock(*ip, info.get_port());
                p.name = name;
                drop(all);
                self.soon();
            }
        }
    }
}

fn sock(ip: std::net::IpAddr, port: u16) -> String {
    match ip {
        std::net::IpAddr::V4(v) => format!("{v}:{port}"),
        std::net::IpAddr::V6(v) => format!("[{v}]:{port}"),
    }
}

use std::io::Read;
