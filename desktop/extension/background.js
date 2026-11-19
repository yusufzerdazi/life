// Asks the life desktop app (http://127.0.0.1:47711) about each page you
// open, and swaps blocked ones for the "Not now." page. If the app isn't
// running, nothing is blocked.
const API = "http://127.0.0.1:47711";
const BLOCKED = chrome.runtime.getURL("blocked.html");

async function check(url) {
  if (!/^https?:/.test(url)) return null;
  try {
    const r = await fetch(`${API}/check?url=${encodeURIComponent(url)}`);
    const j = await r.json();
    return j.blocked ? j : null;
  } catch {
    return null;
  }
}

async function enforce(tabId, url) {
  const hit = await check(url);
  if (!hit) return;
  const q = new URLSearchParams({ url, name: hit.name, until: hit.until || "", category: hit.category || "" });
  chrome.tabs.update(tabId, { url: `${BLOCKED}?${q}` });
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) enforce(d.tabId, d.url);
});
// Single-page sites change the URL without a navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId === 0) enforce(d.tabId, d.url);
});

// Blocks start while pages are open: look at every tab each minute.
chrome.alarms.create("recheck", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  for (const t of await chrome.tabs.query({})) if (t.url) enforce(t.id, t.url);
});
