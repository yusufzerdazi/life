# life — desktop (Mac and Windows)

The phone's blocks, on your computers. One Tauri app (Rust core plus the
shared React UI from `web/`) that:

- **shares blocks** with the phone and your other computers over the home
  wifi. The devices find each other by themselves (mDNS). They need the same
  sync key: it's under **Devices** in the app, so type the phone's key into
  each computer. The newest change to a block wins, and deletions sync too.
  The phone's built-in and category blocks come along as well.
- **blocks apps**: a blocked app is hidden (Mac) or minimised (Windows), and a
  "Not now." window comes up. Apps are identified by their bundle id on a Mac
  and by their .exe name on Windows. Phone apps in a block are ignored there.
- **blocks sites** through the browser extension in `extension/`, which asks
  the app (`127.0.0.1:47711`) about each page. The category lists are the
  phone's, from `android/app/src/main/assets/lists/`.
- runs in the tray, starts at login, and closing the window only hides it.

## Build

Needs Rust (`brew install rustup && rustup default stable`, or rustup.rs on
Windows) and Node.

```bash
cd desktop
npm install
npx tauri build            # Mac: src-tauri/target/release/bundle/macos/life.app
                           # Windows: …\bundle\msi\ and …\bundle\nsis\ installers
```

Windows has to be built on Windows. The same commands work in PowerShell.

The first time it runs, macOS asks whether life may find devices on your
local network. Allow it, or sync can't find the phone. You can change this
later in System Settings → Privacy & Security → Local Network.

## Browser extension (Chrome, Edge, Brave)

1. Open `chrome://extensions` (`edge://extensions` in Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick `desktop/extension`.

If the life app isn't running, nothing is blocked.

See [PROTOCOL.md](PROTOCOL.md) for how devices sync.
