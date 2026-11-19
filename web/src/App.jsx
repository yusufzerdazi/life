import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { todayStr, shiftDate, formatDuration, minutesBetween, streaks, Mark, useOnSynced } from "./ui.jsx";
import Blocks from "./Blocks.jsx";
import SyncPanel from "./SyncPanel.jsx";
import { Lights, ScreenTime, SyncStatus } from "./Phone.jsx";

export default function App() {
  const navigate = useNavigate();
  const [date, setDate] = useState(todayStr());
  const [goals, setGoals] = useState([]);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const isToday = date === todayStr();

  const refresh = useCallback(async () => {
    try {
      const [day, hist] = await Promise.all([api.getDay(date), api.getHistory(30)]);
      setGoals(day.goals);
      setHistory(hist);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [date]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useOnSynced(refresh);

  const updateGoal = async (goal, fields, optimistic = {}) => {
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, ...optimistic } : g)));
    try {
      setBusy(true);
      const res = await api.setDay(goal.id, date, fields);
      setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, ...res } : g)));
      setHistory(await api.getHistory(30));
    } catch (e) {
      setError(e.message);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // Avoid goals are tracked separately and don't count toward the day.
  const checkGoals = goals.filter((g) => g.kind !== "avoid");
  const avoidGoals = goals.filter((g) => g.kind === "avoid");
  const doneCount = checkGoals.filter((g) => g.done).length;
  const streakOf = useMemo(() => streaks(history), [history]);

  const d = new Date(date + "T00:00:00");
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const dayMonth = d.toLocaleDateString(undefined, { day: "numeric", month: "long" });

  return (
    <div className="mx-auto max-w-lg px-6 pb-16 pt-10">
      <header className="mb-7 flex items-end justify-between gap-4">
        <label className="relative block min-w-0 cursor-pointer">
          <div className="text-sm text-dim">
            {weekday}
            {!isToday && <span className="text-mute"> · past day</span>}
          </div>
          <h1 className="font-display text-[46px] leading-[1.05] tracking-tight">{dayMonth}</h1>
          {/* the heading itself opens the native date picker */}
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="absolute inset-0 opacity-0"
            aria-label="Pick a day"
          />
        </label>
        <div className="flex shrink-0 items-center gap-1 pb-1.5 text-dim">
          {!isToday && (
            <button onClick={() => setDate(todayStr())} className="mr-2 text-sm hover:text-fg">
              Today
            </button>
          )}
          <button onClick={() => setDate((x) => shiftDate(x, -1))} aria-label="Previous day" className="grid size-9 place-items-center rounded-full hover:bg-raise hover:text-fg">
            <ChevronLeft size={20} />
          </button>
          <button onClick={() => setDate((x) => shiftDate(x, 1))} disabled={isToday} aria-label="Next day" className="grid size-9 place-items-center rounded-full hover:bg-raise hover:text-fg disabled:opacity-25">
            <ChevronRight size={20} />
          </button>
        </div>
      </header>

      {checkGoals.length > 0 && (
        <div className="mb-3 flex items-center gap-4">
          <div className="flex flex-1 gap-1">
            {checkGoals.map((g) => (
              <span key={g.id} className={`h-[3px] flex-1 rounded-full transition-colors ${g.done ? "bg-ok" : "bg-rule"}`} />
            ))}
          </div>
          <span className="font-display text-2xl leading-none">
            {doneCount}
            <span className="text-mute">/{checkGoals.length}</span>
          </span>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-slip">{error}</p>}

      <ul>
        {checkGoals.map((g) => (
          <li key={g.id} className="border-b border-rule">
            <GoalRow goal={g} streak={streakOf(g.id)} busy={busy} onUpdate={updateGoal} />
          </li>
        ))}
        {goals.length === 0 && !error && <li className="py-4 text-sm text-mute">No goals yet.</li>}
      </ul>

      {avoidGoals.length > 0 && (
        <section className="mt-10">
          <h2 className="label mb-1">Avoiding</h2>
          <ul>
            {avoidGoals.map((g) => (
              <li key={g.id} className="border-b border-rule">
                <AvoidRow goal={g} streak={streakOf(g.id)} busy={busy} onUpdate={updateGoal} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {isToday && <ScreenTime />}

      <History history={history} streakOf={streakOf} />

      <Blocks />

      <SyncPanel />

      <Lights />

      {editing && <ManageGoals goals={goals} onChange={refresh} setError={setError} onDone={() => setEditing(false)} />}

      <footer className="mt-14 flex items-start justify-between gap-4 text-sm">
        <div className="flex gap-5">
          {!editing && (
            <button className="link" onClick={() => setEditing(true)}>
              Edit goals
            </button>
          )}
          <button className="link" onClick={() => navigate("/dashboard")}>
            Wall view
          </button>
        </div>
        <SyncStatus onSynced={refresh} />
      </footer>
    </div>
  );
}

function Streak({ n }) {
  if (!n) return null;
  return <span className="text-xs text-mute">{n}d</span>;
}

function Toggle({ on, onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
        on ? "border-ok bg-ok text-night" : "border-rule text-dim hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function GoalRow({ goal, streak, busy, onUpdate }) {
  if (goal.kind === "sleep") return <SleepRow goal={goal} streak={streak} onUpdate={onUpdate} />;

  if (goal.kind === "exercise") {
    return (
      <div className="flex items-center gap-4 py-4">
        <Mark state={goal.done} />
        <span className="flex-1 text-[17px]">{goal.name}</span>
        <Streak n={streak} />
        <div className="flex gap-1.5">
          <Toggle on={goal.ran} disabled={busy} onClick={() => onUpdate(goal, { ran: !goal.ran }, { ran: !goal.ran, done: !goal.ran || goal.workedOut })}>
            run
          </Toggle>
          <Toggle
            on={goal.workedOut}
            disabled={busy}
            onClick={() => onUpdate(goal, { workedOut: !goal.workedOut }, { workedOut: !goal.workedOut, done: goal.ran || !goal.workedOut })}
          >
            gym
          </Toggle>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => onUpdate(goal, { done: !goal.done }, { done: !goal.done })}
      disabled={busy}
      className="flex w-full items-center gap-4 py-4 text-left"
    >
      <Mark state={goal.done} />
      <span className={`flex-1 text-[17px] transition-colors ${goal.done ? "text-dim" : ""}`}>{goal.name}</span>
      <Streak n={streak} />
    </button>
  );
}

// Collapsed: the night at a glance. Tap to edit the four times.
function SleepRow({ goal, streak, onUpdate }) {
  const [open, setOpen] = useState(false);
  const c = goal.criteria || {};
  const t = goal.target || { minMinutes: 450, bedBefore: "23:00", wakeBefore: "08:30" };
  const asleep = goal.asleepMinutes != null ? goal.asleepMinutes : minutesBetween(goal.sleepTime, goal.wakeTime);
  const span = goal.bedTime || goal.upTime ? [goal.bedTime, goal.upTime] : [goal.sleepTime, goal.wakeTime];
  const summary = span[0] || span[1] ? `${span[0] || "–"} → ${span[1] || "–"}` : "not logged";
  const dur = goal.inBedMinutes ?? asleep;

  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-4 py-4 text-left">
        <Mark state={goal.done} />
        <span className="flex-1 text-[17px]">{goal.name}</span>
        <Streak n={streak} />
        <span className="text-right text-sm leading-tight">
          <span className={span[0] || span[1] ? "text-fg" : "text-mute"}>{summary}</span>
          {dur != null && <span className="block text-xs text-mute">{formatDuration(dur)}</span>}
        </span>
      </button>
      {open && (
        <div className="pb-5 pl-[38px]">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <TimeField label="In bed" value={goal.bedTime} field="bedTime" goal={goal} onUpdate={onUpdate} />
            <TimeField label="Up" value={goal.upTime} field="upTime" goal={goal} onUpdate={onUpdate} />
            <TimeField label="Asleep (Health)" value={goal.sleepTime} field="sleepTime" goal={goal} onUpdate={onUpdate} />
            <TimeField label="Woke (Health)" value={goal.wakeTime} field="wakeTime" goal={goal} onUpdate={onUpdate} />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-mute">
            <Crit ok={c.bedOk}>bed before {t.bedBefore}</Crit> · <Crit ok={c.durationOk}>{t.minMinutes / 60}h in bed</Crit> ·{" "}
            <Crit ok={c.wakeOk}>up before {t.wakeBefore}</Crit>
            {asleep != null && <> · {formatDuration(asleep)} asleep</>}
          </p>
        </div>
      )}
    </div>
  );
}

function Crit({ ok, children }) {
  return <span className={ok ? "text-ok" : ""}>{children}</span>;
}

function TimeField({ label, value, field, goal, onUpdate }) {
  // Not disabled while saving — toggling `disabled` mid-edit blurs the input.
  return (
    <label className="flex flex-col text-xs text-mute">
      {label}
      <input
        type="time"
        value={value || ""}
        onChange={(e) => onUpdate(goal, { [field]: e.target.value }, { [field]: e.target.value })}
        className="field w-full min-w-0 text-[15px]"
      />
    </label>
  );
}

// Tap "clean" or "slipped" for the selected day; untouched = not confirmed yet.
function AvoidRow({ goal, streak, busy, onUpdate }) {
  const set = (clean) => onUpdate(goal, { done: clean }, { status: clean ? "clean" : "slipped", done: clean });
  const opt = (active, tone) =>
    `px-2.5 py-1 text-[13px] transition-colors ${active ? tone : "text-mute hover:text-dim"}`;
  return (
    <div className="flex items-center gap-4 py-3">
      <Mark state={goal.status} />
      <span className="flex flex-1 items-center gap-1.5 text-[17px]">
        {goal.name}
        {goal.private && <Lock size={12} className="text-mute" />}
      </span>
      <Streak n={streak} />
      <div className="flex">
        <button disabled={busy} onClick={() => set(true)} className={opt(goal.status === "clean", "text-ok")}>
          clean
        </button>
        <button disabled={busy} onClick={() => set(false)} className={opt(goal.status === "slipped", "text-slip")}>
          slipped
        </button>
      </div>
    </div>
  );
}

function History({ history, streakOf }) {
  const grid = useMemo(() => {
    if (!history) return null;
    const dates = [];
    for (let i = history.days - 1; i >= 0; i--) dates.push(shiftDate(todayStr(), -i));
    return { dates, done: new Set(history.logs.map((l) => `${l.goal_id}|${l.date}`)) };
  }, [history]);

  if (!history || history.goals.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="label mb-3">Last {history.days} days</h2>
      <div className="flex flex-col gap-2.5">
        {history.goals.map((g) => (
          <div key={g.id} className="flex items-center gap-3">
            <span className="w-24 shrink-0 truncate text-[13px] text-dim">{g.name}</span>
            <div className="flex flex-1 justify-between">
              {grid.dates.map((d) => (
                <span
                  key={d}
                  title={d}
                  className={`size-[7px] rounded-full ${grid.done.has(`${g.id}|${d}`) ? (g.kind === "avoid" ? "bg-ok/60" : "bg-ok") : "bg-rule"}`}
                />
              ))}
            </div>
            <span className="w-7 shrink-0 text-right text-xs text-mute">{streakOf(g.id) || ""}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const KINDS = [
  ["check", "Daily"],
  ["exercise", "Exercise"],
  ["sleep", "Sleep"],
  ["avoid", "Avoid"],
];

function ManageGoals({ goals, onChange, setError, onDone }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("check");
  const [priv, setPriv] = useState(false);

  const run = async (fn) => {
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => {
      await api.addGoal(name.trim(), kind, kind === "avoid" && priv);
      setName("");
      setPriv(false);
    });
  };

  const rename = (goal) => {
    const next = window.prompt("Rename goal", goal.name);
    if (next && next.trim()) run(() => api.renameGoal(goal.id, next.trim()));
  };

  const remove = (goal) => {
    if (window.confirm(`Delete "${goal.name}" and all its history?`)) run(() => api.deleteGoal(goal.id));
  };

  return (
    <section className="mt-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="label">Goals</h2>
        <button onClick={onDone} className="link">
          Done
        </button>
      </div>
      <ul>
        {goals.map((g) => (
          <li key={g.id} className="flex items-center gap-3 border-b border-rule py-3 text-[15px]">
            <span className="flex-1">{g.name}</span>
            <span className="text-xs text-mute">{KINDS.find(([k]) => k === g.kind)?.[1]}</span>
            <button onClick={() => rename(g)} className="text-sm text-dim hover:text-fg">
              Rename
            </button>
            <button onClick={() => remove(g)} className="text-sm text-slip/80 hover:text-slip">
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-4 flex items-end gap-3">
        <input placeholder="New goal" value={name} onChange={(e) => setName(e.target.value)} className="field min-w-0 flex-1 text-[15px]" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="field w-auto pr-7 text-sm">
          {KINDS.map(([k, l]) => (
            <option key={k} value={k} className="bg-raise">
              {l}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-full bg-fg px-4 py-1.5 text-sm font-medium text-night">
          Add
        </button>
      </form>
      {kind === "avoid" && (
        <label className="mt-3 flex items-center gap-2 text-xs text-mute">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="rounded border-rule bg-transparent text-ok focus:ring-0" />
          Private — show only the first letter on the wall view
        </label>
      )}
    </section>
  );
}
