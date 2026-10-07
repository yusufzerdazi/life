import { Router } from "express";
import { db } from "../db.js";
import { requireApiKey } from "../auth.js";
import { setLog } from "../logs.js";
import { todayStr, isValidDate } from "../util.js";

export const presenceRouter = Router();

// A "presence" session = the phone sitting on the wall (dashboard mounted).
// start when it connects, end when it's removed. If the /bed prompt is confirmed
// during a session, ending that session is treated as getting up (wake/up time).

const openAllStmt = db.prepare("SELECT * FROM presence WHERE ended_at IS NULL ORDER BY id");
const latestOpenStmt = db.prepare("SELECT * FROM presence WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1");
const insertStmt = db.prepare("INSERT INTO presence (started_at) VALUES (?)");
const closeStmt = db.prepare("UPDATE presence SET ended_at = ? WHERE id = ?");
const bedStmt = db.prepare("UPDATE presence SET bed_at = ?, bed_date = ? WHERE id = ?");
const sleepGoalStmt = db.prepare("SELECT id, name, kind FROM goals WHERE kind = 'sleep' ORDER BY sort_order, id LIMIT 1");

function nowIso() {
  return new Date().toISOString();
}
function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// POST /api/presence/start -> open a session (phone connected to the wall).
// Defensively closes any session left dangling from a missed "end".
presenceRouter.post("/start", requireApiKey, (_req, res) => {
  const now = nowIso();
  for (const s of openAllStmt.all()) closeStmt.run(now, s.id);
  const info = insertStmt.run(now);
  res.json({ id: Number(info.lastInsertRowid), startedAt: now });
});

// POST /api/presence/bed { date? } -> mark the current open session as a
// bedtime session (its end will count as getting up). `date` is the sleep
// entry date the bedtime was attributed to (as returned by /api/report).
presenceRouter.post("/bed", requireApiKey, (req, res) => {
  const open = latestOpenStmt.get();
  if (!open) return res.json({ ok: true, marked: false });
  const date = req.body?.date && isValidDate(String(req.body.date)) ? String(req.body.date) : todayStr();
  bedStmt.run(nowIso(), date, open.id);
  res.json({ ok: true, marked: true, id: open.id, bedDate: date });
});

// POST /api/presence/end -> close the latest open session (phone removed). If a
// bedtime was logged during the session, record now as that night's up time.
presenceRouter.post("/end", requireApiKey, (_req, res) => {
  const open = latestOpenStmt.get();
  if (!open) return res.json({ ok: true, closed: false });
  closeStmt.run(nowIso(), open.id);

  let upTime = null;
  if (open.bed_date) {
    const sleepGoal = sleepGoalStmt.get();
    if (sleepGoal) {
      upTime = nowHM();
      // protectTimes: a manually-set up time wins — don't clobber it.
      setLog(sleepGoal, open.bed_date, { upTime }, { protectTimes: true });
    }
  }
  res.json({ ok: true, closed: true, id: open.id, upTime, bedDate: open.bed_date || null });
});

// GET /api/presence?date=YYYY-MM-DD -> sessions + total minutes on the wall
// (time away from the phone) for that local day. Sessions are clipped to the
// day, so a session spanning midnight is split across days.
presenceRouter.get("/", (req, res) => {
  const date = req.query.date ? String(req.query.date) : todayStr();
  if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  const dayStart = new Date(date + "T00:00:00");
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const rows = db
    .prepare("SELECT * FROM presence WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at")
    .all(new Date(dayEndMs).toISOString(), new Date(dayStartMs).toISOString());

  const now = Date.now();
  let totalMs = 0;
  const sessions = rows.map((r) => {
    const s = Date.parse(r.started_at);
    const e = r.ended_at ? Date.parse(r.ended_at) : now;
    const overlap = Math.max(0, Math.min(e, dayEndMs) - Math.max(s, dayStartMs));
    totalMs += overlap;
    return {
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      open: !r.ended_at,
      bedDate: r.bed_date || null,
      minutes: Math.round(overlap / 60000),
    };
  });

  res.json({ date, totalMinutes: Math.round(totalMs / 60000), count: sessions.length, sessions });
});
