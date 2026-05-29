import { Router } from "express";
import { db } from "../db.js";

export const historyRouter = Router();

const goalsStmt = db.prepare("SELECT id, name FROM goals ORDER BY sort_order, id");
const logsStmt = db.prepare(
  "SELECT goal_id, date FROM logs WHERE done = 1 AND date >= ? ORDER BY date"
);

// GET /api/history?days=30
// Returns goals plus the "done" log entries within the window so the
// client can render a grid and compute streaks.
historyRouter.get("/", (req, res) => {
  let days = Number(req.query.days) || 30;
  days = Math.min(Math.max(days, 1), 365);

  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const tz = from.getTimezoneOffset() * 60000;
  const fromStr = new Date(from - tz).toISOString().slice(0, 10);

  res.json({
    days,
    from: fromStr,
    goals: goalsStmt.all(),
    logs: logsStmt.all(fromStr),
  });
});
