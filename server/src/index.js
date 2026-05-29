import "dotenv/config";
import express from "express";
import cors from "cors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { goalsRouter } from "./routes/goals.js";
import { dayRouter } from "./routes/day.js";
import { reportRouter } from "./routes/report.js";
import { historyRouter } from "./routes/history.js";
import { integrationsRouter } from "./routes/integrations.js";
import { syncWakingUp, wakingUpConfigured } from "./integrations/wakingup.js";
import { syncGoogleHealth, googleConfigured, googleConnected } from "./integrations/googlehealth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/goals", goalsRouter);
app.use("/api/day", dayRouter);
app.use("/api/report", reportRouter);
app.use("/api/history", historyRouter);
app.use("/api/integrations", integrationsRouter);

// In production, serve the built React app (web/dist) from the same origin.
const webDist = join(__dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`life server listening on http://localhost:${PORT}`);
});

// Periodically pull goal status from external integrations.
function startPoller(name, sync, minutes, initialDelay) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await sync();
      if (!r.ok && !r.skipped) console.warn(`[${name}] sync issue: ${r.reason}`);
      else if (r.meditatedToday || r.didYogaToday) console.log(`[${name}] marked ${r.goal} done for ${r.date}`);
      else if (r.ran || r.workedOut) console.log(`[${name}] ${r.goal}: ran=${!!r.ran} workout=${!!r.workedOut}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, initialDelay);
  if (minutes > 0) setInterval(run, minutes * 60 * 1000);
  console.log(`[${name}] polling every ${minutes} min`);
}

const POLL = Number(process.env.POLL_MINUTES ?? 30);
if (googleConfigured() && googleConnected()) startPoller("google", syncGoogleHealth, Number(process.env.GOOGLE_POLL_MINUTES ?? POLL), 2000);
if (wakingUpConfigured()) startPoller("wakingup", syncWakingUp, Number(process.env.WAKINGUP_POLL_MINUTES ?? POLL), 3000);
