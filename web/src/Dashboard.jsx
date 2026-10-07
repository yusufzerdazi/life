import { useEffect, useMemo, useState } from "react";
import { Footprints, Dumbbell, Moon, Brain, Flower2, Check, Flame, Target, SmartphoneNfc, Lock } from "lucide-react";
import { api } from "./api.js";
import { useFullscreen, FullscreenButton } from "./fullscreen.jsx";

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}
function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}
function formatDuration(min) {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
function minutesBetween(a, b) {
  if (!a || !b) return null;
  const m = (t) => {
    const [h, mm] = t.split(":").map(Number);
    return h * 60 + mm;
  };
  let d = m(b) - m(a);
  if (d <= 0) d += 1440;
  return d;
}

// cols × rows for the current viewport: portrait → single column; else near-square.
function bestGrid(n, w, h) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (h > w) return { cols: 1, rows: n };
  let best = { cols: 1, rows: n, cost: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = w / cols / (h / rows);
    const cost = Math.abs(Math.log(cellAspect)) + 0.35 * (cols * rows - n);
    if (cost < best.cost) best = { cols, rows, cost };
  }
  return best;
}

// Per-goal accent (overridden by emerald when the goal is done).
function accentOf(goal) {
  const n = goal.name.toLowerCase();
  if (n.includes("run")) return { fg: "text-orange-300", bg: "bg-orange-500/15" };
  if (n.includes("yoga")) return { fg: "text-fuchsia-300", bg: "bg-fuchsia-500/15" };
  if (n.includes("medit")) return { fg: "text-sky-300", bg: "bg-sky-500/15" };
  if (goal.kind === "sleep") return { fg: "text-indigo-300", bg: "bg-indigo-500/15" };
  if (goal.kind === "exercise") return { fg: "text-orange-300", bg: "bg-orange-500/15" };
  return { fg: "text-emerald-300", bg: "bg-emerald-500/15" };
}

function GoalIcon({ goal, className }) {
  const n = goal.name.toLowerCase();
  let Icon = Target;
  if (n.includes("run")) Icon = Footprints;
  else if (n.includes("yoga")) Icon = Flower2;
  else if (n.includes("medit")) Icon = Brain;
  else if (goal.kind === "sleep" || n.includes("sleep")) Icon = Moon;
  else if (goal.kind === "exercise" || n.includes("workout") || n.includes("gym")) Icon = Dumbbell;
  return <Icon className={className} />;
}

function Ring({ done, total, pct }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid shrink-0 place-items-center">
      <svg viewBox="0 0 130 130" className="w-[clamp(96px,10vw,150px)] -rotate-90">
        <circle cx="65" cy="65" r={r} strokeWidth="11" className="fill-none stroke-slate-700/50" />
        <circle
          cx="65"
          cy="65"
          r={r}
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          className="fill-none stroke-emerald-400 drop-shadow-[0_0_6px_rgba(74,222,128,0.5)] transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute text-center leading-none">
        <div className="text-[clamp(1.6rem,3vw,2.6rem)] font-bold">{done}</div>
        <div className="text-[clamp(0.8rem,1.2vw,0.95rem)] font-semibold text-slate-400">of {total}</div>
      </div>
    </div>
  );
}

// The centre metric: a count for exercise, the night's duration for sleep, and
// nothing for plain check goals (the card colour carries the status).
function CardMetric({ goal, done }) {
  const sub = done ? "text-slate-700" : "text-slate-400";

  if (goal.kind === "exercise") {
    const n = (goal.ran ? 1 : 0) + (goal.workedOut ? 1 : 0);
    return <span className="text-5xl font-bold tabular-nums sm:text-6xl lg:text-8xl">{n}/2</span>;
  }

  if (goal.kind === "sleep") {
    const inBed = goal.inBedMinutes;
    const asleep = goal.asleepMinutes != null ? goal.asleepMinutes : minutesBetween(goal.sleepTime, goal.wakeTime);
    const dur = inBed != null ? inBed : asleep;
    const window =
      goal.bedTime && goal.upTime
        ? `${goal.bedTime}–${goal.upTime}`
        : goal.sleepTime && goal.wakeTime
        ? `${goal.sleepTime}–${goal.wakeTime}`
        : null;
    if (dur == null && !window) return <span className={`text-2xl font-medium sm:text-3xl ${sub}`}>—</span>;
    return (
      <div className="flex flex-col items-center gap-2">
        <span className="text-4xl font-bold leading-none tabular-nums sm:text-5xl lg:text-7xl">
          {dur != null ? formatDuration(dur) : "—"}
        </span>
        {window && <span className={`text-xl font-medium tabular-nums sm:text-2xl lg:text-3xl ${sub}`}>{window}</span>}
      </div>
    );
  }

  return null; // check goal — colour says it all
}

function DashCard({ goal, streak }) {
  const a = accentOf(goal);
  const done = goal.done;
  return (
    <div
      className={
        "flex h-full items-center justify-between gap-6 rounded-3xl border-4 p-6 transition-colors sm:p-8 lg:p-10 " +
        (done
          ? "border-emerald-300 bg-emerald-400 text-slate-900 shadow-[0_0_70px_-8px_rgba(74,222,128,0.75)]"
          : "border-slate-700 bg-slate-800/70 text-slate-100")
      }
    >
      {/* icon — left */}
      <span
        className={
          "grid size-16 shrink-0 place-items-center rounded-2xl sm:size-24 lg:size-32 " +
          (done ? "bg-slate-900/15" : a.bg)
        }
      >
        <GoalIcon goal={goal} className={"size-3/5 " + (done ? "text-slate-900" : a.fg)} />
      </span>

      {/* metric — centre */}
      <div className="flex min-w-0 flex-1 items-center justify-center text-center">
        <CardMetric goal={goal} done={done} />
      </div>

      {/* streak flame — right */}
      <span className="flex w-16 shrink-0 items-center justify-end gap-1.5 text-3xl font-bold tabular-nums sm:w-20 lg:w-24 lg:text-4xl">
        {streak > 0 && (
          <>
            <Flame className={"size-[1.1em] " + (done ? "text-orange-600" : "text-orange-400")} />
            <span className={done ? "text-slate-900" : "text-slate-300"}>{streak}</span>
          </>
        )}
      </span>
    </div>
  );
}

// A "thing to avoid" chip: clean (emerald) / slipped (red) / pending (slate),
// with a days-clean streak. Personal items are censored to their first letter.
function AvoidChip({ goal, streak }) {
  const label = goal.private ? goal.name.charAt(0).toUpperCase() : goal.name;
  const tone =
    goal.status === "clean"
      ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-300"
      : goal.status === "slipped"
      ? "border-red-500/60 bg-red-500/15 text-red-300"
      : "border-slate-700 bg-slate-800/60 text-slate-400";
  return (
    <div
      title={goal.private ? "private" : goal.name}
      className={
        "flex items-center gap-2 rounded-2xl border px-[clamp(0.7rem,1.5vw,1.4rem)] py-[clamp(0.4rem,1vh,0.9rem)] " + tone
      }
    >
      {goal.private && <Lock className="size-[clamp(0.85rem,1.3vw,1.1rem)] opacity-70" />}
      <span className="text-[clamp(1rem,1.9vw,1.6rem)] font-semibold leading-none">{label}</span>
      {streak > 0 && (
        <span className="inline-flex items-center gap-1 text-[clamp(0.85rem,1.5vw,1.3rem)] font-bold tabular-nums">
          <Flame className="size-[1.1em] text-orange-400" /> {streak}
        </span>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [date, setDate] = useState(todayStr());
  const [goals, setGoals] = useState([]);
  const [history, setHistory] = useState(null);
  const [awayMinutes, setAwayMinutes] = useState(null);
  const [clock, setClock] = useState("");
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const { fs, toggle: toggleFs } = useFullscreen();

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
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
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // "Things to avoid" are shown separately and never count toward a perfect day.
  const cards = useMemo(() => goals.filter((g) => g.kind !== "avoid"), [goals]);
  const avoids = useMemo(() => goals.filter((g) => g.kind === "avoid"), [goals]);

  const doneCount = cards.filter((g) => g.done).length;
  const pct = cards.length ? Math.round((doneCount / cards.length) * 100) : 0;
  const { cols, rows } = useMemo(() => bestGrid(cards.length || 1, vp.w, vp.h), [cards.length, vp]);

  const streakOf = useMemo(() => {
    if (!history) return () => 0;
    const done = new Set(history.logs.map((l) => `${l.goal_id}|${l.date}`));
    return (id) => {
      let n = 0;
      let cur = todayStr();
      if (!done.has(`${id}|${cur}`)) cur = shiftDate(cur, -1);
      while (done.has(`${id}|${cur}`)) {
        n++;
        cur = shiftDate(cur, -1);
      }
      return n;
    };
  }, [history]);

  // Last 7 days, summarized: how many goals were done each day (full = all
  // goals). Avoid goals are excluded — they don't count toward a perfect day.
  const week = useMemo(() => {
    if (!history) return [];
    const avoidIds = new Set(history.goals.filter((g) => g.kind === "avoid").map((g) => g.id));
    const total = history.goals.filter((g) => g.kind !== "avoid").length || 0;
    const byDate = {};
    for (const l of history.logs) {
      if (avoidIds.has(l.goal_id)) continue;
      (byDate[l.date] ||= new Set()).add(l.goal_id);
    }
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = shiftDate(todayStr(), -i);
      const done = byDate[d] ? byDate[d].size : 0;
      out.push({ date: d, done, total, full: total > 0 && done >= total });
    }
    return out;
  }, [history]);
  const perfectDays = week.filter((d) => d.full).length;

  const prettyDate = new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex h-[100dvh] w-screen flex-col gap-[clamp(0.6rem,2vh,1.5rem)] overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-[clamp(0.7rem,2.2vw,2.5rem)] font-sans text-slate-100">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[clamp(1.7rem,4.5vw,3.75rem)] font-bold leading-tight tracking-tight">
            {prettyDate}
          </div>
          <div className="flex items-center gap-3 text-[clamp(1.15rem,2.2vw,1.6rem)] font-semibold text-slate-300">
            <span>{clock}</span>
            {awayMinutes != null && awayMinutes > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[clamp(0.95rem,1.7vw,1.3rem)] text-slate-400">
                <SmartphoneNfc className="size-[1.1em]" /> {formatDuration(awayMinutes)} off phone
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[clamp(0.5rem,1.5vw,1.25rem)]">
          <FullscreenButton fs={fs} toggle={toggleFs} />
          <Ring done={doneCount} total={goals.length} pct={pct} />
        </div>
      </header>

      <div
        className="grid min-h-0 flex-1 gap-4 sm:gap-6"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      >
        {cards.map((g) => (
          <DashCard key={g.id} goal={g} streak={streakOf(g.id)} />
        ))}
      </div>

      {avoids.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-[clamp(0.4rem,0.9vw,1rem)]">
          {avoids.map((g) => (
            <AvoidChip key={g.id} goal={g} streak={streakOf(g.id)} />
          ))}
        </div>
      )}

      {week.length > 0 && (
        <div className="shrink-0">
          <div className="mb-2 flex items-center justify-between text-[clamp(1rem,1.8vw,1.5rem)] font-semibold text-slate-300">
            <span>Last 7 days</span>
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <Check className="size-[1.2em]" strokeWidth={3} /> {perfectDays} perfect {perfectDays === 1 ? "day" : "days"}
            </span>
          </div>
          <div className="flex gap-[clamp(0.4rem,0.9vw,1rem)]">
            {week.map((d) => {
              const wd = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
              return (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.done}/${d.total}`}
                  className={
                    "flex h-[clamp(3rem,8vh,5.5rem)] flex-1 flex-col items-center justify-center gap-1 rounded-2xl " +
                    (d.full
                      ? "bg-emerald-400 text-slate-900"
                      : d.done > 0
                      ? "bg-emerald-500/25 text-slate-100"
                      : "bg-slate-700/40 text-slate-400")
                  }
                >
                  <span className="text-[clamp(1.2rem,3vh,2.1rem)] font-bold leading-none">
                    {d.done}/{d.total}
                  </span>
                  <span className="text-[clamp(0.75rem,1.6vh,1.1rem)] font-semibold uppercase tracking-wide">{wd}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
