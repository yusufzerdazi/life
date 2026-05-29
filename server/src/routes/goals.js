import { Router } from "express";
import { db } from "../db.js";
import { requireApiKey } from "../auth.js";

export const goalsRouter = Router();

const KINDS = ["check", "sleep", "exercise"];
const listStmt = db.prepare("SELECT id, name, sort_order, kind FROM goals ORDER BY sort_order, id");
const oneStmt = db.prepare("SELECT id, name, sort_order, kind FROM goals WHERE id = ?");

goalsRouter.get("/", (_req, res) => {
  res.json(listStmt.all());
});

goalsRouter.post("/", requireApiKey, (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  const kind = req.body?.kind || "check";
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });

  const max = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM goals").get().m;
  const info = db
    .prepare("INSERT INTO goals (name, sort_order, kind) VALUES (?, ?, ?)")
    .run(name, max + 1, kind);
  res.status(201).json(oneStmt.get(info.lastInsertRowid));
});

goalsRouter.patch("/:id", requireApiKey, (req, res) => {
  const goal = oneStmt.get(req.params.id);
  if (!goal) return res.status(404).json({ error: "Goal not found" });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : goal.name;
  if (!name) return res.status(400).json({ error: "name cannot be empty" });

  const kind = req.body?.kind !== undefined ? req.body.kind : goal.kind;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });

  const sortOrder = req.body?.sort_order !== undefined ? Number(req.body.sort_order) : goal.sort_order;

  db.prepare("UPDATE goals SET name = ?, sort_order = ?, kind = ? WHERE id = ?").run(
    name,
    sortOrder,
    kind,
    goal.id
  );
  res.json(oneStmt.get(goal.id));
});

goalsRouter.delete("/:id", requireApiKey, (req, res) => {
  const info = db.prepare("DELETE FROM goals WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Goal not found" });
  res.status(204).end();
});
