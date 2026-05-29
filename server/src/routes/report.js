import { Router } from "express";
import { requireApiKey } from "../auth.js";
import { setLog, findGoal } from "../logs.js";
import { todayStr, isValidDate, shiftDay } from "../util.js";

export const reportRouter = Router();

// POST /api/report
//   check goals: { goal, date?, done?, time? }
//   sleep goals: { goal, date?, bedTime?, wakeTime? }
// "goal" may be a goal id or a (case-insensitive) goal name, e.g. "exercise".
//
//   curl -X POST http://localhost:3001/api/report \
//     -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
//     -d '{"goal":"exercise","time":"07:30"}'
//
//   curl -X POST http://localhost:3001/api/report \
//     -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
//     -d '{"goal":"sleep","bedTime":"23:15","wakeTime":"07:00"}'
reportRouter.post("/", requireApiKey, (req, res) => {
  const goal = findGoal(req.body?.goal);
  if (!goal) {
    return res.status(404).json({ error: "Unknown goal " + JSON.stringify(req.body) + ". Pass a valid goal id or name." });
  }

  let date = req.body?.date ? String(req.body.date) : todayStr();
  if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

  try {
    let { done, bedTime, upTime, sleepTime, wakeTime, asleepMinutes, sleepHours, ran, workedOut } =
      req.body || {};
    // A bare report means "I did it": default check goals to done, and a bare
    // exercise report to a workout.
    if (goal.kind === "check") {
      if (done === undefined) done = true;
    } else if (goal.kind === "exercise") {
      if (ran === undefined && workedOut === undefined) workedOut = done === undefined ? true : !!done;
    }
    if (goal.kind === "sleep") {
      // bed/up accept "yyyy-MM-dd HH:mm" (or with "T") — split into event date
      // and time-of-day; the time is stored, the date drives attribution.
      let eventDate = null;
      const strip = (val) => {
        if (typeof val !== "string") return val;
        const m = val.trim().match(/^(\d{4}-\d{2}-\d{2})[ T]+(.+)$/);
        if (m && isValidDate(m[1])) {
          eventDate = eventDate || m[1];
          return m[2].trim();
        }
        return val;
      };
      bedTime = strip(bedTime);
      upTime = strip(upTime);

      // Choose the entry date when none was given explicitly. A PM bedtime
      // belongs to the night you wake the NEXT day.
      if (!req.body?.date) {
        date = eventDate || date;
        if (bedTime) {
          const bh = parseInt(String(bedTime).replace(".", ":").split(":")[0], 10);
          if (Number.isFinite(bh) && bh >= 12) date = shiftDay(date, 1);
        }
      }
    }
    const entry = setLog(goal, date, {
      done, bedTime, upTime, sleepTime, wakeTime, asleepMinutes, sleepHours, ran, workedOut,
    });
    res.json({ goal: { id: goal.id, name: goal.name, kind: goal.kind }, date, ...entry });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
