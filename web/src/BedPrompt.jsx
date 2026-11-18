import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { todayStr, Mark } from "./ui.jsx";
import { DayReview } from "./Phone.jsx";

function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Sleep mode's first screen (the app opens it when the phone is charged
// upright). "Yes" logs now as the night's bed time and confirms the day's
// "things to avoid" (clean by default — tap any you slipped on). Either choice
// continues to the wall view.
export default function BedPrompt() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [avoids, setAvoids] = useState([]);
  const [clean, setClean] = useState({}); // { [goalId]: boolean }
  const [time] = useState(nowHM);

  useEffect(() => {
    api
      .getDay(todayStr())
      .then((day) => {
        const items = day.goals.filter((g) => g.kind === "avoid");
        setAvoids(items);
        setClean(Object.fromEntries(items.map((g) => [g.id, g.status !== "slipped"])));
      })
      .catch(() => {});
  }, []);

  const toWall = () => navigate("/dashboard");

  const confirm = async () => {
    setSaving(true);
    setError("");
    try {
      const r = await api.report({ goal: "sleep", bedTime: nowHM() });
      await Promise.all(avoids.map((g) => api.setDay(g.id, r.date, { done: !!clean[g.id] })));
      // Mark this on-the-wall session as bedtime, so taking the phone off in
      // the morning counts as getting up. Best-effort.
      await api.presenceBed(r.date).catch(() => {});
      toWall();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const slips = avoids.filter((g) => !clean[g.id]).length;

  return (
    <div className="flex min-h-[100dvh] flex-col justify-between bg-night px-8 pb-10 pt-16 text-fg">
      <div>
        <div className="text-sm text-mute">{time}</div>
        <h1 className="mt-1 font-display text-[52px] leading-[1.02] tracking-tight">
          Going to
          <br />
          bed<span className="italic text-dim">?</span>
        </h1>
        <p className="mt-3 text-dim">Logs {time} as tonight’s bedtime.</p>

        <DayReview className="mt-10" />

        {avoids.length > 0 && (
          <section className="mt-10">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 className="label">Stayed clean today</h2>
              <span className="text-xs text-mute">tap any you slipped on</span>
            </div>
            <ul>
              {avoids.map((g) => {
                const ok = !!clean[g.id];
                return (
                  <li key={g.id} className="border-b border-rule">
                    <button
                      onClick={() => setClean((c) => ({ ...c, [g.id]: !c[g.id] }))}
                      className="flex w-full items-center gap-4 py-3 text-left"
                    >
                      <Mark state={ok ? "clean" : "slipped"} />
                      <span className="flex flex-1 items-center gap-1.5 text-[17px]">
                        {g.name}
                        {g.private && <Lock size={12} className="text-mute" />}
                      </span>
                      <span className={`text-[13px] ${ok ? "text-ok" : "text-slip"}`}>{ok ? "clean" : "slipped"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="mt-10 flex flex-col items-stretch gap-3">
        {error && <p className="text-sm text-slip">{error}</p>}
        <button
          onClick={confirm}
          disabled={saving}
          className="rounded-full bg-fg py-4 text-lg font-medium text-night transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving…" : slips ? `Good night · ${slips} slip${slips > 1 ? "s" : ""}` : "Good night"}
        </button>
        <button onClick={toWall} disabled={saving} className="py-3 text-dim">
          Just charging
        </button>
      </div>
    </div>
  );
}
