import { Router } from "express";
import { db } from "../db.js";
import { requireApiKey } from "../auth.js";
import { setLog, formatDayGoal } from "../logs.js";
import { todayStr, isValidDate } from "../util.js";

export const dayRouter = Router();

const dayStmt = db.prepare(`
  SELECT g.id, g.name, g.kind, g.is_private,
         COALESCE(l.done, 0) AS done,
         (l.date IS NOT NULL) AS logged,
         l.bed_time, l.up_time, l.sleep_time, l.wake_time, l.asleep_minutes,
         COALESCE(l.ran, 0) AS ran, COALESCE(l.worked_out, 0) AS worked_out
  FROM goals g
  LEFT JOIN logs l ON l.goal_id = g.id AND l.date = ?
  ORDER BY g.sort_order, g.id
`);

// GET /api/day?date=YYYY-MM-DD  -> goals with status (+ times) for that date
dayRouter.get("/", (req, res) => {
  const date = req.query.date ? String(req.query.date) : todayStr();
  if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  res.json({ date, goals: dayStmt.all(date).map(formatDayGoal) });
});

// PUT /api/day  { goalId, date?, done?, time?, bedTime?, wakeTime? }
dayRouter.put("/", requireApiKey, (req, res) => {
  const date = req.body?.date ? String(req.body.date) : todayStr();
  if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  const goalId = Number(req.body?.goalId);
  if (!goalId) return res.status(400).json({ error: "goalId is required" });

  const goal = db.prepare("SELECT id, name, kind, is_private FROM goals WHERE id = ?").get(goalId);
  if (!goal) return res.status(404).json({ error: "Goal not found" });

  try {
    const { done, bedTime, upTime, sleepTime, wakeTime, asleepMinutes, sleepHours, ran, workedOut } =
      req.body || {};
    res.json(
      setLog(goal, date, { done, bedTime, upTime, sleepTime, wakeTime, asleepMinutes, sleepHours, ran, workedOut })
    );
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
