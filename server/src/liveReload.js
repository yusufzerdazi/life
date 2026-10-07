import { watch } from "node:fs";

// Tiny SSE-based live-reload for the production single-server (`npm run live`).
// Enabled via LIVE_RELOAD=1. It watches the built web dir and tells connected
// browsers to reload on a rebuild. Each server boot also has an id sent on
// connect, so when `node --watch` restarts the server the browser reconnects,
// sees a new id, and reloads too — covering both web and server edits.
export function installLiveReload(app, { dir }) {
  const bootId = String(Date.now());
  const clients = new Set();

  app.get("/__livereload", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${bootId}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  const broadcast = () => {
    for (const res of clients) res.write("event: reload\ndata: 1\n\n");
  };

  let timer = null;
  try {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(broadcast, 150); // debounce a burst of file writes
    });
    console.log("[livereload] watching", dir);
  } catch (err) {
    console.warn("[livereload] could not watch", dir, "-", err.message);
  }

  return { snippet: SNIPPET };
}

// Injected before </body> of the served index.html.
const SNIPPET = `<script>
(function () {
  var boot = null;
  var es = new EventSource("/__livereload");
  es.addEventListener("hello", function (e) {
    if (boot !== null && boot !== e.data) location.reload();
    boot = e.data;
  });
  es.addEventListener("reload", function () { location.reload(); });
})();
</script>`;
