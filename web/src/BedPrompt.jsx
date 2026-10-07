import { useEffect, useState } from "react";
import { Moon, BatteryCharging, X, Check, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { useFullscreen, FullscreenButton } from "./fullscreen.jsx";

function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

// Shown when the phone goes on charge (open this URL from the charging automation).
// "Yes" logs the current time as the night's bed time and confirms the day's
// "things to avoid" (clean by default — tap any you slipped on first). Either
// choice returns to the dashboard.
export default function BedPrompt() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { fs, toggle: toggleFs } = useFullscreen();

  // Avoid checklist: each item starts "clean" (true); tap to mark a slip (false).
  const [avoids, setAvoids] = useState([]);
  const [clean, setClean] = useState({}); // { [goalId]: boolean }

  useEffect(() => {
    api
      .getDay(todayStr())
      .then((day) => {
        const items = day.goals.filter((g) => g.kind === "avoid");
        setAvoids(items);
        // Default to clean, except items already recorded as a slip today.
        setClean(Object.fromEntries(items.map((g) => [g.id, g.status !== "slipped"])));
      })
      .catch(() => {});
  }, []);

  const toggle = (id) => setClean((c) => ({ ...c, [id]: !c[id] }));

  const backToDashboard = () => navigate("/dashboard");

  const confirmBedtime = async () => {
    setSaving(true);
    setError("");
    try {
      const r = await api.report({ goal: "sleep", bedTime: nowHM() });
      // Stamp each avoid item for the night's day (matches the bedtime's date).
      await Promise.all(avoids.map((g) => api.setDay(g.id, r.date, { done: !!clean[g.id] })));
      // Mark this on-the-wall session as a bedtime session, so removing the
      // phone later counts as that night's wake (up) time. Best-effort.
      await api.presenceBed(r.date).catch(() => {});
      backToDashboard();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const slips = avoids.filter((g) => !clean[g.id]).length;

  return (
    <div className="relative flex min-h-[100dvh] w-screen flex-col items-center justify-center gap-8 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6 text-center text-slate-100">
      <FullscreenButton fs={fs} toggle={toggleFs} className="absolute right-4 top-4" />
      <div className="grid size-24 place-items-center rounded-3xl bg-indigo-500/15 text-indigo-300">
        <BatteryCharging className="size-12" />
      </div>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Charging for the night?</h1>
        <p className="mt-2 text-slate-400">Tap “yes” to log {nowHM()} as your bedtime.</p>
      </div>

      {avoids.length > 0 && (
        <div className="w-full max-w-sm text-left">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-400">
            <ShieldCheck className="size-4" /> Stayed clean today?
            <span className="ml-auto text-xs font-normal text-slate-500">tap any you slipped on</span>
          </div>
          <div className="flex flex-col gap-2">
            {avoids.map((g) => {
              const ok = !!clean[g.id];
              return (
                <button
                  key={g.id}
                  onClick={() => toggle(g.id)}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                    ok ? "border-emerald-500/50 bg-emerald-500/10" : "border-red-500/50 bg-red-500/10"
                  }`}
                >
                  <span
                    className={`grid size-6 shrink-0 place-items-center rounded-md border-2 ${
                      ok ? "border-emerald-400 bg-emerald-400 text-slate-900" : "border-red-400 text-red-400"
                    }`}
                  >
                    {ok ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}
                  </span>
                  <span className="flex-1 font-medium">{g.name}</span>
                  <span className={`text-xs font-semibold ${ok ? "text-emerald-400" : "text-red-400"}`}>
                    {ok ? "clean" : "slipped"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</div>
      )}

      <div className="flex w-full max-w-sm flex-col gap-3">
        <button
          onClick={confirmBedtime}
          disabled={saving}
          className="flex items-center justify-center gap-3 rounded-2xl bg-emerald-400 px-6 py-5 text-xl font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:opacity-60"
        >
          <Moon className="size-6" />{" "}
          {saving ? "Saving…" : avoids.length > 0 ? `Yes — bed${slips ? ` (${slips} slip${slips > 1 ? "s" : ""})` : ""}` : "Yes — going to bed"}
        </button>
        <button
          onClick={backToDashboard}
          disabled={saving}
          className="flex items-center justify-center gap-3 rounded-2xl border border-slate-600 px-6 py-5 text-xl font-medium text-slate-300 transition hover:bg-slate-800 disabled:opacity-60"
        >
          <X className="size-6" /> No — just charging
        </button>
      </div>
    </div>
  );
}
