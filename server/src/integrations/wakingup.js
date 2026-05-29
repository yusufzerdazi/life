import { setLog, findGoal } from "../logs.js";
import { getMeta, setMeta } from "../meta.js";
import { todayStr } from "../util.js";

const ENDPOINT = "https://api.wakingup.com/api/graphql";

const QUERY = `query GetStatistics {
  userStatistics {
    ...UserStatisticsData
    __typename
  }
}

fragment UserStatisticsData on UserStatistics {
  __typename
  mindful_days
  total_duration_seconds
  total_meditated_seconds
  total_sessions
}`;

const MINDFUL_KEY = "wakingup_mindful_days";
const SYNC_KEY = "wakingup_last_sync";

export function wakingUpConfigured() {
  return !!process.env.WAKINGUP_TOKEN;
}

function goalName() {
  return process.env.WAKINGUP_GOAL || "Meditation";
}

// Fetches mindful_days from Waking Up. When it has increased since the last
// recorded value, marks the meditation goal done for today. The very first
// sync only records a baseline (the API exposes no per-day data, so we can't
// know whether today is already included).
export async function syncWakingUp() {
  const token = process.env.WAKINGUP_TOKEN;
  if (!token) return { ok: false, skipped: true, reason: "WAKINGUP_TOKEN not set" };

  const goal = findGoal(goalName());
  if (!goal) return { ok: false, reason: `Goal "${goalName()}" not found` };

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: token,
        "app-client": "web",
        "app-version": process.env.WAKINGUP_APP_VERSION || "3.21.7",
        "app-build": process.env.WAKINGUP_APP_BUILD || "987",
      },
      body: JSON.stringify({ operationName: "GetStatistics", variables: {}, query: QUERY }),
    });
  } catch (e) {
    return { ok: false, reason: `Request failed: ${e.message}` };
  }

  if (!res.ok) return { ok: false, reason: `Waking Up API returned ${res.status}` };

  const json = await res.json().catch(() => null);
  const stats = json?.data?.userStatistics;
  if (!stats || typeof stats.mindful_days !== "number") {
    return { ok: false, reason: "Unexpected response (token expired?)", errors: json?.errors };
  }

  const mindfulDays = stats.mindful_days;
  const prevRaw = getMeta(MINDFUL_KEY);
  const prev = prevRaw === null ? null : Number(prevRaw);

  setMeta(MINDFUL_KEY, mindfulDays);
  setMeta(SYNC_KEY, new Date().toISOString());

  if (prev === null) {
    return { ok: true, baseline: true, meditatedToday: false, mindfulDays };
  }
  if (mindfulDays > prev) {
    const date = todayStr();
    setLog(goal, date, { done: true });
    return { ok: true, meditatedToday: true, date, goal: goal.name, previous: prev, mindfulDays };
  }
  return { ok: true, meditatedToday: false, previous: prev, mindfulDays };
}

export function wakingUpStatus() {
  const raw = getMeta(MINDFUL_KEY);
  return {
    configured: wakingUpConfigured(),
    goal: goalName(),
    mindfulDays: raw === null ? null : Number(raw),
    lastSync: getMeta(SYNC_KEY),
  };
}
