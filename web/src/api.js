const API_KEY = import.meta.env.VITE_API_KEY || "dev-secret-change-me";

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "x-api-key": API_KEY }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  getDay: (date) => req("GET", `/day?date=${date}`),
  // fields: { done?, bedTime?, upTime?, sleepTime?, wakeTime?, asleepMinutes? }
  setDay: (goalId, date, fields) => req("PUT", "/day", { goalId, date, ...fields }),
  // report by goal name (e.g. { goal: "sleep", bedTime: "23:10" }); applies date attribution
  report: (body) => req("POST", "/report", body),
  getGoals: () => req("GET", "/goals"),
  addGoal: (name, kind = "check", isPrivate = false) => req("POST", "/goals", { name, kind, private: isPrivate }),
  renameGoal: (id, name) => req("PATCH", `/goals/${id}`, { name }),
  updateGoal: (id, fields) => req("PATCH", `/goals/${id}`, fields),
  deleteGoal: (id) => req("DELETE", `/goals/${id}`),
  getHistory: (days = 30) => req("GET", `/history?days=${days}`),
  // presence = phone-on-wall sessions. start/end are driven by Tasker on the
  // phone (physical connect/disconnect); the web only marks a bedtime on the
  // current session (from /bed) and reads the daily total.
  presenceBed: (date) => req("POST", "/presence/bed", { date }),
  getPresence: (date) => req("GET", `/presence?date=${date}`),
  integrationsStatus: () => req("GET", "/integrations/status"),
  syncIntegration: (name) => req("POST", `/integrations/${name}/sync`),
  googleAuthUrl: () => req("GET", "/integrations/google/url"),
  googleConnect: (code) => req("POST", "/integrations/google/callback", { code }),
};
