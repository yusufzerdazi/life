import { db } from "./db.js";
import { isValidTime } from "./util.js";

const getStmt = db.prepare("SELECT * FROM logs WHERE goal_id = ? AND date = ?");
const insertStmt = db.prepare(`
  INSERT INTO logs (goal_id, date, done, time, bed_time, up_time, sleep_time, wake_time, asleep_minutes, ran, worked_out, updated_at)
  VALUES (@goal_id, @date, @done, @time, @bed_time, @up_time, @sleep_time, @wake_time, @asleep_minutes, @ran, @worked_out, datetime('now'))
`);
const updateStmt = db.prepare(`
  UPDATE logs SET done = @done, time = @time, bed_time = @bed_time, up_time = @up_time,
    sleep_time = @sleep_time, wake_time = @wake_time, asleep_minutes = @asleep_minutes,
    ran = @ran, worked_out = @worked_out, updated_at = datetime('now')
  WHERE goal_id = @goal_id AND date = @date
`);

// Sleep success thresholds.
export const SLEEP_TARGET = { minMinutes: 450, bedBefore: "23:00", wakeBefore: "08:30" };
const EVENING_START = 12 * 60; // bedtimes are evening; anything past midnight is "too late"

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normTime(v) {
  const s = String(v).trim().replace(".", ":"); // accept "HH.MM" as well as "HH:MM"
  if (s === "") return null;
  if (!isValidTime(s)) throw badRequest("time must be HH:MM or HH.MM (24-hour)");
  return s;
}

function normMinutes(v) {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw badRequest("sleep minutes must be 0–1440");
  return Math.round(n);
}

function minutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Time spent in bed (bed -> wake), handling crossing midnight.
export function sleepMinutes(bed, wake) {
  if (!bed || !wake) return null;
  let d = minutes(wake) - minutes(bed);
  if (d <= 0) d += 24 * 60;
  return d;
}

// Per-criterion evaluation. Two independent sources:
//   bed/up   = phone on/off charge (when you got into/out of bed)
//   sleep/wake/asleepMinutes = Google Health (when you actually slept)
// Duration is based on time in bed (bed->up phone charge); only when those
// aren't reported does it fall back to tracked asleep, then sleep->wake.
// Wake prefers the Health "wake"; falls back to the phone "up" time.
//
// Success (`met`) is based on BED TIME only — bed during the evening and before
// the cutoff. Duration and wake are still computed for display, but they don't
// gate completion.
function sleepCriteria(bed, up, sleepStart, wake, asleep) {
  const asleepSpan = sleepMinutes(sleepStart, wake);
  const inBed = sleepMinutes(bed, up);
  const effective = inBed != null ? inBed : asleep != null ? asleep : asleepSpan;
  const effectiveWake = wake || up;
  const durationOk = effective != null && effective >= SLEEP_TARGET.minMinutes;
  const bedOk = !!bed && minutes(bed) >= EVENING_START && minutes(bed) < minutes(SLEEP_TARGET.bedBefore);
  const wakeOk = !!effectiveWake && minutes(effectiveWake) < minutes(SLEEP_TARGET.wakeBefore);
  return { durationOk, bedOk, wakeOk, met: bedOk };
}

// Build the API-facing shape for a goal's entry on a given day.
export function formatDayGoal(row) {
  const base = { id: row.id, name: row.name, kind: row.kind, done: !!row.done };
  if (row.kind === "sleep") {
    base.bedTime = row.bed_time || null;
    base.upTime = row.up_time || null;
    base.sleepTime = row.sleep_time || null;
    base.wakeTime = row.wake_time || null;
    base.inBedMinutes = sleepMinutes(row.bed_time, row.up_time);
    base.asleepMinutes = row.asleep_minutes ?? null;
    base.criteria = sleepCriteria(row.bed_time, row.up_time, row.sleep_time, row.wake_time, base.asleepMinutes);
    base.target = SLEEP_TARGET;
  } else if (row.kind === "exercise") {
    base.ran = !!row.ran;
    base.workedOut = !!row.worked_out;
  } else if (row.kind === "avoid") {
    // Abstinence goal. Tri-state: no log row yet = pending (not confirmed),
    // row with done=1 = stayed clean, row with done=0 = slipped.
    base.private = !!row.is_private;
    base.status = row.logged ? (row.done ? "clean" : "slipped") : "pending";
  }
  // check goals are simply done / not-done — no extra fields.
  return base;
}

function formatEntry(goal, row) {
  // A just-written row exists, so it's logged; carry the goal's privacy flag.
  return formatDayGoal({ id: goal.id, name: goal.name, kind: goal.kind, is_private: goal.is_private, logged: 1, ...row });
}

// Merge-upsert. `fields` keys that are `undefined` are left unchanged.
//   check goals:    { done? }          (simple done / not-done, no time)
//   sleep goals:    { bedTime?, wakeTime?, asleepMinutes?, sleepHours? }
//   exercise goals: { ran?, workedOut?, done? }
export function setLog(goal, date, fields, opts = {}) {
  const existing = getStmt.get(goal.id, date);
  // When protectTimes is set (used by /api/report), a bed/up time that's already
  // tracked for this date is kept — repeat charge events don't overwrite it.
  const keepBed = opts.protectTimes && !!existing?.bed_time;
  const keepUp = opts.protectTimes && !!existing?.up_time;
  const cur = existing || {
    done: 0,
    time: null,
    bed_time: null,
    up_time: null,
    sleep_time: null,
    wake_time: null,
    asleep_minutes: null,
    ran: 0,
    worked_out: 0,
  };

  let done;
  let time = null; // legacy column; no goal kind uses a time-of-day anymore
  let bed_time = cur.bed_time;
  let up_time = cur.up_time;
  let sleep_time = cur.sleep_time;
  let wake_time = cur.wake_time;
  let asleep_minutes = cur.asleep_minutes;
  let ran = cur.ran;
  let worked_out = cur.worked_out;

  if (goal.kind === "sleep") {
    time = null;
    ran = 0;
    worked_out = 0;
    if (fields.bedTime !== undefined && !keepBed) bed_time = normTime(fields.bedTime);
    if (fields.upTime !== undefined && !keepUp) up_time = normTime(fields.upTime);
    if (fields.sleepTime !== undefined) sleep_time = normTime(fields.sleepTime);
    if (fields.wakeTime !== undefined) wake_time = normTime(fields.wakeTime);
    if (fields.asleepMinutes !== undefined) asleep_minutes = normMinutes(fields.asleepMinutes);
    else if (fields.sleepHours !== undefined)
      asleep_minutes = normMinutes(fields.sleepHours === null || fields.sleepHours === "" ? null : Number(fields.sleepHours) * 60);
    done = sleepCriteria(bed_time, up_time, sleep_time, wake_time, asleep_minutes).met ? 1 : 0;
  } else if (goal.kind === "exercise") {
    time = null;
    bed_time = null;
    up_time = null;
    sleep_time = null;
    wake_time = null;
    asleep_minutes = null;
    if (fields.ran !== undefined) ran = fields.ran ? 1 : 0;
    if (fields.workedOut !== undefined) worked_out = fields.workedOut ? 1 : 0;
    done = ran || worked_out ? 1 : 0;
  } else {
    bed_time = null;
    up_time = null;
    sleep_time = null;
    wake_time = null;
    asleep_minutes = null;
    ran = 0;
    worked_out = 0;
    if (fields.done !== undefined) done = fields.done ? 1 : 0;
    else done = cur.done;
  }

  const row = { goal_id: goal.id, date, done, time, bed_time, up_time, sleep_time, wake_time, asleep_minutes, ran, worked_out };
  if (existing) updateStmt.run(row);
  else insertStmt.run(row);
  return formatEntry(goal, { date, done, time, bed_time, up_time, sleep_time, wake_time, asleep_minutes, ran, worked_out });
}

// The time "today" actually began for the user — when they got up (today's
// up/wake on the sleep goal). Returns "HH:MM" or null if not recorded yet.
export function sleepDayStart(date) {
  const sleepGoal = db.prepare("SELECT id FROM goals WHERE kind = 'sleep' ORDER BY sort_order, id LIMIT 1").get();
  if (!sleepGoal) return null;
  const row = db.prepare("SELECT up_time, wake_time FROM logs WHERE goal_id = ? AND date = ?").get(sleepGoal.id, date);
  return row ? row.up_time || row.wake_time || null : null;
}

// Resolve a goal by numeric id or by case-insensitive name.
export function findGoal(goalRef) {
  if (goalRef === undefined || goalRef === null || goalRef === "") return null;
  if (typeof goalRef === "number" || /^\d+$/.test(String(goalRef))) {
    return db.prepare("SELECT id, name, kind, is_private FROM goals WHERE id = ?").get(Number(goalRef)) || null;
  }
  return (
    db.prepare("SELECT id, name, kind, is_private FROM goals WHERE name = ? COLLATE NOCASE").get(String(goalRef).trim()) ||
    null
  );
}
