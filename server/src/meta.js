import { db } from "./db.js";

const getStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
const setStmt = db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export function getMeta(key) {
  const row = getStmt.get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  setStmt.run(key, value == null ? null : String(value));
}
