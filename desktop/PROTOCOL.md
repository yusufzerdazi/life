# Block sync protocol

Implemented in `android/.../server/Sync.kt` and `desktop/src-tauri/src/sync.rs`.

**Discovery.** Each device advertises an mDNS service `_lifesync._tcp` on port
47712, with TXT records `device` (a stable UUID) and `name`. A device that's
contacted directly also counts as found, even if mDNS missed it.

**Exchange.** `POST /sync/v1/exchange`, with body
`{"device", "name", "blocks": [Block…]}`. The receiver merges the blocks and
replies with its own full list in the same shape, which the caller then
merges. Devices exchange on any local change (after about 1.5 s) and every
60 s.

**Auth.** The headers `X-Life-Time` (epoch ms) and `X-Life-Sig` carry
`hex(HMAC-SHA256(key, time + "\n" + method + "\n" + path + "\n" + body))`.
The key is the shared sync key. A request with a time more than 5 minutes off
gets 401.

**Block.**

```json
{ "uid": "…", "name": "Websites",
  "apps": ["com.instagram.android", "slack.exe"], "labels": {"slack.exe": "Slack"},
  "sites": ["reddit.com"], "days": [1,2,3,4,5,6,7], "start": "23:00", "end": "17:30",
  "until": null, "category": null, "builtIn": false,
  "origin": "<device uuid>", "updatedAt": 1763500000000, "deleted": false }
```

- `days` uses ISO numbering, 1 = Monday. A window whose `end` is earlier than
  its `start` runs past midnight. The same `start` and `end` on every day
  means always on.
- `until` (local `YYYY-MM-DDTHH:MM[:SS]`) marks a one-off block. It's on
  until then, and `days`/`start`/`end` are ignored.
- `category` (`news` or `adult`) blocks sites on that bundled list instead of
  `sites`.

**Merge.**
- **Newest wins:** for each `uid`, the higher `updatedAt` wins. On a tie, a
  deletion wins.
- **Tombstones:** deleted blocks are kept for 30 days.
- **Finished one-offs:** they're dropped.
- **Built-ins:** blocks with `builtIn` set come from the phone's code (its
  `Config.kt`). Whenever the phone exchanges, the list it sends replaces that
  device's built-ins. The phone ignores built-ins from anywhere else.
- **Can't remove while on:** each device refuses to delete a block that is
  currently on.
