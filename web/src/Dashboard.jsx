import { useEffect, useMemo, useState } from "react";
import { Footprints, Dumbbell, Moon, Brain, Flower2, Check, Flame, Target, BatteryCharging } from "lucide-react";
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
      <svg viewBox="0 0 130 130" className="w-[clamp(72px,9vw,150px)] -rotate-90">
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
        <div className="text-[clamp(1.1rem,2.6vw,2.6rem)] font-bold">{done}</div>
        <div className="text-[clamp(0.55rem,1vw,0.9rem)] font-medium text-slate-400">of {total}</div>
      </div>
    </div>
  );
}

function Chip({ on, icon: Icon, label }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-[clamp(0.5rem,1.3vw,1.1rem)] py-[clamp(0.2rem,0.8vw,0.55rem)] text-[clamp(0.75rem,1.5vw,1.35rem)] " +
        (on ? "border-emerald-400 bg-emerald-400 font-semibold text-slate-900" : "border-slate-600 text-slate-400")
      }
    >
      <Icon className="size-[1.1em]" />
      {label}
    </span>
  );
}

function CardBody({ goal }) {
  if (goal.kind === "sleep") {
    const inBed = goal.inBedMinutes;
    const asleep = goal.asleepMinutes != null ? goal.asleepMinutes : minutesBetween(goal.sleepTime, goal.wakeTime);
    const dur = inBed != null ? inBed : asleep;
    const window =
      goal.bedTime && goal.upTime
        ? `${goal.bedTime} – ${goal.upTime}`
        : goal.sleepTime && goal.wakeTime
        ? `${goal.sleepTime} – ${goal.wakeTime}`
        : "no sleep data";
    return (
      <>
        <div className="text-[clamp(1.5rem,5.5vw,5rem)] font-bold leading-none">{formatDuration(dur)}</div>
        <div className="mt-1.5 flex items-center gap-1 truncate text-[clamp(0.75rem,1.5vw,1.3rem)] text-slate-400">
          {goal.bedTime && goal.upTime && <BatteryCharging className="size-[1.1em]" />} {window}
          {inBed != null ? " in bed" : ""}
        </div>
        {asleep != null && (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[clamp(0.7rem,1.3vw,1.1rem)] text-slate-500">
            <Moon className="size-[1.1em]" /> {formatDuration(asleep)} asleep
          </div>
        )}
      </>
    );
  }
  if (goal.kind === "exercise") {
    return (
      <div className="flex flex-wrap gap-2">
        <Chip on={goal.ran} icon={Footprints} label="Run" />
        <Chip on={goal.workedOut} icon={Dumbbell} label="Workout" />
      </div>
    );
  }
  return (
    <div
      className={
        "grid size-[clamp(2.75rem,8vw,6rem)] place-items-center rounded-2xl border-2 transition-colors " +
        (goal.done ? "border-emerald-400 bg-emerald-400 text-slate-900" : "border-slate-600 text-transparent")
      }
    >
      <Check className="size-3/5" strokeWidth={3} />
    </div>
  );
}

function DashCard({ goal, streak }) {
  const a = accentOf(goal);
  return (
    <div
      className={
        "relative flex min-h-0 flex-col justify-between overflow-hidden rounded-[clamp(0.9rem,1.6vw,1.75rem)] border p-[clamp(0.8rem,2.2vw,2rem)] backdrop-blur transition-colors " +
        (goal.done
          ? "border-emerald-500/60 bg-emerald-500/10 shadow-[0_0_40px_-12px_rgba(74,222,128,0.45)]"
          : "border-slate-700/60 bg-slate-800/40")
      }
    >
      <div className="flex min-w-0 items-center gap-[clamp(0.5rem,1.2vw,1rem)]">
        <span className={"grid size-[clamp(2rem,3.6vw,3.5rem)] shrink-0 place-items-center rounded-2xl " + (goal.done ? "bg-emerald-500/20" : a.bg)}>
          <GoalIcon goal={goal} className={"size-[60%] " + (goal.done ? "text-emerald-300" : a.fg)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[clamp(0.95rem,2.2vw,2.1rem)] font-semibold">{goal.name}</span>
        {streak > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[clamp(0.8rem,1.5vw,1.35rem)] text-slate-400">
            <Flame className="size-[1.1em] text-orange-400" />
            {streak}
          </span>
        )}
        {goal.done && (
          <span className="grid size-[clamp(1.2rem,2.2vw,1.9rem)] shrink-0 place-items-center rounded-full bg-emerald-400 text-slate-900">
            <Check className="size-3/5" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <CardBody goal={goal} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [date, setDate] = useState(todayStr());
  const [goals, setGoals] = useState([]);
  const [history, setHistory] = useState(null);
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
      Promise.all([api.getDay(t), api.getHistory(30)])
        .then(([day, hist]) => {
          setGoals(day.goals);
          setHistory(hist);
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

  const doneCount = goals.filter((g) => g.done).length;
  const pct = goals.length ? Math.round((doneCount / goals.length) * 100) : 0;
  const { cols, rows } = useMemo(() => bestGrid(goals.length || 1, vp.w, vp.h), [goals.length, vp]);

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

  // Last 30 days, summarized: how many goals were done each day (full = all goals).
  const month = useMemo(() => {
    if (!history) return [];
    const total = history.goals.length || 0;
    const byDate = {};
    for (const l of history.logs) (byDate[l.date] ||= new Set()).add(l.goal_id);
    const out = [];
    for (let i = history.days - 1; i >= 0; i--) {
      const d = shiftDate(todayStr(), -i);
      const done = byDate[d] ? byDate[d].size : 0;
      out.push({ date: d, done, total, full: total > 0 && done >= total });
    }
    return out;
  }, [history]);
  const perfectDays = month.filter((d) => d.full).length;

  const prettyDate = new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex h-[100dvh] w-screen flex-col gap-[clamp(0.6rem,2vh,1.5rem)] overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-[clamp(0.7rem,2.2vw,2.5rem)] font-sans text-slate-100">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[clamp(1.1rem,4vw,3.75rem)] font-bold leading-tight tracking-tight">
            {prettyDate}
          </div>
          <div className="text-[clamp(0.8rem,2vw,1.6rem)] font-medium text-slate-400">{clock}</div>
        </div>
        <div className="flex shrink-0 items-center gap-[clamp(0.5rem,1.5vw,1.25rem)]">
          <FullscreenButton fs={fs} toggle={toggleFs} />
          <Ring done={doneCount} total={goals.length} pct={pct} />
        </div>
      </header>

      <div
        className="grid min-h-0 flex-1 gap-[clamp(0.5rem,1.8vw,1.75rem)]"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
      >
        {goals.map((g) => (
          <DashCard key={g.id} goal={g} streak={streakOf(g.id)} />
        ))}
      </div>

      {month.length > 0 && (
        <div className="shrink-0">
          <div className="mb-1 flex items-center justify-between text-[clamp(0.65rem,1.3vw,1.05rem)] text-slate-400">
            <span>Last 30 days</span>
            <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
              <Check className="size-[1.1em]" strokeWidth={3} /> {perfectDays} perfect {perfectDays === 1 ? "day" : "days"}
            </span>
          </div>
          <div className="flex gap-[clamp(1px,0.3vw,4px)]">
            {month.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.done}/${d.total}`}
                className={
                  "flex h-[clamp(0.7rem,2.4vh,1.7rem)] flex-1 items-center justify-center rounded-[3px] " +
                  (d.full ? "bg-emerald-400 text-slate-900" : d.done > 0 ? "bg-emerald-500/30" : "bg-slate-700/40")
                }
              >
                {d.full && <Check className="size-[80%]" strokeWidth={3} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
