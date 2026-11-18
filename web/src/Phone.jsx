import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { useOnSynced } from "./ui.jsx";

const native = typeof window !== "undefined" && !!window.LifeNative;

function hm(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Today's screen time against the daily limit (Android app only).
export function ScreenTime() {
  const [u, setU] = useState(null);
  const load = useCallback(() => api.getUsage().then(setU).catch(() => {}), []);
  useEffect(() => {
    if (!native) return;
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);
  useOnSynced(load);
  if (!u) return null;

  const left = u.limitMinutes - u.minutes;
  const pct = Math.min(100, (u.minutes / u.limitMinutes) * 100);
  const tone = left <= 0 ? "bg-slip" : left <= 60 ? "bg-ember" : "bg-fg";
  const top = [...u.apps, ...u.sites].sort((a, b) => b.minutes - a.minutes).slice(0, 4);

  return (
    <section className="mt-10">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="label">Screen time</h2>
        <span className={`text-sm ${left <= 0 ? "text-slip" : left <= 60 ? "text-ember" : "text-dim"}`}>
          {left <= 0 ? "used up until 05:00" : `${hm(left)} left`}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[34px] leading-none">{hm(u.minutes)}</span>
        <span className="text-sm text-mute">of {u.limitMinutes / 60}h</span>
      </div>
      <div className="mt-3 h-[3px] rounded-full bg-rule">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {top.length > 0 && (
        <ul className="mt-3">
          {top.map((x) => (
            <li key={x.key} className="flex justify-between py-1 text-[14px]">
              <span className="truncate text-dim">{x.label}</span>
              <span className="shrink-0 pl-4 tabular-nums text-mute">{hm(x.minutes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The bedtime review: today's screen time, where it went, and a way to block
// any of it for tomorrow (Android app only).
export function DayReview({ className = "" }) {
  const [u, setU] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api.getUsage().then(setU).catch(() => {}), []);
  useEffect(() => {
    if (native) load();
  }, [load]);
  if (!u) return null;

  const top = [...u.apps, ...u.sites].sort((a, b) => b.minutes - a.minutes).slice(0, 6);
  const block = async (x) => {
    try {
      await api.blockTomorrow(x.key, x.label);
      setError("");
      load();
    } catch (e) {
      setError(e.message);
    }
  };
  const extras = [
    u.blocked ? `blocked ${u.blocked} time${u.blocked > 1 ? "s" : ""}` : null,
    u.breaks ? `${u.breaks} break prompt${u.breaks > 1 ? "s" : ""}` : null,
  ].filter(Boolean);

  return (
    <section className={className}>
      <h2 className="label mb-2">Today on the phone</h2>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[34px] leading-none">{hm(u.minutes)}</span>
        <span className="text-sm text-mute">of {u.limitMinutes / 60}h</span>
      </div>
      {extras.length > 0 && <p className="mt-1 text-sm text-mute">{extras.join(" · ")}</p>}
      {top.length > 0 && (
        <>
          <div className="mt-5 flex items-baseline justify-between">
            <h3 className="label">Most time</h3>
            <span className="text-xs text-mute">block any for tomorrow</span>
          </div>
          <ul>
            {top.map((x) => (
              <li key={x.key} className="flex items-center gap-3 border-b border-rule py-2.5 text-[15px]">
                <span className="min-w-0 flex-1 truncate">{x.label}</span>
                <span className="shrink-0 tabular-nums text-mute">{hm(x.minutes)}</span>
                {x.blockedTomorrow ? (
                  <span className="w-[112px] shrink-0 text-right text-[13px] text-ember">blocked tomorrow</span>
                ) : (
                  <button
                    onClick={() => block(x)}
                    className="w-[112px] shrink-0 rounded-full border border-rule py-1 text-[13px] text-dim active:bg-raise"
                  >
                    Block tomorrow
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-2 text-sm text-slip">{error}</p>}
    </section>
  );
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Footer sync status: last sync, a "Sync now" button, and Google sign-in when
// it's needed (sign-in itself only works inside the Android app).
export function SyncStatus({ onSynced }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [waiting, setWaiting] = useState(false);

  const load = useCallback(() => api.integrationsStatus().then((s) => (setStatus(s), s)).catch(() => null), []);
  useEffect(() => {
    load();
  }, [load]);
  useOnSynced(load);

  // After opening Google sign-in: watch for it to finish (up to 5 minutes).
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const id = setInterval(async () => {
      const s = await load();
      if (s?.google?.connected || Date.now() - started > 5 * 60_000 || (s && !s.google?.signingIn)) {
        setWaiting(false);
        if (s?.google?.connected) {
          setNote("Google connected");
          onSynced?.();
        }
      }
    }, 2000);
    return () => clearInterval(id);
  }, [waiting, load, onSynced]);

  const sync = async () => {
    setBusy(true);
    setNote("");
    const results = await Promise.all(
      ["google", "wakingup"].map((n) => api.syncIntegration(n).then(() => null).catch((e) => `${n === "google" ? "Google" : "Meditation"}: ${e.message}`))
    );
    setNote(results.filter(Boolean).join(" · "));
    await load();
    onSynced?.();
    setBusy(false);
  };

  const signIn = async () => {
    try {
      await api.googleLogin();
      setWaiting(true);
    } catch (e) {
      setNote(e.message);
    }
  };

  if (!status) return null;
  const g = status.google || {};
  const last = [g.lastSync, status.wakingup?.lastSync].filter(Boolean).sort().pop();
  const needsGoogle = g.configured && !g.connected;

  return (
    <div className="flex flex-col items-end gap-1 text-right text-xs text-mute">
      <div className="flex items-baseline gap-3">
        {last && <span>synced {clock(last)}</span>}
        <button onClick={sync} disabled={busy} className="link text-xs disabled:opacity-50">
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {needsGoogle &&
        (native ? (
          <button onClick={signIn} disabled={waiting} className="text-ember disabled:opacity-60">
            {waiting ? "Waiting for Google…" : `${g.error || "Google not connected"} · Sign in`}
          </button>
        ) : (
          <span className="text-ember">{g.error || "Google not connected"}, sign in from the phone app</span>
        ))}
      {note && <span className={/:/.test(note) ? "text-slip" : "text-ok"}>{note}</span>}
    </div>
  );
}

// Bedtime lights: Hue + Govee flash red until the phone is in sleep mode
// (Android app only).
export function Lights() {
  const [s, setS] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.getLights().then((r) => (setS(r), r)).catch(() => null), []);
  useEffect(() => {
    if (native) load();
  }, [load]);

  // While a scan runs (or the permission prompt is up), keep refreshing.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching) return;
    const started = Date.now();
    const id = setInterval(async () => {
      const r = await load();
      if (Date.now() - started > 30_000 || (r && !r.govee.scanning && r.govee.permission && Date.now() - started > 3000)) setWatching(false);
    }, 1500);
    return () => clearInterval(id);
  }, [watching, load]);

  if (!native || !s) return null;

  const run = async (fn, done) => {
    setBusy(true);
    setNote("");
    try {
      const r = await fn();
      if (r?.error) setNote(r.error);
      else if (done) setNote(done);
    } catch (e) {
      setNote(e.message);
    }
    await load();
    setBusy(false);
  };
  const { hue, govee } = s;

  return (
    <section className="mt-10">
      <h2 className="label mb-1">Bedtime lights</h2>
      <p className="mb-3 text-sm text-mute">
        {s.from}–{s.until}, the lights flash red until the phone is on the wall.
        {s.alerting && <span className="text-ember"> Flashing now.</span>}
      </p>
      <ul className="text-sm">
        <li className="flex items-baseline justify-between gap-3 border-b border-rule py-2">
          <span>
            Hue <span className="text-mute">{hue.paired ? `bridge ${hue.ip}` : "not paired"}</span>
            {hue.error && <span className="text-slip"> · {hue.error}</span>}
          </span>
          {hue.paired ? (
            <button className="link text-xs" disabled={busy} onClick={() => run(api.forgetHue)}>
              Forget
            </button>
          ) : (
            <button className="link text-xs" disabled={busy} onClick={() => run(api.pairHue, "Hue paired")}>
              Pair
            </button>
          )}
        </li>
        {govee.lights.map((l) => (
          <li key={l.address} className="flex items-baseline justify-between gap-3 border-b border-rule py-2">
            <span>
              Govee <span className="text-mute">{l.name}</span>
              {l.connected && <span className="text-ok"> · connected</span>}
              {l.error && <span className="text-slip"> · {l.error}</span>}
            </span>
            <button className="link text-xs" disabled={busy} onClick={() => run(() => api.removeGovee(l.address))}>
              Forget
            </button>
          </li>
        ))}
        <li className="border-b border-rule py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-mute">{govee.lights.length ? "Another Govee light" : "Govee: none yet"}</span>
            <button
              className="link text-xs"
              disabled={busy || govee.scanning}
              onClick={() => run(api.scanGovee).then(() => setWatching(true))}
            >
              {govee.scanning ? "Looking…" : "Find lights"}
            </button>
          </div>
          {govee.found.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-mute">
              Add:
              {govee.found.map((d) => (
                <button key={d.address} className="link text-xs" onClick={() => run(() => api.addGovee(d.address))}>
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </li>
      </ul>
      <div className="mt-2 flex items-baseline justify-between text-xs">
        <button
          className="link text-xs"
          disabled={busy || (!hue.paired && !govee.lights.length)}
          onClick={() => run(api.testLights, "Flashing for 20 seconds")}
        >
          Test
        </button>
        {note && <span className={/paired|Flashing/.test(note) ? "text-ok" : "text-slip"}>{note}</span>}
      </div>
    </section>
  );
}
