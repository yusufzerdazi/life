const API_KEY = import.meta.env.VITE_API_KEY || "dev-secret-change-me";

// Inside the Android app the API runs on-device: requests go through the
// LifeNative bridge instead of the network, and come back via __lifeResolve.
const native = typeof window !== "undefined" ? window.LifeNative : null;
const pending = new Map();
let seq = 0;
if (native) {
  window.__lifeResolve = (id, status, text) => {
    const p = pending.get(id);
    pending.delete(id);
    if (p) p({ status, text });
  };
}

async function nativeReq(method, path, body) {
  const id = ++seq;
  const { status, text } = await new Promise((resolve) => {
    pending.set(id, resolve);
    native.request(id, method, `/api${path}`, body ? JSON.stringify(body) : "");
  });
  const data = text ? JSON.parse(text) : null;
  if (status >= 400) throw new Error(data?.error || `Request failed (${status})`);
  return status === 204 ? null : data;
}

// In the desktop app (Tauri), the Rust core answers the same routes.
const tauri = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;

async function tauriReq(method, path, body) {
  const { status, text } = await tauri.invoke("api", { method, path: `/api${path}`, body: body ? JSON.stringify(body) : "" });
  const data = text ? JSON.parse(text) : null;
  if (status >= 400) throw new Error(data?.error || `Request failed (${status})`);
  return status === 204 ? null : data;
}

async function req(method, path, body) {
  if (native) return nativeReq(method, path, body);
  if (tauri) return tauriReq(method, path, body);
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "x-api-key": API_KEY }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  getDay: (date) => req("GET", `/day?date=${date}`),
  // fields: { done?, bedTime?, upTime?, sleepTime?, wakeTime?, asleepMinutes? }
  setDay: (goalId, date, fields) => req("PUT", "/day", { goalId, date, ...fields }),
  // report by goal name (e.g. { goal: "sleep", bedTime: "23:10" }); applies date attribution
  report: (body) => req("POST", "/report", body),
  getGoals: () => req("GET", "/goals"),
  addGoal: (name, kind = "check", isPrivate = false) => req("POST", "/goals", { name, kind, private: isPrivate }),
  renameGoal: (id, name) => req("PATCH", `/goals/${id}`, { name }),
  updateGoal: (id, fields) => req("PATCH", `/goals/${id}`, fields),
  deleteGoal: (id) => req("DELETE", `/goals/${id}`),
  getHistory: (days = 30) => req("GET", `/history?days=${days}`),
  // presence = phone-on-wall sessions. start/end are driven by Tasker on the
  // phone (physical connect/disconnect); the web only marks a bedtime on the
  // current session (from /bed) and reads the daily total.
  presenceBed: (date) => req("POST", "/presence/bed", { date }),
  getPresence: (date) => req("GET", `/presence?date=${date}`),
  integrationsStatus: () => req("GET", "/integrations/status"),
  syncIntegration: (name) => req("POST", `/integrations/${name}/sync`),
  // Opens Google sign-in in the browser — Android app only.
  googleLogin: () => req("POST", "/integrations/google/login"),
  // Timed app/site blocks — Android app only.
  getBlocks: () => req("GET", "/blocks"),
  addBlock: (block) => req("POST", "/blocks", block),
  deleteBlock: (id) => req("DELETE", `/blocks/${id}`),
  // Block one app:<pkg> / site:<domain> until the end of tomorrow.
  blockTomorrow: (key, label) => req("POST", "/blocks/tomorrow", { key, label }),
  getApps: () => req("GET", "/apps"),
  // Bedtime lights (Hue + Govee) — Android app only.
  getLights: () => req("GET", "/lights"),
  testLights: () => req("POST", "/lights/test"),
  pairHue: () => req("POST", "/lights/hue/pair"),
  forgetHue: () => req("DELETE", "/lights/hue"),
  scanGovee: () => req("POST", "/lights/govee/scan"),
  addGovee: (address) => req("POST", "/lights/govee", { address }),
  removeGovee: (address) => req("DELETE", `/lights/govee/${encodeURIComponent(address)}`),
  // Devices sharing blocks — Android and desktop apps only.
  getSync: () => req("GET", "/sync"),
  setSyncKey: (key) => req("POST", "/sync/key", { key }),
  // Screen time — Android app only.
  getUsage: () => req("GET", "/usage"),
};
