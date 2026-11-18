import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Search } from "lucide-react";
import { api } from "./api.js";
import { useOnSynced } from "./ui.jsx";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"]; // ISO 1 (Mon) … 7 (Sun)
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

function hm(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// "Wed 05:00"
function dayHm(iso) {
  return `${new Date(iso).toLocaleDateString(undefined, { weekday: "short" })} ${hm(iso)}`;
}

function dayText(days) {
  const s = [...days].sort().join("");
  if (s === "1234567") return "every day";
  if (s === "12345") return "weekdays";
  if (s === "67") return "weekends";
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((d) => names[d - 1]).join(", ");
}

// Timed app/site bans, enforced by the Android app's LifeService. Only shown
// inside the app (the endpoints don't exist on the web server). A block can't
// be removed while it's on — that's the point.
export default function Blocks() {
  const [blocks, setBlocks] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => api.getBlocks().then((r) => setBlocks(r.blocks)).catch(() => setBlocks(null)), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60000); // keep "on until" current
    return () => clearInterval(id);
  }, [load]);
  useOnSynced(load);

  if (blocks === null) return null;

  const remove = async (b) => {
    if (!window.confirm(`Remove the "${b.name}" block?`)) return;
    try {
      await api.deleteBlock(b.id);
      setError("");
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <section className="mt-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="label">Blocks</h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className="link">
            Add
          </button>
        )}
      </div>
      {error && <p className="py-2 text-sm text-slip">{error}</p>}
      <ul>
        {blocks.map((b) => (
          <li key={b.id} className="flex items-start gap-4 border-b border-rule py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[17px]">{b.name}</span>
                {b.always ? (
                  <span className="shrink-0 text-sm text-ember">always on</span>
                ) : b.oneOff ? (
                  <span className="shrink-0 text-sm text-ember">until {dayHm(b.activeUntil)}</span>
                ) : b.activeUntil ? (
                  <span className="shrink-0 text-sm text-ember">on until {hm(b.activeUntil)}</span>
                ) : (
                  <span className="shrink-0 text-sm text-dim">
                    {b.start}–{b.end}
                  </span>
                )}
              </div>
              <div className={`mt-0.5 text-[13px] text-mute ${b.note ? "" : "truncate"}`}>
                {b.note || [...b.apps.map((a) => a.label), ...b.sites].join(", ") || "nothing selected"}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[13px] text-mute">
                <span>
                  {b.oneOff
                    ? "tomorrow, from the bedtime review"
                    : b.always
                      ? "all day, every day"
                      : `${dayText(b.days)}${b.activeUntil ? ` · ${b.start}–${b.end}` : ""}`}
                  {b.builtIn && " · built in"}
                </span>
                {b.builtIn || b.activeUntil ? (
                  <Lock size={12} className="text-mute" />
                ) : (
                  <button onClick={() => remove(b)} className="text-slip/80 hover:text-slip">
                    Remove
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
        {blocks.length === 0 && !adding && (
          <li className="py-3 text-sm text-mute">Nothing blocked. Add apps or sites to lock during set hours.</li>
        )}
      </ul>
      {adding && (
        <AddBlock
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function AddBlock({ onCancel, onSaved }) {
  const [name, setName] = useState("");
  const [apps, setApps] = useState([]); // [{ pkg, label }]
  const [sites, setSites] = useState("");
  const [days, setDays] = useState(ALL_DAYS);
  const [start, setStart] = useState("22:00");
  const [end, setEnd] = useState("07:00");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");

  const toggleDay = (d) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort()));

  const save = async (e) => {
    e.preventDefault();
    const siteList = sites
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api.addBlock({
        name: name.trim() || apps[0]?.label || siteList[0] || "Block",
        apps: apps.map((a) => a.pkg),
        sites: siteList,
        days,
        start,
        end,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form onSubmit={save} className="mt-3 flex flex-col gap-5 rounded-xl bg-raise p-5">
      <input placeholder="Name (e.g. Evenings)" value={name} onChange={(e) => setName(e.target.value)} className="field text-[17px]" />

      <div>
        <div className="label mb-2">Apps</div>
        <div className="flex flex-wrap gap-1.5">
          {apps.map((a) => (
            <button
              type="button"
              key={a.pkg}
              onClick={() => setApps((xs) => xs.filter((x) => x.pkg !== a.pkg))}
              className="rounded-full border border-rule px-3 py-1 text-[13px] text-fg"
            >
              {a.label} ×
            </button>
          ))}
          <button type="button" onClick={() => setPicking((p) => !p)} className="rounded-full border border-dashed border-mute px-3 py-1 text-[13px] text-dim">
            {picking ? "Done" : "Choose apps"}
          </button>
        </div>
        {picking && <AppPicker selected={apps} onChange={setApps} />}
      </div>

      <label className="block">
        <div className="label mb-1">Websites</div>
        <input placeholder="reddit.com, youtube.com" value={sites} onChange={(e) => setSites(e.target.value)} autoCapitalize="none" className="field w-full text-[15px]" />
      </label>

      <div>
        <div className="label mb-2">Days</div>
        <div className="flex gap-1.5">
          {DAYS.map((l, i) => {
            const on = days.includes(i + 1);
            return (
              <button
                type="button"
                key={i}
                onClick={() => toggleDay(i + 1)}
                className={`grid size-9 place-items-center rounded-full text-[13px] transition-colors ${on ? "bg-fg text-night" : "border border-rule text-mute"}`}
              >
                {l}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex min-w-0 flex-1 flex-col text-xs text-mute">
          From
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required className="field w-full min-w-0 text-[17px]" />
        </label>
        <label className="flex min-w-0 flex-1 flex-col text-xs text-mute">
          Until
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required className="field w-full min-w-0 text-[17px]" />
        </label>
      </div>
      <p className="-mt-2 text-xs text-mute">
        Runs past midnight if “until” is earlier than “from”. While a block is on, it can’t be removed.
      </p>

      {error && <p className="text-sm text-slip">{error}</p>}

      <div className="flex items-center justify-end gap-5">
        <button type="button" onClick={onCancel} className="text-sm text-dim">
          Cancel
        </button>
        <button type="submit" disabled={!days.length || (!apps.length && !sites.trim())} className="rounded-full bg-fg px-5 py-2 text-sm font-medium text-night disabled:opacity-30">
          Save block
        </button>
      </div>
    </form>
  );
}

function AppPicker({ selected, onChange }) {
  const [apps, setApps] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.getApps().then((r) => setApps(r.apps)).catch(() => setApps([]));
  }, []);

  const shown = useMemo(
    () => (apps || []).filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase())),
    [apps, q]
  );
  const has = (pkg) => selected.some((s) => s.pkg === pkg);
  const toggle = (a) => onChange(has(a.pkg) ? selected.filter((s) => s.pkg !== a.pkg) : [...selected, a]);

  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 border-b border-rule pb-1.5">
        <Search size={14} className="text-mute" />
        <input placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} className="w-full border-0 bg-transparent p-0 text-[15px] placeholder:text-mute focus:ring-0" />
      </label>
      <ul className="mt-1 max-h-64 overflow-y-auto">
        {apps === null && <li className="py-2 text-sm text-mute">Loading…</li>}
        {shown.map((a) => (
          <li key={a.pkg}>
            <button type="button" onClick={() => toggle(a)} className="flex w-full items-center justify-between py-2 text-left text-[15px]">
              <span className={has(a.pkg) ? "text-fg" : "text-dim"}>{a.label}</span>
              <span className={`size-4 rounded-full border-[1.5px] ${has(a.pkg) ? "border-ok bg-ok" : "border-mute/60"}`} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
