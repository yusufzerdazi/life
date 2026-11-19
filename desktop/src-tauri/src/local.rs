// http://127.0.0.1:47711, for the browser extension: GET /check?url=… →
// {"blocked": bool, "name", "until", "category"}. Read-only and local-only;
// it sends no CORS headers, so web pages can't read it (the extension's
// host permission lets it).
use crate::{policy, App};
use serde_json::json;
use std::sync::Arc;

pub const PORT: u16 = 47711;

pub fn start(app: Arc<App>) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => return eprintln!("local: can't listen on {PORT}: {e}"),
        };
        for req in server.incoming_requests() {
            let url = req.url().to_string();
            let body = if let Some(q) = url.strip_prefix("/check?") {
                let target = q
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("url="))
                    .map(decode)
                    .unwrap_or_default();
                let now = chrono::Local::now().naive_local();
                match policy::for_url(&app.store, &target, now) {
                    Some(h) => json!({
                        "blocked": true,
                        "name": h.name,
                        "until": h.until.format("%Y-%m-%dT%H:%M:%S").to_string(),
                        "category": h.category,
                    }),
                    None => json!({ "blocked": false }),
                }
            } else if url == "/ping" {
                json!({ "ok": true })
            } else {
                json!({ "error": "not found" })
            };
            let _ = req.respond(
                tiny_http::Response::from_string(body.to_string())
                    .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap()),
            );
        }
    });
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
