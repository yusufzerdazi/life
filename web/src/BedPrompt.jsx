import { useState } from "react";
import { Moon, BatteryCharging, X } from "lucide-react";
import { api } from "./api.js";
import { navigate } from "./nav.js";
import { useFullscreen, FullscreenButton } from "./fullscreen.jsx";

function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Shown when the phone goes on charge (open this URL from the charging automation).
// "Yes" logs the current time as the night's bed time; either choice returns to
// the dashboard.
export default function BedPrompt() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { fs, toggle: toggleFs } = useFullscreen();

  const backToDashboard = () => navigate("/dashboard");

  const confirmBedtime = async () => {
    setSaving(true);
    setError("");
    try {
      await api.report({ goal: "sleep", bedTime: nowHM() });
      backToDashboard();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="relative flex h-[100dvh] w-screen flex-col items-center justify-center gap-8 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6 text-center text-slate-100">
      <FullscreenButton fs={fs} toggle={toggleFs} className="absolute right-4 top-4" />
      <div className="grid size-24 place-items-center rounded-3xl bg-indigo-500/15 text-indigo-300">
        <BatteryCharging className="size-12" />
      </div>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Charging for the night?</h1>
        <p className="mt-2 text-slate-400">Tap “yes” to log {nowHM()} as your bedtime.</p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</div>
      )}

      <div className="flex w-full max-w-sm flex-col gap-3">
        <button
          onClick={confirmBedtime}
          disabled={saving}
          className="flex items-center justify-center gap-3 rounded-2xl bg-emerald-400 px-6 py-5 text-xl font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:opacity-60"
        >
          <Moon className="size-6" /> {saving ? "Saving…" : "Yes — going to bed"}
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
