import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { todayStr, shiftDate, formatDuration, minutesBetween, streaks, Mark, useOnSynced } from "./ui.jsx";

// The metric on the right of a goal: run/gym for exercise, the night for sleep.
function Metric({ goal }) {
  if (goal.kind === "exercise") {
    const parts = [goal.ran && "run", goal.workedOut && "gym"].filter(Boolean);
    return <span className="text-dim">{parts.join(" · ") || "—"}</span>;
  }
  if (goal.kind === "sleep") {
    const asleep = goal.asleepMinutes != null ? goal.asleepMinutes : minutesBetween(goal.sleepTime, goal.wakeTime);
    const dur = goal.inBedMinutes ?? asleep;
    const from = goal.bedTime || goal.sleepTime;
    const to = goal.upTime || goal.wakeTime;
    if (dur == null && !from) return <span className="text-mute">—</span>;
    return (
      <span className="text-right leading-tight">
        <span className="text-fg">{dur != null ? formatDuration(dur) : from}</span>
        {from && to && (
          <span className="block text-[0.6em] text-mute">
            {from}–{to}
          </span>
        )}
      </span>
    );
  }
  return null;
}

// Read-only wall view (sleep mode lands here after the bed prompt). Refreshes
// every minute and dims itself overnight.
export default function Dashboard() {
  const [date, setDate] = useState(todayStr());
  const [goals, setGoals] = useState([]);
  const [history, setHistory] = useState(null);
  const [awayMinutes, setAwayMinutes] = useState(null);
  const [now, setNow] = useState(new Date());

  const load = () => {
    const t = todayStr();
    setDate(t);
    Promise.all([api.getDay(t), api.getHistory(30), api.getPresence(t)])
      .then(([day, hist, presence]) => {
        setGoals(day.goals);
        setHistory(hist);
        setAwayMinutes(presence?.totalMinutes ?? null);
      })
      .catch(() => {});
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);
  useOnSynced(load);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const cards = useMemo(() => goals.filter((g) => g.kind !== "avoid"), [goals]);
  const avoids = useMemo(() => goals.filter((g) => g.kind === "avoid"), [goals]);
  const doneCount = cards.filter((g) => g.done).length;
  const streakOf = useMemo(() => streaks(history), [history]);

  // Last 7 days: share of goals done each day (avoid goals excluded).
  const week = useMemo(() => {
    if (!history) return [];
    const avoidIds = new Set(history.goals.filter((g) => g.kind === "avoid").map((g) => g.id));
    const total = history.goals.length - avoidIds.size;
    const byDate = {};
    for (const l of history.logs) if (!avoidIds.has(l.goal_id)) (byDate[l.date] ||= new Set()).add(l.goal_id);
    return Array.from({ length: 7 }, (_, i) => {
      const d = shiftDate(todayStr(), i - 6);
      const done = byDate[d]?.size || 0;
      return { date: d, done, total, frac: total ? done / total : 0 };
    });
  }, [history]);

  const hour = now.getHours();
  const night = hour >= 22 || hour < 6;
  const clock = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const pretty = new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div
      className={`flex h-[100dvh] w-screen flex-col overflow-hidden bg-night px-[6vw] py-[5vh] text-fg transition-opacity duration-1000 ${
        night ? "opacity-50" : ""
      }`}
    >
      <header className="flex items-end justify-between gap-6">
        <div>
          <div className="text-[clamp(0.95rem,2.2vmin,1.4rem)] text-dim">{pretty}</div>
          <div className="font-display text-[clamp(4.5rem,17vmin,11rem)] leading-[0.95] tracking-tight">{clock}</div>
        </div>
        <div className="pb-[1vh] text-right">
          <div className="font-display text-[clamp(2.2rem,7vmin,4.5rem)] leading-none">
            {doneCount}
            <span className="text-mute">/{cards.length}</span>
          </div>
          {awayMinutes > 0 && (
            <div className="mt-1 text-[clamp(0.8rem,1.8vmin,1.1rem)] text-mute">{formatDuration(awayMinutes)} off phone</div>
          )}
        </div>
      </header>

      <ul className="mt-[5vh] grid min-h-0 flex-1 content-start gap-x-[5vw] landscape:grid-cols-2">
        {cards.map((g) => (
          <li key={g.id} className="flex items-center gap-[3vmin] border-b border-rule py-[2.6vh] text-[clamp(1.9rem,7vmin,3.4rem)]">
            <Mark state={g.done} size="size-[0.75em]" />
            <span className={`flex-1 font-display leading-none ${g.done ? "text-dim" : ""}`}>{g.name}</span>
            <span className="text-[0.55em]">
              <Metric goal={g} />
            </span>
            {streakOf(g.id) > 0 && <span className="w-[2.2em] text-right text-[0.45em] text-ember">{streakOf(g.id)}d</span>}
          </li>
        ))}
      </ul>

      {avoids.length > 0 && (
        <div className="mt-[3vh] flex flex-wrap gap-x-[4vmin] gap-y-2 text-[clamp(1rem,2.6vmin,1.6rem)]">
          {avoids.map((g) => (
            <span
              key={g.id}
              className={g.status === "clean" ? "text-ok" : g.status === "slipped" ? "text-slip" : "text-mute"}
              title={g.private ? "private" : g.name}
            >
              {g.private ? g.name.charAt(0).toUpperCase() : g.name}
              {streakOf(g.id) > 0 && <span className="ml-1.5 text-[0.75em] text-mute">{streakOf(g.id)}d</span>}
            </span>
          ))}
        </div>
      )}

      {week.length > 0 && (
        <div className="mt-[4vh] flex justify-between">
          {week.map((d) => {
            const wd = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
            const isToday = d.date === date;
            return (
              <div key={d.date} title={`${d.date}: ${d.done}/${d.total}`} className="flex flex-col items-center gap-[1.2vmin]">
                <span className="relative grid size-[clamp(1.6rem,5vmin,3rem)] place-items-center overflow-hidden rounded-full border border-rule">
                  {/* fills from the bottom with the day's completion */}
                  <span className="absolute inset-x-0 bottom-0 bg-ok" style={{ height: `${d.frac * 100}%` }} />
                </span>
                <span className={`text-[clamp(0.75rem,1.8vmin,1.05rem)] ${isToday ? "text-fg" : "text-mute"}`}>{wd}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
