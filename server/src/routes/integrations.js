import { Router } from "express";
import { requireApiKey } from "../auth.js";
import { syncWakingUp, wakingUpStatus } from "../integrations/wakingup.js";
import {
  syncGoogleHealth,
  googleStatus,
  googleAuthUrl,
  googleExchangeCode,
} from "../integrations/googlehealth.js";

export const integrationsRouter = Router();

integrationsRouter.get("/status", (_req, res) => {
  res.json({
    google: googleStatus(),
    wakingup: wakingUpStatus(),
  });
});

// --- Google Health (OAuth) ---
integrationsRouter.get("/google/status", (_req, res) => res.json(googleStatus()));
integrationsRouter.get("/google/url", (_req, res) => {
  const url = googleAuthUrl();
  if (!url) return res.status(400).json({ error: "Google OAuth client not configured (auth/*.json missing)" });
  res.json({ url });
});
integrationsRouter.post("/google/callback", requireApiKey, async (req, res) => {
  const code = req.body?.code;
  if (!code) return res.status(400).json({ error: "code is required" });
  const r = await googleExchangeCode(code);
  res.status(r.ok ? 200 : 400).json(r);
});
integrationsRouter.post("/google/sync", requireApiKey, async (_req, res) => {
  const r = await syncGoogleHealth();
  res.status(r.ok ? 200 : 400).json(r);
});

// --- Waking Up ---
integrationsRouter.get("/wakingup/status", (_req, res) => res.json(wakingUpStatus()));
integrationsRouter.post("/wakingup/sync", requireApiKey, async (_req, res) => {
  const r = await syncWakingUp();
  res.status(r.ok ? 200 : 400).json(r);
});
