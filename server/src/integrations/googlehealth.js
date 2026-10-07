import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { setLog, findGoal, sleepDayStart } from "../logs.js";
import { getMeta, setMeta } from "../meta.js";
import { todayStr, shiftDay } from "../util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, "..", "..", "..", "auth");

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
];
const API_BASE = "https://health.googleapis.com/v4/users/me/dataTypes";

const ACCESS_KEY = "google_access_token";
const EXPIRES_KEY = "google_expires_at";
const REFRESH_KEY = "google_refresh_token";
const SYNC_KEY = "google_last_sync";

// --- OAuth client config (from the JSON downloaded out of Google Cloud Console) ---
let cachedConfig;
function clientConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  cachedConfig = null;
  if (existsSync(AUTH_DIR)) {
    const file = readdirSync(AUTH_DIR).find((f) => f.endsWith(".json"));
    if (file) {
      const raw = JSON.parse(readFileSync(join(AUTH_DIR, file), "utf8"));
      const c = raw.web || raw.installed;
      if (c) {
        cachedConfig = {
          clientId: c.client_id,
          clientSecret: c.client_secret,
          authUri: c.auth_uri || "https://accounts.google.com/o/oauth2/auth",
          tokenUri: c.token_uri || "https://oauth2.googleapis.com/token",
          redirectUri: (c.redirect_uris && c.redirect_uris[0]) || "http://localhost:5173/",
        };
      }
    }
  }
  return cachedConfig;
}

export function googleConfigured() {
  return !!clientConfig();
}
export function googleConnected() {
  return !!getMeta(REFRESH_KEY);
}
function goalName(envKey, fallback) {
  return process.env[envKey] || fallback;
}

// Consent URL the user opens to grant access.
export function googleAuthUrl() {
  const c = clientConfig();
  if (!c) return null;
  // Note: intentionally NOT setting include_granted_scopes — mixing legacy
  // Google Fit scopes into the token breaks the Health API authorization.
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES.join(" "),
  });
  return `${c.authUri}?${params.toString()}`;
}

export async function googleExchangeCode(code) {
  const c = clientConfig();
  if (!c) return { ok: false, reason: "No OAuth client configured (auth/*.json missing)" };

  const res = await fetch(c.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: data.error_description || data.error || `Token exchange failed (${res.status})` };

  setMeta(ACCESS_KEY, data.access_token);
  setMeta(EXPIRES_KEY, Math.floor(Date.now() / 1000) + (data.expires_in || 3600));
  if (data.refresh_token) setMeta(REFRESH_KEY, data.refresh_token);
  return { ok: true, connected: true };
}

async function getAccessToken() {
  const access = getMeta(ACCESS_KEY);
  const expiresAt = Number(getMeta(EXPIRES_KEY) || 0);
  if (access && expiresAt > Date.now() / 1000 + 60) return access;

  const c = clientConfig();
  const refresh = getMeta(REFRESH_KEY);
  if (!c || !refresh) throw new Error("Not connected to Google (no refresh token)");

  const res = await fetch(c.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Token refresh failed (${res.status})`);
  setMeta(ACCESS_KEY, data.access_token);
  setMeta(EXPIRES_KEY, Math.floor(Date.now() / 1000) + (data.expires_in || 3600));
  return data.access_token;
}

// --- helpers ---
function dayShift(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

// RFC3339 UTC time + a Google "Duration" offset like "3600s" -> local "HH:MM".
function localHM(rfc3339, offsetStr) {
  const off = parseInt(offsetStr || "0", 10) * 1000;
  const d = new Date(Date.parse(rfc3339) + off);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// Same instant, local YYYY-MM-DD.
function localDate(rfc3339, offsetStr) {
  const off = parseInt(offsetStr || "0", 10) * 1000;
  return new Date(Date.parse(rfc3339) + off).toISOString().slice(0, 10);
}

function classifyExercise(exerciseType) {
  const t = String(exerciseType || "").toUpperCase();
  if (t.includes("RUN")) return "run";
  if (t.includes("YOGA")) return "yoga";
  return "workout";
}

// Comma-separated list of dataSource.application.packageName values to accept.
// Empty/unset = accept all sources.
function allowedSources() {
  const v = process.env.GOOGLE_DATA_SOURCES;
  if (!v) return null;
  const set = new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
  return set.size ? set : null;
}
function fromAllowedSource(point, allowed) {
  if (!allowed) return true;
  const pkg = point?.dataSource?.application?.packageName;
  return !!pkg && allowed.has(pkg);
}

async function listDataPoints(token, dataType, filter) {
  let url = `${API_BASE}/${dataType}/dataPoints?pageSize=100`;
  if (filter) url += `&filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message || `${dataType} API error ${res.status}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.dataPoints || [];
}

// Pull today's exercise (run/workout/yoga) and last night's sleep, and write to goals.
export async function syncGoogleHealth() {
  if (!googleConfigured()) return { ok: false, skipped: true, reason: "Google client not configured" };
  if (!googleConnected()) return { ok: false, needsAuth: true, reason: "Not connected — authorize Google first" };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  const today = todayStr();
  const tomorrow = dayShift(1);
  const yesterday = dayShift(-1);
  const allowed = allowedSources();
  const result = { ok: true };

  // Exercise -> Exercise (ran/workedOut) and Yoga goals.
  // Each activity is attributed to its own date (the activity's local start
  // date), with the same early-hours rule as /api/report: events before that
  // date's get-up time roll back to the previous day.
  try {
    const exGoal = findGoal(goalName("GOOGLE_EXERCISE_GOAL", "Exercise"));
    const yogaGoal = findGoal(goalName("GOOGLE_YOGA_GOAL", "Yoga"));
    const points = await listDataPoints(
      token,
      "exercise",
      `exercise.interval.civil_start_time >= "${yesterday}" AND exercise.interval.civil_start_time < "${tomorrow}"`
    );
    const summarize = (p) => {
      const ds = p?.dataSource || {};
      const dev = ds.device || {};
      return JSON.stringify({
        pkg: ds.application?.packageName || null,
        manufacturer: dev.manufacturer || null,
        model: dev.model || null,
        formFactor: dev.formFactor || null,
      });
    };
    result.exerciseSources = [...new Set(points.map(summarize))].map((s) => JSON.parse(s));

    const byDate = new Map();
    for (const p of points) {
      if (!fromAllowedSource(p, allowed)) continue;
      const ex = p.exercise;
      if (!ex?.interval?.startTime) continue;
      const rawDate = localDate(ex.interval.startTime, ex.interval.startUtcOffset);
      const time = localHM(ex.interval.startTime, ex.interval.startUtcOffset);
      const start = sleepDayStart(rawDate) || process.env.DAY_START || "05:00";
      const [sh, sm] = start.split(":").map(Number);
      const [th, tm] = time.split(":").map(Number);
      const date = th * 60 + tm < sh * 60 + sm ? shiftDay(rawDate, -1) : rawDate;
      const kind = classifyExercise(ex.exerciseType);
      if (!byDate.has(date)) byDate.set(date, { ran: false, workedOut: false, yoga: false });
      const agg = byDate.get(date);
      if (kind === "run") agg.ran = true;
      else if (kind === "yoga") agg.yoga = true;
      else agg.workedOut = true;
    }
    const dates = [];
    const aggAll = { ran: false, workedOut: false, yoga: false, sessions: points.length };
    for (const [date, agg] of byDate) {
      if (exGoal && (agg.ran || agg.workedOut)) {
        const fields = {};
        if (agg.ran) fields.ran = true;
        if (agg.workedOut) fields.workedOut = true;
        setLog(exGoal, date, fields);
      }
      if (yogaGoal && agg.yoga) setLog(yogaGoal, date, { done: true });
      dates.push({ date, ...agg });
      if (agg.ran) aggAll.ran = true;
      if (agg.workedOut) aggAll.workedOut = true;
      if (agg.yoga) aggAll.yoga = true;
    }
    result.exercise = aggAll;
    if (dates.length) result.exerciseDates = dates;
  } catch (e) {
    result.exerciseError = e.message;
  }

  // Sleep -> Sleep goal. Each session is attributed to the day you went to bed
  // (the day that's ending): an evening start stays on its own date, but an
  // after-midnight start (before noon) rolls back to the previous day — the
  // same rule the phone-charge bedTime uses in /api/report, so both sleep
  // sources land on the same day. Using the session's own start date (not
  // "today") keeps re-syncs from copying the most recent session onto every day.
  try {
    const sleepGoal = findGoal(goalName("GOOGLE_SLEEP_GOAL", "Sleep"));
    const points = await listDataPoints(token, "sleep");
    const summarize = (p) => {
      const ds = p?.dataSource || {};
      const dev = ds.device || {};
      return JSON.stringify({
        pkg: ds.application?.packageName || null,
        manufacturer: dev.manufacturer || null,
        model: dev.model || null,
        formFactor: dev.formFactor || null,
      });
    };
    result.sleepSources = [...new Set(points.map(summarize))].map((s) => JSON.parse(s));
    const sessions = points
      .filter((p) => fromAllowedSource(p, allowed))
      .map((p) => p.sleep)
      .filter((s) => s?.interval?.endTime)
      .sort((a, b) => Date.parse(a.interval.startTime) - Date.parse(b.interval.startTime)); // oldest first: latest for a date wins

    const written = [];
    if (sleepGoal) {
      for (const s of sessions) {
        const rawDate = localDate(s.interval.startTime, s.interval.startUtcOffset);
        const sleepTime = localHM(s.interval.startTime, s.interval.startUtcOffset);
        const wakeTime = localHM(s.interval.endTime, s.interval.endUtcOffset);
        const asleepMinutes = s.summary?.minutesAsleep != null ? Number(s.summary.minutesAsleep) : null;
        // After-midnight start (before noon) belongs to the previous day.
        const startHour = parseInt(sleepTime.split(":")[0], 10);
        const date = startHour < 12 ? shiftDay(rawDate, -1) : rawDate;
        setLog(sleepGoal, date, { sleepTime, wakeTime });
        if (asleepMinutes != null) setLog(sleepGoal, date, { asleepMinutes });
        written.push({ date, sleepTime, wakeTime, asleepMinutes });
      }
    }
    result.sleep = written[written.length - 1] || null;
    result.sleepSessions = written.length;
  } catch (e) {
    result.sleepError = e.message;
  }

  // If both calls failed (e.g. account not linked to Google Health), report failure.
  if (result.exerciseError && result.sleepError) {
    return { ok: false, reason: result.sleepError, exerciseError: result.exerciseError };
  }

  setMeta(SYNC_KEY, new Date().toISOString());
  return result;
}

export function googleStatus() {
  return {
    configured: googleConfigured(),
    connected: googleConnected(),
    lastSync: getMeta(SYNC_KEY),
  };
}
