# life — Android app

A native Kotlin app (no framework) that runs **life entirely on the phone**:

- **UI**: the same React app as `web/`, bundled into the APK and shown in a WebView.
- **Data**: an on-device SQLite port of the server (`app/src/main/java/.../server/`):
  goals, day, report, history and presence, plus Google Health sync, and meditation from
  Waking Up via Health Connect.
  `web/src/api.js` sends requests over the `LifeNative` bridge when it runs
  inside the app, and uses normal `fetch` everywhere else.
- **Blocking**: add timed blocks in the app's **Blocks** section. Pick apps from
  the installed list, type websites, then choose days and from/until times. A
  block can't be removed while it's on. `Config.BLOCKS` holds built-in ones
  that can't be removed without a rebuild. A blocked app or site (in Chrome,
  Brave, Edge, Samsung Internet, Firefox or DuckDuckGo) is covered by a
  "Not now." screen.
- **Category blocks**: news (17:30–23:00 only) and adult sites (always),
  from bundled domain lists (`app/src/main/assets/lists/`). Adult sites come
  from HaGeZi NSFW. News sites come from the UT1 "press" list (Université
  Toulouse Capitole) plus Wikidata's official websites of news outlets. Apps
  that declare themselves news apps are blocked too. To refresh the lists, run
  `python3 -I lists/update.py` and rebuild. Exemptions live in
  `Config.CATEGORY_EXEMPT_*`.
- **Breaks**: after 15 minutes on one app or site, a "Take a break?" screen
  with the logo comes up. "Keep going" asks again 15 minutes later.
- **Grayscale evenings**: the screen goes grayscale from 22:00 until 05:00.
  This needs a one-off permission grant (see Install).
- **Bedtime review**: the bed prompt shows today's screen time and the apps
  and sites you spent the most time on. "Block tomorrow" blocks one of them
  until 05:00 the day after tomorrow.
- **Screen time**: 5 hours a day (`Config.SCREEN_TIME_LIMIT_MIN`), counted per
  app and site while the screen is on and unlocked. You get warnings at 4h,
  4h30 and 4h55; after that everything except `SCREEN_TIME_EXEMPT` locks until
  05:00.
- **Meditation**: Waking Up saves each session to Health Connect as a
  mindfulness record. The app reads those, so no Waking Up token is needed, and
  marks Meditation done for each day with a session. The app asks once for
  Health Connect access, via the bar at the top of the app.
- **Syncing**: Google Health and meditation sync when the app opens (at most
  every 5 minutes) and every 30 minutes in the background. **Sync now** in the
  footer syncs straight away. If Google's sign-in has expired, the footer says
  so: **Sign in** opens Google in Chrome, and the app picks up the redirect on
  `localhost:5173`, a redirect URI registered on the OAuth client. If the OAuth
  consent screen is in "Testing", Google expires the sign-in every 7 days, so
  publish it ("In production") in Google Cloud Console → Audience.
- **Sleep mode**: when the phone is plugged in while upright (on the wall), the app
  opens a presence session and shows `/bed`, then `/dashboard`. It appears over
  the lock screen and keeps the screen on. Unplugging closes the session, which
  records the up time if you confirmed bed. This replaces the Tasker profiles.

Blocking, charge detection and background sync all run in `LifeService`, an
accessibility service. Nothing works until it's enabled, and the app shows a
banner until then.

## Build

```bash
cd android
cp secrets.properties.example secrets.properties   # fill in tokens (gitignored)
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

The build runs `npm install && npm run build` in `web/` and bundles `web/dist`.

## Install

Turn on USB debugging on the phone, then:

```bash
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Then go to **Settings → Accessibility → life → On**. If you sideloaded the APK
instead of using adb and the switch is greyed out, open **App info → ⋮ → Allow
restricted settings** first.

For grayscale evenings, grant this once (it survives reinstalls with `-r`):

```bash
~/Library/Android/sdk/platform-tools/adb shell pm grant com.zerdazi.life android.permission.WRITE_SECURE_SETTINGS
```

## Bring over existing data

To start from the server's database, copy a consistent snapshot into the app
**before the first launch** (or clear the app's storage first):

```bash
sqlite3 server/data/life.sqlite ".backup android/app/src/main/assets/seed.sqlite"
```

`seed.sqlite` is gitignored.
