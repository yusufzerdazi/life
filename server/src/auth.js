const API_KEY = process.env.API_KEY || "dev-secret-change-me";

if (!process.env.API_KEY) {
  console.warn(
    "[auth] API_KEY not set — using insecure default 'dev-secret-change-me'. Set API_KEY in server/.env before exposing this server."
  );
}

// Accepts the key via "x-api-key: <key>", "Authorization: Bearer <key>", or a
// "?key=<key>" query param (handy for fire-and-forget requests from the wall
// device / automations that can't set headers).
export function requireApiKey(req, res, next) {
  const headerKey = req.get("x-api-key");
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const provided = headerKey || bearer || (req.query && req.query.key);

  if (provided && provided === API_KEY) return next();
  return res.status(401).json({ error: "Invalid or missing API key" });
}
