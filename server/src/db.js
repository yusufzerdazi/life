import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "life.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'check',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    time TEXT,
    bed_time TEXT,
    wake_time TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(goal_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Idempotent migrations for databases created before these columns existed ---
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(table, col, def) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const goalsHadKind = hasColumn("goals", "kind");
addColumn("goals", "kind", "TEXT NOT NULL DEFAULT 'check'");
addColumn("logs", "time", "TEXT");
addColumn("logs", "bed_time", "TEXT");
addColumn("logs", "wake_time", "TEXT");
addColumn("logs", "ran", "INTEGER NOT NULL DEFAULT 0");
addColumn("logs", "worked_out", "INTEGER NOT NULL DEFAULT 0");
addColumn("logs", "asleep_minutes", "INTEGER");
addColumn("logs", "up_time", "TEXT");
addColumn("logs", "sleep_time", "TEXT");
if (!goalsHadKind) {
  // First time the column is added: make the default Sleep goal a sleep-type goal.
  db.prepare("UPDATE goals SET kind = 'sleep' WHERE name = 'Sleep'").run();
}

// Make the default Exercise goal an exercise-type (run/workout) goal, and treat
// any pre-existing "done" exercise log as a workout. Runs once (meta-flagged).
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'mig_exercise_v1'").get()) {
  db.prepare("UPDATE goals SET kind = 'exercise' WHERE name = 'Exercise' AND kind = 'check'").run();
  db.prepare(
    "UPDATE logs SET worked_out = 1 WHERE done = 1 AND goal_id IN (SELECT id FROM goals WHERE kind = 'exercise')"
  ).run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('mig_exercise_v1', '1')").run();
}

// Seed the four default goals on first run.
const count = db.prepare("SELECT COUNT(*) AS n FROM goals").get().n;
if (count === 0) {
  const insert = db.prepare("INSERT INTO goals (name, sort_order, kind) VALUES (?, ?, ?)");
  [
    ["Exercise", "exercise"],
    ["Meditation", "check"],
    ["Yoga", "check"],
    ["Sleep", "sleep"],
  ].forEach(([name, kind], i) => insert.run(name, i, kind));
}
