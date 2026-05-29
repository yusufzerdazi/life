import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { setLog, findGoal } from "../logs.js";
import { getMeta, setMeta } from "../meta.js";
import { todayStr } from "../util.js";

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

function classifyExercise(exerciseType) {
  const t = String(exerciseType || "").toUpperCase();
  if (t.includes("RUN")) return "run";
  if (t.includes("YOGA")) return "yoga";
  return "workout";
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
  const result = { ok: true };

  // Exercise -> Exercise (ran/workedOut) and Yoga goals
  try {
    const exGoal = findGoal(goalName("GOOGLE_EXERCISE_GOAL", "Exercise"));
    const yogaGoal = findGoal(goalName("GOOGLE_YOGA_GOAL", "Yoga"));
    const points = await listDataPoints(
      token,
      "exercise",
      `exercise.interval.civil_start_time >= "${today}" AND exercise.interval.civil_start_time < "${tomorrow}"`
    );
    let ran = false, workedOut = false, yoga = false;
    for (const p of points) {
      const kind = classifyExercise(p.exercise?.exerciseType);
      if (kind === "run") ran = true;
      else if (kind === "yoga") yoga = true;
      else workedOut = true;
    }
    if (exGoal && (ran || workedOut)) {
      const fields = {};
      if (ran) fields.ran = true;
      if (workedOut) fields.workedOut = true;
      setLog(exGoal, today, fields);
    }
    if (yogaGoal && yoga) setLog(yogaGoal, today, { done: true });
    result.exercise = { ran, workedOut, yoga, sessions: points.length };
  } catch (e) {
    result.exerciseError = e.message;
  }

  // Sleep -> Sleep goal (bed/wake separately from tracked asleep minutes)
  try {
    const sleepGoal = findGoal(goalName("GOOGLE_SLEEP_GOAL", "Sleep"));
    // Sleep doesn't accept the interval time filter, so list recent and pick the
    // most recent session (last night's sleep).
    const points = await listDataPoints(token, "sleep");
    const latest = points
      .map((p) => p.sleep)
      .filter((s) => s?.interval?.endTime)
      .sort((a, b) => Date.parse(b.interval.endTime) - Date.parse(a.interval.endTime))[0];

    if (sleepGoal && latest) {
      // Google Health gives when you actually slept/woke (not phone-charge bed/up).
      const sleepTime = localHM(latest.interval.startTime, latest.interval.startUtcOffset);
      const wakeTime = localHM(latest.interval.endTime, latest.interval.endUtcOffset);
      const asleepMinutes = latest.summary?.minutesAsleep != null ? Number(latest.summary.minutesAsleep) : null;
      setLog(sleepGoal, today, { sleepTime, wakeTime });
      if (asleepMinutes != null) setLog(sleepGoal, today, { asleepMinutes });
      result.sleep = { sleepTime, wakeTime, asleepMinutes };
    } else {
      result.sleep = null;
    }
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
