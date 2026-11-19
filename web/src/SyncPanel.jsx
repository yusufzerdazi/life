import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Blocks are shared with your other devices on the same wifi (phone, Mac,
// Windows). They find each other by themselves; all they need is the same key.
export default function SyncPanel() {
  const [s, setS] = useState(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => api.getSync().then(setS).catch(() => setS(null)), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);
  if (!s) return null;

  const save = async () => {
    try {
      setS(await api.setSyncKey(key));
      setEditing(false);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <section className="mt-10">
      <h2 className="label mb-1">Devices</h2>
      <p className="mb-3 text-sm text-mute">Blocks are shared with your other devices on the same wifi that have this key.</p>
      <ul className="text-sm">
        <li className="flex items-baseline justify-between gap-3 border-b border-rule py-2">
          <span>
            {s.name} <span className="text-mute">this device</span>
          </span>
        </li>
        {s.peers.map((p) => (
          <li key={p.name} className="flex items-baseline justify-between gap-3 border-b border-rule py-2">
            <span>{p.name}</span>
            {p.error ? (
              <span className="text-xs text-slip">{p.error}</span>
            ) : (
              <span className="text-xs text-mute">{p.lastSync ? `synced ${ago(p.lastSync)}` : "found"}</span>
            )}
          </li>
        ))}
        {s.peers.length === 0 && <li className="border-b border-rule py-2 text-mute">No other devices found yet.</li>}
      </ul>
      <div className="mt-2 text-xs">
        {editing ? (
          <div className="flex flex-wrap items-baseline gap-3">
            <input
              className="min-w-0 flex-1 border-b border-rule bg-transparent py-1 font-mono uppercase outline-none"
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
            <button className="link text-xs" onClick={save}>
              Use key
            </button>
            <button className="link text-xs" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="text-mute">
              Key <span className="select-all font-mono text-fg">{s.key}</span>
            </span>
            <button className="link text-xs" onClick={() => (setKey(""), setEditing(true))}>
              Enter another device’s key
            </button>
          </div>
        )}
        {error && <p className="mt-1 text-slip">{error}</p>}
      </div>
    </section>
  );
}
