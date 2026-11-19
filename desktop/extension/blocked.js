const q = new URLSearchParams(location.search);
let host = "";
try { host = new URL(q.get("url")).hostname.replace(/^www\./, ""); } catch {}
let until = "";
const u = q.get("until");
if (u && !u.startsWith("9999")) {
  const d = new Date(u);
  const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  until = d.toDateString() === new Date().toDateString() ? ` until ${t}` : ` until ${d.toLocaleDateString(undefined, { weekday: "short" })} ${t}`;
}
const what = q.get("category") ? `${host} is on the ${q.get("category")} list, blocked by` : `${host || "This site"} is blocked by`;
document.getElementById("detail").textContent = `${what} “${q.get("name") || "a block"}”${until}.`;
