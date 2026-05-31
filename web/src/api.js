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
  addGoal: (name, kind = "check") => req("POST", "/goals", { name, kind }),
  renameGoal: (id, name) => req("PATCH", `/goals/${id}`, { name }),
  deleteGoal: (id) => req("DELETE", `/goals/${id}`),
  getHistory: (days = 30) => req("GET", `/history?days=${days}`),
  integrationsStatus: () => req("GET", "/integrations/status"),
  syncIntegration: (name) => req("POST", `/integrations/${name}/sync`),
  googleAuthUrl: () => req("GET", "/integrations/google/url"),
  googleConnect: (code) => req("POST", "/integrations/google/callback", { code }),
};
