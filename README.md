# life — daily goals tracker

A small full-stack app to report daily progress toward customizable goals
(seeded with **Exercise, Meditation, Yoga, Sleep**). Track via the web UI or
report progress with plain API calls (curl, iOS Shortcuts, cron, etc.).

- **Frontend:** React + Vite (the wall dashboard is styled with Tailwind CSS + Flowbite)
- **Backend:** Node + Express
- **Database:** SQLite (file-based, zero config) via better-sqlite3
- **Model:** goals have a kind — `check` (done + optional time), `sleep`
  (phone-charge bed/up + Google Health sleep/wake/asleep, with a
  7.5h / bed-before-23:00 / wake-before-08:30 success rule), or `exercise`
  (run + workout). Exercise, sleep, and yoga auto-fill from Google Health;
  meditation from Waking Up.

## Project layout

```
life/
├── server/   Express API + SQLite (data/life.sqlite created on first run)
└── web/      React (Vite) frontend
```

## Setup

```bash
# from the repo root
npm install                 # installs concurrently (dev runner)
npm run install:all         # installs server + web dependencies
```

Environment files are already created with a development key. Before exposing
the server anywhere, change the key in **both** `server/.env` and `web/.env`
(they must match):

```
# server/.env
PORT=3001
API_KEY=dev-secret-change-me

# web/.env
VITE_API_KEY=dev-secret-change-me
```

## Run (development)

```bash
npm run dev
```

- Web UI: http://localhost:5173
- API:    http://localhost:3001

Vite proxies `/api` → the server, so the UI and API share an origin in the browser.

## Run (production-style, single server)

```bash
npm run build     # builds web/dist
npm start         # Express serves the API *and* the built UI on PORT
```

Then open http://localhost:3001.

## Wall dashboard

A read-only, glanceable view for a permanent screen (wall tablet / TV) lives at
**`/dashboard`**. It shows today's goals as large cards with an overall
completion ring and streaks, auto-refreshes every minute, and rolls over at
midnight. The grid adapts to the screen — it picks a balanced near-square layout
for portrait, landscape, or square displays. It only reads (no API key needed)
and has no controls, so it's safe to leave running on a kiosk.

It **goes fullscreen** on the first tap (browsers require a gesture) or via the
⤢ button in the header; the `/bed` prompt does the same. Navigation between
views is in-app (no reload), so fullscreen persists from `/bed` back to
`/dashboard`.

### Bedtime prompt (`/bed`)

Point your phone's "started charging" automation at **`/bed`**. It shows a
full-screen **"Charging for the night?"** prompt: tap **Yes** to log the current
time as that night's bedtime (an evening time is attributed to the next day's
sleep entry automatically), or **No** to dismiss. Either way it returns to
`/dashboard`. (Yes performs a write, so it uses the bundled `VITE_API_KEY`.)

### Open it from another device on your network

The wall device must reach your computer by its **LAN IP** (not `localhost`).
Find it with `ipconfig getifaddr en0` (macOS Wi-Fi), e.g. `192.168.1.131`.

- **Recommended (production):** `npm run build && npm start`, then open
  `http://<your-ip>:3001/dashboard`. The server listens on all interfaces and
  serves the UI + API on one port — stable for a fixture.
- **Dev:** `npm run dev` now exposes Vite on the network too (`server.host`), so
  `http://<your-ip>:5173/dashboard` also works.

If the device still can't connect, allow incoming connections for `node` in
**System Settings → Network → Firewall**, and make sure both devices are on the
same Wi-Fi.

## API

Reads are open; **writes require the API key** via header
`x-api-key: <key>` (or `Authorization: Bearer <key>`).

| Method | Path                    | Auth | Body / Query                         | Description                          |
|--------|-------------------------|------|--------------------------------------|--------------------------------------|
| GET    | `/api/health`           | no   | —                                    | health check                         |
| GET    | `/api/goals`            | no   | —                                    | list goals                           |
| POST   | `/api/goals`            | yes  | `{ "name", "kind"? }`                | add a goal (`kind`: `check`/`sleep`) |
| PATCH  | `/api/goals/:id`        | yes  | `{ "name"?, "kind"?, "sort_order"? }`| rename / retype / reorder a goal     |
| DELETE | `/api/goals/:id`        | yes  | —                                    | delete a goal (and its history)      |
| GET    | `/api/day?date=YYYY-MM-DD` | no | (date defaults to today)            | goals + status (+ times) for a day   |
| PUT    | `/api/day`              | yes  | `{ "goalId", "date"?, ...fields }`   | set a goal's entry for a day         |
| POST   | `/api/report`           | yes  | `{ "goal", "date"?, ...fields }`     | friendly report by goal id **or name** |
| GET    | `/api/history?days=30`  | no   | —                                    | done-logs window for streaks/grid    |

`date` defaults to today.

**Goal kinds & their fields** (used by `/api/report` and `PUT /api/day`):

- `check` goals — `{ "done"? }`. Simple done / not-done (no time); `done`
  defaults to `true` on a bare report. Meditation & yoga are check goals.
- `sleep` goals — two independent sources, all times `"HH:MM"` (or `"HH.MM"`), all merge into one entry:
  - **Phone charge** (you report these): `{ "bedTime"? }` when the phone goes on
    charge, `{ "upTime"? }` when it comes off. These also accept a full timestamp
    `"yyyy-MM-dd HH:mm"` (or with `T`) — the date sets the entry day. A PM
    `bedTime` (noon–23:59) with no explicit `date` is attributed to the **next
    day's** entry — the morning you wake — so it lands with that night's
    up/sleep/wake. Once a `bedTime`/`upTime` is set for a date, **repeat reports
    for it are discarded** (first one wins, so re-plugging the phone won't move
    it). Use the UI's sleep editor to correct a value.
  - **Google Health** (auto): `{ "sleepTime"?, "wakeTime"?, "asleepMinutes"? }`
    (or `"sleepHours"`) — when you actually slept/woke.
  `done` is true only when: time in bed ≥ 7.5h (bed→up phone charge; falls back
  to tracked asleep, then sleep→wake when charge times are missing), **and** bed
  (on charge) before 23:00, **and** wake before 08:30 (Google Health `wake`,
  falling back to phone `up`).
- `exercise` goals — `{ "ran"?, "workedOut"? }`. `done` = ran **or** workedOut
  (ideally both). Google Health sets these automatically (see below).

All times accept `"HH:MM"` or `"HH.MM"` (24-hour).

**Day boundary.** A `/api/report` with no explicit `date` that arrives in the
early hours is attributed to the **previous day** — the day "starts" when you
get up, not at midnight. The boundary is today's recorded get-up time (`up`/
`wake`); before that's logged it falls back to `DAY_START` (default `05:00`). So
yoga at 03:00 counts toward yesterday, and on a late night (up at 13:00) events
before 13:00 still count toward the prior day. (Auto-detected Google Health
activities are attributed by their own date; this rule applies to `/api/report`.)

### Report progress via API

The easiest endpoint for scripts/shortcuts is `/api/report` — it accepts a
goal **name** (case-insensitive):

Exercise, sleep (sleep/wake) and yoga normally fill in automatically from Google
Health — these calls are for **phone-charge bed/up times** and manual entries:

```bash
# mark a check goal done (meditation, yoga); done defaults to true
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"meditation"}'

# phone-charge times: bed = on charge, up = off charge (reported separately,
# HH:MM or HH.MM)
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"sleep","bedTime":"22.50"}'
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"sleep","upTime":"07:10"}'

# exercise: a run and/or a workout (both stick on the same day)
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"exercise","ran":true}'

# log for a specific date, or un-mark
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"yoga","date":"2026-05-27"}'
curl -X POST http://localhost:3001/api/report \
  -H "x-api-key: dev-secret-change-me" -H "Content-Type: application/json" \
  -d '{"goal":"yoga","done":false}'
```

## Integrations (auto-detect goals)

The server can pull goal status from external services on a schedule
(`POLL_MINUTES`, default 30) and via on-demand sync. Each integration also has a
footer button in the UI when configured. Status for all integrations:

```bash
curl http://localhost:3001/api/integrations/status
```

Manual sync (auth required):

```bash
curl -X POST http://localhost:3001/api/integrations/<name>/sync \
  -H "x-api-key: dev-secret-change-me"
# <name> = google | wakingup
```

### Meditation — Waking Up

Watches the `mindful_days` count from the `GetStatistics` GraphQL query; when it
goes **up**, marks the `Meditation` goal done for today. The first sync only
records a baseline (the API exposes no per-day data). Configure in `server/.env`:

```
WAKINGUP_TOKEN=eyJhbGciOi...   # "authorization" header from app.wakingup.com
# WAKINGUP_POLL_MINUTES=30
# WAKINGUP_GOAL=Meditation
```

### Exercise, Sleep & Yoga — Google Health

Pulls activity and sleep from the [Google Health API](https://developers.google.com/health)
(v4) and fills the Exercise, Yoga, and Sleep goals automatically:

- Exercise sessions: a **running** activity sets `ran`, anything else sets
  `workedOut` on the **Exercise** goal; a **yoga** activity marks the **Yoga**
  goal done.
- The most recent **sleep** session sets the **Sleep** goal's `sleepTime`,
  `wakeTime`, and tracked `asleepMinutes` (when you actually slept). These are
  separate from the phone-charge `bedTime`/`upTime` you report yourself — see
  the Sleep goal notes below.

Uses OAuth — connect once from the UI, no secrets in `.env`:

1. In Google Cloud Console (the project that owns your OAuth client), enable the
   **Health API**, and on the OAuth consent screen add the scopes
   `.../auth/googlehealth.activity_and_fitness.readonly` and
   `.../auth/googlehealth.sleep.readonly`, plus yourself as a test user.
2. Drop the OAuth **client JSON** in `auth/` (already gitignored). Its redirect
   URIs must include `http://localhost:5173/`.
3. Run the app, open the UI, and click **Connect Google Health** in the footer.
   Approve consent — you're redirected back and the first sync runs automatically.
4. After that it syncs on a schedule (`GOOGLE_POLL_MINUTES`, default
   `POLL_MINUTES`) and via the **Sync Google Health** button or
   `POST /api/integrations/google/sync`.

Optional env overrides: `GOOGLE_EXERCISE_GOAL`, `GOOGLE_YOGA_GOAL`,
`GOOGLE_SLEEP_GOAL`, `GOOGLE_POLL_MINUTES`.

> Note: `web/.env`'s `VITE_API_KEY` is bundled into the frontend JS. That's
> fine for a personal/local tool. For a multi-user or public deployment, add
> real authentication in front of the API instead of relying on this key.
