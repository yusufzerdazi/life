import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Footprints,
  Dumbbell,
  BatteryCharging,
  BatteryFull,
  Sunrise,
  Moon,
  Brain,
  Flower2,
  Check,
  ChevronLeft,
  ChevronRight,
  Flame,
  RefreshCw,
  Target,
  Lock,
  ShieldCheck,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";

function GoalIcon({ goal, className = "size-5 shrink-0 text-slate-400" }) {
  const n = goal.name.toLowerCase();
  let Icon = Target;
  if (n.includes("run")) Icon = Footprints;
  else if (n.includes("yoga")) Icon = Flower2;
  else if (n.includes("medit")) Icon = Brain;
  else if (goal.kind === "sleep" || n.includes("sleep")) Icon = Moon;
  else if (goal.kind === "exercise" || n.includes("exercis") || n.includes("workout") || n.includes("gym"))
    Icon = Dumbbell;
  return <Icon className={className} />;
}

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

function prettyDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const CARD = "rounded-2xl border border-slate-700/60 bg-slate-800/40 p-5";
const LINK = "text-sm text-emerald-400 transition-colors hover:text-emerald-300";
const ROW = (done) =>
  `rounded-xl border p-3.5 transition-colors ${
    done ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-700/60 bg-slate-800/50"
  }`;

export default function App() {
  const navigate = useNavigate();
  const [date, setDate] = useState(todayStr());
  const [goals, setGoals] = useState([]);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [notice, setNotice] = useState("");

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

  // Handle the Google OAuth redirect (?code=...) once on load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;
    window.history.replaceState({}, "", window.location.pathname);
    setNotice("Connecting Google…");
    api
      .googleConnect(code)
      .then((r) => {
        if (!r.ok) throw new Error(r.reason || "Google connect failed");
        setNotice("Google connected — syncing health data…");
        return api.syncIntegration("google");
      })
      .then(() => {
        setNotice("Google Health connected ✓");
        return refresh();
      })
      .catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Avoid goals are tracked separately and don't count toward the daily total.
  const checkGoals = goals.filter((g) => g.kind !== "avoid");
  const avoidGoals = goals.filter((g) => g.kind === "avoid");
  const doneCount = checkGoals.filter((g) => g.done).length;
  const pct = checkGoals.length ? Math.round((doneCount / checkGoals.length) * 100) : 0;

  return (
    <div className="mx-auto max-w-xl px-5 pb-16 pt-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">life</h1>
        <p className="mt-0.5 text-sm text-slate-400">daily goals tracker</p>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/60 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      <section className={`mb-5 ${CARD}`}>
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setDate((d) => shiftDate(d, -1))}
            aria-label="Previous day"
            className="grid size-10 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1 text-center">
            <div className="text-lg font-semibold">{prettyDate(date)}</div>
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="mt-0.5 bg-transparent text-center text-xs text-slate-400 [color-scheme:dark]"
            />
          </div>
          <button
            onClick={() => setDate((d) => shiftDate(d, 1))}
            disabled={isToday}
            aria-label="Next day"
            className="grid size-10 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-30"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        {!isToday && (
          <button
            onClick={() => setDate(todayStr())}
            className="mx-auto mt-3 block rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800"
          >
            Jump to today
          </button>
        )}

        <div className="my-5 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <span className="whitespace-nowrap text-sm text-slate-400">
            {doneCount} / {goals.length} done
          </span>
        </div>

        <ul className="flex flex-col gap-2.5">
          {checkGoals.map((g) => (
            <li key={g.id}>
              <GoalRow goal={g} busy={busy} onUpdate={updateGoal} />
            </li>
          ))}
          {goals.length === 0 && <li className="py-2 text-sm text-slate-400">No goals yet — add one below.</li>}
        </ul>

        {avoidGoals.length > 0 && (
          <div className="mt-4 border-t border-slate-700/60 pt-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <ShieldCheck size={14} /> Avoiding {isToday ? "today" : "this day"}
            </div>
            <ul className="flex flex-col gap-2">
              {avoidGoals.map((g) => (
                <li key={g.id}>
                  <AvoidRow goal={g} busy={busy} onUpdate={updateGoal} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <button onClick={() => setShowManage((s) => !s)} className={`mt-3 ${LINK}`}>
          {showManage ? "Hide goal settings" : "Customize goals"}
        </button>

        {showManage && <ManageGoals goals={goals} onChange={refresh} setError={setError} />}
      </section>

      <History history={history} />

      <footer className="flex flex-col items-center gap-2 text-center">
        <Integrations onSynced={refresh} />
        <ApiHint />
        <button className={LINK} onClick={() => navigate("/dashboard")}>
          Open wall dashboard ↗
        </button>
      </footer>
    </div>
  );
}

function formatDuration(min) {
  if (min == null) return "";
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

function Crit({ ok, children }) {
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
        ok ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-slate-700 text-slate-400"
      }`}
    >
      {children}
    </span>
  );
}

function TimeField({ icon, label, value, field, goal, onUpdate }) {
  // Note: intentionally NOT disabled while saving — toggling `disabled` mid-edit
  // blurs the input, so the picker would lose focus on every keystroke.
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="inline-flex items-center gap-1.5">
        {icon} {label}
      </span>
      <input
        type="time"
        value={value || ""}
        onChange={(e) => onUpdate(goal, { [field]: e.target.value }, { [field]: e.target.value })}
        className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-[15px] text-slate-100 [color-scheme:dark]"
      />
    </label>
  );
}

function Lane({ on, icon: Icon, label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
        on ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-700 bg-slate-900/50"
      }`}
    >
      <Icon size={18} className={on ? "text-emerald-400" : "text-slate-400"} />
      <span className="flex-1">{label}</span>
      <span
        className={`grid size-5 place-items-center rounded-md border-2 ${
          on ? "border-emerald-400 bg-emerald-400 text-slate-900" : "border-slate-600 text-transparent"
        }`}
      >
        <Check size={13} strokeWidth={3} />
      </span>
    </button>
  );
}

function GoalRow({ goal, busy, onUpdate }) {
  if (goal.kind === "sleep") {
    const c = goal.criteria || {};
    const t = goal.target || { minMinutes: 450, bedBefore: "23:00", wakeBefore: "08:30" };
    const asleep = goal.asleepMinutes != null ? goal.asleepMinutes : minutesBetween(goal.sleepTime, goal.wakeTime);
    const parts = [];
    if (goal.inBedMinutes != null) parts.push(`${formatDuration(goal.inBedMinutes)} in bed`);
    if (asleep != null) parts.push(`${formatDuration(asleep)} asleep`);
    const duration = parts.join(" · ");
    return (
      <div className={`flex flex-col gap-3 ${ROW(goal.done)}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 font-medium">
            <GoalIcon goal={goal} /> {goal.name}
          </span>
          {duration && <span className="text-sm font-semibold text-emerald-400">{duration}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <TimeField icon={<BatteryCharging size={14} />} label="Bed (charge)" value={goal.bedTime} field="bedTime" goal={goal} busy={busy} onUpdate={onUpdate} />
          <TimeField icon={<BatteryFull size={14} />} label="Up (charge)" value={goal.upTime} field="upTime" goal={goal} busy={busy} onUpdate={onUpdate} />
          <TimeField icon={<Moon size={14} />} label="Sleep (Health)" value={goal.sleepTime} field="sleepTime" goal={goal} busy={busy} onUpdate={onUpdate} />
          <TimeField icon={<Sunrise size={14} />} label="Wake (Health)" value={goal.wakeTime} field="wakeTime" goal={goal} busy={busy} onUpdate={onUpdate} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Crit ok={c.durationOk}>≥ {Math.round((t.minMinutes / 60) * 10) / 10}h in bed</Crit>
          <Crit ok={c.bedOk}>bed &lt; {t.bedBefore}</Crit>
          <Crit ok={c.wakeOk}>wake &lt; {t.wakeBefore}</Crit>
        </div>
      </div>
    );
  }

  if (goal.kind === "exercise") {
    return (
      <div className={`flex flex-col gap-2.5 ${ROW(goal.done)}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 font-medium">
            <GoalIcon goal={goal} /> {goal.name}
          </span>
          {goal.ran && goal.workedOut && <span className="text-sm font-semibold text-emerald-400">run + workout</span>}
        </div>
        <div className="flex flex-col gap-2">
          <Lane
            on={goal.ran}
            icon={Footprints}
            label="Run"
            disabled={busy}
            onClick={() => onUpdate(goal, { ran: !goal.ran }, { ran: !goal.ran, done: !goal.ran || goal.workedOut })}
          />
          <Lane
            on={goal.workedOut}
            icon={Dumbbell}
            label="Workout"
            disabled={busy}
            onClick={() =>
              onUpdate(goal, { workedOut: !goal.workedOut }, { workedOut: !goal.workedOut, done: goal.ran || !goal.workedOut })
            }
          />
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => onUpdate(goal, { done: !goal.done }, { done: !goal.done })}
      disabled={busy}
      className={`flex w-full items-center gap-3.5 text-left ${ROW(goal.done)}`}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-lg border-2 ${
          goal.done ? "border-emerald-400 bg-emerald-400 text-slate-900" : "border-slate-600 text-transparent"
        }`}
      >
        <Check size={16} strokeWidth={3} />
      </span>
      <GoalIcon goal={goal} />
      <span className={goal.done ? "text-slate-400 line-through" : ""}>{goal.name}</span>
    </button>
  );
}

// A "thing to avoid" row: tap to cycle clean ↔ slipped for the selected day.
// pending (unconfirmed) shows neutral; the first tap records a clean/slip.
function AvoidRow({ goal, busy, onUpdate }) {
  const clean = goal.status === "clean";
  const slipped = goal.status === "slipped";
  const next = clean ? "slipped" : "clean";
  return (
    <button
      onClick={() => onUpdate(goal, { done: next === "clean" }, { status: next, done: next === "clean" })}
      disabled={busy}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        clean
          ? "border-emerald-500/50 bg-emerald-500/10"
          : slipped
          ? "border-red-500/50 bg-red-500/10"
          : "border-slate-700/60 bg-slate-800/50"
      }`}
    >
      <span
        className={`grid size-6 shrink-0 place-items-center rounded-md border-2 ${
          clean
            ? "border-emerald-400 bg-emerald-400 text-slate-900"
            : slipped
            ? "border-red-400 text-red-400"
            : "border-slate-600 text-transparent"
        }`}
      >
        {slipped ? <X size={13} strokeWidth={3} /> : <Check size={13} strokeWidth={3} />}
      </span>
      {goal.private && <Lock size={14} className="shrink-0 text-slate-400" />}
      <span className="flex-1">{goal.name}</span>
      <span
        className={`text-xs font-semibold ${
          clean ? "text-emerald-400" : slipped ? "text-red-400" : "text-slate-500"
        }`}
      >
        {goal.status || "pending"}
      </span>
    </button>
  );
}

function ManageGoals({ goals, onChange, setError }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("check");
  const [priv, setPriv] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.addGoal(name.trim(), kind, kind === "avoid" && priv);
      setName("");
      setKind("check");
      setPriv(false);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const rename = async (goal) => {
    const next = window.prompt("Rename goal", goal.name);
    if (next === null || !next.trim()) return;
    try {
      await api.renameGoal(goal.id, next.trim());
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (goal) => {
    if (!window.confirm(`Delete "${goal.name}" and all its history?`)) return;
    try {
      await api.deleteGoal(goal.id);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="mt-3.5 border-t border-slate-700/60 pt-3.5">
      <form onSubmit={add} className="mb-3 flex gap-2">
        <input
          placeholder="New goal name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 text-sm text-slate-100 [color-scheme:dark]"
        >
          <option value="check">check</option>
          <option value="sleep">sleep</option>
          <option value="exercise">exercise</option>
          <option value="avoid">avoid</option>
        </select>
        <button type="submit" className="rounded-lg bg-emerald-400 px-4 font-semibold text-slate-900 hover:bg-emerald-300">
          Add
        </button>
      </form>
      {kind === "avoid" && (
        <label className="-mt-1 mb-3 flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={priv}
            onChange={(e) => setPriv(e.target.checked)}
            className="accent-emerald-400"
          />
          <Lock size={12} /> Private — censor to first letter on the wall dashboard
        </label>
      )}
      <ul>
        {goals.map((g) => (
          <li key={g.id} className="flex items-center justify-between border-b border-slate-800 py-2 text-sm">
            <span>
              {g.name}
              {g.kind !== "check" && (
                <span className="ml-1.5 rounded-md border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400">
                  {g.kind}
                </span>
              )}
            </span>
            <span className="flex gap-3">
              <button onClick={() => rename(g)} className={LINK}>
                rename
              </button>
              <button onClick={() => remove(g)} className="text-sm text-red-400 transition-colors hover:text-red-300">
                delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function History({ history }) {
  const grid = useMemo(() => {
    if (!history) return null;
    const dates = [];
    for (let i = history.days - 1; i >= 0; i--) dates.push(shiftDate(todayStr(), -i));
    const done = new Set(history.logs.map((l) => `${l.goal_id}|${l.date}`));
    const streak = (goalId) => {
      let n = 0;
      let cursor = todayStr();
      if (!done.has(`${goalId}|${cursor}`)) cursor = shiftDate(cursor, -1);
      while (done.has(`${goalId}|${cursor}`)) {
        n++;
        cursor = shiftDate(cursor, -1);
      }
      return n;
    };
    return { dates, done, streak };
  }, [history]);

  if (!history || history.goals.length === 0) return null;

  return (
    <section className={`mb-5 ${CARD}`}>
      <h2 className="mb-3.5 text-base font-semibold text-slate-400">Last {history.days} days</h2>
      <div className="flex flex-col gap-3.5">
        {history.goals.map((g) => (
          <div key={g.id} className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[13px]">
              <span>{g.name}</span>
              <span className="inline-flex items-center gap-1 text-slate-400">
                <Flame size={13} className="text-orange-400" /> {grid.streak(g.id)}
              </span>
            </div>
            <div className="flex flex-wrap gap-[3px]">
              {grid.dates.map((d) => (
                <span
                  key={d}
                  title={`${g.name} · ${d}`}
                  className={`size-3 rounded-[3px] ${
                    grid.done.has(`${g.id}|${d}`) ? "bg-emerald-400" : "border border-slate-700 bg-slate-800"
                  }`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const INTEGRATIONS = [{ key: "wakingup", label: "Meditation (Waking Up)" }];

function summarize(key, r) {
  if (!r.ok) return r.needsAuth ? "Connect Google first" : r.reason || "Sync failed";
  if (r.baseline) return "Baseline saved — future activity will sync";
  if (key === "wakingup") return r.meditatedToday ? "✓ Meditation marked done" : `No new mindful day (${r.mindfulDays})`;
  if (key === "google") {
    const bits = [];
    if (r.exercise?.ran) bits.push("run");
    if (r.exercise?.workedOut) bits.push("workout");
    if (r.exercise?.yoga) bits.push("yoga");
    if (r.sleep) bits.push(`sleep ${r.sleep.asleepMinutes ?? "?"}m`);
    return bits.length ? `✓ ${bits.join(", ")}` : "No new data today";
  }
  return "Synced";
}

function Integrations({ onSynced }) {
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState({});
  const [syncing, setSyncing] = useState("");

  const load = () => api.integrationsStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  if (!status) return null;

  const sync = async (key) => {
    setSyncing(key);
    setMsg((m) => ({ ...m, [key]: "Syncing…" }));
    try {
      const r = await api.syncIntegration(key);
      setMsg((m) => ({ ...m, [key]: summarize(key, r) }));
      await load();
      onSynced && onSynced();
    } catch (e) {
      setMsg((m) => ({ ...m, [key]: e.message }));
    } finally {
      setSyncing("");
    }
  };

  const connectGoogle = async () => {
    try {
      const { url } = await api.googleAuthUrl();
      window.location.href = url;
    } catch (e) {
      setMsg((m) => ({ ...m, google: e.message }));
    }
  };

  const google = status.google;
  const others = INTEGRATIONS.filter((i) => status[i.key]?.configured);
  if (!google?.configured && others.length === 0) return null;

  const btn = "inline-flex items-center gap-1.5 text-sm text-emerald-400 transition-colors hover:text-emerald-300";

  return (
    <div className="flex flex-col items-center gap-1">
      {google?.configured &&
        (google.connected ? (
          <div>
            <button className={btn} disabled={syncing === "google"} onClick={() => sync("google")}>
              <RefreshCw size={13} className={syncing === "google" ? "animate-spin" : ""} /> Sync Google Health
            </button>
            {msg.google && <div className="text-xs text-slate-400">{msg.google}</div>}
          </div>
        ) : (
          <div>
            <button className={btn} onClick={connectGoogle}>
              <RefreshCw size={13} /> Connect Google Health
            </button>
            {msg.google && <div className="text-xs text-slate-400">{msg.google}</div>}
          </div>
        ))}
      {others.map((i) => (
        <div key={i.key}>
          <button className={btn} disabled={syncing === i.key} onClick={() => sync(i.key)}>
            <RefreshCw size={13} className={syncing === i.key ? "animate-spin" : ""} /> Sync {i.label}
          </button>
          {msg[i.key] && <div className="text-xs text-slate-400">{msg[i.key]}</div>}
        </div>
      ))}
    </div>
  );
}

function ApiHint() {
  const [open, setOpen] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const example = `# Exercise, sleep (sleep/wake) and yoga auto-fill from Google Health.
# Use the API for phone-charge bed/up times and manual entries.
# All writes need the header  x-api-key: YOUR_API_KEY

# bed = phone on charge, up = phone off charge (reported separately)
curl -X POST ${origin}/api/report \\
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \\
  -d '{"goal":"sleep","bedTime":"22:50"}'
curl -X POST ${origin}/api/report -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" -d '{"goal":"sleep","upTime":"07:10"}'

# mark a check goal done (e.g. meditation, yoga)
curl -X POST ${origin}/api/report -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" -d '{"goal":"meditation"}'

# exercise: a run and/or a workout
curl -X POST ${origin}/api/report -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" -d '{"goal":"exercise","ran":true}'`;

  return (
    <div className="w-full">
      <button className={LINK} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Report via API"}
      </button>
      {open && (
        <pre className="mt-2 w-full overflow-x-auto rounded-xl border border-slate-700 bg-slate-900 p-3.5 text-left text-xs text-slate-200">
          {example}
        </pre>
      )}
    </div>
  );
}
