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

  -- One row per "phone on the wall" session: started when the dashboard mounts
  -- (phone connected), ended when it unmounts (phone removed). When the /bed
  -- prompt is confirmed during a session, bed_at/bed_date are stamped so the
  -- session's end can be treated as that night's wake (up) time.
  CREATE TABLE IF NOT EXISTS presence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    bed_at TEXT,
    bed_date TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_presence_started ON presence(started_at);
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
addColumn("goals", "is_private", "INTEGER NOT NULL DEFAULT 0");
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

// One-time: re-attribute sleep entries to the day you went to bed. The old
// logic stored a night on the wake day (bed day + 1); the new logic stores it
// on the bed day, so every existing sleep log shifts back one day. Also
// recompute `done` under the new bedtime-only rule (bed in the evening, before
// 23:00). Meta-flagged so it runs exactly once.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'mig_sleep_bedday_v1'").get()) {
  const shiftDate1 = (s) => {
    const d = new Date(s + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const bedOk = (t) => {
    if (!t) return 0;
    const [h, m] = String(t).split(":").map(Number);
    const mins = h * 60 + m;
    return mins >= 12 * 60 && mins < 23 * 60 ? 1 : 0; // evening, before 23:00
  };
  const updateRow = db.prepare("UPDATE logs SET date = ?, done = ? WHERE id = ?");
  const migrateSleep = db.transaction(() => {
    const sleepGoals = db.prepare("SELECT id FROM goals WHERE kind = 'sleep'").all();
    for (const g of sleepGoals) {
      // Ascending date order so each -1 day shift lands on a now-vacated date
      // (no transient UNIQUE(goal_id, date) collision).
      const rows = db.prepare("SELECT id, date, bed_time FROM logs WHERE goal_id = ? ORDER BY date ASC").all(g.id);
      for (const r of rows) updateRow.run(shiftDate1(r.date), bedOk(r.bed_time), r.id);
    }
  });
  migrateSleep();
  db.prepare("INSERT INTO meta (key, value) VALUES ('mig_sleep_bedday_v1', '1')").run();
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

// Seed the initial "things to avoid" goals once (after the defaults above, so a
// fresh DB still gets its four goals). These are abstinence goals: done=1 means
// you stayed clean that day, done=0 a slip, no row = unconfirmed. Personal ones
// are flagged private (censored to a first letter on the wall). Meta-flagged +
// name-guarded so it runs once and never duplicates.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'mig_avoid_seed_v1'").get()) {
  const insertAvoid = db.prepare(
    "INSERT INTO goals (name, sort_order, kind, is_private) VALUES (?, ?, 'avoid', ?)"
  );
  const existsByName = db.prepare("SELECT 1 FROM goals WHERE name = ? COLLATE NOCASE");
  const seedAvoid = db.transaction(() => {
    let order = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM goals").get().m;
    const items = [
      ["Porn", 1],
      ["Masturbation", 1],
      ["YouTube", 0],
      ["Nicotine", 0],
      ["Alcohol", 0],
    ];
    for (const [name, priv] of items) {
      if (!existsByName.get(name)) insertAvoid.run(name, ++order, priv);
    }
  });
  seedAvoid();
  db.prepare("INSERT INTO meta (key, value) VALUES ('mig_avoid_seed_v1', '1')").run();
}
