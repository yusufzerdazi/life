import "dotenv/config";
import express from "express";
import cors from "cors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { installLiveReload } from "./liveReload.js";

import { goalsRouter } from "./routes/goals.js";
import { dayRouter } from "./routes/day.js";
import { reportRouter } from "./routes/report.js";
import { historyRouter } from "./routes/history.js";
import { integrationsRouter } from "./routes/integrations.js";
import { presenceRouter } from "./routes/presence.js";
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
app.use("/api/presence", presenceRouter);

// In production, serve the built React app (web/dist) from the same origin.
const webDist = join(__dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  // With LIVE_RELOAD=1 (`npm run live`), inject a reload script into index.html
  // and let static skip it; otherwise serve index.html straight from static.
  const live = process.env.LIVE_RELOAD ? installLiveReload(app, { dir: webDist }) : null;
  const indexPath = join(webDist, "index.html");
  app.use(express.static(webDist, { index: live ? false : "index.html" }));
  app.get("*", async (_req, res, next) => {
    if (!live) return res.sendFile(indexPath);
    try {
      const html = await readFile(indexPath, "utf8");
      res.type("html").send(html.replace("</body>", `${live.snippet}</body>`));
    } catch {
      // A `vite build --watch` rebuild briefly clears web/dist, so index.html
      // can be missing for a moment. Serve a placeholder carrying the same
      // live-reload client; it reloads itself once the new build lands.
      res.type("html").send(`<!doctype html><meta charset="utf-8"><title>building…</title><body>${live.snippet}</body>`);
    }
  });
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
